import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, or, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { bookings, reservations, roomTypes, guests, guestPropertyLinks, reservationGuests, serviceBookings } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { ReservationService } from './reservation.service';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { calculateCanonicalRoomPricing } from '../rate-plan/canonical-room-pricing';
import { stayDates } from './availability.service';
import { StaffCreateReservationDto } from './dto/staff-create-reservation.dto';

export function staffRequestFingerprint(dto: StaffCreateReservationDto) {
  return createHash('sha256').update(JSON.stringify([dto.propertyId, dto.guestId, dto.roomTypeId, dto.ratePlanId,
    dto.checkIn, dto.checkOut, dto.roomId ?? null, dto.adults ?? 1, dto.children ?? 0,
    dto.specialRequests?.trim() ?? '', new Decimal(dto.expectedTotal).toFixed(2), dto.currencyCode])).digest('hex');
}

@Injectable()
export class StaffReservationService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly reservationsService: ReservationService,
    private readonly rates: RatePlanService, private readonly taxes: TaxService, private readonly outbox: DomainEventOutboxService) {}
  /** Recover a committed staff request without repricing or creating another stay. */
  async result(propertyId: string, requestId: string) {
    return this.db.transaction(async (tx: any) => {
      const key = 'staff:' + requestId;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':' + key}, 0))`);
      const [row] = await tx.select({ id: reservations.id, status: reservations.status }).from(bookings)
        .innerJoin(reservations, and(eq(reservations.bookingId, bookings.id), eq(reservations.propertyId, propertyId)))
        .where(and(eq(bookings.propertyId, propertyId), eq(bookings.idempotencyKey, key)));
      return row ? { state: 'committed' as const, reservationId: row.id, status: row.status }
        : { state: 'unconfirmed' as const };
    });
  }
  async create(dto: StaffCreateReservationDto) {
    const dates = stayDates(dto.checkIn, dto.checkOut);
    if (dates.length > 366) throw new BadRequestException('Stay must not exceed 366 nights');
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
        return { reservation: previous.reservation, replayed: true };
      }
      const [guest] = await tx.select({ id: guests.id }).from(guests).where(and(eq(guests.id, dto.guestId), eq(guests.isDeleted, false), isNull(guests.mergedIntoGuestId),
        or(inArray(guests.id, tx.select({ guestId: reservations.guestId }).from(reservations).where(eq(reservations.propertyId, dto.propertyId))),
          inArray(guests.id, tx.select({ guestId: reservationGuests.guestId }).from(reservationGuests).where(eq(reservationGuests.propertyId, dto.propertyId))),
          inArray(guests.id, tx.select({ guestId: serviceBookings.guestId }).from(serviceBookings).where(eq(serviceBookings.propertyId, dto.propertyId))),
          inArray(guests.id, tx.select({ guestId: guestPropertyLinks.guestId }).from(guestPropertyLinks).where(eq(guestPropertyLinks.propertyId, dto.propertyId))))));
      if (!guest) throw new BadRequestException('Guest not found in this property');
      const plan = await this.rates.findById(dto.ratePlanId, dto.propertyId, tx, true);
      if (plan.roomTypeId !== dto.roomTypeId) throw new BadRequestException('Rate plan does not apply to the selected room type');
      await this.rates.assertSellable(dto.propertyId, dto.ratePlanId, dto.checkIn, dto.checkOut, tx);
      const [type] = await tx.select().from(roomTypes).where(and(eq(roomTypes.id, dto.roomTypeId), eq(roomTypes.propertyId, dto.propertyId)));
      if (!type?.isActive || (dto.adults ?? 1) + (dto.children ?? 0) > type.maxOccupancy) throw new BadRequestException('Selected room type cannot accommodate this party');
      const quote = await calculateCanonicalRoomPricing({ propertyId: dto.propertyId, ratePlanId: dto.ratePlanId,
        checkIn: dto.checkIn, checkOut: dto.checkOut, nights: dates.length, isTaxInclusive: plan.isTaxInclusive,
        ratePlanService: this.rates, taxService: this.taxes, db: tx, lockForUpdate: true, guestId: dto.guestId });
      if (quote.currency !== dto.currencyCode || !new Decimal(quote.totalAmount).equals(dto.expectedTotal)) throw new ConflictException({ code: 'QUOTE_CHANGED', message: 'Reservation price changed. Refresh the quote before accepting.' });
      const created = await this.reservationsService.create({ propertyId: dto.propertyId, guestId: dto.guestId,
        arrivalDate: dto.checkIn, departureDate: dto.checkOut, roomTypeId: dto.roomTypeId, ratePlanId: dto.ratePlanId,
        totalAmount: quote.totalAmount, currencyCode: quote.currency, adults: dto.adults, children: dto.children,
        specialRequests: dto.specialRequests?.trim(), source: 'direct' }, {
          idempotencyKey: key, integrationContext: { staffRequestFingerprint: fingerprint },
          acceptedPricingSnapshot: { version: 1, source: 'current', currencyCode: quote.currency, grandTotal: quote.totalAmount,
            roomTotal: quote.roomTotal, taxTotal: quote.taxTotal, nights: quote.lineItems.map(n => ({ date: n.date, roomAmount: n.rate, taxAmount: n.tax })),
            services: [], servicesTotal: '0.00', servicesTaxTotal: '0.00', customReason: null, adjustment: null },
        }, tx);
      const [confirmed] = await tx.update(reservations).set({ status: 'confirmed', updatedAt: new Date() })
        .where(and(eq(reservations.id, created.id), eq(reservations.propertyId, dto.propertyId), eq(reservations.status, 'pending'))).returning();
      if (!confirmed) throw new ConflictException('Reservation changed while confirming');
      const reservation = dto.roomId ? await this.reservationsService.assignRoom(created.id, dto.propertyId, { roomId: dto.roomId }, tx) : confirmed;
      await this.outbox.persist(tx, { event: 'reservation.created', entityType: 'reservation', entityId: reservation.id,
        propertyId: dto.propertyId, timestamp: new Date().toISOString(), data: { reservationId: reservation.id,
          arrivalDate: dto.checkIn, departureDate: dto.checkOut, roomTypeId: dto.roomTypeId } }, logicalEventId);
      return { reservation, replayed: false };
    });
    await this.outbox.deliver(dto.propertyId, logicalEventId);
    return { ...result.reservation, replayed: result.replayed };
  }
}
