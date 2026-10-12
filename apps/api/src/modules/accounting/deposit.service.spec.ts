import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DepositService } from './deposit.service';

const entry = { id: 'dep-001', propertyId: 'prop-001', reservationId: 'res-001', amount: '200.00',
  currencyCode: 'USD', status: 'held', isRefundable: true };
const outbox = { persist: vi.fn(), deliver: vi.fn() };
const folio = { findById: vi.fn(), postCharge: vi.fn() };

function fakeDb(row: typeof entry | null = entry) {
  const chain = (rows: any[]) => {
    const q: any = { from: () => q, where: () => q, for: async () => rows, then: (resolve: any) => resolve(rows) };
    return q;
  };
  const db: any = {
    select: vi.fn(() => chain(row ? [row] : [])),
    insert: vi.fn(() => ({ values: () => ({ returning: async () => [row] }) })),
    update: vi.fn(() => ({ set: (update: any) => ({ where: () => ({ returning: async () => [{ ...row, ...update }] }) }) })),
  };
  db.transaction = async (work: (tx: any) => Promise<unknown>) => work(db);
  return db;
}

describe('DepositService state and provenance', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    folio.findById.mockResolvedValue({ id: 'folio-001', propertyId: 'prop-001', currencyCode: 'USD', reservationId: 'res-001', status: 'open' });
    folio.postCharge.mockResolvedValue({ id: 'charge-001', propertyId: 'prop-001', amount: '-200.00', type: 'adjustment',
      folioId: 'folio-001', sourceKey: 'deposit:dep-001:apply', revenueRole: 'deposit_credit' });
  });

  it('records a held liability with a durable event', async () => {
    const service = new DepositService(fakeDb(), outbox as any, folio as any);
    expect((await service.recordDeposit({ propertyId: 'prop-001', amount: '200', currencyCode: 'USD' })).status).toBe('held');
    expect(outbox.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'deposit.received' }), 'deposit:dep-001:received');
  });

  it('requires a property-scoped deposit', async () => {
    await expect(new DepositService(fakeDb(null), outbox as any, folio as any)
      .findById('dep-001', 'other-prop')).rejects.toThrow(NotFoundException);
  });

  it('posts an applied liability credit with immutable source, never public adjustment provenance', async () => {
    const db = fakeDb(); const service = new DepositService(db, outbox as any, folio as any);
    expect((await service.applyDeposit('dep-001', { propertyId: 'prop-001', folioId: 'folio-001' })).status).toBe('applied');
    expect(folio.postCharge).toHaveBeenCalledWith('folio-001', expect.objectContaining({ type: 'adjustment', amount: '-200.00', skipTaxCalculation: true }), db,
      { sourceKey: 'deposit:dep-001:apply', revenueRole: 'deposit_credit' });
    expect(outbox.persist).toHaveBeenCalledWith(db, expect.objectContaining({ event: 'deposit.applied' }), 'deposit:dep-001:applied');
  });

  it('replays same terminal state without reposting, but never permits a different transition', async () => {
    const service = new DepositService(fakeDb({ ...entry, status: 'applied' }), outbox as any, folio as any);
    await service.applyDeposit('dep-001', { propertyId: 'prop-001' });
    expect(folio.postCharge).not.toHaveBeenCalled();
    await expect(service.refundDeposit('dep-001', 'prop-001')).rejects.toThrow(BadRequestException);
  });

  it('refunds only a held refundable liability, not earned revenue', async () => {
    const service = new DepositService(fakeDb(), outbox as any, folio as any);
    expect((await service.refundDeposit('dep-001', 'prop-001')).status).toBe('refunded');
    expect(folio.postCharge).not.toHaveBeenCalled();
    expect(outbox.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'deposit.refunded' }), 'deposit:dep-001:refunded');
    await expect(new DepositService(fakeDb({ ...entry, isRefundable: false }), outbox as any, folio as any)
      .refundDeposit('dep-001', 'prop-001')).rejects.toThrow(BadRequestException);
  });

  it('forfeits a held liability as earned income once with a durable event', async () => {
    const service = new DepositService(fakeDb(), outbox as any, folio as any);
    expect((await service.forfeitDeposit('dep-001', 'prop-001')).status).toBe('forfeited');
    expect(outbox.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'deposit.forfeited' }), 'deposit:dep-001:forfeited');
  });
});
