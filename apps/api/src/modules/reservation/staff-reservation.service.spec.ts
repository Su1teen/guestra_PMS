import { describe, expect, it, vi } from 'vitest';
import { StaffReservationService, staffRequestFingerprint } from './staff-reservation.service';
describe('staff booking replay', () => {
  const dto = { propertyId: 'hotel-a', guestId: 'guest-a', roomTypeId: 'type-a', ratePlanId: 'rate-a', checkIn: '2026-10-10', checkOut: '2026-10-12', requestId: 'request-a', expectedTotal: '10.00', currencyCode: 'KZT' };
  function harness(changed = false) {
    const tx: any = { execute: vi.fn(), select: () => ({ from: () => ({ innerJoin: () => ({ where: async () => [{ booking: { integrationContext: { staffRequestFingerprint: changed ? 'other' : staffRequestFingerprint(dto) } }, reservation: { id: 'same-stay', status: 'confirmed' } }] }) }) }) };
    const rates: any = { findById: vi.fn() }; const outbox: any = { persist: vi.fn(), deliver: vi.fn() };
    const service = new StaffReservationService({ transaction: async (fn: any) => fn(tx) } as any, {} as any, rates, {} as any, outbox);
    return { service, rates, outbox };
  }
  it('replays before repricing or checking availability and still retries the committed consequence', async () => {
    const h = harness(); expect(await h.service.create(dto)).toMatchObject({ id: 'same-stay', replayed: true });
    expect(h.rates.findById).not.toHaveBeenCalled(); expect(h.outbox.persist).not.toHaveBeenCalled();
    expect(h.outbox.deliver).toHaveBeenCalledWith('hotel-a','staff-reservation:request-a');
  });
  it('rejects reuse of a request key with different details before touching price or inventory', async () => {
    const h = harness(true); await expect(h.service.create(dto)).rejects.toMatchObject({ response: { code: 'REQUEST_CHANGED' } });
    expect(h.rates.findById).not.toHaveBeenCalled(); expect(h.outbox.deliver).not.toHaveBeenCalled();
  });
  it('normalizes decimal inputs but distinguishes the hotel, party, dates and physical room', () => {
    const fingerprint = staffRequestFingerprint(dto);
    expect(staffRequestFingerprint({ ...dto, expectedTotal: '10' })).toBe(fingerprint);
    for (const change of [{ propertyId: 'hotel-b' }, { adults: 2 }, { checkOut: '2026-10-13' }, { roomId: 'room-b' }]) expect(staffRequestFingerprint({ ...dto, ...change })).not.toBe(fingerprint);
  });
});
