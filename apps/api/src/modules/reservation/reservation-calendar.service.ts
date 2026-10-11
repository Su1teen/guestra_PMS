import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, lt, notInArray, sql } from 'drizzle-orm';
import { bookings, guests, reservations, rooms, roomTypes, icalBlocks, icalFeeds, folios, roomInventoryBlocks, properties } from '@telivityhaip/database';
import { activeInventoryBlockConditions } from '../room/room-inventory-policy';
import { DRIZZLE } from '../../database/database.module';
import { AvailabilityService, stayDates } from './availability.service';
import { CalendarRangeDto } from './dto/calendar-range.dto';

/** A complete, bounded time window. No list pagination or silent truncation. */
@Injectable()
export class ReservationCalendarService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly availability: AvailabilityService) {}
  /** Ledger indicators only. No summing money across currencies or estimating unpaid future nights. */
  async ledgerIndicators(dto: CalendarRangeDto) {
    if (stayDates(dto.checkIn, dto.checkOut).length > 31) throw new BadRequestException('Calendar range must not exceed 31 nights');
    return this.db.select({ reservationId: reservations.id,
      hasPostedPayment: sql<boolean>`bool_or(${folios.totalPayments}::numeric > 0)`,
      hasBalanceDue: sql<boolean>`bool_or(${folios.balance}::numeric > 0)`,
    }).from(reservations).innerJoin(folios, and(eq(folios.reservationId, reservations.id), eq(folios.propertyId, dto.propertyId)))
      .where(and(eq(reservations.propertyId, dto.propertyId), lt(reservations.arrivalDate, dto.checkOut), gt(reservations.departureDate, dto.checkIn), notInArray(reservations.status, ['cancelled','no_show','checked_out'] as any)))
      .groupBy(reservations.id);
  }
  async range(dto: CalendarRangeDto) {
    if (stayDates(dto.checkIn, dto.checkOut).length > 31) throw new BadRequestException('Calendar range must not exceed 31 nights');
    return this.db.transaction(async (tx: any) => {
      const property = dto.propertyId;
      const roomRows = await tx.select().from(rooms).where(and(eq(rooms.propertyId, property), eq(rooms.isActive, true))).orderBy(asc(rooms.number));
      const types = await tx.select().from(roomTypes).where(eq(roomTypes.propertyId, property));
      const rows = await tx.select({
        id: reservations.id, guestId: reservations.guestId, roomId: reservations.roomId,
        roomTypeId: reservations.roomTypeId, ratePlanId: reservations.ratePlanId,
        arrivalDate: reservations.arrivalDate, departureDate: reservations.departureDate,
        status: reservations.status, totalAmount: reservations.totalAmount, currencyCode: reservations.currencyCode,
        firstName: guests.firstName, lastName: guests.lastName,
        confirmationNumber: bookings.confirmationNumber, source: bookings.source,
      }).from(reservations)
        .innerJoin(bookings, and(eq(bookings.id, reservations.bookingId), eq(bookings.propertyId, property)))
        .innerJoin(guests, eq(guests.id, reservations.guestId))
        .where(and(eq(reservations.propertyId, property), lt(reservations.arrivalDate, dto.checkOut), gt(reservations.departureDate, dto.checkIn), notInArray(reservations.status, ['cancelled', 'no_show', 'checked_out'] as any)))
        .orderBy(asc(reservations.arrivalDate), asc(reservations.id));
      const blocks = await tx.select({ id: icalBlocks.id, roomTypeId: icalBlocks.roomTypeId, startDate: icalBlocks.startDate, endDate: icalBlocks.endDate })
        .from(icalBlocks).innerJoin(icalFeeds, and(eq(icalFeeds.id, icalBlocks.feedId), eq(icalFeeds.propertyId, property), eq(icalFeeds.isActive, true)))
        .where(and(eq(icalBlocks.propertyId, property), lt(icalBlocks.startDate, dto.checkOut), gt(icalBlocks.endDate, dto.checkIn)));
      const availability = await this.availability.searchAvailability(property, dto.checkIn, dto.checkOut, undefined, tx);
      const [settings]=await tx.select({timezone:properties.timezone}).from(properties).where(eq(properties.id,property));
      const today=new Intl.DateTimeFormat('sv-SE',{timeZone:settings?.timezone??'UTC'}).format(new Date());
      const inventoryBlocks=await tx.select().from(roomInventoryBlocks).where(activeInventoryBlockConditions(property,dto.checkOut));
      return { checkIn: dto.checkIn, checkOut: dto.checkOut, complete: true, rooms: roomRows, roomTypes: types,
        reservations: rows.map(({ firstName, lastName, ...row }: any) => ({ ...row, guestName: [firstName, lastName].filter(Boolean).join(' ') })), blocks, availability,
        inventoryBlocks:inventoryBlocks.map((block:any)=>({...block,overdue:block.endDate<=today,releaseRequired:true})) };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
}
