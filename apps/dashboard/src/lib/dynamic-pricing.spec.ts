/**
 * The pricing model is the only place in the dashboard that turns demand into
 * money, so the cases pinned here are the ones that would put a wrong rate in
 * front of a guest:
 *
 * - the same-day evening discount leaking onto later nights of a stay,
 * - a composed discount dropping a rate under the revenue manager's floor,
 * - the 15:00 cut firing on the browser's clock instead of the hotel's.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRICING_SETTINGS,
  MAX_DISCOUNT,
  computeNightPrice,
  computeStayQuote,
  generateMockForecast,
  goalSeekBaseRate,
  leadTimeAdjustment,
  leadTimeDays,
  occupancyAdjustment,
  paceAdjustment,
  propertyClock,
  roundToStep,
  stayNightKeys,
  summariseForecast,
  type NightDemand,
  type PricingSettings,
} from './dynamic-pricing';

const CLOCK = { today: '2026-03-10', hour: 9 };
const EVENING = { today: '2026-03-10', hour: 15 };

function demand(overrides: Partial<NightDemand> & { date: string }): NightDemand {
  return { occupancyPercent: 50, bookingsLast24h: 0, eventAdjustment: 0, ...overrides };
}

function settings(overrides: Partial<PricingSettings> = {}): PricingSettings {
  return { ...DEFAULT_PRICING_SETTINGS, ...overrides };
}

describe('adjustment tiers', () => {
  it('maps occupancy onto the documented tiers, boundaries included', () => {
    const tiers = DEFAULT_PRICING_SETTINGS.occupancy;
    expect(occupancyAdjustment(0, tiers)).toBe(-0.1);
    expect(occupancyAdjustment(39.9, tiers)).toBe(-0.1);
    expect(occupancyAdjustment(40, tiers)).toBe(0);
    expect(occupancyAdjustment(70, tiers)).toBe(0);
    expect(occupancyAdjustment(71, tiers)).toBe(0.15);
    expect(occupancyAdjustment(85, tiers)).toBe(0.15);
    expect(occupancyAdjustment(85.1, tiers)).toBe(0.3);
    expect(occupancyAdjustment(100, tiers)).toBe(0.3);
  });

  it('lets the stronger pace trigger win instead of stacking both', () => {
    const pace = DEFAULT_PRICING_SETTINGS.pace;
    expect(paceAdjustment(3, pace)).toBe(0);
    expect(paceAdjustment(4, pace)).toBe(0.1);
    expect(paceAdjustment(5, pace)).toBe(0.1);
    expect(paceAdjustment(6, pace)).toBe(0.25);
    expect(paceAdjustment(60, pace)).toBe(0.25); // never 0.35
  });

  it('prices urgency by lead-time window and ignores past dates', () => {
    const lead = DEFAULT_PRICING_SETTINGS.leadTime;
    expect(leadTimeAdjustment(0, lead)).toBe(0.1);
    expect(leadTimeAdjustment(3, lead)).toBe(0.1);
    expect(leadTimeAdjustment(4, lead)).toBe(0.05);
    expect(leadTimeAdjustment(7, lead)).toBe(0.05);
    expect(leadTimeAdjustment(8, lead)).toBe(0);
    expect(leadTimeAdjustment(-1, lead)).toBe(0);
  });
});

describe('roundToStep', () => {
  it('rounds commercially to the configured step', () => {
    expect(roundToStep(100_249, 500)).toBe(100_000);
    expect(roundToStep(100_250, 500)).toBe(100_500);
    expect(roundToStep(100_250, 1000)).toBe(100_000);
    expect(roundToStep(100_251, 100)).toBe(100_300);
  });

  it('never rounds a rate below the floor it was clamped to', () => {
    // Nearest-step rounding alone would return 40 000 here — under the floor.
    expect(roundToStep(40_100, 500, 40_100)).toBe(40_500);
    expect(roundToStep(40_100, 500)).toBe(40_000);
  });
});

describe('computeNightPrice', () => {
  it('composes the documented worked example', () => {
    // Deluxe (x1.25), 80% occupancy (+15%), 4 bookings in 24h (+10%),
    // 30 days out so no lead-time lift: 125 000 x 1.25 = 156 250 -> 156 500.
    const night = computeNightPrice(
      demand({ date: '2026-04-09', occupancyPercent: 80, bookingsLast24h: 4 }),
      'deluxe',
      settings(),
      CLOCK,
    );
    expect(night.adjustments.total).toBeCloseTo(0.25, 10);
    expect(night.rawPrice).toBeCloseTo(156_250, 6);
    expect(night.finalPrice).toBe(156_500);
    expect(night.intradayApplied).toBe(false);
  });

  it('keeps the waterfall lines summing to the final price', () => {
    const night = computeNightPrice(
      demand({ date: '2026-03-10', occupancyPercent: 92, bookingsLast24h: 6, eventAdjustment: 0.4 }),
      'suite',
      settings(),
      EVENING,
    );
    const steps = night.lines
      .filter((line) => line.kind !== 'total')
      .reduce((sum, line) => sum + line.amount, 0);
    expect(steps).toBeCloseTo(night.finalPrice, 6);
  });

  it('applies the evening decay only to tonight', () => {
    const tonight = computeNightPrice(demand({ date: '2026-03-10' }), 'standard', settings(), EVENING);
    const tomorrow = computeNightPrice(demand({ date: '2026-03-11' }), 'standard', settings(), EVENING);
    expect(tonight.intradayApplied).toBe(true);
    expect(tomorrow.intradayApplied).toBe(false);
  });

  it('does not apply the evening decay before the decay hour', () => {
    const night = computeNightPrice(demand({ date: '2026-03-10' }), 'standard', settings(), {
      today: '2026-03-10',
      hour: 14,
    });
    expect(night.intradayApplied).toBe(false);
  });

  it('respects the decay toggle', () => {
    const off = settings({
      intradayDecay: { ...DEFAULT_PRICING_SETTINGS.intradayDecay, enabled: false },
    });
    expect(
      computeNightPrice(demand({ date: '2026-03-10' }), 'standard', off, EVENING).intradayApplied,
    ).toBe(false);
  });

  it('clamps the composed discount at -80% and scales the breakdown with it', () => {
    const night = computeNightPrice(
      demand({ date: '2026-04-09', occupancyPercent: 10, eventAdjustment: -1.5 }),
      'standard',
      settings({ floorPrice: 0 }),
      CLOCK,
    );
    expect(night.adjustments.total).toBeCloseTo(MAX_DISCOUNT, 10);
    expect(night.rawPrice).toBeCloseTo(20_000, 6);
    const steps = night.lines
      .filter((line) => line.kind !== 'total')
      .reduce((sum, line) => sum + line.amount, 0);
    expect(steps).toBeCloseTo(night.finalPrice, 6);
  });

  it('never quotes below the floor, decay and discounts included', () => {
    const night = computeNightPrice(
      demand({ date: '2026-03-10', occupancyPercent: 5 }),
      'standard',
      settings({ floorPrice: 88_000 }),
      EVENING,
    );
    expect(night.floorApplied).toBe(true);
    expect(night.finalPrice).toBeGreaterThanOrEqual(88_000);
    expect(night.finalPrice % 500).toBe(0);
  });
});

describe('computeStayQuote', () => {
  it('sums independently-priced nights and leaves later nights undiscounted', () => {
    const nights = stayNightKeys('2026-03-10', '2026-03-13');
    expect(nights).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);

    const demandByDate = new Map(
      nights.map((date) => [date, demand({ date, occupancyPercent: 50 })]),
    );
    const quote = computeStayQuote(nights, 'standard', settings(), EVENING, demandByDate);

    expect(quote.nights).toHaveLength(3);
    expect(quote.nights[0].intradayApplied).toBe(true);
    expect(quote.nights.slice(1).every((n) => !n.intradayApplied)).toBe(true);
    expect(quote.total).toBe(quote.nights.reduce((sum, n) => sum + n.finalPrice, 0));
    // Arrival night is cheaper than the identical-demand nights that follow it.
    expect(quote.nights[0].finalPrice).toBeLessThan(quote.nights[1].finalPrice);
  });

  it('counts nights, not calendar days, across a month boundary', () => {
    expect(stayNightKeys('2026-02-27', '2026-03-02')).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
    expect(stayNightKeys('2026-03-10', '2026-03-10')).toEqual([]);
  });
});

describe('propertyClock', () => {
  it('reads the hour and date in the property timezone, not the runtime one', () => {
    // 2026-03-10T23:30Z is still the 10th in London and already the 11th in Tokyo.
    const at = new Date('2026-03-10T23:30:00Z');
    expect(propertyClock(at, 'Europe/London')).toEqual({ today: '2026-03-10', hour: 23 });
    expect(propertyClock(at, 'Asia/Tokyo')).toEqual({ today: '2026-03-11', hour: 8 });
  });

  it('falls back to the runtime zone for an unknown zone rather than throwing', () => {
    expect(() => propertyClock(new Date('2026-03-10T12:00:00Z'), 'Mars/Olympus')).not.toThrow();
  });

  it('reports midnight as hour 0', () => {
    expect(propertyClock(new Date('2026-03-10T00:15:00Z'), 'UTC')).toEqual({
      today: '2026-03-10',
      hour: 0,
    });
  });
});

describe('leadTimeDays', () => {
  it('is unaffected by daylight-saving shifts', () => {
    // Europe/Zurich springs forward on 2026-03-29; the night count must not slip.
    expect(leadTimeDays('2026-03-28', '2026-03-30')).toBe(2);
    expect(leadTimeDays('2026-03-10', '2026-03-09')).toBe(-1);
  });
});

describe('generateMockForecast', () => {
  it('produces a stable 30-day curve with a peak on day 14', () => {
    const first = generateMockForecast('2026-03-10');
    const second = generateMockForecast('2026-03-10');
    expect(first).toHaveLength(30);
    expect(first).toEqual(second); // deterministic: no re-roll on re-render

    const peak = first[14];
    expect(peak.occupancyPercent).toBe(92);
    expect(peak.eventAdjustment).toBe(0.4);
    expect(first.every((d) => d.isSynthetic)).toBe(true);
  });

  it('puts weekends high and weekdays mid, in the documented bands', () => {
    for (const day of generateMockForecast('2026-03-10').filter((_, i) => i !== 14)) {
      const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const isWeekend = weekday === 5 || weekday === 6;
      if (isWeekend) {
        expect(day.occupancyPercent).toBeGreaterThanOrEqual(75);
        expect(day.occupancyPercent).toBeLessThanOrEqual(85);
      } else {
        expect(day.occupancyPercent).toBeGreaterThanOrEqual(45);
        expect(day.occupancyPercent).toBeLessThanOrEqual(55);
      }
    }
  });
});

describe('goalSeekBaseRate', () => {
  it('solves the base rate in closed form and rounds to the step', () => {
    const priced = [
      { finalPrice: 100_000, occupancyPercent: 50 },
      { finalPrice: 120_000, occupancyPercent: 80 },
    ];
    const { currentAdr, recommendedBaseRate } = goalSeekBaseRate({
      targetAdr: 125_000,
      currentBaseRate: 100_000,
      roundingStep: 500,
      totalRooms: 40,
      priced,
    });
    // Revenue-weighted: (100k*20 + 120k*32) / (20 + 32) = 112 307.69…
    expect(currentAdr).toBeCloseTo(112_307.6923, 3);
    expect(recommendedBaseRate).toBe(
      Math.round((100_000 * (125_000 / currentAdr)) / 500) * 500,
    );
    expect(recommendedBaseRate % 500).toBe(0);
  });

  it('cannot divide by zero on an empty or fully-vacant forecast', () => {
    const result = goalSeekBaseRate({
      targetAdr: 125_000,
      currentBaseRate: 100_000,
      roundingStep: 500,
      totalRooms: 0,
      priced: [],
    });
    expect(Number.isFinite(result.recommendedBaseRate)).toBe(true);
  });
});

describe('summariseForecast', () => {
  it('separates ADR (per sold room) from RevPAR (per available room)', () => {
    const summary = summariseForecast(
      [
        { finalPrice: 100_000, occupancyPercent: 50 },
        { finalPrice: 100_000, occupancyPercent: 100 },
      ],
      10,
    );
    expect(summary.soldRooms).toBe(15);
    expect(summary.revenue).toBe(1_500_000);
    expect(summary.adr).toBe(100_000);
    expect(summary.averageOccupancyPercent).toBe(75);
    expect(summary.revpar).toBe(75_000);
  });
});
