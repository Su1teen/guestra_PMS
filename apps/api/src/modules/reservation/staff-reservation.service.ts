import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { actorFields, type AuditActor } from '@telivityhaip/shared';
import { AddBookingRoomDto } from './dto/add-booking-room.dto';
import { and, eq, sql, or, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { bookings, reservations, roomTypes, guests, guestPropertyLinks, groupProfiles, properties, reservationGuests, serviceBookings,
  staffRequestFences, auditLogs } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { ReservationService } from './reservation.service';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { calculateCanonicalRoomPricing } from '../rate-plan/canonical-room-pricing';
import { bedOccupants, type ChildAgeBand } from '../rate-plan/child-pricing';
import { stayDates } from './availability.service';
import { StaffCreateReservationDto } from './dto/staff-create-reservation.dto';
import type { BookingConfirmationOptionsDto } from './dto/booking-confirmation-options.dto';
import type { CreateGroupBookingDto } from './dto/create-group-booking.dto';
import { resolveParty } from './dto/child-ages';
import { acceptedSnapshotFromQuote } from './pricing-snapshot';
import { ReservationGuaranteeService } from './reservation-guarantee.service';
import { ReservationConfirmationService } from './reservation-confirmation.service';

export function staffRequestFingerprint(dto: StaffCreateReservationDto) {
  const party = [dto.propertyId, dto.guestId, dto.roomTypeId, dto.ratePlanId,
    dto.checkIn, dto.checkOut, dto.roomId ?? null, dto.adults ?? 1, dto.children ?? 0,
    dto.specialRequests?.trim() ?? '', new Decimal(dto.expectedTotal).toFixed(2), dto.currencyCode];
  // New fields join the fingerprint only when used, so retries of older clients keep their fingerprint.
  const extras = [dto.childAges?.length ? dto.childAges : null, dto.confirmation ?? null, dto.guaranteeType ?? null,
    dto.optionUntil ?? null, dto.requiredDeposit ?? null];
  return createHash('sha256').update(JSON.stringify(extras.some((v) => v !== null) ? [...party, ...extras] : party)).digest('hex');
}

function groupFingerprint(dto: CreateGroupBookingDto) {
  return createHash('sha256').update(JSON.stringify([dto.propertyId, dto.guestId, dto.groupName.trim(), dto.groupProfileId ?? null,
    dto.checkIn, dto.checkOut, dto.rooms.map((r) => [r.roomTypeId, r.ratePlanId, r.quantity, r.adults ?? 1, r.children ?? 0,
      r.childAges ?? null, r.roomIds ?? null]), new Decimal(dto.expectedTotal).toFixed(2), dto.currencyCode,
    dto.confirmation ?? null, dto.guaranteeType ?? null, dto.optionUntil ?? null, dto.requiredDeposit ?? null,
    dto.specialRequests?.trim() ?? ''])).digest('hex');
}

/** Splits an amount across parts proportionally to their weights; the last part absorbs rounding. */
export function splitProportionally(amount: string, weights: string[]): string[] {
  const total = weights.reduce((sum, w) => sum.plus(w), new Decimal(0));
  if (total.isZero()) return weights.map((_, i) => (i === weights.length - 1 ? new Decimal(amount).toFixed(2) : '0.00'));
  let allocated = new Decimal(0);
  return weights.map((w, i) => {
    if (i === weights.length - 1) return new Decimal(amount).minus(allocated).toFixed(2);
    const part = new Decimal(amount).times(w).dividedBy(total).toDecimalPlaces(2, Decimal.ROUND_DOWN);
    allocated = allocated.plus(part);
    return part.toFixed(2);
  });
}

@Injectable()
export class StaffReservationService {
  private readonly logger = new Logger(StaffReservationService.name);

  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly reservationsService: ReservationService,
    private readonly rates: RatePlanService, private readonly taxes: TaxService, private readonly outbox: DomainEventOutboxService,
    private readonly guarantee: ReservationGuaranteeService, private readonly confirmation: ReservationConfirmationService) {}

  /** Recover a committed staff request without repricing or creating another stay. */
  async result(propertyId: string, requestId: string, closeUncommitted = false) {
    return this.db.transaction(async (tx: any) => {
      const key = 'staff:' + requestId;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':' + key}, 0))`);
      const [row] = await tx.select({ id: reservations.id, status: reservations.status }).from(bookings)
        .innerJoin(reservations, and(eq(reservations.bookingId, bookings.id), eq(reservations.propertyId, propertyId)))
        .where(and(eq(bookings.propertyId, propertyId), eq(bookings.idempotencyKey, key)));
      if (row) return { state: 'committed' as const, reservationId: row.id, status: row.status };
      const [fence] = await tx.select().from(staffRequestFences)
        .where(and(eq(staffRequestFences.propertyId, propertyId), eq(staffRequestFences.requestId, requestId)));
      if (fence) return { state: 'closed' as const };
      if (!closeUncommitted) return { state: 'unconfirmed' as const };
      // The same lock as create fences a POST that has not yet reached the server.
      // A committed stay is returned above and is never cancelled by recovery.
      await tx.insert(staffRequestFences).values({ propertyId, requestId });
      await tx.insert(auditLogs).values({ propertyId, entityType: 'staff_request', entityId: requestId,
        action: 'close', description: 'Закрыта неподтверждённая попытка создания брони' });
      return { state: 'closed' as const };
    });
  }

  /** The guest must already be known at this property (reservation, party, service booking or explicit link). */
  private async assertGuestAtProperty(tx: any, guestId: string, propertyId: string) {
    const [guest] = await tx.select({ id: guests.id }).from(guests).where(and(eq(guests.id, guestId), eq(guests.isDeleted, false), isNull(guests.mergedIntoGuestId),
      or(inArray(guests.id, tx.select({ guestId: reservations.guestId }).from(reservations).where(eq(reservations.propertyId, propertyId))),
        inArray(guests.id, tx.select({ guestId: reservationGuests.guestId }).from(reservationGuests).where(eq(reservationGuests.propertyId, propertyId))),
        inArray(guests.id, tx.select({ guestId: serviceBookings.guestId }).from(serviceBookings).where(eq(serviceBookings.propertyId, propertyId))),
        inArray(guests.id, tx.select({ guestId: guestPropertyLinks.guestId }).from(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId, propertyId))))));
    if (!guest) throw new BadRequestException('Guest not found in this property');
  }

  private async assertCapacity(tx: any, propertyId: string, roomTypeId: string, party: ReturnType<typeof resolveParty>, bands: ChildAgeBand[]) {
    const [type] = await tx.select().from(roomTypes).where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, propertyId)));
    if (!type?.isActive || bedOccupants(party.adults, party.children, party.childAges, bands) > type.maxOccupancy) {
      throw new BadRequestException('Selected room type cannot accommodate this party');
    }
    return type;
  }

  private async bandsFor(tx: any, propertyId: string, ...parties: Array<{ childAges: number[] | null }>) {
    return parties.some((p) => p.childAges?.length) ? this.rates.childAgeBands(propertyId, tx) : [];
  }

  /**
   * Applies the start state to a stay created as `pending`: an option with deadline and guarantee amount,
   * or immediate confirmation. Returns the updated row; the caller delivers outbox events after commit.
   */
  private async applyStartState(tx: any, row: any, options: BookingConfirmationOptionsDto, settings: any,
    actor: AuditActor | undefined, requiredDepositOverride?: string | null) {
    if (options.confirmation === undefined) {
      // API callers that predate options keep the previous contract: the booking is confirmed (assigned when a
      // room was picked) with only `reservation.created`, no extra event and no guest message.
      const status = row.roomId ? 'assigned' : 'confirmed';
      const [legacy] = await tx.update(reservations).set({ status, confirmedAt: new Date(), confirmedBy: actor?.userId ?? null, updatedAt: new Date() })
        .where(and(eq(reservations.id, row.id), eq(reservations.propertyId, row.propertyId), eq(reservations.status, 'pending'))).returning();
      if (!legacy) throw new ConflictException('Reservation changed while confirming');
      return { row: legacy, confirmed: false, legacyConfirmed: true };
    }
    if (options.confirmation === 'confirmed') {
      if (options.guaranteeType === 'none' && !options.guaranteeReason?.trim()) {
        throw new BadRequestException('A reason is required to confirm without a guarantee');
      }
      return { row: await this.guarantee.confirmLocked(tx, row, options.guaranteeType ?? null, options.guaranteeReason?.trim() || null, actor, 'manual'), confirmed: true };
    }
    const terms = ReservationGuaranteeService.holdTerms(settings, row.totalAmount, {
      optionUntil: options.optionUntil,
      requiredDeposit: requiredDepositOverride !== undefined ? requiredDepositOverride : options.requiredDeposit,
    });
    const [held] = await tx.update(reservations).set({ optionUntil: terms.optionUntil, requiredDeposit: terms.requiredDeposit, updatedAt: new Date() })
      .where(and(eq(reservations.id, row.id), eq(reservations.propertyId, row.propertyId))).returning();
    return { row: held, confirmed: false };
  }

  private async propertySettings(tx: any, propertyId: string) {
    const [property] = await tx.select({ settings: properties.settings }).from(properties).where(eq(properties.id, propertyId));
    return property?.settings ?? null;
  }

  /** Best-effort guest confirmation after a booking was created as confirmed; never undoes the booking. */
  private async notify(reservationId: string, propertyId: string, wanted: boolean | undefined, confirmed: boolean, actor?: AuditActor) {
    if (!wanted || !confirmed) return undefined;
    try {
      return await this.confirmation.send(reservationId, propertyId, { kind: 'confirmation' }, actor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Confirmation for ${reservationId} not sent: ${message}`);
      return { sent: false, error: message };
    }
  }

  async create(dto: StaffCreateReservationDto, actor?: AuditActor) {
    const dates = stayDates(dto.checkIn, dto.checkOut);
    if (dates.length > 366) throw new BadRequestException('Stay must not exceed 366 nights');
    const party = resolveParty(dto);
    const key = 'staff:' + dto.requestId;
    const logicalEventId = 'staff-reservation:' + dto.requestId;
    const fingerprint = staffRequestFingerprint(dto);
    const result = await this.db.transaction(async (tx: any) => {
      // The namespace keeps staff retries separate from direct/channel keys.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${dto.propertyId + ':' + key}, 0))`);
      const [previous] = await tx.select({ booking: bookings, reservation: reservations }).from(bookings)
        .innerJoin(reservations, and(eq(reservations.bookingId, bookings.id), eq(reservations.propertyId, dto.propertyId)))
        .where(and(eq(bookings.propertyId, dto.propertyId), eq(bookings.idempotencyKey, key)));
      if (previous) {
        if (previous.booking.integrationContext?.staffRequestFingerprint !== fingerprint) throw new ConflictException({ code: 'REQUEST_CHANGED', message: 'Request key was already used for different booking details' });
        return { reservation: previous.reservation, replayed: true, confirmed: false };
      }
      const [fence] = await tx.select().from(staffRequestFences)
        .where(and(eq(staffRequestFences.propertyId, dto.propertyId), eq(staffRequestFences.requestId, dto.requestId)));
      if (fence) throw new ConflictException({ code: 'REQUEST_CLOSED', message: 'Попытка бронирования закрыта. Создайте новый запрос.' });
      await this.assertGuestAtProperty(tx, dto.guestId, dto.propertyId);
      const plan = await this.rates.findById(dto.ratePlanId, dto.propertyId, tx, true);
      if (plan.roomTypeId !== dto.roomTypeId) throw new BadRequestException('Rate plan does not apply to the selected room type');
      await this.rates.assertSellable(dto.propertyId, dto.ratePlanId, dto.checkIn, dto.checkOut, tx);
      await this.assertCapacity(tx, dto.propertyId, dto.roomTypeId, party, await this.bandsFor(tx, dto.propertyId, party));
      const quote = await calculateCanonicalRoomPricing({ propertyId: dto.propertyId, ratePlanId: dto.ratePlanId,
        checkIn: dto.checkIn, checkOut: dto.checkOut, nights: dates.length, isTaxInclusive: plan.isTaxInclusive,
        ratePlanService: this.rates, taxService: this.taxes, db: tx, lockForUpdate: true, guestId: dto.guestId, occupancy: party });
      if (quote.currency !== dto.currencyCode || !new Decimal(quote.totalAmount).equals(dto.expectedTotal)) throw new ConflictException({ code: 'QUOTE_CHANGED', message: 'Reservation price changed. Refresh the quote before accepting.' });
      const created = await this.reservationsService.create({ propertyId: dto.propertyId, guestId: dto.guestId,
        arrivalDate: dto.checkIn, departureDate: dto.checkOut, roomTypeId: dto.roomTypeId, ratePlanId: dto.ratePlanId,
        totalAmount: quote.totalAmount, currencyCode: quote.currency, adults: party.adults, children: party.children,
        childAges: party.childAges ?? undefined, specialRequests: dto.specialRequests?.trim(), source: 'direct' }, {
          idempotencyKey: key, integrationContext: { staffRequestFingerprint: fingerprint },
          acceptedPricingSnapshot: acceptedSnapshotFromQuote(quote),
        }, tx);
      // A room picked on the tape chart is held by the option and stays with the stay after confirmation.
      const withRoom = dto.roomId ? await this.reservationsService.assignRoom(created.id, dto.propertyId, { roomId: dto.roomId }, tx) : created;
      const start = await this.applyStartState(tx, withRoom, dto, await this.propertySettings(tx, dto.propertyId), actor);
      await tx.insert(auditLogs).values({ propertyId: dto.propertyId, entityType: 'reservation', entityId: created.id, action: 'create',
        ...actorFields(actor), description: start.confirmed || 'legacyConfirmed' in start ? 'Бронь создана и подтверждена' : 'Создана предварительная бронь (опция)',
        newValue: { status: start.row.status, totalAmount: quote.totalAmount, optionUntil: start.row.optionUntil ?? null,
          requiredDeposit: start.row.requiredDeposit ?? null, adults: party.adults, children: party.children, childAges: party.childAges } });
      await this.outbox.persist(tx, { event: 'reservation.created', entityType: 'reservation', entityId: created.id,
        propertyId: dto.propertyId, timestamp: new Date().toISOString(), data: { reservationId: created.id,
          arrivalDate: dto.checkIn, departureDate: dto.checkOut, roomTypeId: dto.roomTypeId, status: start.row.status } }, logicalEventId);
      return { reservation: start.row, replayed: false, confirmed: start.confirmed };
    });
    await this.outbox.deliver(dto.propertyId, logicalEventId);
    if (result.confirmed) await this.outbox.deliver(dto.propertyId, `reservation:${result.reservation.id}:confirmed`);
    const notification = await this.notify(result.reservation.id, dto.propertyId, dto.notifyGuest, result.confirmed, actor);
    return { ...result.reservation, replayed: result.replayed, ...(notification ? { notification } : {}) };
  }

  /** Add one more room to an existing booking: same dates, own room type, tariff and guests. */
  async addRoom(reservationId: string, propertyId: string, dto: AddBookingRoomDto, actor?: AuditActor) {
    const logicalEventId = 'staff-booking-room:' + dto.requestId;
    const party = resolveParty(dto);
    const result = await this.db.transaction(async (tx: any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':staff-room:' + dto.requestId}, 0))`);
      const [done] = await tx.select().from(auditLogs).where(and(eq(auditLogs.propertyId, propertyId),
        eq(auditLogs.entityType, 'staff_request'), eq(auditLogs.entityId, dto.requestId), eq(auditLogs.action, 'add_room')));
      if (done) {
        const previous = done.newValue as { reservationId: string; sourceReservationId: string };
        if (previous.sourceReservationId !== reservationId) throw new ConflictException({ code: 'REQUEST_CHANGED', message: 'Request key was already used for another booking' });
        const [row] = await tx.select().from(reservations).where(and(eq(reservations.id, previous.reservationId), eq(reservations.propertyId, propertyId)));
        return { reservation: row, replayed: true, confirmed: false };
      }
      const [source] = await tx.select().from(reservations).where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
      if (!source) throw new NotFoundException(`Reservation ${reservationId} not found`);
      if (!['pending', 'confirmed', 'assigned'].includes(source.status)) throw new BadRequestException('Rooms can only be added before arrival');
      const [booking] = await tx.select().from(bookings).where(and(eq(bookings.id, source.bookingId), eq(bookings.propertyId, propertyId)));
      const guestId = dto.guestId ?? booking.guestId;
      const plan = await this.rates.findById(dto.ratePlanId, propertyId, tx, true);
      if (plan.roomTypeId !== dto.roomTypeId) throw new BadRequestException('Rate plan does not apply to the selected room type');
      await this.assertCapacity(tx, propertyId, dto.roomTypeId, party, await this.bandsFor(tx, propertyId, party));
      const nights = stayDates(source.arrivalDate, source.departureDate).length;
      const quote = await calculateCanonicalRoomPricing({ propertyId, ratePlanId: dto.ratePlanId, checkIn: source.arrivalDate,
        checkOut: source.departureDate, nights, isTaxInclusive: plan.isTaxInclusive, ratePlanService: this.rates, taxService: this.taxes,
        db: tx, lockForUpdate: true, guestId, occupancy: party });
      if (quote.currency !== dto.currencyCode || !new Decimal(quote.totalAmount).equals(dto.expectedTotal))
        throw new ConflictException({ code: 'QUOTE_CHANGED', message: 'Reservation price changed. Refresh the quote before accepting.' });
      const created = await this.reservationsService.create({ propertyId, guestId, arrivalDate: source.arrivalDate,
        departureDate: source.departureDate, roomTypeId: dto.roomTypeId, ratePlanId: dto.ratePlanId, totalAmount: quote.totalAmount,
        currencyCode: quote.currency, adults: party.adults, children: party.children, childAges: party.childAges ?? undefined,
        specialRequests: dto.specialRequests?.trim(), source: 'direct' }, {
          bookingId: booking.id, acceptedPricingSnapshot: acceptedSnapshotFromQuote(quote),
        }, tx);
      if (source.groupProfileId) {
        await tx.update(reservations).set({ groupProfileId: source.groupProfileId })
          .where(and(eq(reservations.id, created.id), eq(reservations.propertyId, propertyId)));
      }
      const withRoom = dto.roomId ? await this.reservationsService.assignRoom(created.id, propertyId, { roomId: dto.roomId }, tx) : created;
      // The new room follows the booking unless staff chose otherwise: tentative booking → tentative room.
      const options: BookingConfirmationOptionsDto = { ...dto,
        confirmation: dto.confirmation ?? (source.status === 'pending' ? 'tentative' : 'confirmed'),
        guaranteeType: dto.guaranteeType ?? (source.status === 'pending' ? undefined : source.guaranteeType ?? undefined),
        guaranteeReason: dto.guaranteeReason ?? (source.status === 'pending' ? undefined : 'Номер добавлен в подтверждённое бронирование'),
        optionUntil: dto.optionUntil !== undefined ? dto.optionUntil : (source.status === 'pending' && source.optionUntil ? new Date(source.optionUntil).toISOString() : undefined) };
      const start = await this.applyStartState(tx, withRoom, options, await this.propertySettings(tx, propertyId), actor);
      await tx.insert(auditLogs).values({ propertyId, entityType: 'staff_request', entityId: dto.requestId, action: 'add_room', ...actorFields(actor),
        description: 'Добавлен номер в бронирование', newValue: { reservationId: created.id, sourceReservationId: reservationId, bookingId: booking.id } });
      await this.outbox.persist(tx, { event: 'reservation.created', entityType: 'reservation', entityId: created.id, propertyId,
        timestamp: new Date().toISOString(), data: { reservationId: created.id, arrivalDate: source.arrivalDate,
          departureDate: source.departureDate, roomTypeId: dto.roomTypeId, status: start.row.status } }, logicalEventId);
      return { reservation: start.row, replayed: false, confirmed: start.confirmed };
    });
    await this.outbox.deliver(propertyId, logicalEventId);
    if (result.confirmed) await this.outbox.deliver(propertyId, `reservation:${result.reservation.id}:confirmed`);
    return { ...result.reservation, replayed: result.replayed };
  }

  /**
   * Group booking: one booking (one confirmation number, group name, optional company profile) with several rooms
   * of one or more categories, created all-or-nothing under the inventory locks. Each room is priced canonically;
   * the staff-accepted grand total must match. Rooms start tentative or confirmed together.
   */
  async createGroup(dto: CreateGroupBookingDto, actor?: AuditActor) {
    const dates = stayDates(dto.checkIn, dto.checkOut);
    if (dates.length > 366) throw new BadRequestException('Stay must not exceed 366 nights');
    const roomCount = dto.rooms.reduce((n, line) => n + line.quantity, 0);
    if (roomCount < 1 || roomCount > 100) throw new BadRequestException('A group booking holds between 1 and 100 rooms');
    const groupName = dto.groupName.trim();
    if (!groupName) throw new BadRequestException('Group name is required');
    const assigned = dto.rooms.flatMap((line) => line.roomIds ?? []);
    if (new Set(assigned).size !== assigned.length) throw new BadRequestException('A room can be assigned only once');
    for (const line of dto.rooms) {
      if ((line.roomIds?.length ?? 0) > line.quantity) throw new BadRequestException('More rooms assigned than requested for a category');
    }
    const parties = dto.rooms.map((line) => resolveParty(line));
    const key = 'staff-group:' + dto.requestId;
    const fingerprint = groupFingerprint(dto);
    const result = await this.db.transaction(async (tx: any) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${dto.propertyId + ':' + key}, 0))`);
      const [previous] = await tx.select().from(bookings).where(and(eq(bookings.propertyId, dto.propertyId), eq(bookings.idempotencyKey, key)));
      if (previous) {
        if (previous.integrationContext?.staffRequestFingerprint !== fingerprint) throw new ConflictException({ code: 'REQUEST_CHANGED', message: 'Request key was already used for different booking details' });
        const rows = await tx.select().from(reservations).where(and(eq(reservations.bookingId, previous.id), eq(reservations.propertyId, dto.propertyId)));
        return { booking: previous, reservations: rows, replayed: true, confirmedIds: [] as string[] };
      }
      await this.assertGuestAtProperty(tx, dto.guestId, dto.propertyId);
      if (dto.groupProfileId) {
        const [profile] = await tx.select({ id: groupProfiles.id }).from(groupProfiles)
          .where(and(eq(groupProfiles.id, dto.groupProfileId), eq(groupProfiles.propertyId, dto.propertyId)));
        if (!profile) throw new BadRequestException('Company / group profile not found in this property');
      }
      const bands = await this.bandsFor(tx, dto.propertyId, ...parties);
      // Price every category line once; every room of a line shares its tariff.
      const lines = [];
      for (const [index, line] of dto.rooms.entries()) {
        const plan = await this.rates.findById(line.ratePlanId, dto.propertyId, tx, true);
        if (plan.roomTypeId !== line.roomTypeId) throw new BadRequestException(`Line ${index + 1}: rate plan does not apply to the room type`);
        await this.rates.assertSellable(dto.propertyId, line.ratePlanId, dto.checkIn, dto.checkOut, tx);
        await this.assertCapacity(tx, dto.propertyId, line.roomTypeId, parties[index]!, bands);
        const quote = await calculateCanonicalRoomPricing({ propertyId: dto.propertyId, ratePlanId: line.ratePlanId,
          checkIn: dto.checkIn, checkOut: dto.checkOut, nights: dates.length, isTaxInclusive: plan.isTaxInclusive,
          ratePlanService: this.rates, taxService: this.taxes, db: tx, lockForUpdate: true, guestId: dto.guestId, occupancy: parties[index]! });
        if (quote.currency !== dto.currencyCode) throw new ConflictException({ code: 'QUOTE_CHANGED', message: 'Rate plan currency differs from the booking currency' });
        lines.push({ line, quote, party: parties[index]! });
      }
      const grandTotal = lines.reduce((sum, l) => sum.plus(new Decimal(l.quote.totalAmount).times(l.line.quantity)), new Decimal(0));
      if (!grandTotal.equals(dto.expectedTotal)) throw new ConflictException({ code: 'QUOTE_CHANGED', message: 'Group price changed. Refresh the quote before accepting.' });

      const settings = await this.propertySettings(tx, dto.propertyId);
      const units = lines.flatMap((l) => Array.from({ length: l.line.quantity }, (_, i) => ({ ...l, roomId: l.line.roomIds?.[i] })));
      // A group guarantee entered by staff is spread over the rooms by price; otherwise each room uses the property rule.
      const deposits = dto.requiredDeposit != null ? splitProportionally(dto.requiredDeposit, units.map((u) => u.quote.totalAmount)) : null;
      if (dto.requiredDeposit != null && new Decimal(dto.requiredDeposit).greaterThan(grandTotal)) {
        throw new BadRequestException('Required deposit must not exceed the group total');
      }
      let bookingId: string | undefined;
      const rows: any[] = [];
      const confirmedIds: string[] = [];
      for (const [index, unit] of units.entries()) {
        const created = await this.reservationsService.create({ propertyId: dto.propertyId, guestId: unit.line.guestId ?? dto.guestId,
          arrivalDate: dto.checkIn, departureDate: dto.checkOut, roomTypeId: unit.line.roomTypeId, ratePlanId: unit.line.ratePlanId,
          totalAmount: unit.quote.totalAmount, currencyCode: unit.quote.currency, adults: unit.party.adults, children: unit.party.children,
          childAges: unit.party.childAges ?? undefined, specialRequests: dto.specialRequests?.trim(), source: 'group' },
        bookingId ? { bookingId, acceptedPricingSnapshot: acceptedSnapshotFromQuote(unit.quote) }
          : { idempotencyKey: key, integrationContext: { staffRequestFingerprint: fingerprint }, acceptedPricingSnapshot: acceptedSnapshotFromQuote(unit.quote) }, tx);
        if (!bookingId) {
          bookingId = created.bookingId;
          // The booker of a group is the contact guest; the group name is shown on the tape chart and documents.
          await tx.update(bookings).set({ groupName, groupId: dto.groupProfileId ?? null, notes: dto.specialRequests?.trim() || null, updatedAt: new Date() })
            .where(and(eq(bookings.id, bookingId!), eq(bookings.propertyId, dto.propertyId)));
        }
        if (dto.groupProfileId) {
          await tx.update(reservations).set({ groupProfileId: dto.groupProfileId })
            .where(and(eq(reservations.id, created.id), eq(reservations.propertyId, dto.propertyId)));
        }
        const withRoom = unit.roomId ? await this.reservationsService.assignRoom(created.id, dto.propertyId, { roomId: unit.roomId }, tx) : created;
        const start = await this.applyStartState(tx, withRoom, { ...dto, confirmation: dto.confirmation ?? 'tentative' }, settings, actor, deposits ? deposits[index] : undefined);
        if (start.confirmed) confirmedIds.push(created.id);
        rows.push(start.row);
        await this.outbox.persist(tx, { event: 'reservation.created', entityType: 'reservation', entityId: created.id,
          propertyId: dto.propertyId, timestamp: new Date().toISOString(), data: { reservationId: created.id, bookingId,
            arrivalDate: dto.checkIn, departureDate: dto.checkOut, roomTypeId: unit.line.roomTypeId, status: start.row.status, groupName } },
        `staff-group:${dto.requestId}:${index}`);
      }
      await tx.insert(auditLogs).values({ propertyId: dto.propertyId, entityType: 'booking', entityId: bookingId, action: 'create_group',
        ...actorFields(actor), description: `Групповая бронь «${groupName}»: ${rows.length} номеров`,
        newValue: { groupName, rooms: rows.length, total: grandTotal.toFixed(2), confirmation: dto.confirmation ?? 'tentative' } });
      const [booking] = await tx.select().from(bookings).where(and(eq(bookings.id, bookingId!), eq(bookings.propertyId, dto.propertyId)));
      return { booking, reservations: rows, replayed: false, confirmedIds };
    });
    if (!result.replayed) {
      for (let i = 0; i < result.reservations.length; i++) await this.outbox.deliver(dto.propertyId, `staff-group:${dto.requestId}:${i}`);
      for (const id of result.confirmedIds) await this.outbox.deliver(dto.propertyId, `reservation:${id}:confirmed`);
    }
    const notification = result.reservations[0]
      ? await this.notify(result.reservations[0].id, dto.propertyId, dto.notifyGuest, result.confirmedIds.length > 0, actor) : undefined;
    const total = result.reservations.reduce((sum: Decimal, r: any) => sum.plus(r.totalAmount), new Decimal(0));
    return { booking: { id: result.booking.id, confirmationNumber: result.booking.confirmationNumber, groupName: result.booking.groupName },
      reservations: result.reservations, totalAmount: total.toFixed(2), replayed: result.replayed, ...(notification ? { notification } : {}) };
  }
}
