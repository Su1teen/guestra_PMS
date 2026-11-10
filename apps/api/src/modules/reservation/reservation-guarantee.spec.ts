import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReservationGuaranteeService } from './reservation-guarantee.service';
import { splitProportionally, staffRequestFingerprint } from './staff-reservation.service';

const now = new Date('2027-01-10T10:00:00.000Z');

describe('ReservationGuaranteeService.holdTerms', () => {
  it('asks for the default 50% prepayment when the hotel configured nothing', () => {
    expect(ReservationGuaranteeService.holdTerms(null, '100000.00', {}, now)).toEqual({ optionUntil: null, requiredDeposit: '50000.00' });
    expect(ReservationGuaranteeService.holdTerms({ depositPercentage: 0 }, '100000.00', {}, now).requiredDeposit).toBe('0.00');
  });

  it('derives deadline and guarantee from property settings', () => {
    const terms = ReservationGuaranteeService.holdTerms({ optionHoldHours: 48, depositPercentage: 30 }, '100000.00', {}, now);
    expect(terms.optionUntil?.toISOString()).toBe('2027-01-12T10:00:00.000Z');
    expect(terms.requiredDeposit).toBe('30000.00');
  });

  it('lets staff override or clear both terms', () => {
    const settings = { optionHoldHours: 48, depositPercentage: 30 };
    const custom = ReservationGuaranteeService.holdTerms(settings, '100000.00', { optionUntil: '2027-01-11T09:00:00.000Z', requiredDeposit: '5000' }, now);
    expect(custom.optionUntil?.toISOString()).toBe('2027-01-11T09:00:00.000Z');
    expect(custom.requiredDeposit).toBe('5000.00');
    expect(ReservationGuaranteeService.holdTerms(settings, '100000.00', { optionUntil: null, requiredDeposit: null }, now))
      .toEqual({ optionUntil: null, requiredDeposit: null });
  });

  it('rejects a past deadline and a guarantee above the total', () => {
    expect(() => ReservationGuaranteeService.holdTerms(null, '100.00', { optionUntil: '2027-01-01T00:00:00Z' }, now)).toThrow(BadRequestException);
    expect(() => ReservationGuaranteeService.holdTerms(null, '100.00', { requiredDeposit: '100.01' }, now)).toThrow(BadRequestException);
  });

  it('caps the percentage at the stay total', () => {
    expect(ReservationGuaranteeService.holdTerms({ depositPercentage: 150 }, '80.00', {}, now).requiredDeposit).toBe('80.00');
  });
});

describe('ReservationGuaranteeService.confirm', () => {
  const service = (row: any) => {
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => (row ? [row] : []) }) }) }),
      update: vi.fn(() => ({ set: (values: any) => ({ where: () => ({ returning: async () => [{ ...row, ...values }] }) }) })),
      insert: vi.fn(() => ({ values: async () => undefined })),
    };
    const db = {
      transaction: async (work: any) => work(tx),
      select: () => ({ from: () => ({ where: async () => [{ settings: { autoSendConfirmation: false } }] }) }),
    };
    const outbox = { persist: vi.fn(), deliver: vi.fn() };
    const confirmation = { send: vi.fn() };
    return { svc: new ReservationGuaranteeService(db as any, outbox as any, {} as any, {} as any, confirmation as any, {} as any, {} as any), tx, outbox, confirmation };
  };

  it('requires a reason to confirm without a guarantee', async () => {
    const { svc } = service({ id: 'r1', propertyId: 'p1', status: 'pending' });
    await expect(svc.confirm('r1', 'p1', { guaranteeType: 'none' })).rejects.toThrow(BadRequestException);
  });

  it('moves a stay holding a room straight to assigned and emits reservation.confirmed', async () => {
    const { svc, outbox, confirmation } = service({ id: 'r1', propertyId: 'p1', bookingId: 'b1', status: 'pending', roomId: 'room-1' });
    const result = await svc.confirm('r1', 'p1', { guaranteeType: 'card' }, { userId: 'u1' } as any);
    expect(result.status).toBe('assigned');
    expect(result.guaranteeType).toBe('card');
    expect(outbox.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'reservation.confirmed' }), 'reservation:r1:confirmed');
    expect(outbox.deliver).toHaveBeenCalledWith('p1', 'reservation:r1:confirmed');
    expect(confirmation.send).not.toHaveBeenCalled(); // auto-send switched off for this property
  });

  it('refuses to confirm twice', async () => {
    const { svc } = service({ id: 'r1', propertyId: 'p1', status: 'confirmed' });
    await expect(svc.confirm('r1', 'p1', {})).rejects.toThrow(ConflictException);
  });
});

describe('group helpers', () => {
  it('splits a group guarantee by room price without losing cents', () => {
    expect(splitProportionally('100.00', ['1', '1', '1'])).toEqual(['33.33', '33.33', '33.34']);
    expect(splitProportionally('50.00', ['30000.00', '10000.00'])).toEqual(['37.50', '12.50']);
    expect(splitProportionally('10.00', ['0', '0'])).toEqual(['0.00', '10.00']);
  });

  it('keeps the fingerprint of requests that do not use the new fields', () => {
    const dto: any = { propertyId: 'p', guestId: 'g', roomTypeId: 't', ratePlanId: 'r', checkIn: '2027-01-01', checkOut: '2027-01-02',
      requestId: 'q', expectedTotal: '10', currencyCode: 'KZT' };
    const legacy = staffRequestFingerprint(dto);
    expect(staffRequestFingerprint({ ...dto })).toBe(legacy);
    expect(staffRequestFingerprint({ ...dto, childAges: [4] })).not.toBe(legacy);
    expect(staffRequestFingerprint({ ...dto, confirmation: 'confirmed' })).not.toBe(legacy);
  });
});

/** Chainable query stub: every builder call returns itself, awaiting yields the next queued result. */
function queryDb(results: any[][]) {
  const queue = [...results];
  const chain: any = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'for', 'set', 'values', 'returning']) chain[m] = () => chain;
  chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  const inserts: any[] = [];
  const db: any = {
    select: () => chain, update: () => chain,
    insert: () => ({ values: (v: any) => { inserts.push(v); return Promise.resolve(); } }),
    transaction: async (work: any) => work(db),
  };
  return { db, inserts };
}

describe('manual prepayment and option handling', () => {
  const pending = { id: 'r1', propertyId: 'p1', bookingId: 'b1', guestId: 'g1', status: 'pending', currencyCode: 'KZT',
    totalAmount: '100000.00', requiredDeposit: '50000.00', optionUntil: new Date('2027-01-11T10:00:00Z') };

  it('records the prepayment as a captured folio payment and returns the confirmation outcome', async () => {
    const { db, inserts } = queryDb([[pending], [{ status: 'assigned' }]]);
    const folios = { createAutoFolio: vi.fn(async () => ({ id: 'f1' })) };
    const payments = { recordPayment: vi.fn(async () => ({ id: 'pay1' })) };
    const svc = new ReservationGuaranteeService(db, {} as any, {} as any, {} as any, {} as any, folios as any, payments as any);
    const confirmIfGuaranteed = vi.spyOn(svc, 'confirmIfGuaranteed').mockResolvedValue({ confirmed: 1, paid: '50000.00', required: '50000.00' } as any);
    vi.spyOn(svc, 'paidForBooking').mockResolvedValue(new (await import('decimal.js')).default('50000'));
    const result = await svc.recordPrepayment('r1', 'p1', { amount: '50000', method: 'bank_transfer', reference: 'ПП 17' }, { userId: 'u1' } as any);
    expect(payments.recordPayment).toHaveBeenCalledWith(expect.objectContaining({ folioId: 'f1', propertyId: 'p1', method: 'bank_transfer',
      amount: '50000.00', currencyCode: 'KZT', notes: 'Предоплата (отмечена вручную): ПП 17' }));
    expect(confirmIfGuaranteed).toHaveBeenCalledWith('r1', 'p1');
    expect(inserts[0]).toMatchObject({ action: 'prepayment_recorded', entityId: 'r1' });
    expect(result).toMatchObject({ paymentId: 'pay1', confirmed: true, status: 'assigned', paid: '50000.00' });
  });

  it('refuses a prepayment on a cancelled stay and an unknown tender', async () => {
    const { db } = queryDb([[{ ...pending, status: 'cancelled' }]]);
    const svc = new ReservationGuaranteeService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(svc.recordPrepayment('r1', 'p1', { amount: '10', method: 'cash' })).rejects.toThrow(ConflictException);
    await expect(svc.recordPrepayment('r1', 'p1', { amount: '10', method: 'vcc' as any })).rejects.toThrow(BadRequestException);
    await expect(svc.recordPrepayment('r1', 'p1', { amount: '0', method: 'cash' })).rejects.toThrow(BadRequestException);
  });

  it('extends the option deadline with an audit entry', async () => {
    const until = '2027-01-12T10:00:00.000Z';
    const { db, inserts } = queryDb([[pending], [pending], [{ ...pending, optionUntil: new Date(until) }]]);
    const svc = new ReservationGuaranteeService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const result = await svc.changeOption('r1', 'p1', { optionUntil: until }, undefined, now);
    expect(result.updated).toBe(1);
    expect(inserts[0]).toMatchObject({ action: 'option_changed', description: 'Срок опции изменён' });
    await expect(svc.changeOption('r1', 'p1', { optionUntil: '2027-01-01T00:00:00Z' }, undefined, now)).rejects.toThrow(BadRequestException);
    await expect(svc.changeOption('r1', 'p1', {}, undefined, now)).rejects.toThrow(BadRequestException);
  });

  it('releases every unconfirmed room of the booking by hand', async () => {
    const { db, inserts } = queryDb([[pending], [pending, { ...pending, id: 'r2' }]]);
    const reservationService = { cancel: vi.fn(async () => ({})) };
    const svc = new ReservationGuaranteeService(db, {} as any, {} as any, reservationService as any, {} as any, {} as any, {} as any);
    const result = await svc.releaseOption('r1', 'p1', { wholeBooking: true });
    expect(result.released).toBe(2);
    expect(reservationService.cancel).toHaveBeenCalledWith('r2', 'p1', { cancellationReason: 'Опция снята вручную: гарантия не получена' });
    expect(inserts.map((i) => i.action)).toEqual(['option_released', 'option_released']);
  });

  it('reminds the guest with the proposal marked as a reminder, only while unconfirmed', async () => {
    const confirmation = { send: vi.fn(async () => ({ sent: true })) };
    const { db } = queryDb([[{ status: 'pending' }], [{ status: 'assigned' }]]);
    const svc = new ReservationGuaranteeService(db, {} as any, {} as any, {} as any, confirmation as any, {} as any, {} as any);
    await svc.remindGuest('r1', 'p1', { channel: 'sms' });
    expect(confirmation.send).toHaveBeenCalledWith('r1', 'p1', { kind: 'proposal', channel: 'sms', to: undefined, reminder: true }, undefined);
    await expect(svc.remindGuest('r1', 'p1', {})).rejects.toThrow(ConflictException);
  });

  it('only reminds staff when an option expires unless the hotel chose release', async () => {
    const webhooks = { emit: vi.fn() };
    const { db } = queryDb([[{ settings: null }], [pending]]);
    const svc = new ReservationGuaranteeService(db, {} as any, webhooks as any, { cancel: vi.fn() } as any, {} as any, {} as any, {} as any);
    const result = await svc.sweepExpiredOptions('p1', new Date('2027-01-12T00:00:00Z'));
    expect(result).toMatchObject({ action: 'notify', notified: 1, cancelled: 0 });
    expect(webhooks.emit).toHaveBeenCalledWith('reservation.option_expired', 'reservation', 'r1', expect.anything(), 'p1');
  });
});
