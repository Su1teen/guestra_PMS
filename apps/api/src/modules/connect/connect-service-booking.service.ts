import { BadRequestException, ConflictException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gt, lt, ne, notInArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { folios, guests, guestPropertyLinks, integrationLinks, reservations, serviceBookings, serviceResourceAllocations, serviceResources, services } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import { WebhookService } from '../webhook/webhook.service';
import type { AgentServiceAvailabilityDto, AgentServiceBookDto } from './dto/agent-service.dto';

@Injectable()
export class ConnectServiceBookingService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly folioService: FolioService, private readonly webhookService: WebhookService) {}

  async options(propertyId: string) {
    return this.db.select({ id: services.id, code: services.code, name: services.name, description: services.description,
      price: services.price, currencyCode: services.currencyCode, agentBookingMode: services.agentBookingMode, durationMinutes: services.durationMinutes })
      .from(services).where(and(eq(services.propertyId, propertyId), eq(services.isActive, true))).orderBy(asc(services.sortOrder));
  }

  async availability(dto: AgentServiceAvailabilityDto, db: any = this.db) {
    const [service] = await db.select().from(services).where(and(eq(services.id, dto.serviceId), eq(services.propertyId, dto.propertyId), eq(services.isActive, true)));
    if (!service) throw new NotFoundException('SERVICE_NOT_FOUND');
    if (service.agentBookingMode !== 'live_booking') return { serviceId: service.id, available: false, code: 'SERVICE_NOT_LIVE_BOOKABLE', bookingMode: service.agentBookingMode };
    const resources = await db.select().from(serviceResources).where(and(eq(serviceResources.propertyId, dto.propertyId), eq(serviceResources.serviceId, service.id), eq(serviceResources.isActive, true)));
    if (!resources.length) return { serviceId: service.id, available: false, code: 'NO_AVAILABILITY', reason: 'No operational resource is configured' };
    const allocations = await db.select({ resourceId: serviceResourceAllocations.resourceId, units: serviceResourceAllocations.units })
      .from(serviceResourceAllocations).innerJoin(serviceBookings, and(eq(serviceBookings.id, serviceResourceAllocations.serviceBookingId), eq(serviceBookings.propertyId, dto.propertyId)))
      .where(and(eq(serviceResourceAllocations.propertyId, dto.propertyId), notInArray(serviceBookings.status, ['cancelled'] as any), lt(serviceBookings.startAt, new Date(dto.endAt)), gt(serviceBookings.endAt, new Date(dto.startAt))));
    const demand = dto.participants ?? 1;
    const selected = resources.find((resource: any) => Number(resource.capacity) - allocations.filter((a: any) => a.resourceId === resource.id).reduce((sum: number, a: any) => sum + Number(a.units), 0) >= demand);
    return { serviceId: service.id, serviceCode: service.code, available: Boolean(selected), bookingMode: service.agentBookingMode,
      startAt: dto.startAt, endAt: dto.endAt, participants: demand, authoritativePrice: Number(service.price), currencyCode: service.currencyCode };
  }

  async book(dto: AgentServiceBookDto) {
    const fingerprint = this.fingerprint(dto);
    const [existing] = await this.db.select().from(serviceBookings).where(and(eq(serviceBookings.propertyId, dto.propertyId), eq(serviceBookings.idempotencyKey, dto.idempotencyKey)));
    if (existing) {
      if ((existing.integrationContext as any)?.idempotencyFingerprint !== fingerprint) throw new ConflictException('IDEMPOTENCY_CONFLICT');
      return { success: true, idempotentReplay: true, serviceBookingId: existing.id, status: existing.status, folioId: existing.folioId };
    }
    const committed = await this.db.transaction(async (tx: any) => {
      const availability = await this.availability(dto, tx);
      if (!availability.available) throw new BadRequestException(availability.code ?? 'NO_AVAILABILITY');
      const [service] = await tx.select().from(services).where(and(eq(services.id, dto.serviceId), eq(services.propertyId, dto.propertyId))).for('update');
      const lockedResources = await tx.select().from(serviceResources).where(and(eq(serviceResources.propertyId, dto.propertyId), eq(serviceResources.serviceId, dto.serviceId), eq(serviceResources.isActive, true))).orderBy(asc(serviceResources.code)).for('update');
      const guest = await this.resolveGuest(tx, dto);
      let folio: any;
      if (dto.reservationId) {
        const [reservation] = await tx.select().from(reservations).where(and(eq(reservations.id, dto.reservationId), eq(reservations.propertyId, dto.propertyId), eq(reservations.guestId, guest.id)));
        if (!reservation || !['checked_in', 'stayover', 'due_out'].includes(reservation.status)) throw new BadRequestException('INVALID_STATE');
        [folio] = await tx.select().from(folios).where(and(eq(folios.propertyId, dto.propertyId), eq(folios.reservationId, dto.reservationId), eq(folios.status, 'open')));
      }
      if (!folio) folio = await this.folioService.create({ propertyId: dto.propertyId, guestId: guest.id, type: 'guest', currencyCode: service.currencyCode, notes: 'Standalone service folio' }, tx);
      const demand = dto.participants ?? 1;
      const allocationRows = await tx.select({ resourceId: serviceResourceAllocations.resourceId, units: serviceResourceAllocations.units })
        .from(serviceResourceAllocations).innerJoin(serviceBookings, eq(serviceBookings.id, serviceResourceAllocations.serviceBookingId))
        .where(and(eq(serviceResourceAllocations.propertyId, dto.propertyId), notInArray(serviceBookings.status, ['cancelled'] as any), lt(serviceBookings.startAt, new Date(dto.endAt)), gt(serviceBookings.endAt, new Date(dto.startAt))));
      const resource = lockedResources.find((candidate: any) => Number(candidate.capacity) - allocationRows.filter((a: any) => a.resourceId === candidate.id).reduce((sum: number, a: any) => sum + Number(a.units), 0) >= demand);
      if (!resource) throw new ConflictException('RESOURCE_CONFLICT');
      const total = new Decimal(service.price).times(dto.quantity ?? 1);
      const [booking] = await tx.insert(serviceBookings).values({ propertyId: dto.propertyId, guestId: guest.id, serviceId: service.id, reservationId: dto.reservationId, folioId: folio.id,
        startAt: new Date(dto.startAt), endAt: new Date(dto.endAt), participants: demand, quantity: dto.quantity ?? 1, unitPrice: service.price, totalAmount: total.toFixed(2), currencyCode: service.currencyCode,
        notes: dto.notes, sourceChannel: 'ai_guest_agent', idempotencyKey: dto.idempotencyKey, integrationContext: { ...(dto.integrationContext ?? {}), idempotencyFingerprint: fingerprint } }).returning();
      await tx.insert(serviceResourceAllocations).values({ propertyId: dto.propertyId, serviceBookingId: booking.id, resourceId: resource.id, units: demand });
      await this.folioService.postCharge(folio.id, { propertyId: dto.propertyId, type: service.chargeType, description: service.name, amount: total.toFixed(2), currencyCode: service.currencyCode, serviceDate: dto.startAt, skipTaxCalculation: true } as any, tx, { sourceKey: `service-booking:${booking.id}` });
      await this.linkCustomer(tx, dto.propertyId, guest.id, booking.id, dto.integrationContext);
      return { booking, service, folio };
    });
    await this.webhookService.emit('service_booking.created', 'service_booking', committed.booking.id, { serviceBookingId: committed.booking.id, serviceId: committed.service.id, folioId: committed.folio.id, integrationContext: dto.integrationContext ?? {} }, dto.propertyId);
    return { success: true, serviceBookingId: committed.booking.id, status: committed.booking.status, serviceId: committed.service.id, serviceCode: committed.service.code, folioId: committed.folio.id, totalAmount: Number(committed.booking.totalAmount), currencyCode: committed.booking.currencyCode };
  }

  private async resolveGuest(tx: any, dto: AgentServiceBookDto) {
    if (dto.guestId) {
      const [guest] = await tx.select().from(guests).where(eq(guests.id, dto.guestId));
      const [link] = await tx.select().from(guestPropertyLinks).where(and(eq(guestPropertyLinks.guestId, dto.guestId), eq(guestPropertyLinks.propertyId, dto.propertyId)));
      if (!guest || !link) throw new NotFoundException('GUEST_NOT_FOUND');
      return guest;
    }
    const context = dto.integrationContext;
    if (context?.sourceSystem && context.customerId) {
      const [identity] = await tx.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, dto.propertyId), eq(integrationLinks.sourceSystem, context.sourceSystem), eq(integrationLinks.externalEntityType, 'customer'), eq(integrationLinks.externalEntityId, context.customerId)));
      if (identity?.localEntityType === 'guest') {
        const [guest] = await tx.select().from(guests).where(eq(guests.id, identity.localEntityId));
        if (guest) return guest;
      }
    }
    if (!dto.guestFirstName) throw new BadRequestException('GUEST_NOT_FOUND');
    const [guest] = await tx.insert(guests).values({ firstName: dto.guestFirstName, lastName: dto.guestLastName || 'Не указана', email: dto.guestEmail, phone: dto.guestPhone }).returning();
    await tx.insert(guestPropertyLinks).values({ guestId: guest.id, propertyId: dto.propertyId, source: context?.sourceSystem ?? 'connect' });
    return guest;
  }

  private async linkCustomer(tx: any, propertyId: string, guestId: string, bookingId: string, context?: AgentServiceBookDto['integrationContext']) {
    if (!context?.sourceSystem || !context.customerId) return;
    const [existing] = await tx.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId), eq(integrationLinks.sourceSystem, context.sourceSystem), eq(integrationLinks.externalEntityType, 'customer'), eq(integrationLinks.externalEntityId, context.customerId)));
    if (existing && (existing.localEntityType !== 'guest' || existing.localEntityId !== guestId)) throw new ConflictException('IDENTITY_CONFLICT');
    if (!existing) await tx.insert(integrationLinks).values({ propertyId, sourceSystem: context.sourceSystem, externalEntityType: 'customer', externalEntityId: context.customerId, localEntityType: 'guest', localEntityId: guestId });
    if (context.reservationId) await tx.insert(integrationLinks).values({ propertyId, sourceSystem: context.sourceSystem, externalEntityType: 'service_reservation', externalEntityId: context.reservationId, localEntityType: 'service_booking', localEntityId: bookingId });
  }

  private fingerprint(dto: AgentServiceBookDto) { const { idempotencyKey: _key, ...rest } = dto as any; return JSON.stringify(rest); }
}
