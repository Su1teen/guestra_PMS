import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rateMutationFences } from '@telivityhaip/database';
import { RatePlanService } from './rate-plan.service';

const A = 'aaaaaaaa-0000-4000-a000-000000000001';
const guard = { requestId: randomUUID(), expectedRevision: 1, reason: 'Ownership check' };
const property = { id: A, currencyCode: 'USD', settings: {} };
const fence = { actorKey: 'auth-off', fingerprint: '', status: 'running' };

function setup(results: any[]) {
  const queries = [...results];
  const db: any = {
    select: vi.fn(() => {
      const result = queries.shift();
      const chain: any = { from: () => chain, where: () => chain, for: () => chain,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
      return chain;
    }),
    insert: vi.fn(() => ({ values: (value: any) => ({ onConflictDoNothing: async () => { fence.fingerprint = value.fingerprint; } }) })),
    update: vi.fn(),
  };
  db.transaction = async (work: any) => work(db);
  const outbox = { persist: vi.fn() };
  return { db, svc: new RatePlanService(db, outbox as any), outbox };
}

describe('RatePlanService — cross-tenant FK ownership', () => {
  it('update() rejects when dto.parentRatePlanId belongs to another property', async () => {
    const before = { id: 'rp-1', propertyId: A, revision: 1, baseAmount: '100.00', currencyCode: 'USD' };
    const { db, svc, outbox } = setup([[property], [fence], [before], [property], [property], []]);

    await expect(
      svc.update('rp-1', A, { ...guard, parentRatePlanId: 'foreign-rp' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.select).toHaveBeenCalledTimes(6);
    expect(db.update).not.toHaveBeenCalled();
    expect(outbox.persist).not.toHaveBeenCalled();
  });

  it('rejects when dto.roomTypeId belongs to another property', async () => {
    const { db, svc, outbox } = setup([[property], [fence], [property], [property], []]);

    await expect(
      svc.create({
        ...guard, expectedRevision: 0,
        propertyId: A,
        roomTypeId: 'foreign-rt',
        name: 'BAR',
        code: 'BAR',
        type: 'bar',
        baseAmount: '100.00',
        currencyCode: 'USD',
      } as any),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.select).toHaveBeenCalledTimes(5);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledWith(rateMutationFences);
    expect(outbox.persist).not.toHaveBeenCalled();
  });
});
