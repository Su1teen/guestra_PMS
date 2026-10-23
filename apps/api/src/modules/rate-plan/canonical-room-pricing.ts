import Decimal from 'decimal.js';
import type { RatePlanService } from './rate-plan.service';
import type { TaxService } from '../tax/tax.service';

type CanonicalRoomPricingInput = {
  propertyId: string;
  ratePlanId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  isTaxInclusive: boolean;
  guestId?: string;
  ratePlanService: RatePlanService;
  taxService: TaxService;
  db?: any;
  lockForUpdate?: boolean;
  /** Party size; applies the rate plan's occupancy supplements when the plan defines them. */
  occupancy?: { adults: number; children: number };
};

/**
 * Supplement per night for guests above the room type default occupancy.
 * Adults fill the included places first; every further adult or child pays the plan's supplement.
 */
export function occupancySupplementAmount(
  plan: { extraAdultAmount?: string | null; extraChildAmount?: string | null },
  includedOccupancy: number,
  adults: number,
  children: number,
): string {
  const extraAdults = Math.max(0, adults - includedOccupancy);
  const extraChildren = Math.max(0, Math.min(children, adults + children - includedOccupancy));
  return new Decimal(plan.extraAdultAmount ?? 0).times(extraAdults)
    .plus(new Decimal(plan.extraChildAmount ?? 0).times(extraChildren)).toFixed(2);
}

/** Canonical room-only pricing shared by Booking Engine Search and Quote. */
export async function calculateCanonicalRoomPricing(input: CanonicalRoomPricingInput) {
  let currency: string | undefined;
  const lineItems: Array<{ date: string; rate: string; tax: string }> = [];
  let roomTotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  const arrival = new Date(input.checkIn);
  const supplement = new Decimal(input.occupancy
    ? await input.ratePlanService.occupancySupplement(input.ratePlanId, input.propertyId,
      input.occupancy.adults, input.occupancy.children, input.db)
    : 0);

  for (let i = 0; i < input.nights; i++) {
    const date = new Date(arrival);
    date.setUTCDate(date.getUTCDate() + i);
    const serviceDate = date.toISOString().slice(0, 10);
    const rateContext = {
      nights: input.nights,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      stayDate: serviceDate,
    };
    const { effectiveRate, currency: nightCurrency } = input.lockForUpdate
      ? await input.ratePlanService.calculateDerivedRate(
        input.ratePlanId,
        input.propertyId,
        rateContext,
        input.db,
        true,
      )
      : await input.ratePlanService.calculateDerivedRate(
        input.ratePlanId,
        input.propertyId,
        rateContext,
        input.db,
      );


    if (currency && currency !== nightCurrency) throw new Error('Currency changed within stay pricing');
    currency = nightCurrency;
    let nightlyRate = new Decimal(new Decimal(effectiveRate).toFixed(2)).plus(supplement);
    const taxOptions = { numberOfNights: input.nights, nightNumber: i + 1, ...(input.guestId ? { guestId: input.guestId } : {}) };
    const inclusive = input.isTaxInclusive ? await input.taxService.backCalculateFromInclusive(
      nightlyRate.toFixed(2), 'room', input.propertyId, serviceDate, taxOptions, input.db,
    ) : null;
    const taxes = inclusive?.taxes ?? await input.taxService.calculateTaxes(
      nightlyRate.toFixed(2),
      'room',
      input.propertyId,
      serviceDate,
      taxOptions,
      input.db,
    );
    if (inclusive) nightlyRate = new Decimal(inclusive.baseAmount);
    const nightTax = taxes.reduce(
      (sum, tax) => sum.plus(new Decimal(tax.amount)),
      new Decimal(0),
    );
    roomTotal = roomTotal.plus(nightlyRate);
    taxTotal = taxTotal.plus(nightTax);
    lineItems.push({
      date: serviceDate,
      rate: nightlyRate.toFixed(2),
      tax: nightTax.toFixed(2),
    });
  }

  if (!currency) throw new Error('A priced stay requires at least one night');
  return {
    currency,
    lineItems,
    roomTotal: roomTotal.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    totalAmount: roomTotal.plus(taxTotal).toFixed(2),
  };
}
