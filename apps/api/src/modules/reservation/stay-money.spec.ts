import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { StayMoneyService } from './stay-money.service';

function queryDb(results: any[][]) {
  const queue = [...results];
  const chain: any = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'for', 'set', 'values', 'returning', 'innerJoin']) chain[m] = () => chain;
  chain.then = (resolve: any, reject: any) => Promise.resolve(queue.shift() ?? []).then(resolve, reject);
  const inserts: any[] = [];
  const db: any = { select: () => chain, update: () => chain, insert: () => ({ values: (v: any) => { inserts.push(v); return Promise.resolve(); } }) };
  return { db, inserts };
}

const stay = { id: 'r1', propertyId: 'p1', bookingId: 'b1', status: 'cancelled', currencyCode: 'KZT', arrivalDate: '2027-02-14' };
const paid = { id: 'pay1', amount: '50000.00', status: 'captured', originalPaymentId: null };
const property = { timezone: 'Asia/Almaty', checkInTime: '14:00', settings: {} };

describe('StayMoneyService', () => {
  it('suggests retaining the prepayment when cancelled less than 24 hours before arrival', async () => {
    const { db } = queryDb([[stay], [{ id: 'f1' }], [paid], [], [property]]);
    const svc = new StayMoneyService(db, {} as any, {} as any, {} as any, {} as any);
    const advice = await svc.cancellationAdvice('r1', 'p1', new Date('2027-02-13T21:00:00Z')); // 12 h before 14:00 Almaty
    expect(advice).toMatchObject({ late: true, hoursBeforeArrival: 12, suggestion: 'retain_prepayment', available: '50000.00' });
  });

  it('does not suggest a penalty for an early cancellation', async () => {
    const { db } = queryDb([[stay], [{ id: 'f1' }], [paid], [], [property]]);
    const svc = new StayMoneyService(db, {} as any, {} as any, {} as any, {} as any);
    const advice = await svc.cancellationAdvice('r1', 'p1', new Date('2027-02-10T09:00:00Z'));
    expect(advice).toMatchObject({ late: false, suggestion: 'refund_or_keep' });
  });

  it('retains as a fee charge plus a penalty row, never more than was received', async () => {
    const { db, inserts } = queryDb([[stay], [{ id: 'f1' }], [paid], [], [stay], [{ id: 'f1' }], [paid], [{ amount: '50000.00' }]]);
    const folios = { postCharge: vi.fn(async () => ({ id: 'ch1' })) };
    const webhooks = { emit: vi.fn() };
    const svc = new StayMoneyService(db, {} as any, folios as any, {} as any, webhooks as any);
    const result = await svc.retainPrepayment('r1', 'p1', { reason: 'Отмена за 12 часов' }, { userId: 'u1' } as any, new Date('2027-02-13T21:00:00Z'));
    expect(folios.postCharge).toHaveBeenCalledWith('f1', expect.objectContaining({ type: 'fee', amount: '50000.00', serviceDate: '2027-02-13' }));
    expect(inserts[0]).toMatchObject({ kind: 'penalty', category: 'penalty', amount: '50000.00', sourceId: 'ch1', actorId: 'u1' });
    expect(result.money.available).toBe('0.00');
    const again = queryDb([[stay], [{ id: 'f1' }], [paid], []]);
    await expect(new StayMoneyService(again.db, {} as any, folios as any, {} as any, webhooks as any)
      .retainPrepayment('r1', 'p1', { reason: 'x', amount: '60000' })).rejects.toThrow(BadRequestException);
  });

  it('requires a reason and a cancelled stay', async () => {
    const svc = new StayMoneyService(queryDb([]).db, {} as any, {} as any, {} as any, {} as any);
    await expect(svc.cancel('r1', 'p1', { reason: ' ' })).rejects.toThrow(BadRequestException);
    const open = queryDb([[{ ...stay, status: 'confirmed' }], [{ id: 'f1' }], [paid], []]);
    await expect(new StayMoneyService(open.db, {} as any, {} as any, {} as any, {} as any)
      .retainPrepayment('r1', 'p1', { reason: 'x' })).rejects.toThrow(ConflictException);
  });

  it('refunds as its own row and keeps the original payment', async () => {
    const { db, inserts } = queryDb([[{ ...stay, status: 'confirmed' }], [{ id: 'f1' }], [paid], [], [{ ...stay, status: 'confirmed' }], [{ id: 'f1' }], [paid], []]);
    const payments = { refundPayment: vi.fn(async () => ({ id: 'ref1' })) };
    const svc = new StayMoneyService(db, {} as any, {} as any, payments as any, {} as any);
    const result = await svc.refund('r1', 'p1', { paymentId: 'pay1', amount: '20000', reason: 'Перенос отменён' }, undefined, new Date('2027-02-01T10:00:00Z'));
    expect(payments.refundPayment).toHaveBeenCalledWith('pay1', 'p1', '20000.00', expect.objectContaining({ idempotencyKey: expect.stringContaining('stay-refund:r1:pay1') }));
    expect(inserts[0]).toMatchObject({ kind: 'refund', amount: '-20000.00', sourceId: 'ref1' });
    expect(result.refunded).toBe('20000.00');
  });
});
