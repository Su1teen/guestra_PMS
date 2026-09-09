/**
 * Dynamic pricing model — pure, per-night, and deliberately free of React,
 * network and clock access so it can be unit-tested and reused by both the
 * simulator page and the tape chart's stay quote.
 *
 * The price of a stay is NEVER a single nightly rate multiplied by a length of
 * stay: every night carries its own occupancy, pace, lead time and event
 * demand, so the total is the sum of independently-priced nights (KB 8.x
 * revenue management). Collapsing that into `nightlyRate * nights` is the bug
 * this module exists to prevent — it would, among other things, spread a
 * same-day evening discount across nights that are still weeks away.
 *
 *   P_calc(d)  = P_base · M_cat · (1 + max(-0.80, K_event + K_occ + K_pace + K_lead))
 *   P_step2(d) = P_calc(d) · (1 - D_intra)   only when d is today, lead time is 0
 *                                            and the property-local clock has
 *                                            passed the decay hour
 *   P_final(d) = roundToStep(max(P_min, P_step2(d)), step)
 */

export type RoomCategory = 'standard' | 'deluxe' | 'suite';

export const ROOM_CATEGORIES: RoomCategory[] = ['standard', 'deluxe', 'suite'];

export const ROUNDING_STEPS = [100, 500, 1000] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];

/** Occupancy tier thresholds are percentages (0–100), adjustments are fractions. */
export interface OccupancyTierSettings {
  /** Below this occupancy the rate is discounted (default 40%). */
  lowBelow: number;
  /** Up to and including this occupancy the rate is neutral (default 70%). */
  neutralThrough: number;
  /** Up to and including this occupancy the rate is lifted (default 85%). */
  highThrough: number;
  lowAdjustment: number;
  neutralAdjustment: number;
  highAdjustment: number;
  peakAdjustment: number;
}

/** Pace = bookings taken in the last 24h. Tier 2 wins when both trigger. */
export interface PaceSettings {
  tier1Above: number;
  tier1Adjustment: number;
  tier2Above: number;
  tier2Adjustment: number;
}

export interface LeadTimeSettings {
  nearThroughDays: number;
  nearAdjustment: number;
  midThroughDays: number;
  midAdjustment: number;
}

export interface IntradayDecaySettings {
  enabled: boolean;
  /** Fraction cut from the same-day rate, e.g. 0.30 for -30%. */
  amount: number;
  /** Property-local hour (0–23) from which the cut applies. */
  fromHour: number;
}

export interface PricingSettings {
  baseRate: number;
  floorPrice: number;
  roundingStep: RoundingStep;
  categoryMultipliers: Record<RoomCategory, number>;
  occupancy: OccupancyTierSettings;
  pace: PaceSettings;
  leadTime: LeadTimeSettings;
  intradayDecay: IntradayDecaySettings;
}

/**
 * The floor of a rate ladder cannot be clamped by a total demand collapse:
 * -80% is the widest discount the model may ever compose, whatever the
 * adjustments sum to.
 */
export const MAX_DISCOUNT = -0.8;

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  baseRate: 100000,
  floorPrice: 40000,
  roundingStep: 500,
  categoryMultipliers: { standard: 1, deluxe: 1.25, suite: 1.6 },
  occupancy: {
    lowBelow: 40,
    neutralThrough: 70,
    highThrough: 85,
    lowAdjustment: -0.1,
    neutralAdjustment: 0,
    highAdjustment: 0.15,
    peakAdjustment: 0.3,
  },
  pace: { tier1Above: 3, tier1Adjustment: 0.1, tier2Above: 5, tier2Adjustment: 0.25 },
  leadTime: { nearThroughDays: 3, nearAdjustment: 0.1, midThroughDays: 7, midAdjustment: 0.05 },
  intradayDecay: { enabled: true, amount: 0.3, fromHour: 15 },
};

/** One night of demand input. Occupancy is a percentage (0–100). */
export interface NightDemand {
  /** yyyy-MM-dd, in the property's own calendar. */
  date: string;
  occupancyPercent: number;
  /** Bookings taken in the last 24h that touch this night. */
  bookingsLast24h: number;
  /** K_event — a manual/forecast demand modifier, e.g. 0.4 for a city-wide event. */
  eventAdjustment: number;
}

/** Everything about "now" the model needs, injected so tests own the clock. */
export interface PricingClock {
  /** yyyy-MM-dd — today in the PROPERTY's timezone, not the browser's. */
  today: string;
  /** 0–23 — the property-local hour. */
  hour: number;
}

export type BreakdownKind =
  | 'base'
  | 'category'
  | 'event'
  | 'occupancy'
  | 'pace'
  | 'leadTime'
  | 'clamp'
  | 'intraday'
  | 'floor'
  | 'rounding'
  | 'total';

export interface BreakdownLine {
  kind: BreakdownKind;
  /** Signed money contribution of this step. */
  amount: number;
  /** Signed fraction driving the step, where one exists (0.15 = +15%). */
  percent?: number;
  /** Extra context for the label, e.g. the occupancy that selected the tier. */
  detail?: number;
}

export interface NightPrice {
  date: string;
  leadTimeDays: number;
  occupancyPercent: number;
  category: RoomCategory;
  /** Signed fractions actually applied (post-clamp scaling). */
  adjustments: {
    event: number;
    occupancy: number;
    pace: number;
    leadTime: number;
    total: number;
  };
  /** Price before the floor and rounding are enforced. */
  rawPrice: number;
  intradayApplied: boolean;
  floorApplied: boolean;
  roundingDelta: number;
  finalPrice: number;
  lines: BreakdownLine[];
}

// ---------------------------------------------------------------------------
// Date helpers — all dates are plain yyyy-MM-dd in the property's calendar, so
// they are compared as UTC midnights and never pass through the local zone.
// ---------------------------------------------------------------------------

function toUtcMidnight(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Whole days from `today` to `date`; negative for dates already past. */
export function leadTimeDays(today: string, date: string): number {
  return Math.round((toUtcMidnight(date) - toUtcMidnight(today)) / 86_400_000);
}

export function addDaysKey(dateKey: string, days: number): string {
  return new Date(toUtcMidnight(dateKey) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * "Now" as the PROPERTY experiences it. A 15:00 decay evaluated in the
 * browser's timezone fires at the wrong moment for every remote user — and for
 * a hotel that is the difference between discounting tonight's empty rooms and
 * discounting tomorrow's full ones.
 */
export function propertyClock(at: Date, timeZone?: string | null): PricingClock {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  };
  if (timeZone) options.timeZone = timeZone;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(at);
  } catch {
    // An unknown IANA zone must not take down pricing; fall back to the runtime zone.
    delete options.timeZone;
    parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(at);
  }
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(get('hour')) % 24;
  return { today: `${get('year')}-${get('month')}-${get('day')}`, hour };
}

// ---------------------------------------------------------------------------
// Adjustment tiers
// ---------------------------------------------------------------------------

export function occupancyAdjustment(
  occupancyPercent: number,
  tiers: OccupancyTierSettings,
): number {
  if (occupancyPercent < tiers.lowBelow) return tiers.lowAdjustment;
  if (occupancyPercent <= tiers.neutralThrough) return tiers.neutralAdjustment;
  if (occupancyPercent <= tiers.highThrough) return tiers.highAdjustment;
  return tiers.peakAdjustment;
}

export function paceAdjustment(bookingsLast24h: number, pace: PaceSettings): number {
  if (bookingsLast24h > pace.tier2Above) return pace.tier2Adjustment;
  if (bookingsLast24h > pace.tier1Above) return pace.tier1Adjustment;
  return 0;
}

export function leadTimeAdjustment(days: number, lead: LeadTimeSettings): number {
  // Stays already in house are not repriced by lead time.
  if (days < 0) return 0;
  if (days <= lead.nearThroughDays) return lead.nearAdjustment;
  if (days <= lead.midThroughDays) return lead.midAdjustment;
  return 0;
}

/**
 * Commercial rounding to a step.
 *
 * Nearest-step rounding can land a rate a few hundred BELOW the floor the
 * revenue manager set (floor 40 100 → 40 000 at a 500 step), so a result under
 * the floor is lifted to the first step at or above it. The floor is an
 * absolute: rounding may never breach it.
 */
export function roundToStep(value: number, step: number, floor?: number): number {
  if (!Number.isFinite(value)) return 0;
  const safeStep = step > 0 ? step : 1;
  let rounded = Math.round(value / safeStep) * safeStep;
  if (floor != null && rounded < floor) rounded = Math.ceil(floor / safeStep) * safeStep;
  return rounded;
}

// ---------------------------------------------------------------------------
// Per-night pricing
// ---------------------------------------------------------------------------

export function computeNightPrice(
  night: NightDemand,
  category: RoomCategory,
  settings: PricingSettings,
  clock: PricingClock,
): NightPrice {
  const multiplier = settings.categoryMultipliers[category] ?? 1;
  const categoryBase = settings.baseRate * multiplier;
  const days = leadTimeDays(clock.today, night.date);

  const rawEvent = night.eventAdjustment || 0;
  const rawOccupancy = occupancyAdjustment(night.occupancyPercent, settings.occupancy);
  const rawPace = paceAdjustment(night.bookingsLast24h, settings.pace);
  const rawLead = leadTimeAdjustment(days, settings.leadTime);
  const rawSum = rawEvent + rawOccupancy + rawPace + rawLead;
  const appliedSum = Math.max(MAX_DISCOUNT, rawSum);

  // When the clamp bites, attribute it proportionally so the waterfall still
  // adds up to the final price instead of showing a phantom surplus.
  const scale = rawSum < MAX_DISCOUNT && rawSum !== 0 ? appliedSum / rawSum : 1;
  const event = rawEvent * scale;
  const occupancy = rawOccupancy * scale;
  const pace = rawPace * scale;
  const lead = rawLead * scale;

  const calculated = categoryBase * (1 + appliedSum);

  // STRICTLY the arrival night: today, lead time 0, and past the decay hour.
  const intradayApplied =
    settings.intradayDecay.enabled &&
    settings.intradayDecay.amount > 0 &&
    days === 0 &&
    night.date === clock.today &&
    clock.hour >= settings.intradayDecay.fromHour;
  const decayed = intradayApplied
    ? calculated * (1 - settings.intradayDecay.amount)
    : calculated;

  const floored = Math.max(settings.floorPrice, decayed);
  const floorApplied = floored > decayed;
  const finalPrice = roundToStep(floored, settings.roundingStep, settings.floorPrice);

  const lines: BreakdownLine[] = [
    { kind: 'base', amount: settings.baseRate },
  ];
  if (categoryBase !== settings.baseRate) {
    lines.push({
      kind: 'category',
      amount: categoryBase - settings.baseRate,
      percent: multiplier - 1,
    });
  }
  if (event !== 0) lines.push({ kind: 'event', amount: categoryBase * event, percent: event });
  if (occupancy !== 0) {
    lines.push({
      kind: 'occupancy',
      amount: categoryBase * occupancy,
      percent: occupancy,
      detail: night.occupancyPercent,
    });
  }
  if (pace !== 0) {
    lines.push({
      kind: 'pace',
      amount: categoryBase * pace,
      percent: pace,
      detail: night.bookingsLast24h,
    });
  }
  if (lead !== 0) {
    lines.push({ kind: 'leadTime', amount: categoryBase * lead, percent: lead, detail: days });
  }
  if (scale !== 1) lines.push({ kind: 'clamp', amount: 0, percent: MAX_DISCOUNT });
  if (intradayApplied) {
    lines.push({
      kind: 'intraday',
      amount: decayed - calculated,
      percent: -settings.intradayDecay.amount,
      detail: settings.intradayDecay.fromHour,
    });
  }
  if (floorApplied) {
    lines.push({ kind: 'floor', amount: floored - decayed, detail: settings.floorPrice });
  }
  if (finalPrice !== floored) {
    lines.push({
      kind: 'rounding',
      amount: finalPrice - floored,
      detail: settings.roundingStep,
    });
  }
  lines.push({ kind: 'total', amount: finalPrice });

  return {
    date: night.date,
    leadTimeDays: days,
    occupancyPercent: night.occupancyPercent,
    category,
    adjustments: { event, occupancy, pace, leadTime: lead, total: appliedSum },
    rawPrice: decayed,
    intradayApplied,
    floorApplied,
    roundingDelta: finalPrice - floored,
    finalPrice,
    lines,
  };
}

export interface StayQuote {
  nights: NightPrice[];
  total: number;
  /** Average nightly rate actually quoted — the ADR of this stay. */
  averageNightly: number;
}

/**
 * Price a stay as the sum of its nights. `demand` supplies whatever is known
 * per date; unknown nights fall back to `fallback` so a quote is still honest
 * about being an estimate rather than silently pricing at base.
 */
export function computeStayQuote(
  dates: string[],
  category: RoomCategory,
  settings: PricingSettings,
  clock: PricingClock,
  demandByDate: Map<string, NightDemand>,
  fallback: Omit<NightDemand, 'date'> = { occupancyPercent: 0, bookingsLast24h: 0, eventAdjustment: 0 },
): StayQuote {
  const nights = dates.map((date) =>
    computeNightPrice(demandByDate.get(date) ?? { date, ...fallback }, category, settings, clock),
  );
  const total = nights.reduce((sum, n) => sum + n.finalPrice, 0);
  return {
    nights,
    total,
    averageNightly: nights.length ? total / nights.length : 0,
  };
}

/** Inclusive-exclusive stay nights: arrival night through the night before departure. */
export function stayNightKeys(checkIn: string, checkOut: string): string[] {
  const nights: string[] = [];
  const end = toUtcMidnight(checkOut);
  for (let cursor = toUtcMidnight(checkIn); cursor < end; cursor += 86_400_000) {
    nights.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return nights;
}

/**
 * Map a room-type name onto a pricing category. Properties name their types
 * freely, so this is a hint, not a truth — the simulator always lets the user
 * pick the category explicitly.
 */
export function categoryFromRoomTypeName(name?: string | null): RoomCategory {
  const value = (name ?? '').toLowerCase();
  if (/suite|penthouse|люкс|апартамент/.test(value)) return 'suite';
  if (/deluxe|superior|premium|полулюкс|улучшен/.test(value)) return 'deluxe';
  return 'standard';
}

// ---------------------------------------------------------------------------
// Forecast + goal seek
// ---------------------------------------------------------------------------

export interface ForecastDay extends NightDemand {
  /** True when the row came from the mock generator rather than the ledger. */
  isSynthetic: boolean;
}

/** Deterministic 0–1 hash of a string: a stable "random" that never re-rolls on render. */
function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export const MOCK_FORECAST_MIN_BOOKINGS = 10;
export const FORECAST_DAYS = 30;
/** Day index (0-based) of the injected demand spike in the mock forecast. */
export const MOCK_PEAK_DAY_INDEX = 14;

/**
 * Fallback demand curve for a property with almost no history — weekday
 * 45–55%, weekend 75–85%, plus one high-demand peak on day 14. It is labelled
 * synthetic everywhere it is shown: a simulator that silently invents occupancy
 * teaches a revenue manager to trust a number the hotel never earned.
 */
export function generateMockForecast(startDate: string, days = FORECAST_DAYS): ForecastDay[] {
  return Array.from({ length: days }, (_, index) => {
    const date = addDaysKey(startDate, index);
    const weekday = new Date(toUtcMidnight(date)).getUTCDay(); // 0 = Sunday
    const isWeekend = weekday === 5 || weekday === 6; // Fri–Sat
    const jitter = hashUnit(date);
    const occupancyPercent = isWeekend
      ? Math.round(75 + jitter * 10)
      : Math.round(45 + jitter * 10);
    const isPeak = index === MOCK_PEAK_DAY_INDEX;
    return {
      date,
      occupancyPercent: isPeak ? 92 : occupancyPercent,
      bookingsLast24h: isPeak ? 6 : Math.round(jitter * 5),
      eventAdjustment: isPeak ? 0.4 : 0,
      isSynthetic: true,
    };
  });
}

export interface GoalSeekInput {
  targetAdr: number;
  currentBaseRate: number;
  roundingStep: number;
  totalRooms: number;
  /** Priced nights, in forecast order, with the occupancy used for each. */
  priced: { finalPrice: number; occupancyPercent: number }[];
}

export interface GoalSeekResult {
  currentAdr: number;
  scalingFactor: number;
  recommendedBaseRate: number;
}

/**
 * Closed-form base-rate solve. The model is linear in P_base up to the floor
 * and the rounding step, so the scaling factor is exact algebra — no iteration,
 * no risk of a solver spinning on an unreachable target.
 */
export function goalSeekBaseRate({
  targetAdr,
  currentBaseRate,
  roundingStep,
  totalRooms,
  priced,
}: GoalSeekInput): GoalSeekResult {
  const projectedRevenue = priced.reduce(
    (sum, day) => sum + day.finalPrice * (day.occupancyPercent / 100) * totalRooms,
    0,
  );
  const projectedSoldRooms = priced.reduce(
    (sum, day) => sum + (day.occupancyPercent / 100) * totalRooms,
    0,
  );
  const currentAdr = projectedRevenue / (projectedSoldRooms || 1);
  const scalingFactor = targetAdr / (currentAdr || 1);
  const step = roundingStep > 0 ? roundingStep : 1;
  return {
    currentAdr,
    scalingFactor,
    recommendedBaseRate: Math.round((currentBaseRate * scalingFactor) / step) * step,
  };
}

export interface ForecastSummary {
  adr: number;
  averageOccupancyPercent: number;
  revpar: number;
  revenue: number;
  soldRooms: number;
}

export function summariseForecast(
  priced: { finalPrice: number; occupancyPercent: number }[],
  totalRooms: number,
): ForecastSummary {
  const revenue = priced.reduce(
    (sum, day) => sum + day.finalPrice * (day.occupancyPercent / 100) * totalRooms,
    0,
  );
  const soldRooms = priced.reduce(
    (sum, day) => sum + (day.occupancyPercent / 100) * totalRooms,
    0,
  );
  const occupancySum = priced.reduce((sum, day) => sum + day.occupancyPercent, 0);
  const dayCount = priced.length || 1;
  const availableRoomNights = totalRooms * dayCount;
  return {
    adr: soldRooms > 0 ? revenue / soldRooms : 0,
    averageOccupancyPercent: occupancySum / dayCount,
    revpar: availableRoomNights > 0 ? revenue / availableRoomNights : 0,
    revenue,
    soldRooms,
  };
}
