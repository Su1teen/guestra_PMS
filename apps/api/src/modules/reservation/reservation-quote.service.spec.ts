import { ReservationQuoteService } from './reservation-quote.service';
import { ReservationQuoteDto } from './dto/reservation-quote.dto';
import { validate } from 'class-validator';
describe('staff reservation quote', () => {
  const input = { propertyId: 'hotel-a', roomTypeId: 'rt-a', ratePlanId: 'rp-a', checkIn: '2026-10-10', checkOut: '2026-10-12' };
  let rates: any; let taxes: any; let availability: any; let service: ReservationQuoteService;
  beforeEach(() => {
    rates = { findById: vi.fn().mockResolvedValue({ roomTypeId: 'rt-a', isTaxInclusive: false }), assertSellable: vi.fn(), calculateDerivedRate: vi.fn().mockResolvedValue({ effectiveRate: 1200.01, currency: 'KZT' }) };
    taxes = { calculateTaxes: vi.fn().mockResolvedValue([{ amount: '120.00' }]) };
    availability = { searchAvailability: vi.fn().mockResolvedValue([{ roomTypeId: 'rt-a', date: '2026-10-10', available: 1 }, { roomTypeId: 'rt-a', date: '2026-10-11', available: 1 }]) };
    service = new ReservationQuoteService(rates, taxes, availability, { findById: vi.fn() } as any);
  });
  it('prices with canonical decimal amounts and scopes every call to the requesting property', async () => {
    const quote = await service.quote(input);
    expect(quote.totalAmount).toBe('2640.02');
    expect(quote.roomTotal).toBe('2400.02');
    expect(quote.taxTotal).toBe('240.00');
    expect(rates.findById).toHaveBeenCalledWith('rp-a', 'hotel-a');
    expect(availability.searchAvailability).toHaveBeenCalledWith('hotel-a', input.checkIn, input.checkOut, 'rt-a');
    expect(taxes.calculateTaxes.mock.calls.every((args: any[]) => args[2] === 'hotel-a')).toBe(true);
  });
  it('rejects a tariff from another room category before calculating', async () => {
    rates.findById.mockResolvedValue({ roomTypeId: 'rt-b' });
    await expect(service.quote(input)).rejects.toThrow('Rate plan does not apply');
    expect(rates.calculateDerivedRate).not.toHaveBeenCalled();
  });
  it('rejects incomplete availability and a closed rate', async () => {
    availability.searchAvailability.mockResolvedValue([{ roomTypeId: 'rt-a', date: '2026-10-10', available: 1 }]);
    await expect(service.quote(input)).rejects.toThrow('No availability');
    rates.assertSellable.mockRejectedValue(new Error('Stop sell'));
    await expect(service.quote(input)).rejects.toThrow('Stop sell');
    expect(rates.calculateDerivedRate).not.toHaveBeenCalled();
  });
  it('validates real calendar dates and positive stay windows', async () => {
    const valid = { propertyId: 'a0000001-0000-4000-a000-000000000001', roomTypeId: 'a0000002-0000-4000-a000-000000000001', ratePlanId: 'a0000003-0000-4000-a000-000000000001', checkIn: '2026-10-10', checkOut: '2026-10-12' };
    expect(await validate(Object.assign(new ReservationQuoteDto(), valid))).toHaveLength(0);
    for (const changes of [{ checkIn: '2026-02-30' }, { checkOut: '2026-10-09' }, { checkIn: '2026-10-10T00:00:00Z' }]) {
      expect((await validate(Object.assign(new ReservationQuoteDto(), valid, changes))).length).toBeGreaterThan(0);
    }
  });
});
