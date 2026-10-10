import { describe, expect, it, vi } from 'vitest';
import { calculateCanonicalRoomPricing } from './canonical-room-pricing';
describe('dated canonical room pricing', () => {
  it('evaluates every stay date while preserving whole-stay LOS and tax context', async () => {
    const rates: any = { calculateDerivedRate: vi.fn(async (_id: string, _property: string, context: any) => ({ effectiveRate: context.stayDate === '2026-10-10' ? '100.01' : '200.02', currency: 'KZT' })) };
    const taxes: any = { calculateTaxes: vi.fn().mockResolvedValue([{ amount: '10.00' }]) };
    const quote = await calculateCanonicalRoomPricing({ propertyId: 'hotel-a', ratePlanId: 'rate-a', checkIn: '2026-10-10', checkOut: '2026-10-12', nights: 2, isTaxInclusive: false, ratePlanService: rates, taxService: taxes });
    expect(quote.lineItems.map(n => n.rate)).toEqual(['100.01','200.02']);
    expect(quote.roomTotal).toBe('300.03'); expect(quote.totalAmount).toBe('320.03');
    expect(rates.calculateDerivedRate.mock.calls.map((c: any[]) => c[2])).toEqual([
      { nights: 2, checkIn: '2026-10-10', checkOut: '2026-10-12', stayDate: '2026-10-10' },
      { nights: 2, checkIn: '2026-10-10', checkOut: '2026-10-12', stayDate: '2026-10-11' },
    ]);
    expect(taxes.calculateTaxes.mock.calls[1][4]).toEqual({ numberOfNights: 2, nightNumber: 2 });
  });
});
