import Decimal from 'decimal.js';
import type { RatePlanService } from './rate-plan.service';
import type { TaxService } from '../tax/tax.service';
import { occupancySupplementDetail, type OccupancySupplement } from './child-pricing';

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
  occupancy?: { adults: number; children: number; childAges?: number[] | null };
};

/**
 * Supplement per night for guests above the room type default occupancy (count-based, no ages).
 * Kept for callers that only know head counts; see `occupancySupplementDetail` for age bands.
 */
export function occupancySupplementAmount(
  plan: { extraAdultAmount?: string | null; extraChildAmount?: string | null },
  includedOccupancy: number,
  adults: number,
  children: number,
): string {
  return occupancySupplementDetail(plan, includedOccupancy, adults, children, null, null).amount;
}

/** Accepts the detailed result and the plain amount older test doubles return. */
function asSupplement(value: OccupancySupplement | string | number | undefined): OccupancySupplement {
  if (value && typeof value === 'object') return value;
  return { amount: new Decimal(value ?? 0).toFixed(2), lines: [] };
}

/** Canonical room-only pricing shared by Booking Engine Search and Quote. */
export async function calculateCanonicalRoomPricing(input: CanonicalRoomPricingInput) {
  let currency: string | undefined;
  const lineItems: Array<{ date: string; rate: string; tax: string }> = [];
  let roomTotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  const arrival = new Date(input.checkIn);
  const occupancy = asSupplement(input.occupancy
    ? await input.ratePlanService.occupancySupplement(input.ratePlanId, input.propertyId,
      input.occupancy.adults, input.occupancy.children, input.db, input.occupancy.childAges)
    : undefined);
  const supplement = new Decimal(occupancy.amount);

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
    /** Per-night supplement included in every night's rate, with the guests it is charged for. */
    occupancySupplement: occupancy,
  };
}
