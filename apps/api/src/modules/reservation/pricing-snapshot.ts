import type { AcceptedPricingSnapshot } from '@telivityhaip/database';
import type { OccupancySupplement } from '../rate-plan/child-pricing';

/** Result of `calculateCanonicalRoomPricing` as far as the accepted snapshot needs it. */
export interface CanonicalQuote {
  currency: string;
  roomTotal: string;
  taxTotal: string;
  totalAmount: string;
  lineItems: Array<{ date: string; rate: string; tax: string }>;
  occupancySupplement?: OccupancySupplement;
}

/** Snapshot block describing the extra-guest supplement, or null when nothing is charged. */
export function supplementSnapshot(quote: Pick<CanonicalQuote, 'occupancySupplement'>): AcceptedPricingSnapshot['occupancySupplement'] {
  const supplement = quote.occupancySupplement;
  if (!supplement || (!supplement.lines.length && Number(supplement.amount) === 0)) return null;
  return { amountPerNight: supplement.amount, lines: supplement.lines };
}

/** Immutable tariff a staff-created stay is accepted at (room only; services are added separately). */
export function acceptedSnapshotFromQuote(quote: CanonicalQuote): AcceptedPricingSnapshot {
  return {
    version: 1, source: 'current', currencyCode: quote.currency, grandTotal: quote.totalAmount,
    roomTotal: quote.roomTotal, taxTotal: quote.taxTotal,
    nights: quote.lineItems.map((n) => ({ date: n.date, roomAmount: n.rate, taxAmount: n.tax })),
    services: [], servicesTotal: '0.00', servicesTaxTotal: '0.00', customReason: null, adjustment: null,
    occupancySupplement: supplementSnapshot(quote),
  };
}
