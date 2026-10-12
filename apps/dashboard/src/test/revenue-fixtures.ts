import type { LiveCalendar, LivePreview, LiveRate, ManagementSummary, RateChange, RatePlanRecord } from '../lib/live-revenue';

export const PROPERTY = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
export const PLAN = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
export const REQUEST = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
export const kpis = { occ: 0.5, adr: 10000, revpar: 5000, trevpar: 6250, roomRevenue: 10000, foodBeverageRevenue: 2000, ancillaryRevenue: 500, totalRevenue: 12500, separatelyPostedTax: 1500, roomsSold: 1, availableRooms: 2, ratioStatus: { adr: 'AVAILABLE', revpar: 'AVAILABLE' } };
export const actual = { value: 12500, status: 'COMPLETE', source: 'financial_ledger', closedDays: 1, expectedDays: 1 };
export const unavailable = { status: 'INSUFFICIENT_HISTORY', value: null, reason: 'No validated commercial history', source: null } as const;
export const rate: LiveRate = {
  date: '2026-10-12', ratePlanId: PLAN, roomTypeId: PROPERTY, name: 'Canonical BAR', code: 'BAR', planRevision: 7, currencyCode: 'KZT',
  price: { effectiveRate: 10000, baseRate: 10000, currency: 'KZT', isTaxInclusive: false, losAdjustment: null, occupancyAdjustment: null, override: null },
  quote: { currency: 'KZT', roomTotal: '10000', taxTotal: '1500', totalAmount: '11500', lineItems: [{ date: '2026-10-12', rate: '10000', tax: '1500' }] },
  restrictions: [], sellable: true, restrictionReason: null,
  recommendation: { status: 'RULE_BASED', value: 10000, source: 'RatePlanService', reason: 'Configured canonical rules only', requiresHumanReview: true }, forecast: unavailable,
};
export const preview: LivePreview = { mode: 'LIVE_PREVIEW', propertyId: PROPERTY, ratePlanId: PLAN, planRevision: 7, stateToken: 'b'.repeat(64), currencyCode: 'KZT', approvalRequired: false, acceptedPricesChanged: false, isEarnedRevenue: false,
  days: [{ date: rate.date, before: rate.price, after: { ...rate.price, effectiveRate: 12000 }, beforeQuote: rate.quote, afterQuote: { ...rate.quote, roomTotal: '12000', taxTotal: '1800', totalAmount: '13800' }, beforeSales: { sellable: true, reason: null }, afterSales: { sellable: true, reason: null }, beforeRestrictions: [], afterRestrictions: [] }] };
export const proposal: RateChange = { id: REQUEST, propertyId: PROPERTY, ratePlanId: PLAN, status: 'pending', revision: 2, expectedPlanRevision: 7, requestedBy: 'initiator', approvedBy: null, reason: 'Canonical rule review', decisionReason: null, preview,
  change: { propertyId: PROPERTY, ratePlanId: PLAN, requestId: REQUEST, expectedRevision: 7, reason: 'Canonical rule review', kind: 'plan', plan: { baseAmount: '12000' }, startDate: rate.date, endDate: rate.date, stateToken: preview.stateToken }, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
export const plan: RatePlanRecord = { id: PLAN, name: 'Canonical BAR', code: 'BAR', roomTypeId: PROPERTY, revision: 7, type: 'bar', baseAmount: '10000', currencyCode: 'KZT', derivedAdjustmentType: null, derivedAdjustmentValue: null, isActive: true };
export const calendar: LiveCalendar = { mode: 'LIVE', propertyId: PROPERTY, rates: [rate], signals: { propertyId: PROPERTY, roomTypeId: null, currencyCode: 'KZT', timezone: 'Asia/Almaty', operationalDate: rate.date, startDate: rate.date, endDate: rate.date, synthetic: false, source: 'ReportsService', kpiScope: 'property', kpis, actual, daily: [], pace: { daily: [], summary: { avgRoomsOnBooks: 1, totalNewBookings: 2 } }, forecast: unavailable } };
export const summary: ManagementSummary = { date: rate.date, currencyCode: 'KZT', financial: { kpis, actual, deposits: { held: 3000, asOf: 'CURRENT_SNAPSHOT' }, outstandingBalances: { totalBalanceDue: 5000, accountsReceivableDue: 1000, creditBalances: 0, asOf: 'CURRENT_SNAPSHOT' }, cash: { net: 4000, received: 4500, refunds: 500 } }, periods: Object.fromEntries(['mtd', 'ytd', 'ly', 'lytd'].map(p => [p, { ...actual, start: rate.date, end: rate.date }])), bookingWindow: { value: 4, unit: 'days', sampleSize: 2 }, averageLengthOfStay: { value: 2, unit: 'nights', sampleSize: 2 }, forecast: unavailable, planToDate: { ...unavailable, status: 'NO_PLAN' }, gop: { ...unavailable, status: 'NO_CONFIRMED_EXPENSES' } };
