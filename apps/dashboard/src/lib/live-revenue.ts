import { formatMoney } from './money';

export interface ActualRevenue { value: number | null; status: string; source: string; closedDays: number; expectedDays: number }
export interface FinancialKpis {
  occ: number | null; adr: number; revpar: number; trevpar: number | null;
  totalRevenue: number; roomRevenue: number; foodBeverageRevenue: number; ancillaryRevenue: number;
  separatelyPostedTax: number; roomsSold: number; availableRooms: number; ratioStatus: Record<string, string>;
}
export interface UnavailableMetric { status: string; value: null; reason: string; source?: string | null }
export interface SignalDay {
  date: string; totalRooms: number; outOfOrder: number; outOfService: number; availableRooms: number;
  roomsOnBooks: number; onBooksOccupancy: number | null; realisedRooms: number; realisedOccupancy: number | null;
  pickup: { roomNights: number }; pickupBaseline: { roomNights: number }; pickupPeriod: { from: string; to: string };
}
export interface Restriction {
  id: string; startDate: string; endDate: string; minLos: number | null; maxLos: number | null;
  closedToArrival: boolean; closedToDeparture: boolean; isClosed: boolean;
  rateOverride: string | number | null; overrideReason: string | null; dayOfWeekOverrides: Record<string, number> | null;
}
export interface CanonicalRate {
  effectiveRate: number; currency: string; baseRate: number; isTaxInclusive: boolean;
  occupancyPct?: number; losAdjustment: { minNights: number; adjustmentType: string; adjustmentValue: number } | null;
  occupancyAdjustment: { occupancyPctMin: number; occupancyPctMax: number; adjustmentType: string; adjustmentValue: number } | null;
  override: { restrictionId: string; amount: number | null; reason: string | null } | null;
}
export interface CanonicalQuote { currency: string; roomTotal: string; taxTotal: string; totalAmount: string; lineItems: { date: string; rate: string; tax: string }[] }
export interface PreviewDay {
  date: string; before: CanonicalRate; after: CanonicalRate; beforeQuote: CanonicalQuote; afterQuote: CanonicalQuote;
  beforeSales: { sellable: boolean; reason: string | null }; afterSales: { sellable: boolean; reason: string | null };
  beforeRestrictions: Restriction[]; afterRestrictions: Restriction[];
}
export interface LivePreview {
  mode: 'LIVE_PREVIEW'; propertyId: string; ratePlanId: string; planRevision: number; stateToken: string;
  currencyCode: string; approvalRequired: boolean; days: PreviewDay[]; acceptedPricesChanged: false; isEarnedRevenue: false;
}
export interface LiveRate {
  date: string; ratePlanId: string; roomTypeId: string; name: string; code: string; planRevision: number;
  currencyCode: string; price: CanonicalRate; quote: CanonicalQuote; sellable: boolean; restrictionReason: string | null;
  restrictions: Restriction[]; recommendation: { status: string; value: number; source: string; reason: string; requiresHumanReview: true };
  forecast: UnavailableMetric;
}
export interface LiveCalendar {
  mode: 'LIVE'; propertyId: string; rates: LiveRate[];
  signals: { propertyId: string; roomTypeId: string | null; currencyCode: string; timezone: string; operationalDate: string;
    startDate: string; endDate: string; synthetic: false; source: string; kpiScope: string; kpis: FinancialKpis; actual: ActualRevenue;
    daily: SignalDay[]; pace: { daily: { date: string; roomsOnBooks: number; newBookings: number }[];
      summary: { avgRoomsOnBooks: number; totalNewBookings: number } }; forecast: UnavailableMetric };
}
export interface LiveChange {
  propertyId: string; ratePlanId: string; requestId: string; expectedRevision: number; reason: string;
  kind: 'plan' | 'restriction_create' | 'restriction_update' | 'restriction_delete'; restrictionId?: string;
  plan?: Record<string, unknown>; restriction?: Record<string, unknown>; startDate: string; endDate: string; stateToken?: string;
}
export interface RateChange {
  id: string; propertyId: string; ratePlanId: string; status: 'pending' | 'approved' | 'applied' | 'rejected'; revision: number;
  expectedPlanRevision: number; requestedBy: string | null; approvedBy: string | null; reason: string; decisionReason: string | null;
  change: LiveChange; preview: LivePreview; createdAt: string; updatedAt: string;
}
export interface RatePlanRecord {
  id: string; name: string; code: string; roomTypeId: string; revision: number; type: string; baseAmount: string;
  currencyCode: string; derivedAdjustmentType: string | null; derivedAdjustmentValue: string | null;
  losAdjustments?: unknown; occupancyBands?: unknown; isActive: boolean;
}
export interface ManagementSummary {
  date: string; currencyCode: string;
  financial: { kpis: FinancialKpis; actual: ActualRevenue; deposits: { held: number; asOf: string };
    outstandingBalances: { totalBalanceDue: number; accountsReceivableDue: number; creditBalances: number; asOf: string };
    cash: { net: number; received: number; refunds: number } };
  periods: Record<string, ActualRevenue & { start: string; end: string }>;
  bookingWindow: { value: number | null; unit: string; sampleSize: number };
  averageLengthOfStay: { value: number | null; unit: string; sampleSize: number };
  forecast: UnavailableMetric; planToDate: UnavailableMetric; gop: UnavailableMetric;
}
export interface PricingAudit {
  id: string; occurredAt: string; userEmail?: string | null; userId?: string | null; description?: string;
  action?: string; previousValue?: Record<string, unknown> | null; newValue?: Record<string, unknown> | null;
}
export interface PendingPricingRequest {
  requestId: string; propertyId: string; path: string; body: LiveChange | { requestId: string; expectedRevision: number; reason: string; [key: string]: unknown };
}
export interface PricingRequestState { state: 'unconfirmed' | 'running' | 'committed' | 'closed'; record?: unknown }

export function unwrap<T>(data: T | { data: T }): T {
  return data && typeof data === 'object' && 'data' in data ? data.data : data as T;
}
export function liveRateKey(rate: Pick<LiveRate, 'date' | 'ratePlanId'>) { return `${rate.date}:${rate.ratePlanId}`; }
export function validCalendarRange(start: string, end: string) {
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  return validDate(start) && validDate(end) && end >= start && (Date.parse(end) - Date.parse(start)) / 86400000 < 93;
}
export function realisedMoney(value: number | null, actual: ActualRevenue, currency: string, locale: string) {
  return actual.value === null || actual.status === 'NO_POSTINGS' ? '—' : formatMoney(value, currency, locale);
}
export function ratioValue(kpis: FinancialKpis, key: 'adr' | 'revpar' | 'trevpar') {
  return kpis.ratioStatus[key] && kpis.ratioStatus[key] !== 'AVAILABLE' ? null : kpis[key];
}
export function isAmbiguousPricingError(error: unknown) {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return !status || status >= 500;
}
export function pricingError(error: unknown, ru: boolean) {
  const e = error as { response?: { status?: number; data?: { code?: string; message?: string | string[] } }; message?: string };
  const code = e.response?.data?.code;
  if (e.response?.status === 409) return `${code ?? 'CONFLICT'} · ${ru ? 'Обновите данные и создайте новый предпросмотр. Тариф не перезаписывается автоматически.' : 'Refresh and preview again. No automatic rate overwrite.'}`;
  if (e.response?.status === 403) return ru ? 'Недостаточно прав или требуется независимый согласующий. Проверьте объект и роль.' : 'Permission denied or independent approver required. Check property and role.';
  const message = e.response?.data?.message;
  return `${code ? `${code} · ` : ''}${Array.isArray(message) ? message.join(' · ') : message ?? e.message ?? (ru ? 'Ошибка запроса' : 'Request failed')}`;
}
export function pricingRecoveryKey(propertyId: string, actor: string) { return `guestra:live-pricing:${actor}:${propertyId}`; }

export function readPricingRecovery(value: string | null, propertyId: string): PendingPricingRequest | null {
  if (!value) return null;
  try {
    const saved = JSON.parse(value) as PendingPricingRequest | null;
    if (!saved || saved.propertyId !== propertyId || !saved.body || saved.body.requestId !== saved.requestId ||
      !/^[0-9a-f-]{36}$/i.test(saved.requestId) ||
      !/^\/v1\/rate-plans(?:\/rate-changes(?:\/[0-9a-f-]{36}\/(?:approve|apply|reject))?)?$/.test(saved.path)) return null;
    if ((saved.path === '/v1/rate-plans' || saved.path === '/v1/rate-plans/rate-changes') && saved.body.propertyId !== propertyId) return null;
    return saved;
  } catch { return null; }
}

export function canDecideChange(record: RateChange, action: 'approve' | 'apply' | 'reject', actor: string | undefined, manage: boolean, approve: boolean) {
  if (!manage || record.status === 'applied' || record.status === 'rejected') return false;
  if (action === 'approve') return approve && record.status === 'pending' && (!record.preview.approvalRequired || (!!actor && actor !== record.requestedBy));
  if (action === 'reject') return approve;
  return record.status === 'approved' || !record.preview.approvalRequired;
}
