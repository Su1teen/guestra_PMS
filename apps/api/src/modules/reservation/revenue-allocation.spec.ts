import { describe, expect, it } from 'vitest';
import { RevenueAllocationService } from './revenue-allocation.service';
import { zonedTimeToUtc } from './stay-money.service';

const food = { id: 'c-food', quantity: 1, includedInRate: true, basis: 'per_guest_per_night' as const, allocationAmount: '4000.00', amountOverride: null,
  unitCost: '4000.00', revenueCategory: 'fnb' as const, service: { name: 'Питание', price: '0.00', chargeType: 'food_beverage' } };

describe('RevenueAllocationService.compute', () => {
  it('splits a 100 000 package for two guests into 92 000 accommodation and 8 000 food with 8 000 cost', () => {
    const lines = RevenueAllocationService.compute({ totalAmount: '100000.00', nights: 1, adults: 2, children: 0, childAges: null }, [food], 5)!;
    expect(lines).toEqual([
      { category: 'accommodation', componentId: null, description: 'Проживание', quantity: 1, amount: '92000.00', cost: '0.00' },
      { category: 'fnb', componentId: 'c-food', description: 'Питание', quantity: 2, amount: '8000.00', cost: '8000.00' },
    ]);
    expect(lines.reduce((s, l) => s + Number(l.amount), 0)).toBe(100000);
  });

  it('counts children from the property age as adults and lets younger ones stay free', () => {
    const stay = { totalAmount: '200000.00', nights: 2, adults: 2, children: 2, childAges: [3, 7] };
    expect(RevenueAllocationService.countedGuests(stay, 5)).toBe(3);
    expect(RevenueAllocationService.countedGuests(stay, null)).toBe(4);
    expect(RevenueAllocationService.countedGuests({ ...stay, childAges: null }, 5)).toBe(4); // unknown age counts
    const lines = RevenueAllocationService.compute(stay, [food], 5)!;
    expect(lines[1]).toMatchObject({ quantity: 6, amount: '24000.00' });
    expect(lines[0]!.amount).toBe('176000.00');
  });

  it('ignores surcharges outside the rate and refuses a split above the price', () => {
    expect(RevenueAllocationService.compute({ totalAmount: '50000.00', nights: 1, adults: 1, children: 0, childAges: null },
      [{ ...food, includedInRate: false }], 5)).toHaveLength(1);
    expect(RevenueAllocationService.compute({ totalAmount: '5000.00', nights: 1, adults: 2, children: 0, childAges: null }, [food], 5)).toBeNull();
  });

  it('counts per stay, per night and per guest per stay', () => {
    const stay = { totalAmount: '100000.00', nights: 3, adults: 2, children: 0, childAges: null };
    const mk = (basis: any) => RevenueAllocationService.compute(stay, [{ ...food, basis, unitCost: null }], null)![1]!.quantity;
    expect([mk('per_stay'), mk('per_night'), mk('per_guest_per_stay'), mk(null)]).toEqual([1, 3, 2, 1]);
  });
});

describe('zonedTimeToUtc', () => {
  it('converts the property check-in time to UTC', () => {
    expect(zonedTimeToUtc('2027-02-14', '14:00', 'Asia/Almaty').toISOString()).toBe('2027-02-14T09:00:00.000Z');
    expect(zonedTimeToUtc('2027-02-14', '14:00', 'UTC').toISOString()).toBe('2027-02-14T14:00:00.000Z');
  });
});
