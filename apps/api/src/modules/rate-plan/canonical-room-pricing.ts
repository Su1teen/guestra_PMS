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
  ratePlanService: RatePlanService;
  taxService: TaxService;
  db?: any;
  lockForUpdate?: boolean;
};

/** Canonical room-only pricing shared by Booking Engine Search and Quote. */
export async function calculateCanonicalRoomPricing(input: CanonicalRoomPricingInput) {
  // TODO(pricing): tax-inclusive rate plans need a canonical gross-to-net
  // decomposition using TaxService.backCalculateFromInclusive. Until that is
  // designed for every rule type, preserve the existing tax-exclusive behavior
  // identically in Search and Quote instead of changing booked totals here.
  void input.isTaxInclusive;

  let currency: string | undefined;
  const lineItems: Array<{ date: string; rate: string; tax: string }> = [];
  let roomTotal = new Decimal(0);
  let taxTotal = new Decimal(0);
  const arrival = new Date(input.checkIn);

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
    const nightlyRate = new Decimal(effectiveRate);
    const taxes = await input.taxService.calculateTaxes(
      nightlyRate.toFixed(2),
      'room',
      input.propertyId,
      serviceDate,
      { numberOfNights: input.nights, nightNumber: i + 1 },
      input.db,
    );
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
