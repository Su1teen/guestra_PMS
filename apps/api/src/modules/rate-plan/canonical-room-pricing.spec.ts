import { describe, expect, it, vi } from 'vitest';
import { calculateCanonicalRoomPricing } from './canonical-room-pricing';
import { TaxService } from '../tax/tax.service';

function harness(rules: any[], gross = '115.50', options = {}) {
  const taxes = new TaxService({});
  vi.spyOn(taxes, 'getActiveTaxProfile').mockResolvedValue({ rules } as any);
  const rates = { calculateDerivedRate: vi.fn().mockResolvedValue({ effectiveRate: gross, currency: 'KZT' }) };
  const input = { propertyId: 'hotel-a', ratePlanId: 'rate-a', checkIn: '2027-05-01', checkOut: '2027-05-03',
    nights: 2, isTaxInclusive: true, taxService: taxes, ratePlanService: rates as any, ...options };
  return { taxes, rates, input };
}
const percent = (rate: string, extra = {}) => ({ name: 'Tax', code: 'TAX', type: 'percentage', rate, ...extra });
describe('canonical room pricing', () => {
  it('back-calculates compounding and keeps gross unchanged', async () => {
    const h = harness([percent('10'), percent('5', { isCompounding: true })]);
    expect(await calculateCanonicalRoomPricing(h.input)).toMatchObject({ roomTotal: '200.00', taxTotal: '31.00', totalAmount: '231.00' });
    expect(h.rates.calculateDerivedRate.mock.calls.map(args => args[2])).toEqual([
      { nights: 2, checkIn: '2027-05-01', checkOut: '2027-05-03', stayDate: '2027-05-01' },
      { nights: 2, checkIn: '2027-05-01', checkOut: '2027-05-03', stayDate: '2027-05-02' },
    ]);
  });
  it('bills flat-per-night once per night and flat-per-stay once, retaining full LOS for exemptions', async () => {
    const h = harness([{ type: 'flat_per_night', rate: '2.50', name: 'Night', code: 'N' },
      { type: 'flat_per_stay', rate: '10.00', name: 'Stay', code: 'S' }], '112.50');
    h.rates.calculateDerivedRate.mockResolvedValueOnce({ effectiveRate: '112.50', currency: 'KZT' }).mockResolvedValueOnce({ effectiveRate: '102.50', currency: 'KZT' });
    expect(await calculateCanonicalRoomPricing(h.input)).toMatchObject({ roomTotal: '200.00', taxTotal: '15.00', totalAmount: '215.00' });
    // Existing aggregate charge API keeps N-night multiplication when there is no nightNumber.
    expect(await h.taxes.calculateTaxes('200.00', 'room', 'hotel-a', '2027-05-01', { numberOfNights: 2 })).toEqual([
      expect.objectContaining({ amount: '5.00' }), expect.objectContaining({ amount: '10.00' }),
    ]);
  });
  it('applies split components with the forward engine rounding', async () => {
    const h = harness([{ type: 'split_component', rate: '10', splitPercentage: '50', name: 'Split', code: 'S' }], '105.00');
    expect(await calculateCanonicalRoomPricing(h.input)).toMatchObject({ roomTotal: '200.00', taxTotal: '10.00', totalAmount: '210.00' });
  });
  it('applies a maximum-night cap and a full-stay exemption to inclusive tariffs', async () => {
    const h = harness([percent('10', { exemptions: { maxNights: 1 } }), percent('20', { exemptions: { minStayNights: 2 } })], '110.00');
    h.rates.calculateDerivedRate.mockResolvedValueOnce({ effectiveRate: '110.00', currency: 'KZT' }).mockResolvedValueOnce({ effectiveRate: '100.00', currency: 'KZT' });
    expect(await calculateCanonicalRoomPricing(h.input)).toMatchObject({ roomTotal: '200.00', taxTotal: '10.00', totalAmount: '210.00' });
  });
  it('honors guest exemptions using the same transaction connection', async () => {
    const h = harness([percent('10', { exemptions: { guestTypes: ['gold'] } })], '100.00');
    const tx = { select: vi.fn().mockReturnValue({ from: () => ({ where: async () => [{ vipLevel: 'gold' }] }) }) };
    const quote = await calculateCanonicalRoomPricing({ ...h.input, guestId: 'guest-a', db: tx });
    expect(quote).toMatchObject({ roomTotal: '200.00', taxTotal: '0.00', totalAmount: '200.00' });
    expect(h.taxes.getActiveTaxProfile).toHaveBeenCalledWith('hotel-a', '2027-05-01', tx);
  });
  it('uses the tax profile effective on each night', async () => {
    const h = harness([], '100.00');
    vi.mocked(h.taxes.getActiveTaxProfile).mockResolvedValueOnce({ rules: [percent('10')] } as any).mockResolvedValueOnce({ rules: [percent('20')] } as any);
    h.rates.calculateDerivedRate.mockResolvedValueOnce({ effectiveRate: '110.00', currency: 'KZT' }).mockResolvedValueOnce({ effectiveRate: '120.00', currency: 'KZT' });
    expect(await calculateCanonicalRoomPricing(h.input)).toMatchObject({ roomTotal: '200.00', taxTotal: '30.00', totalAmount: '230.00' });
  });
  it('rejects an impossible cent-rounded gross instead of changing financial totals', async () => {
    const h = harness([percent('100')], '0.01');
    await expect(calculateCanonicalRoomPricing(h.input)).rejects.toMatchObject({ response: { code: 'TAX_INCLUSIVE_NOT_REPRESENTABLE' } });
  });
});
