import { BadRequestException, ConflictException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { auditLogs, charges, folios, guests, guestPropertyLinks, integrationLinks, properties, reservations, serviceBookings, serviceOperations, serviceResourceAllocations, serviceResourceBlocks, serviceResources, services } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import { TaxService } from '../tax/tax.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import type { AgentServiceAvailabilityDto, AgentServiceBookDto } from './dto/agent-service.dto';
import type { ServiceBlockDto, ServiceChangeDto, ServiceStatusDto, ServiceMutationDto, ServiceResourceDto, ServiceResourceUpdateDto, ServiceConsumptionDto, ServiceConsumptionQuoteDto } from './dto/service-operations.dto';
import { peakAllocatedUnits, stableServicePayload } from './service-capacity';
import { fitsServiceSchedule, serviceInterval, validateServiceSchedule } from './service-schedule';

const failure = (code: string, message: string) => ({ code, message });
type ServiceOperationEvent = 'service_booking.rescheduled' | 'service_booking.cancelled' | 'service_booking.completed' | 'service_resource.created' | 'service_resource.updated' | 'service_resource.blocked' | 'service_resource.unblocked';

@Injectable()
export class ConnectServiceBookingService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly folioService: FolioService,
    private readonly taxes: TaxService, private readonly outbox: DomainEventOutboxService) {}

  async options(propertyId: string) {
    return this.db.select({ id: services.id, code: services.code, name: services.name, description: services.description,
      price: services.price, currencyCode: services.currencyCode, taxMode: services.taxMode, agentBookingMode: services.agentBookingMode, durationMinutes: services.durationMinutes })
      .from(services).where(and(eq(services.propertyId, propertyId), eq(services.isActive, true))).orderBy(asc(services.sortOrder));
  }

  private async service(db: any, propertyId: string, id: string, lock = false) {
    const query = db.select().from(services).where(and(eq(services.id, id), eq(services.propertyId, propertyId)));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new NotFoundException(failure('SERVICE_NOT_FOUND', 'Услуга не найдена.'));
    return row;
  }
  private validateDuration(service: any, start: Date, end: Date) {
    if (service.durationMinutes && end.getTime() - start.getTime() !== service.durationMinutes * 60000)
      throw new BadRequestException(failure('INVALID_DURATION', 'Продолжительность не соответствует настройке услуги.'));
  }
  private async pricing(db: any, service: any, quantity: number, start: Date, guestId?: string, consumedOn?: string) {
    if (!['none','exclusive','inclusive'].includes(service.taxMode))
      throw new BadRequestException(failure('TAX_POLICY_REQUIRED', 'Укажите налоговый режим услуги перед бронированием.'));
    const [property] = await db.select({ timezone: properties.timezone }).from(properties).where(eq(properties.id, service.propertyId));
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: property?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(start).map(p => [p.type, p.value]));
    const serviceDate = consumedOn ?? parts['year'] + '-' + parts['month'] + '-' + parts['day'];
    const amount = new Decimal(service.price).times(quantity).toFixed(2);
    let baseAmount = amount; let taxLines: any[] = [];
    if (service.taxMode === 'inclusive') ({ baseAmount, taxes: taxLines } = await this.taxes.backCalculateFromInclusive(amount, service.chargeType, service.propertyId, serviceDate, { guestId }, db));
    else if (service.taxMode === 'exclusive') taxLines = await this.taxes.calculateTaxes(amount, service.chargeType, service.propertyId, serviceDate, { guestId }, db);
    const taxAmount = taxLines.reduce((sum, line) => sum.plus(line.amount), new Decimal(0)).toFixed(2);
    return { version: 1, taxMode: service.taxMode, unitPrice: service.price, quantity, baseAmount, taxAmount,
      totalAmount: new Decimal(baseAmount).plus(taxAmount).toFixed(2), currencyCode: service.currencyCode, serviceDate, taxes: taxLines };
  }
  private async resourceCapacity(db: any, propertyId: string, resource: any, start: Date, end: Date, excludeBookingId?: string) {
    const from = new Date(start.getTime() - resource.bufferBeforeMinutes * 60000);
    const to = new Date(end.getTime() + resource.bufferAfterMinutes * 60000);
    if (!fitsServiceSchedule(resource.schedule, from, to)) return { availableUnits: 0, start: from, end: to };
    const [block] = await db.select({ id: serviceResourceBlocks.id }).from(serviceResourceBlocks)
      .where(and(eq(serviceResourceBlocks.propertyId, propertyId), eq(serviceResourceBlocks.resourceId, resource.id), lt(serviceResourceBlocks.startAt, to), gt(serviceResourceBlocks.endAt, from))).limit(1);
    if (block) return { availableUnits: 0, start: from, end: to };
    const begin = sql<Date>`coalesce(${serviceResourceAllocations.startAt}, ${serviceBookings.startAt})`;
    const finish = sql<Date>`coalesce(${serviceResourceAllocations.endAt}, ${serviceBookings.endAt})`;
    const rows = await db.select({ startAt: begin, endAt: finish, units: serviceResourceAllocations.units }).from(serviceResourceAllocations)
      .innerJoin(serviceBookings, and(eq(serviceBookings.id, serviceResourceAllocations.serviceBookingId), eq(serviceBookings.propertyId, propertyId)))
      .where(and(eq(serviceResourceAllocations.propertyId, propertyId), eq(serviceResourceAllocations.resourceId, resource.id), notInArray(serviceBookings.status, ['cancelled']),
        lt(begin, to.toISOString()), gt(finish, from.toISOString()), excludeBookingId ? ne(serviceBookings.id, excludeBookingId) : undefined));
    return { availableUnits: Math.max(0, resource.capacity - peakAllocatedUnits(from, to, rows.map((r: any) => ({ ...r, startAt: new Date(r.startAt), endAt: new Date(r.endAt) })))), start: from, end: to };
  }
  private async selectResource(db: any, propertyId: string, serviceId: string, start: Date, end: Date, participants: number, resourceId?: string, excludeBookingId?: string) {
    const resources = await db.select().from(serviceResources).where(and(eq(serviceResources.propertyId, propertyId), eq(serviceResources.serviceId, serviceId), eq(serviceResources.isActive, true), resourceId ? eq(serviceResources.id, resourceId) : undefined)).orderBy(asc(serviceResources.code), asc(serviceResources.id));
    for (const resource of resources) {
      const capacity = await this.resourceCapacity(db, propertyId, resource, start, end, excludeBookingId);
      if (capacity.availableUnits >= participants) return { resource, ...capacity };
    }
    return null;
  }
  async availability(dto: AgentServiceAvailabilityDto, db: any = this.db, resourceId?: string) {
    const { start, end } = serviceInterval(dto.startAt, dto.endAt);
    const service = await this.service(db, dto.propertyId, dto.serviceId);
    if (!service.isActive || service.agentBookingMode !== 'live_booking') return { serviceId: service.id, available: false, code: 'SERVICE_NOT_LIVE_BOOKABLE', bookingMode: service.agentBookingMode };
    this.validateDuration(service, start, end);
    const selected = await this.selectResource(db, dto.propertyId, service.id, start, end, dto.participants ?? 1, resourceId);
    const guest = dto.guestId ? await this.resolveGuest(db, dto as AgentServiceBookDto) : undefined;
    const pricing = await this.pricing(db, service, dto.quantity ?? 1, start, guest?.id);
    return { serviceId: service.id, serviceCode: service.code, available: Boolean(selected), bookingMode: service.agentBookingMode,
      startAt: start.toISOString(), endAt: end.toISOString(), participants: dto.participants ?? 1,
      authoritativePrice: Number(pricing.totalAmount), currencyCode: service.currencyCode, pricing,
      ...(selected ? {} : { code: 'NO_AVAILABILITY' }) };
  }
  private async lockKey(tx: any, propertyId: string, key: string) {
    // Existing staff-booking primitive: serialize a property/operation namespace.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':service-operation:' + key}, 0))`);
  }
  private async lockServiceResources(tx: any, propertyId: string, serviceId: string) {
    const service = await this.service(tx, propertyId, serviceId, true);
    await tx.select({ id: serviceResources.id }).from(serviceResources).where(and(eq(serviceResources.propertyId, propertyId), eq(serviceResources.serviceId, serviceId))).orderBy(asc(serviceResources.id)).for('update');
    return service;
  }

  async book(dto: AgentServiceBookDto, sourceChannel = 'ai_guest_agent', resourceId?: string) {
    const { start, end } = serviceInterval(dto.startAt, dto.endAt);
    const fingerprint = stableServicePayload({ ...dto, idempotencyKey: undefined, startAt: start.toISOString(), endAt: end.toISOString(), quantity: dto.quantity ?? 1, participants: dto.participants ?? 1, resourceId });
    const { idempotencyKey: _legacyKey, ...legacy } = dto;
    const committed = await this.db.transaction(async (tx: any) => {
      await this.lockKey(tx, dto.propertyId, dto.idempotencyKey);
      const [otherOperation] = await tx.select().from(serviceOperations).where(and(eq(serviceOperations.propertyId, dto.propertyId), eq(serviceOperations.idempotencyKey, dto.idempotencyKey)));
      if (otherOperation?.fingerprint === 'service_booking.request_closed:v1') throw new ConflictException(failure('SERVICE_REQUEST_CLOSED', 'Исходный запрос закрыт без создания записи. Проверьте время и создайте новый запрос.'));
      if (otherOperation) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ запроса уже использован для другого действия.'));
      const [existing] = await tx.select().from(serviceBookings).where(and(eq(serviceBookings.propertyId, dto.propertyId), eq(serviceBookings.idempotencyKey, dto.idempotencyKey)));
      if (existing) {
        const prior = existing.integrationContext?.idempotencyFingerprint;
        let legacyMatches = false;
        try { legacyMatches = stableServicePayload(JSON.parse(prior)) === stableServicePayload(legacy); } catch { /* Missing legacy receipt is not a match. */ }
        if (prior !== fingerprint && !legacyMatches) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ запроса уже использован для других данных.'));
        return { booking: existing, replayed: true, events: [] as string[] };
      }
      if (dto.integrationContext?.sourceSystem && dto.integrationContext.customerId)
        await this.lockKey(tx, dto.propertyId, 'identity:' + dto.integrationContext.sourceSystem + ':' + dto.integrationContext.customerId);
      const service = await this.lockServiceResources(tx, dto.propertyId, dto.serviceId);
      if (!service.isActive || service.agentBookingMode !== 'live_booking') throw new BadRequestException(failure('SERVICE_NOT_LIVE_BOOKABLE', 'Услуга недоступна для автоматического бронирования.'));
      this.validateDuration(service, start, end);
      const selected = await this.selectResource(tx, dto.propertyId, service.id, start, end, dto.participants ?? 1, resourceId);
      if (!selected) throw new ConflictException(failure('RESOURCE_CONFLICT', 'Выбранное время или ресурс уже заняты.'));
      const guest = await this.resolveGuest(tx, dto);
      const pricing = await this.pricing(tx, service, dto.quantity ?? 1, start, guest.id);
      if (dto.expectedTotal != null && !new Decimal(dto.expectedTotal).eq(pricing.totalAmount)) throw new ConflictException(failure('PRICE_CHANGED', 'Стоимость изменилась. Проверьте предложение заново.'));
      const folio = await this.serviceFolio(tx, dto, guest, service, dto.notes);
      const demand = dto.participants ?? 1;
      const [booking] = await tx.insert(serviceBookings).values({ propertyId: dto.propertyId, guestId: guest.id, serviceId: service.id, reservationId: dto.reservationId, folioId: folio.id,
        startAt: start, endAt: end, participants: demand, quantity: dto.quantity ?? 1, unitPrice: service.price, totalAmount: pricing.totalAmount, currencyCode: service.currencyCode, pricingSnapshot: pricing,
        notes: dto.notes, sourceChannel, idempotencyKey: dto.idempotencyKey, integrationContext: { ...(dto.integrationContext ?? {}), idempotencyFingerprint: fingerprint } }).returning();
      await tx.insert(serviceResourceAllocations).values({ propertyId: dto.propertyId, serviceBookingId: booking.id, resourceId: selected.resource.id, units: demand, startAt: selected.start, endAt: selected.end });
      const posted = await this.folioService.postChargeFromSnapshotWithOutcome(folio.id, { propertyId: dto.propertyId, type: service.chargeType, description: service.name, amount: pricing.baseAmount,
        currencyCode: service.currencyCode, serviceDate: pricing.serviceDate }, pricing.taxAmount, undefined, 'service-booking:' + booking.id, tx);
      const events: string[] = [];
      for (const charge of [posted.charge, ...(posted.charge.taxCharges ?? [])]) {
        const eventId = randomUUID(); events.push(eventId);
        await this.outbox.persist(tx, { event: 'folio.charge_posted', entityType: 'charge', entityId: charge.id, propertyId: dto.propertyId, timestamp: new Date().toISOString(),
          data: { folioId: folio.id, type: charge.type, amount: charge.amount, description: charge.description, serviceBookingId: booking.id } }, eventId);
      }
      await this.linkCustomer(tx, dto.propertyId, guest.id, booking.id, dto.integrationContext);
      const eventId = randomUUID(); events.push(eventId);
      await this.outbox.persist(tx, { event: 'service_booking.created', entityType: 'service_booking', entityId: booking.id, propertyId: dto.propertyId, timestamp: new Date().toISOString(),
        data: { serviceBookingId: booking.id, serviceId: service.id, folioId: folio.id, reservationId: booking.reservationId, schemaVersion: 1, integrationContext: dto.integrationContext ?? {} } }, eventId);
      return { booking, replayed: false, events };
    });
    for (const id of committed.events) { try { await this.outbox.deliver(dto.propertyId, id); } catch { /* Recovery retains the committed outbox. */ } }
    const b = committed.booking;
    const service = await this.service(this.db, dto.propertyId, b.serviceId);
    return { success: true, idempotentReplay: committed.replayed, serviceBookingId: b.id, status: b.status, revision: b.revision, serviceId: b.serviceId, serviceCode: service.code, folioId: b.folioId, totalAmount: Number(b.totalAmount), currencyCode: b.currencyCode };
  }

  async get(id: string, propertyId: string, db: any = this.db) {
    const [booking] = await db.select().from(serviceBookings).where(and(eq(serviceBookings.id, id), eq(serviceBookings.propertyId, propertyId)));
    if (!booking) throw new NotFoundException(failure('SERVICE_BOOKING_NOT_FOUND', 'Бронирование услуги не найдено.'));
    const allocations = await db.select().from(serviceResourceAllocations).where(and(eq(serviceResourceAllocations.serviceBookingId, id), eq(serviceResourceAllocations.propertyId, propertyId)));
    const [folio] = booking.folioId ? await db.select({ id: folios.id, status: folios.status, balance: folios.balance, totalCharges: folios.totalCharges, totalPayments: folios.totalPayments }).from(folios).where(and(eq(folios.id, booking.folioId), eq(folios.propertyId, propertyId))) : [];
    const [base] = booking.folioId ? await db.select({ id: charges.id }).from(charges).where(and(eq(charges.propertyId, propertyId), eq(charges.folioId, booking.folioId), eq(charges.sourceKey, 'service-booking:' + id))) : [];
    const [reversed] = base ? await db.select({ id: charges.id }).from(charges).where(and(eq(charges.propertyId, propertyId), eq(charges.originalChargeId, base.id), eq(charges.isReversal, true))) : [];
    const { integrationContext, ...safe } = booking;
    const { idempotencyFingerprint: _fingerprint, ...context } = integrationContext ?? {};
    return { ...safe, integrationContext: context, allocations, folio,
      financial: { chargePosted: !!base, chargeReversed: !!reversed, settlementScope: 'folio',
        requiresFinancialReview: booking.status === 'cancelled' && !!base && (!reversed || new Decimal(folio?.balance ?? 0).lt(0)), refundStatus: 'manual_workflow' } };
  }

  async recover(propertyId: string, idempotencyKey: string) {
    if (!idempotencyKey || idempotencyKey.length > 200) throw new BadRequestException(failure('INVALID_REQUEST_KEY', 'Укажите ключ исходного запроса.'));
    const [booking] = await this.db.select({ id: serviceBookings.id }).from(serviceBookings).where(and(eq(serviceBookings.propertyId, propertyId), eq(serviceBookings.idempotencyKey, idempotencyKey)));
    if (!booking) {
      const [receipt] = await this.db.select().from(serviceOperations).where(and(eq(serviceOperations.propertyId, propertyId), eq(serviceOperations.idempotencyKey, idempotencyKey)));
      if (receipt?.fingerprint.startsWith('service_consumption:v1:')) return { ...receipt.response, folio: undefined, idempotencyKey: undefined };
      throw new NotFoundException(failure('SERVICE_BOOKING_NOT_FOUND', 'Запрос ещё не принят. Проверьте результат или закройте непринятый запрос.'));
    }
    return this.get(booking.id, propertyId);
  }

  /** Close an unaccepted attempt under the same lock as creation: a late request cannot commit afterwards. */
  async closeRequest(dto: ServiceMutationDto) {
    return this.db.transaction(async (tx: any) => {
      await this.lockKey(tx, dto.propertyId, dto.idempotencyKey);
      const [booking] = await tx.select({ id: serviceBookings.id }).from(serviceBookings).where(and(eq(serviceBookings.propertyId, dto.propertyId), eq(serviceBookings.idempotencyKey, dto.idempotencyKey)));
      if (booking) return { status: 'committed', serviceBookingId: booking.id };
      const fingerprint = 'service_booking.request_closed:v1';
      const [receipt] = await tx.select().from(serviceOperations).where(and(eq(serviceOperations.propertyId, dto.propertyId), eq(serviceOperations.idempotencyKey, dto.idempotencyKey)));
      if (receipt?.fingerprint.startsWith('service_consumption:v1:')) return { status: 'committed', kind: 'consumption', folioId: receipt.response['folioId'] };
      if (receipt && receipt.fingerprint !== fingerprint) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ запроса уже использован для другого действия.'));
      if (!receipt) await tx.insert(serviceOperations).values({ propertyId: dto.propertyId, idempotencyKey: dto.idempotencyKey, fingerprint, response: { status: 'closed' } });
      return { status: 'closed' };
    });
  }

  async publicDetail(id: string, propertyId: string) {
    const b = await this.get(id, propertyId);
    return { serviceBookingId: b.id, serviceId: b.serviceId, guestId: b.guestId, reservationId: b.reservationId, status: b.status, revision: b.revision,
      startAt: b.startAt, endAt: b.endAt, participants: b.participants, quantity: b.quantity, totalAmount: b.totalAmount, currencyCode: b.currencyCode, folioId: b.folioId };
  }

  private async consumptionDate(tx: any, dto: ServiceConsumptionQuoteDto) {
    const date = new Date(dto.serviceDate + 'T12:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== dto.serviceDate) throw new BadRequestException(failure('INVALID_SERVICE_DATE', 'Укажите существующую дату оказания услуги.'));
    const [property] = await tx.select({ timezone: properties.timezone }).from(properties).where(eq(properties.id, dto.propertyId));
    if (!property) throw new NotFoundException(failure('PROPERTY_NOT_FOUND', 'Объект не найден.'));
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: property.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type,p.value]));
    if (dto.serviceDate > parts['year'] + '-' + parts['month'] + '-' + parts['day']) throw new BadRequestException(failure('SERVICE_NOT_PROVIDED', 'Будущую услугу нельзя отметить оказанной.'));
  }

  private async serviceFolio(tx: any, dto: { propertyId: string; reservationId?: string }, guest: any, service: any, notes?: string) {
    let folio: any;
    if (dto.reservationId) {
      const [stay] = await tx.select({ id: reservations.id, status: reservations.status }).from(reservations).where(and(eq(reservations.id, dto.reservationId), eq(reservations.propertyId, dto.propertyId), eq(reservations.guestId, guest.id))).for('update');
      if (!stay || !['confirmed','assigned','checked_in','stayover','due_out'].includes(stay.status)) throw new BadRequestException(failure('INVALID_STATE', 'Проживание недоступно для добавления услуги.'));
      [folio] = await tx.select().from(folios).where(and(eq(folios.propertyId, dto.propertyId), eq(folios.reservationId, dto.reservationId), eq(folios.guestId, guest.id), eq(folios.status, 'open'))).orderBy(asc(folios.createdAt)).for('update');
    }
    if (folio && folio.currencyCode !== service.currencyCode) throw new BadRequestException(failure('CURRENCY_MISMATCH', 'Валюты услуги и фолио отличаются.'));
    return folio ?? this.folioService.create({ propertyId: dto.propertyId, guestId: guest.id, reservationId: dto.reservationId, type: 'guest', currencyCode: service.currencyCode,
      notes: notes ?? (dto.reservationId ? 'Услуги проживания' : 'Услуги без проживания') }, tx);
  }

  private validateConsumption(service: any) {
    if (!service.isActive) throw new BadRequestException(failure('SERVICE_INACTIVE', 'Услуга выключена.'));
    if (service.postingRule !== 'on_consumption') throw new BadRequestException(failure('SERVICE_POSTING_WORKFLOW_REQUIRED', 'Для этой услуги используйте существующий пакетный или начисляемый по проживанию процесс.'));
  }

  async quoteConsumption(dto: ServiceConsumptionQuoteDto) {
    return this.db.transaction(async (tx: any) => {
      await this.consumptionDate(tx, dto);
      const service = await this.service(tx, dto.propertyId, dto.serviceId);
      this.validateConsumption(service);
      const guest = dto.guestId ? await this.resolveGuest(tx, dto as unknown as AgentServiceBookDto) : undefined;
      const pricing = await this.pricing(tx, service, dto.quantity ?? 1, new Date(), guest?.id, dto.serviceDate);
      return { pricing, currencyCode: service.currencyCode };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  /** Actual consumption has a folio charge and a durable receipt, never a fictitious timed booking/allocation. */
  async recordConsumption(dto: ServiceConsumptionDto) {
    const fingerprint = 'service_consumption:v1:' + stableServicePayload({ ...dto, idempotencyKey: undefined, quantity: dto.quantity ?? 1 });
    const result = await this.db.transaction(async (tx: any) => {
      await this.lockKey(tx, dto.propertyId, dto.idempotencyKey);
      const [booking] = await tx.select({ id: serviceBookings.id }).from(serviceBookings).where(and(eq(serviceBookings.propertyId, dto.propertyId), eq(serviceBookings.idempotencyKey, dto.idempotencyKey)));
      if (booking) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ уже использован для записи на услугу.'));
      const [receipt] = await tx.select().from(serviceOperations).where(and(eq(serviceOperations.propertyId, dto.propertyId), eq(serviceOperations.idempotencyKey, dto.idempotencyKey)));
      if (receipt) {
        if (receipt.fingerprint === 'service_booking.request_closed:v1') throw new ConflictException(failure('SERVICE_REQUEST_CLOSED', 'Исходный запрос закрыт. Проверьте стоимость и создайте новый запрос.'));
        if (receipt.fingerprint !== fingerprint) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ уже использован для другого действия.'));
        return { response: { ...receipt.response, idempotentReplay: true }, events: [] as string[] };
      }
      await this.consumptionDate(tx, dto);
      if (dto.provided !== true) throw new BadRequestException(failure('SERVICE_NOT_PROVIDED', 'Подтвердите фактическое оказание услуги.'));
      const service = await this.service(tx, dto.propertyId, dto.serviceId, true);
      this.validateConsumption(service);
      const guest = await this.resolveGuest(tx, dto as unknown as AgentServiceBookDto);
      const pricing = await this.pricing(tx, service, dto.quantity ?? 1, new Date(), guest.id, dto.serviceDate);
      if (!new Decimal(dto.expectedTotal).eq(pricing.totalAmount)) throw new ConflictException(failure('PRICE_CHANGED', 'Стоимость изменилась. Проверьте предложение заново.'));
      const folio = await this.serviceFolio(tx, dto, guest, service, dto.notes);
      const outcome = await this.folioService.postChargeFromSnapshotWithOutcome(folio.id, { propertyId: dto.propertyId, type: service.chargeType, description: service.name, amount: pricing.baseAmount,
        currencyCode: service.currencyCode, serviceDate: dto.serviceDate }, pricing.taxAmount, undefined, 'service-consumption:' + dto.idempotencyKey, tx);
      const response = { kind: 'consumption', status: 'posted', folioId: folio.id, chargeId: outcome.charge.id, guestId: guest.id, reservationId: dto.reservationId ?? null, serviceId: service.id,
        totalAmount: pricing.totalAmount, currencyCode: service.currencyCode, pricingSnapshot: pricing, paymentStatus: 'not_confirmed', idempotentReplay: false };
      await tx.insert(serviceOperations).values({ propertyId: dto.propertyId, idempotencyKey: dto.idempotencyKey, fingerprint, response });
      const events: string[] = [];
      for (const charge of [outcome.charge, ...(outcome.charge.taxCharges ?? [])]) {
        const eventId = randomUUID(); events.push(eventId);
        await this.outbox.persist(tx, { event: 'folio.charge_posted', entityType: 'charge', entityId: charge.id, propertyId: dto.propertyId, timestamp: new Date().toISOString(),
          data: { folioId: folio.id, guestId: guest.id, serviceId: service.id, type: charge.type, amount: charge.amount, schemaVersion: 1 } }, eventId);
      }
      return { response, events };
    });
    for (const id of result.events) { try { await this.outbox.deliver(dto.propertyId, id); } catch { /* Existing outbox retains delivery for retry. */ } }
    return result.response;
  }

  async forReservation(propertyId: string, reservationId: string) {
    const [stay] = await this.db.select({ id: reservations.id }).from(reservations).where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!stay) throw new NotFoundException(failure('RESERVATION_NOT_FOUND', 'Проживание не найдено в этом объекте.'));
    const rows = await this.db.select({ booking: serviceBookings, name: services.name }).from(serviceBookings)
      .innerJoin(services, and(eq(services.id, serviceBookings.serviceId), eq(services.propertyId, propertyId)))
      .where(and(eq(serviceBookings.propertyId, propertyId), eq(serviceBookings.reservationId, reservationId))).orderBy(asc(serviceBookings.startAt));
    return rows.map((r: any) => { const { integrationContext: _context, idempotencyKey: _key, ...booking } = r.booking; return { ...booking, name: r.name }; });
  }

  async previewChange(id: string, dto: ServiceChangeDto) {
    return this.db.transaction(async (tx: any) => {
      const current = await this.get(id, dto.propertyId, tx);
      if (current.revision !== dto.expectedRevision || current.status !== 'scheduled') throw new ConflictException(failure('STALE_REVISION', 'Обновите карточку перед переносом.'));
      const { start, end } = serviceInterval(dto.startAt ?? current.startAt.toISOString(), dto.endAt ?? current.endAt.toISOString());
      if (end.getTime() - start.getTime() !== current.endAt.getTime() - current.startAt.getTime()) throw new BadRequestException(failure('DURATION_CHANGE_REQUIRES_NEW_QUOTE', 'При переносе сохраняется принятая продолжительность услуги.'));
      const selected = await this.selectResource(tx, dto.propertyId, current.serviceId, start, end, dto.participants ?? current.participants, dto.resourceId ?? current.allocations[0]?.resourceId, id);
      return { available: !!selected, startAt: start.toISOString(), endAt: end.toISOString(), totalAmount: current.totalAmount, currencyCode: current.currencyCode, revision: current.revision };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  async calendar(propertyId: string, startAt: string, endAt: string) {
    // Seven hotel dates can exceed 168 hours during a daylight saving change.
    const { start, end } = serviceInterval(startAt, endAt, 8);
    return this.db.transaction(async (tx: any) => {
      const resources = await tx.select().from(serviceResources).where(eq(serviceResources.propertyId, propertyId)).orderBy(asc(serviceResources.serviceId), asc(serviceResources.code));
      const catalog = await tx.select().from(services).where(eq(services.propertyId, propertyId)).orderBy(asc(services.sortOrder));
      const booked = await tx.select({ booking: serviceBookings, guestFirstName: guests.firstName, guestLastName: guests.lastName }).from(serviceBookings).leftJoin(guests, eq(guests.id, serviceBookings.guestId))
        .where(and(eq(serviceBookings.propertyId, propertyId), lt(serviceBookings.startAt, end), gt(serviceBookings.endAt, start))).orderBy(asc(serviceBookings.startAt));
      const ids = booked.map((r: any) => r.booking.id);
      const allocations = ids.length ? await tx.select().from(serviceResourceAllocations).where(and(eq(serviceResourceAllocations.propertyId, propertyId), inArray(serviceResourceAllocations.serviceBookingId, ids))) : [];
      const blocks = await tx.select().from(serviceResourceBlocks).where(and(eq(serviceResourceBlocks.propertyId, propertyId), lt(serviceResourceBlocks.startAt, end), gt(serviceResourceBlocks.endAt, start)));
      return { complete: true, startAt: start.toISOString(), endAt: end.toISOString(), services: catalog, resources, allocations, blocks,
        bookings: booked.map((r: any) => { const { integrationContext: _private, idempotencyKey: _privateKey, ...booking } = r.booking; return { ...booking, guestName: [r.guestFirstName, r.guestLastName].filter(Boolean).join(' ') }; }) };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  async resourceSlots(id: string, propertyId: string, startAt: string, endAt: string) {
    const { start, end } = serviceInterval(startAt, endAt, 2);
    if (end.getTime() - start.getTime() > 25 * 3600000) throw new BadRequestException(failure('INVALID_INTERVAL', 'Выберите один день для просмотра интервалов.'));
    return this.db.transaction(async (tx: any) => {
      const [resource] = await tx.select().from(serviceResources).where(and(eq(serviceResources.id, id), eq(serviceResources.propertyId, propertyId)));
      if (!resource) throw new NotFoundException(failure('RESOURCE_NOT_FOUND', 'Ресурс не найден.'));
      const service = await this.service(tx, propertyId, resource.serviceId);
      if (!service.durationMinutes) throw new BadRequestException(failure('INVALID_DURATION', 'Настройте продолжительность услуги.'));
      const from = new Date(start.getTime() - resource.bufferBeforeMinutes * 60000);
      const to = new Date(end.getTime() + resource.bufferAfterMinutes * 60000);
      const begin = sql<Date>`coalesce(${serviceResourceAllocations.startAt}, ${serviceBookings.startAt})`;
      const finish = sql<Date>`coalesce(${serviceResourceAllocations.endAt}, ${serviceBookings.endAt})`;
      const rows = await tx.select({ startAt: begin, endAt: finish, units: serviceResourceAllocations.units }).from(serviceResourceAllocations)
        .innerJoin(serviceBookings, and(eq(serviceBookings.id, serviceResourceAllocations.serviceBookingId), eq(serviceBookings.propertyId, propertyId)))
        .where(and(eq(serviceResourceAllocations.propertyId, propertyId), eq(serviceResourceAllocations.resourceId, id), notInArray(serviceBookings.status, ['cancelled']), lt(begin, to.toISOString()), gt(finish, from.toISOString())));
      const occupied = rows.map((r: any) => ({ ...r, startAt: new Date(r.startAt), endAt: new Date(r.endAt) }));
      const blocks = await tx.select().from(serviceResourceBlocks).where(and(eq(serviceResourceBlocks.propertyId, propertyId), eq(serviceResourceBlocks.resourceId, id), lt(serviceResourceBlocks.startAt, to), gt(serviceResourceBlocks.endAt, from)));
      const slots = [];
      for (let at = start.getTime(); at + service.durationMinutes * 60000 <= end.getTime(); at += 30 * 60000) {
        const slotEnd = at + service.durationMinutes * 60000;
        const bufferedStart = new Date(at - resource.bufferBeforeMinutes * 60000); const bufferedEnd = new Date(slotEnd + resource.bufferAfterMinutes * 60000);
        const blocked = blocks.some((b: any) => b.startAt < bufferedEnd && b.endAt > bufferedStart);
        const inWorkingHours = resource.isActive && service.isActive && service.agentBookingMode === 'live_booking' && fitsServiceSchedule(resource.schedule, bufferedStart, bufferedEnd);
        slots.push({ startAt: new Date(at).toISOString(), endAt: new Date(slotEnd).toISOString(), inWorkingHours, availableUnits: inWorkingHours && !blocked ? Math.max(0, resource.capacity - peakAllocatedUnits(bufferedStart, bufferedEnd, occupied)) : 0 });
      }
      return { resourceId: id, capacity: resource.capacity, durationMinutes: service.durationMinutes, checkedAt: new Date().toISOString(), slots };
    }, { isolationLevel: 'repeatable read', readOnly: true });
  }

  private async mutation(dto: ServiceMutationDto, operation: ServiceOperationEvent, entityId: string, work: (tx: any) => Promise<Record<string, any>>) {
    const fingerprint = stableServicePayload({ operation, entityId, ...dto, idempotencyKey: undefined });
    const result = await this.db.transaction(async (tx: any) => {
      await this.lockKey(tx, dto.propertyId, dto.idempotencyKey);
      const [createdBooking] = await tx.select({ id: serviceBookings.id }).from(serviceBookings).where(and(eq(serviceBookings.propertyId, dto.propertyId), eq(serviceBookings.idempotencyKey, dto.idempotencyKey)));
      if (createdBooking) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ запроса уже использован для создания бронирования.'));
      const [receipt] = await tx.select().from(serviceOperations).where(and(eq(serviceOperations.propertyId, dto.propertyId), eq(serviceOperations.idempotencyKey, dto.idempotencyKey)));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new ConflictException(failure('IDEMPOTENCY_CONFLICT', 'Ключ запроса уже использован для другого действия.'));
        return { response: { ...receipt.response, idempotentReplay: true }, eventId: undefined };
      }
      const response = JSON.parse(JSON.stringify(await work(tx))) as Record<string, any>;
      const eventId = randomUUID();
      const eventData = operation.startsWith('service_resource.') ? { id: response['id'], schemaVersion: 1 } : { ...response, schemaVersion: 1 };
      await this.outbox.persist(tx, { event: operation, entityType: operation.startsWith('service_booking.') ? 'service_booking' : 'service_resource', entityId: response['id'] ?? entityId, propertyId: dto.propertyId,
        timestamp: new Date().toISOString(), data: eventData }, eventId);
      await tx.insert(serviceOperations).values({ propertyId: dto.propertyId, idempotencyKey: dto.idempotencyKey, fingerprint, response });
      return { response, eventId };
    });
    if (result.eventId) { try { await this.outbox.deliver(dto.propertyId, result.eventId); } catch { /* Existing recovery handles dispatch failure. */ } }
    return result.response;
  }

  async change(id: string, dto: ServiceChangeDto) {
    return this.mutation(dto, 'service_booking.rescheduled', id, async tx => {
      const current = await this.get(id, dto.propertyId, tx);
      await this.lockServiceResources(tx, dto.propertyId, current.serviceId);
      const [booking] = await tx.select().from(serviceBookings).where(and(eq(serviceBookings.id, id), eq(serviceBookings.propertyId, dto.propertyId))).for('update');
      if (booking.status !== 'scheduled') throw new ConflictException(failure('INVALID_STATE', 'Изменить можно только запланированную услугу.'));
      if (booking.revision !== dto.expectedRevision) throw new ConflictException(failure('STALE_REVISION', 'Бронирование изменилось. Обновите карточку.'));
      const { start, end } = serviceInterval(dto.startAt ?? booking.startAt.toISOString(), dto.endAt ?? booking.endAt.toISOString());
      if (end.getTime() - start.getTime() !== booking.endAt.getTime() - booking.startAt.getTime()) throw new BadRequestException(failure('DURATION_CHANGE_REQUIRES_NEW_QUOTE', 'При переносе сохраняется принятая продолжительность услуги.'));
      const participants = dto.participants ?? booking.participants;
      const resourceId = dto.resourceId ?? current.allocations[0]?.resourceId;
      const selected = await this.selectResource(tx, dto.propertyId, booking.serviceId, start, end, participants, resourceId, id);
      if (!selected) throw new ConflictException(failure('RESOURCE_CONFLICT', 'Выбранное время или ресурс уже заняты.'));
      const [next] = await tx.update(serviceBookings).set({ startAt: start, endAt: end, participants, revision: booking.revision + 1, updatedAt: new Date() }).where(and(eq(serviceBookings.id, id), eq(serviceBookings.propertyId, dto.propertyId))).returning();
      await tx.delete(serviceResourceAllocations).where(and(eq(serviceResourceAllocations.serviceBookingId, id), eq(serviceResourceAllocations.propertyId, dto.propertyId)));
      await tx.insert(serviceResourceAllocations).values({ propertyId: dto.propertyId, serviceBookingId: id, resourceId: selected.resource.id, units: participants, startAt: selected.start, endAt: selected.end });
      return { id: next.id, status: next.status, revision: next.revision, startAt: next.startAt.toISOString(), endAt: next.endAt.toISOString(), participants, totalAmount: next.totalAmount, currencyCode: next.currencyCode };
    });
  }

  async transition(id: string, dto: ServiceStatusDto, status: 'cancelled' | 'completed') {
    return this.mutation(dto, status === 'cancelled' ? 'service_booking.cancelled' : 'service_booking.completed', id, async tx => {
      const current = await this.get(id, dto.propertyId, tx);
      await this.lockServiceResources(tx, dto.propertyId, current.serviceId);
      const [booking] = await tx.select().from(serviceBookings).where(and(eq(serviceBookings.id, id), eq(serviceBookings.propertyId, dto.propertyId))).for('update');
      if (booking.revision !== dto.expectedRevision) throw new ConflictException(failure('STALE_REVISION', 'Бронирование изменилось. Обновите карточку.'));
      if (booking.status !== 'scheduled') throw new ConflictException(failure('INVALID_STATE', 'Услуга уже завершена или отменена.'));
      if (status === 'completed' && booking.startAt > new Date()) throw new BadRequestException(failure('SERVICE_NOT_STARTED', 'Время услуги ещё не наступило.'));
      await tx.update(serviceBookings).set({ status, revision: booking.revision + 1, updatedAt: new Date() }).where(and(eq(serviceBookings.id, id), eq(serviceBookings.propertyId, dto.propertyId)));
      const detail = await this.get(id, dto.propertyId, tx);
      // Cancellation frees capacity; existing manual workflows handle reversals/refunds.
      return { id, status, revision: detail.revision, folioId: detail.folioId, financial: detail.financial };
    });
  }

  async createResource(dto: ServiceResourceDto) {
    const schedule = validateServiceSchedule(dto.schedule);
    return this.mutation(dto, 'service_resource.created', dto.serviceId, async tx => {
      await this.lockServiceResources(tx, dto.propertyId, dto.serviceId);
      const [duplicate] = await tx.select({ id: serviceResources.id }).from(serviceResources).where(and(eq(serviceResources.propertyId, dto.propertyId), eq(serviceResources.serviceId, dto.serviceId), eq(serviceResources.code, dto.code)));
      if (duplicate) throw new ConflictException(failure('RESOURCE_CODE_EXISTS', 'Ресурс с таким кодом уже существует.'));
      const [row] = await tx.insert(serviceResources).values({ propertyId: dto.propertyId, serviceId: dto.serviceId, code: dto.code, name: dto.name, capacity: dto.capacity,
        bufferBeforeMinutes: dto.bufferBeforeMinutes ?? 0, bufferAfterMinutes: dto.bufferAfterMinutes ?? 0, schedule, isActive: dto.isActive ?? true }).returning();
      return row;
    });
  }

  async updateResource(id: string, dto: ServiceResourceUpdateDto) {
    const schedule = validateServiceSchedule(dto.schedule);
    return this.mutation(dto, 'service_resource.updated', id, async tx => {
      await this.lockServiceResources(tx, dto.propertyId, dto.serviceId);
      const [current] = await tx.select().from(serviceResources).where(and(eq(serviceResources.propertyId, dto.propertyId), eq(serviceResources.id, id), eq(serviceResources.serviceId, dto.serviceId)));
      if (!current) throw new NotFoundException(failure('RESOURCE_NOT_FOUND', 'Ресурс не найден.'));
      if (current.updatedAt.getTime() !== Date.parse(dto.expectedUpdatedAt)) throw new ConflictException(failure('STALE_REVISION', 'Ресурс изменился. Обновите настройки.'));
      const [duplicate] = await tx.select({ id: serviceResources.id }).from(serviceResources).where(and(eq(serviceResources.propertyId, dto.propertyId), eq(serviceResources.serviceId, dto.serviceId), eq(serviceResources.code, dto.code), ne(serviceResources.id, id)));
      if (duplicate) throw new ConflictException(failure('RESOURCE_CODE_EXISTS', 'Ресурс с таким кодом уже существует.'));
      const begin = sql<Date>`coalesce(${serviceResourceAllocations.startAt}, ${serviceBookings.startAt})`;
      const finish = sql<Date>`coalesce(${serviceResourceAllocations.endAt}, ${serviceBookings.endAt})`;
      const rows = await tx.select({ startAt: begin, endAt: finish, units: serviceResourceAllocations.units }).from(serviceResourceAllocations)
        .innerJoin(serviceBookings, and(eq(serviceBookings.id, serviceResourceAllocations.serviceBookingId), eq(serviceBookings.propertyId, dto.propertyId)))
        .where(and(eq(serviceResourceAllocations.propertyId, dto.propertyId), eq(serviceResourceAllocations.resourceId, id), eq(serviceBookings.status, 'scheduled'), gt(finish, new Date().toISOString())));
      const intervals = rows.map((r: any) => ({ ...r, startAt: new Date(r.startAt), endAt: new Date(r.endAt) }));
      if (intervals.length) {
        const start = new Date(intervals.reduce((value: number, r: any) => Math.min(value, r.startAt.getTime()), Infinity));
        const end = new Date(intervals.reduce((value: number, r: any) => Math.max(value, r.endAt.getTime()), -Infinity));
        if (dto.isActive === false || peakAllocatedUnits(start, end, intervals) > dto.capacity || intervals.some((r: any) => !fitsServiceSchedule(schedule, r.startAt, r.endAt)))
          throw new ConflictException(failure('RESOURCE_HAS_BOOKINGS', 'Настройки нарушают принятые записи. Сначала перенесите их на другой ресурс.'));
      }
      // Buffers are frozen on each accepted allocation; edited buffers apply only to new scheduling decisions.
      const [row] = await tx.update(serviceResources).set({ code: dto.code, name: dto.name, capacity: dto.capacity, schedule,
        bufferBeforeMinutes: dto.bufferBeforeMinutes ?? 0, bufferAfterMinutes: dto.bufferAfterMinutes ?? 0, isActive: dto.isActive ?? current.isActive,
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)) }).where(and(eq(serviceResources.id, id), eq(serviceResources.propertyId, dto.propertyId))).returning();
      return row;
    });
  }

  async createBlock(dto: ServiceBlockDto) {
    const { start, end } = serviceInterval(dto.startAt, dto.endAt);
    return this.mutation(dto, 'service_resource.blocked', dto.resourceId, async tx => {
      const [resource] = await tx.select().from(serviceResources).where(and(eq(serviceResources.id, dto.resourceId), eq(serviceResources.propertyId, dto.propertyId)));
      if (!resource) throw new NotFoundException(failure('RESOURCE_NOT_FOUND', 'Ресурс не найден.'));
      await this.lockServiceResources(tx, dto.propertyId, resource.serviceId);
      const used = await this.resourceCapacity(tx, dto.propertyId, resource, start, end);
      if (used.availableUnits !== resource.capacity) throw new ConflictException(failure('RESOURCE_CONFLICT', 'Интервал занят или находится вне рабочего расписания.'));
      const [row] = await tx.insert(serviceResourceBlocks).values({ propertyId: dto.propertyId, resourceId: resource.id, startAt: start, endAt: end, reason: dto.reason }).returning();
      return row;
    });
  }

  async removeBlock(id: string, dto: ServiceMutationDto) {
    return this.mutation(dto, 'service_resource.unblocked', id, async tx => {
      const [block] = await tx.select().from(serviceResourceBlocks).where(and(eq(serviceResourceBlocks.id, id), eq(serviceResourceBlocks.propertyId, dto.propertyId)));
      if (!block) throw new NotFoundException(failure('RESOURCE_BLOCK_NOT_FOUND', 'Блокировка не найдена.'));
      const [resource] = await tx.select().from(serviceResources).where(and(eq(serviceResources.id, block.resourceId), eq(serviceResources.propertyId, dto.propertyId)));
      if (!resource) throw new NotFoundException(failure('RESOURCE_NOT_FOUND', 'Ресурс не найден.'));
      await this.lockServiceResources(tx, dto.propertyId, resource.serviceId);
      await tx.delete(serviceResourceBlocks).where(and(eq(serviceResourceBlocks.id, id), eq(serviceResourceBlocks.propertyId, dto.propertyId)));
      return { id, resourceId: resource.id, removed: true };
    });
  }

  async history(id: string, propertyId: string) {
    await this.get(id, propertyId);
    return this.db.select({ id: auditLogs.id, action: auditLogs.action, occurredAt: auditLogs.occurredAt, description: auditLogs.description }).from(auditLogs)
      .where(and(eq(auditLogs.propertyId, propertyId), eq(auditLogs.entityType, 'service_booking'), eq(auditLogs.entityId, id))).orderBy(desc(auditLogs.occurredAt)).limit(100);
  }

  private async resolveGuest(tx: any, dto: AgentServiceBookDto) {
    if (dto.guestId) {
      const [guest] = await tx.select().from(guests).where(and(eq(guests.id, dto.guestId), eq(guests.isDeleted, false), isNull(guests.mergedIntoGuestId)));
      const [link] = await tx.select().from(guestPropertyLinks).where(and(eq(guestPropertyLinks.guestId, dto.guestId), eq(guestPropertyLinks.propertyId, dto.propertyId)));
      const [stay] = !link ? await tx.select({ id: reservations.id }).from(reservations).where(and(eq(reservations.guestId, dto.guestId), eq(reservations.propertyId, dto.propertyId))).limit(1) : [];
      const [serviceStay] = !link && !stay ? await tx.select({ id: serviceBookings.id }).from(serviceBookings).where(and(eq(serviceBookings.guestId, dto.guestId), eq(serviceBookings.propertyId, dto.propertyId))).limit(1) : [];
      if (!guest || (!link && !stay && !serviceStay)) throw new NotFoundException(failure('GUEST_NOT_FOUND', 'Гость не найден в этом объекте.'));
      return guest;
    }
    const context = dto.integrationContext;
    if (context?.sourceSystem && context.customerId) {
      const [identity] = await tx.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, dto.propertyId), eq(integrationLinks.sourceSystem, context.sourceSystem), eq(integrationLinks.externalEntityType, 'customer'), eq(integrationLinks.externalEntityId, context.customerId)));
      if (identity?.localEntityType === 'guest') {
        const [guest] = await tx.select().from(guests).where(and(eq(guests.id, identity.localEntityId), eq(guests.isDeleted, false), isNull(guests.mergedIntoGuestId)));
        if (guest) return guest;
        throw new NotFoundException(failure('GUEST_NOT_FOUND', 'Связанный гость недоступен.'));
      }
    }
    if (!dto.guestFirstName?.trim()) throw new BadRequestException(failure('GUEST_NOT_FOUND', 'Укажите гостя или его имя.'));
    const [guest] = await tx.insert(guests).values({ firstName: dto.guestFirstName, lastName: dto.guestLastName || 'Не указана', email: dto.guestEmail, phone: dto.guestPhone }).returning();
    await tx.insert(guestPropertyLinks).values({ guestId: guest.id, propertyId: dto.propertyId, source: context?.sourceSystem ?? 'connect' });
    return guest;
  }

  private async linkCustomer(tx: any, propertyId: string, guestId: string, bookingId: string, context?: AgentServiceBookDto['integrationContext']) {
    if (!context?.sourceSystem || !context.customerId) return;
    const [existing] = await tx.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId), eq(integrationLinks.sourceSystem, context.sourceSystem), eq(integrationLinks.externalEntityType, 'customer'), eq(integrationLinks.externalEntityId, context.customerId)));
    if (existing && (existing.localEntityType !== 'guest' || existing.localEntityId !== guestId)) throw new ConflictException(failure('IDENTITY_CONFLICT', 'Внешний клиент уже связан с другим гостем.'));
    if (!existing) await tx.insert(integrationLinks).values({ propertyId, sourceSystem: context.sourceSystem, externalEntityType: 'customer', externalEntityId: context.customerId, localEntityType: 'guest', localEntityId: guestId });
    if (context.reservationId) await tx.insert(integrationLinks).values({ propertyId, sourceSystem: context.sourceSystem, externalEntityType: 'service_reservation', externalEntityId: context.reservationId, localEntityType: 'service_booking', localEntityId: bookingId });
  }

}
