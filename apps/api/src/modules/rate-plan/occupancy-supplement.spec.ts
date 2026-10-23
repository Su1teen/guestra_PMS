import { describe, expect, it } from 'vitest';
import { occupancySupplementAmount } from './canonical-room-pricing';

describe('occupancySupplementAmount', () => {
  const plan = { extraAdultAmount: '5000.00', extraChildAmount: '2500.00' };

  it('charges nothing within the default occupancy', () => {
    expect(occupancySupplementAmount(plan, 2, 2, 0)).toBe('0.00');
    expect(occupancySupplementAmount(plan, 2, 1, 1)).toBe('0.00');
  });

  it('charges every adult above the default occupancy', () => {
    expect(occupancySupplementAmount(plan, 2, 3, 0)).toBe('5000.00');
    expect(occupancySupplementAmount(plan, 2, 4, 0)).toBe('10000.00');
  });

  it('fills included places with adults first, then charges children', () => {
    expect(occupancySupplementAmount(plan, 2, 2, 1)).toBe('2500.00');
    expect(occupancySupplementAmount(plan, 2, 1, 3)).toBe('5000.00');
    expect(occupancySupplementAmount(plan, 2, 3, 2)).toBe('10000.00');
  });

  it('keeps per-room pricing when the plan defines no supplements', () => {
    expect(occupancySupplementAmount({ extraAdultAmount: null, extraChildAmount: null }, 2, 4, 2)).toBe('0.00');
  });
});
