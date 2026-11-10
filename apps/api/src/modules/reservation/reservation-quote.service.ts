import { BadRequestException, Injectable } from '@nestjs/common';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { calculateCanonicalRoomPricing } from '../rate-plan/canonical-room-pricing';
import { AvailabilityService, assertFullStayAvailability, stayDates } from './availability.service';
import { ReservationQuoteDto } from './dto/reservation-quote.dto';
import { GuestService } from '../guest/guest.service';
import { resolveParty } from './dto/child-ages';
import type { GroupQuoteDto } from './dto/create-group-booking.dto';
import Decimal from 'decimal.js';

/** Staff pricing uses the same pricing implementation as direct booking. */
@Injectable()
export class ReservationQuoteService {
  constructor(private readonly rates: RatePlanService, private readonly taxes: TaxService,
    private readonly availability: AvailabilityService, private readonly guests: GuestService) {}

  async calendarPrices(dto: { propertyId: string; ratePlanId: string; checkIn: string; checkOut: string }) {
    const dates = stayDates(dto.checkIn, dto.checkOut);
    if (dates.length > 31) throw new BadRequestException('Calendar range must not exceed 31 nights');
    const plan = await this.rates.findById(dto.ratePlanId, dto.propertyId);
    const prices = [];
    for (const date of dates) {
      const departure = new Date(date + 'T00:00:00Z'); departure.setUTCDate(departure.getUTCDate() + 1);
      const quote = await calculateCanonicalRoomPricing({ propertyId: dto.propertyId, ratePlanId: dto.ratePlanId, checkIn: date,
        checkOut: departure.toISOString().slice(0,10), nights: 1, isTaxInclusive: plan.isTaxInclusive, ratePlanService: this.rates, taxService: this.taxes });
      prices.push({ date, totalAmount: quote.totalAmount, taxTotal: quote.taxTotal, currency: quote.currency });
    }
    return { roomTypeId: plan.roomTypeId, prices };
  }

  async quote(dto: ReservationQuoteDto) {
    const dates = stayDates(dto.checkIn, dto.checkOut);
    const plan = await this.rates.findById(dto.ratePlanId, dto.propertyId);
    if (dto.guestId) await this.guests.findById(dto.guestId, dto.propertyId);
    if (plan.roomTypeId !== dto.roomTypeId) {
      throw new BadRequestException('Rate plan does not apply to the selected room type');
    }
    await this.rates.assertSellable(dto.propertyId, dto.ratePlanId, dto.checkIn, dto.checkOut);
    const rows = await this.availability.searchAvailability(dto.propertyId, dto.checkIn, dto.checkOut, dto.roomTypeId);
    assertFullStayAvailability(rows, dto.roomTypeId, dto.checkIn, dto.checkOut);
    return calculateCanonicalRoomPricing({
      propertyId: dto.propertyId, ratePlanId: dto.ratePlanId,
      checkIn: dto.checkIn, checkOut: dto.checkOut, nights: dates.length,
      isTaxInclusive: plan.isTaxInclusive, ratePlanService: this.rates, taxService: this.taxes, guestId: dto.guestId,
      occupancy: resolveParty(dto),
    });
  }

  /**
   * Group quote: canonical price per room for every category line, line totals and the grand total.
   * Availability is checked per category for the summed quantity, so staff sees shortages before booking.
   */
  async groupQuote(dto: GroupQuoteDto) {
    const dates = stayDates(dto.checkIn, dto.checkOut);
    if (dto.guestId) await this.guests.findById(dto.guestId, dto.propertyId);
    const needed = new Map<string, number>();
    for (const line of dto.rooms) needed.set(line.roomTypeId, (needed.get(line.roomTypeId) ?? 0) + line.quantity);
    const shortages: Array<{ roomTypeId: string; requested: number; available: number }> = [];
    for (const [roomTypeId, requested] of needed) {
      const rows = await this.availability.searchAvailability(dto.propertyId, dto.checkIn, dto.checkOut, roomTypeId);
      const nights = rows.filter((r: any) => r.roomTypeId === roomTypeId);
      const free = nights.length ? Math.min(...nights.map((r: any) => Number(r.available))) : 0;
      if (free < requested) shortages.push({ roomTypeId, requested, available: Math.max(0, free) });
    }
    const lines = [];
    let currency: string | null = null;
    let grand = new Decimal(0);
    for (const line of dto.rooms) {
      const plan = await this.rates.findById(line.ratePlanId, dto.propertyId);
      if (plan.roomTypeId !== line.roomTypeId) throw new BadRequestException('Rate plan does not apply to the selected room type');
      await this.rates.assertSellable(dto.propertyId, line.ratePlanId, dto.checkIn, dto.checkOut);
      const price = await calculateCanonicalRoomPricing({ propertyId: dto.propertyId, ratePlanId: line.ratePlanId,
        checkIn: dto.checkIn, checkOut: dto.checkOut, nights: dates.length, isTaxInclusive: plan.isTaxInclusive,
        ratePlanService: this.rates, taxService: this.taxes, guestId: dto.guestId, occupancy: resolveParty(line) });
      if (currency && currency !== price.currency) throw new BadRequestException('All rooms of a group must use one currency');
      currency = price.currency;
      const lineTotal = new Decimal(price.totalAmount).times(line.quantity);
      grand = grand.plus(lineTotal);
      lines.push({ roomTypeId: line.roomTypeId, ratePlanId: line.ratePlanId, quantity: line.quantity, perRoom: price,
        lineTotal: lineTotal.toFixed(2) });
    }
    return { currency, nights: dates.length, lines, totalAmount: grand.toFixed(2), shortages, available: shortages.length === 0 };
  }
}
