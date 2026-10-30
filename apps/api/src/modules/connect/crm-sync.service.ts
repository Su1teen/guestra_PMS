import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray } from 'drizzle-orm';
import Decimal from 'decimal.js';
import {
  bookings, charges, folios, guests, integrationLinks, payments, properties, ratePlans, reservations, rooms, roomTypes,
  serviceBookings, services,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { ReservationService } from '../reservation/reservation.service';
import { FolioService } from '../folio/folio.service';
import { WebhookService } from '../webhook/webhook.service';
import { folioPaymentSumWhere } from '../payment/payment-ledger';
import { matchCategory, parseCategoryOverrides } from './crm-sync.matching';
import type { CrmSyncApplyDto, CrmSyncLinkDto } from './dto/crm-sync.dto';

const SOURCE = 'guestra_crm';
/** CRM-originated ledger rows carry these prefixes so the mirror never echoes them back. */
export const CRM_CHARGE_PREFIX = 'crm:fline:';
export const CRM_PAYMENT_PREFIX = 'crm:payment:';
const PAYMENT_METHODS: Record<string, 'credit_card' | 'bank_transfer' | 'cash'> = { card: 'credit_card', transfer: 'bank_transfer', cash: 'cash' };
const CHARGE_TYPES = new Set(['food_beverage', 'minibar', 'phone', 'laundry', 'parking', 'spa', 'incidental', 'fee', 'package']);

/**
 * Staff-level two-way mirror between Guestra CRM and this PMS.
 * Unlike the guest-scoped agent contract, the CRM service principal sees every
 * stay of its property so that a reservation created at either front desk
 * appears in the other system. Every query is property-scoped.
 */
@Injectable()
export class CrmSyncService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly reservationService: ReservationService,
    private readonly folioService: FolioService,
    private readonly webhookService: WebhookService,
    private readonly config: ConfigService,
  ) {}

  private async link(db: any, propertyId: string, externalEntityType: string, externalEntityId: string, localEntityType: string) {
    const [row] = await db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId),
      eq(integrationLinks.sourceSystem, SOURCE), eq(integrationLinks.externalEntityType, externalEntityType),
      eq(integrationLinks.externalEntityId, externalEntityId), eq(integrationLinks.localEntityType, localEntityType))).limit(1);
    return row as { localEntityId: string } | undefined;
  }

  private async ensureLink(db: any, propertyId: string, externalEntityType: string, externalEntityId: string, localEntityType: string, localEntityId: string) {
    const existing = await this.link(db, propertyId, externalEntityType, externalEntityId, localEntityType);
    if (existing && existing.localEntityId !== localEntityId) throw new ConflictException('IDENTITY_CONFLICT');
    if (!existing) await db.insert(integrationLinks).values({ propertyId, sourceSystem: SOURCE, externalEntityType, externalEntityId, localEntityType, localEntityId })
      .onConflictDoNothing();
  }

  private async localLinks(db: any, propertyId: string, localEntityType: string, localEntityId: string) {
    return db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId), eq(integrationLinks.sourceSystem, SOURCE),
      eq(integrationLinks.localEntityType, localEntityType), eq(integrationLinks.localEntityId, localEntityId)));
  }

  /** Full staff view of one stay: guest, category, room, folio ledger and scheduled services. */
  async snapshot(propertyId: string, reservationId: string, db: any = this.db) {
    const [row] = await db.select({ reservation: reservations, booking: bookings, guest: guests, roomType: roomTypes, roomNumber: rooms.number,
      timezone: properties.timezone, checkInTime: properties.checkInTime, checkOutTime: properties.checkOutTime })
      .from(reservations)
      .innerJoin(properties, eq(properties.id, reservations.propertyId))
      .innerJoin(bookings, and(eq(bookings.id, reservations.bookingId), eq(bookings.propertyId, reservations.propertyId)))
      .innerJoin(guests, eq(guests.id, reservations.guestId))
      .leftJoin(roomTypes, and(eq(roomTypes.id, reservations.roomTypeId), eq(roomTypes.propertyId, reservations.propertyId)))
      .leftJoin(rooms, and(eq(rooms.id, reservations.roomId), eq(rooms.propertyId, reservations.propertyId)))
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException('RESERVATION_NOT_FOUND');
    const folioRows = await db.select().from(folios)
      .where(and(eq(folios.propertyId, propertyId), eq(folios.reservationId, reservationId), eq(folios.type, 'guest')))
      .orderBy(asc(folios.createdAt));
    const folio = folioRows[0];
    const [chargeRows, paymentRows, bookingRows, reservationLinks, guestLinks] = await Promise.all([
      folio ? db.select().from(charges).where(and(eq(charges.propertyId, propertyId), eq(charges.folioId, folio.id))).orderBy(asc(charges.postedAt)) : [],
      folio ? db.select().from(payments).where(folioPaymentSumWhere(folio.id, propertyId)).orderBy(asc(payments.createdAt)) : [],
      db.select({ booking: serviceBookings, name: services.name, code: services.code }).from(serviceBookings)
        .innerJoin(services, and(eq(services.id, serviceBookings.serviceId), eq(services.propertyId, serviceBookings.propertyId)))
        .where(and(eq(serviceBookings.propertyId, propertyId), eq(serviceBookings.reservationId, reservationId))),
      this.localLinks(db, propertyId, 'reservation', reservationId),
      this.localLinks(db, propertyId, 'guest', row.guest.id),
    ]);
    const { reservation, guest } = row;
    return {
      entityType: 'staff_reservation', id: reservation.id, propertyId,
      property: { timezone: row.timezone, checkInTime: row.checkInTime, checkOutTime: row.checkOutTime },
      confirmationNumber: row.booking.confirmationNumber, source: row.booking.source, status: reservation.status,
      arrivalDate: reservation.arrivalDate, departureDate: reservation.departureDate, nights: reservation.nights,
      adults: reservation.adults, children: reservation.children,
      totalAmount: String(reservation.totalAmount), currencyCode: reservation.currencyCode,
      specialRequests: reservation.specialRequests ?? null,
      checkedInAt: reservation.checkedInAt ?? null, checkedOutAt: reservation.checkedOutAt ?? null,
      roomType: row.roomType ? { id: row.roomType.id, code: row.roomType.code, name: row.roomType.name, maxOccupancy: row.roomType.maxOccupancy } : null,
      roomNumber: row.roomNumber ?? null,
      guest: { id: guest.id, firstName: guest.firstName, lastName: guest.lastName, phone: guest.phone ?? null, email: guest.email ?? null },
      crm: {
        reservationId: reservationLinks.find((l: any) => l.externalEntityType === 'reservation')?.externalEntityId ?? null,
        customerId: guestLinks.find((l: any) => l.externalEntityType === 'customer')?.externalEntityId ?? null,
      },
      folio: folio ? {
        id: folio.id, folioNumber: folio.folioNumber, status: folio.status,
        totalCharges: String(folio.totalCharges), totalPayments: String(folio.totalPayments), balance: String(folio.balance),
        charges: chargeRows.map((c: any) => ({ id: c.id, type: c.type, description: c.description, amount: String(c.amount), taxAmount: String(c.taxAmount ?? '0'),
          serviceDate: c.serviceDate, isReversal: c.isReversal, parentChargeId: c.parentChargeId ?? null, sourceKey: c.sourceKey ?? null })),
        payments: paymentRows.map((p: any) => ({ id: p.id, method: p.method, amount: String(p.amount), status: p.status,
          processedAt: p.processedAt ?? p.createdAt, idempotencyKey: p.idempotencyKey ?? null })),
      } : null,
      services: bookingRows.map((r: any) => ({ id: r.booking.id, serviceCode: r.code, serviceName: r.name, status: r.booking.status,
        startAt: r.booking.startAt, endAt: r.booking.endAt, participants: r.booking.participants, quantity: r.booking.quantity,
        unitPrice: String(r.booking.unitPrice), totalAmount: String(r.booking.totalAmount), currencyCode: r.booking.currencyCode })),
      updatedAt: reservation.updatedAt,
    };
  }

  /** Maps any domain event entity to the stay it belongs to. Service-only bookings return the booking itself. */
  async resolve(propertyId: string, type: string, id: string) {
    let reservationId: string | null = null;
    if (type === 'reservation') reservationId = id;
    else if (type === 'folio') {
      const [folio] = await this.db.select({ reservationId: folios.reservationId }).from(folios).where(and(eq(folios.id, id), eq(folios.propertyId, propertyId)));
      reservationId = folio?.reservationId ?? null;
    } else if (type === 'payment') {
      const [row] = await this.db.select({ reservationId: folios.reservationId }).from(payments)
        .innerJoin(folios, and(eq(folios.id, payments.folioId), eq(folios.propertyId, payments.propertyId)))
        .where(and(eq(payments.id, id), eq(payments.propertyId, propertyId)));
      reservationId = row?.reservationId ?? null;
    } else if (type === 'service_booking') {
      const [row] = await this.db.select({ booking: serviceBookings, name: services.name, code: services.code, guest: guests }).from(serviceBookings)
        .innerJoin(services, and(eq(services.id, serviceBookings.serviceId), eq(services.propertyId, serviceBookings.propertyId)))
        .innerJoin(guests, eq(guests.id, serviceBookings.guestId))
        .where(and(eq(serviceBookings.id, id), eq(serviceBookings.propertyId, propertyId)));
      if (!row) return { kind: 'none' as const };
      if (row.booking.reservationId) reservationId = row.booking.reservationId;
      else {
        const guestLinks = await this.localLinks(this.db, propertyId, 'guest', row.guest.id);
        return { kind: 'service_only' as const, service: {
          id: row.booking.id, serviceCode: row.code, serviceName: row.name, status: row.booking.status, startAt: row.booking.startAt, endAt: row.booking.endAt,
          participants: row.booking.participants, quantity: row.booking.quantity, unitPrice: String(row.booking.unitPrice),
          totalAmount: String(row.booking.totalAmount), currencyCode: row.booking.currencyCode,
          guest: { id: row.guest.id, firstName: row.guest.firstName, lastName: row.guest.lastName, phone: row.guest.phone ?? null, email: row.guest.email ?? null },
          crmCustomerId: guestLinks.find((l: any) => l.externalEntityType === 'customer')?.externalEntityId ?? null,
        } };
      }
    }
    if (!reservationId) return { kind: 'none' as const };
    return { kind: 'reservation' as const, reservation: await this.snapshot(propertyId, reservationId) };
  }

  async linkGuest(dto: CrmSyncLinkDto) {
    await this.db.transaction(async (tx: any) => {
      const [guest] = await tx.select({ id: guests.id }).from(guests).where(eq(guests.id, dto.pmsGuestId));
      if (!guest) throw new NotFoundException('GUEST_NOT_FOUND');
      if (dto.pmsReservationId) {
        // The guest must belong to a stay at this property (guests are cross-property rows).
        const [stay] = await tx.select({ id: reservations.id }).from(reservations).where(and(eq(reservations.id, dto.pmsReservationId),
          eq(reservations.propertyId, dto.propertyId), eq(reservations.guestId, dto.pmsGuestId)));
        if (!stay) throw new NotFoundException('RESERVATION_NOT_FOUND');
        if (dto.crmReservationId) await this.ensureLink(tx, dto.propertyId, 'reservation', dto.crmReservationId, 'reservation', dto.pmsReservationId);
      } else {
        const [booking] = await tx.select({ id: serviceBookings.id }).from(serviceBookings)
          .where(and(eq(serviceBookings.propertyId, dto.propertyId), eq(serviceBookings.guestId, dto.pmsGuestId))).limit(1);
        if (!booking) throw new NotFoundException('GUEST_NOT_AT_PROPERTY');
      }
      await this.ensureLink(tx, dto.propertyId, 'customer', dto.customerId, 'guest', dto.pmsGuestId);
    });
    return { linked: true };
  }

  private async categoryFor(db: any, propertyId: string, name: string) {
    const candidates = await db.select().from(roomTypes).where(eq(roomTypes.propertyId, propertyId));
    const match = matchCategory(name, candidates, parseCategoryOverrides(this.config.get('GUESTRA_SYNC_CATEGORY_MAP')));
    if (!match) throw new BadRequestException('CATEGORY_NOT_MAPPED');
    const [plan] = await db.select().from(ratePlans).where(and(eq(ratePlans.propertyId, propertyId), eq(ratePlans.roomTypeId, match.id),
      eq(ratePlans.type, 'bar'), eq(ratePlans.isActive, true))).orderBy(asc(ratePlans.code)).limit(1);
    if (!plan) throw new BadRequestException('NO_SELLABLE_RATE_PLAN');
    return { roomType: match, ratePlan: plan };
  }

  /**
   * Applies a CRM stay: creates the guest/stay once, then posts every CRM
   * charge and payment exactly once (source keys), then follows the CRM status.
   * Accommodation itself is never posted as a charge: PMS night audit posts room nights.
   */
  async apply(dto: CrmSyncApplyDto) {
    const { propertyId } = dto;
    let createdNow = false;
    const reservationId: string = await this.db.transaction(async (tx: any) => {
      let guestId = (await this.link(tx, propertyId, 'customer', dto.guest.customerId, 'guest'))?.localEntityId ?? dto.guest.pmsGuestId;
      if (!guestId) {
        const [guest] = await tx.insert(guests).values({ firstName: dto.guest.firstName.slice(0, 100), lastName: (dto.guest.lastName || '—').slice(0, 100),
          phone: dto.guest.phone || null, email: dto.guest.email || null }).returning();
        guestId = guest.id as string;
      }
      let id = dto.pmsReservationId ?? (await this.link(tx, propertyId, 'reservation', dto.crmReservationId, 'reservation'))?.localEntityId;
      if (id) {
        const [own] = await tx.select({ id: reservations.id, guestId: reservations.guestId }).from(reservations)
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, propertyId)));
        if (!own) throw new NotFoundException('RESERVATION_NOT_FOUND');
        guestId = guestId ?? own.guestId;
      } else {
        if (!dto.stay) throw new BadRequestException('STAY_REQUIRED');
        const { roomType, ratePlan } = await this.categoryFor(tx, propertyId, dto.stay.categoryName);
        const created = await this.reservationService.create({
          propertyId, guestId: guestId!, arrivalDate: dto.stay.arrivalDate, departureDate: dto.stay.departureDate,
          roomTypeId: roomType.id, ratePlanId: ratePlan.id, totalAmount: new Decimal(dto.stay.totalAmount).toFixed(2),
          currencyCode: dto.stay.currencyCode, adults: dto.stay.adults, children: dto.stay.children,
          specialRequests: dto.stay.specialRequests, source: 'direct', channelCode: 'guestra_crm',
        } as any, { idempotencyKey: 'crm:reservation:' + dto.crmReservationId, integrationContext: { sourceSystem: SOURCE, customerId: dto.guest.customerId } }, tx);
        id = created.id as string;
        createdNow = true;
      }
      await this.ensureLink(tx, propertyId, 'customer', dto.guest.customerId, 'guest', guestId!);
      await this.ensureLink(tx, propertyId, 'reservation', dto.crmReservationId, 'reservation', id!);
      return id!;
    });

    // ReservationService only emits outside a caller transaction; keep channel/ARI consumers informed.
    if (createdNow && dto.stay) await this.webhookService.emit('reservation.created', 'reservation', reservationId,
      { reservationId, arrivalDate: dto.stay.arrivalDate, departureDate: dto.stay.departureDate, source: SOURCE }, propertyId);
    const [folio] = await this.db.select().from(folios).where(and(eq(folios.propertyId, propertyId), eq(folios.reservationId, reservationId), eq(folios.type, 'guest')))
      .orderBy(asc(folios.createdAt)).limit(1);
    const errors: string[] = [];
    if (dto.charges.length || dto.payments.length) {
      if (!folio) errors.push('FOLIO_NOT_FOUND');
      else if (folio.status !== 'open') errors.push('FOLIO_NOT_OPEN');
    }
    if (folio && folio.status === 'open') {
      for (const line of dto.charges) {
        try {
          await this.folioService.postChargeFromSnapshotWithOutcome(folio.id, {
            propertyId, type: CHARGE_TYPES.has(line.category) ? line.category : 'incidental', description: line.description.slice(0, 255),
            amount: new Decimal(line.amount).toFixed(2), currencyCode: folio.currencyCode, serviceDate: line.serviceDate,
          } as any, '0.00', undefined, CRM_CHARGE_PREFIX + line.crmLineId);
        } catch (error) { errors.push('CHARGE_REJECTED:' + line.crmLineId + ':' + (error as Error).message); }
      }
      if (dto.payments.length) {
        const keys = dto.payments.map(p => CRM_PAYMENT_PREFIX + p.crmPaymentId);
        const existing = new Set((await this.db.select({ key: payments.idempotencyKey }).from(payments)
          .where(and(eq(payments.propertyId, propertyId), inArray(payments.idempotencyKey, keys)))).map((r: any) => r.key));
        for (const payment of dto.payments) {
          const key = CRM_PAYMENT_PREFIX + payment.crmPaymentId;
          if (existing.has(key)) continue;
          const processedAt = new Date(Math.min(Date.parse(payment.processedAt), Date.now()));
          const [row] = await this.db.insert(payments).values({ propertyId, folioId: folio.id, idempotencyKey: key, method: PAYMENT_METHODS[payment.method],
            status: 'captured', amount: new Decimal(payment.amount).toFixed(2), currencyCode: folio.currencyCode, processedAt,
            notes: ['Guestra CRM', payment.reference].filter(Boolean).join(' · ').slice(0, 1000) }).onConflictDoNothing().returning();
          if (!row) continue;
          await this.folioService.recalculateBalance(folio.id, propertyId);
          await this.webhookService.emit('payment.received', 'payment', row.id, { folioId: folio.id, method: row.method, amount: row.amount, status: 'captured' }, propertyId);
        }
      }
    }
    if (dto.stay) {
      const error = await this.followStatus(propertyId, reservationId, dto.stay.status);
      if (error) errors.push(error);
    }
    return { reservationId, errors, snapshot: await this.snapshot(propertyId, reservationId) };
  }

  /** Moves the PMS stay forward to the CRM status. Never moves backwards; failures are reported, not hidden. */
  private async followStatus(propertyId: string, reservationId: string, target: string): Promise<string | null> {
    const [current] = await this.db.select({ status: reservations.status, roomId: reservations.roomId }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!current) return 'RESERVATION_NOT_FOUND';
    try {
      if (target === 'cancelled' && ['pending', 'confirmed', 'assigned'].includes(current.status))
        await this.reservationService.cancel(reservationId, propertyId, { cancellationReason: 'Отменено в Guestra CRM' } as any);
      else if (['confirmed', 'checked_in', 'checked_out'].includes(target) && current.status === 'pending')
        await this.reservationService.confirm(reservationId, propertyId);
      if (['checked_in', 'checked_out'].includes(target) && ['pending', 'confirmed', 'assigned'].includes(current.status)) {
        if (!current.roomId) return 'ROOM_ASSIGNMENT_REQUIRED_IN_PMS';
        await this.reservationService.checkIn(reservationId, propertyId, {});
      }
      if (target === 'checked_out') {
        const [now] = await this.db.select({ status: reservations.status }).from(reservations).where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
        if (now && ['checked_in', 'stayover', 'due_out'].includes(now.status)) await this.reservationService.checkOut(reservationId, propertyId, {});
      }
      return null;
    } catch (error) { return 'STATUS_NOT_APPLIED:' + target + ':' + (error as Error).message; }
  }
}
