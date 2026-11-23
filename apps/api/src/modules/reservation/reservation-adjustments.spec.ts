import { describe, expect, it, vi } from 'vitest';
import { ReservationAdjustmentsService } from './reservation-adjustments.service';

function db(row: Record<string, unknown>) {
  const inserted: any[] = []; const updates: any[] = [];
  const chain = (value: any) => { const c: any = { from: () => c, where: () => c, for: () => Promise.resolve(value), set: (v: any) => { updates.push(v); return c; }, returning: () => Promise.resolve([{ ...row, ...updates.at(-1) }]) }; return c; };
  const tx = { select: () => chain([row]), update: () => chain([row]), insert: () => ({ values: (v: any) => { inserted.push(v); return Promise.resolve(); } }) };
  return { inserted, updates, db: { transaction: (fn: any) => fn(tx) } };
}
const actor = { userId: 'u-rop', userEmail: 'rop@les.kz' } as any;

describe('price type and closed-stay corrections', () => {
  it('marks a stay as barter only with a reason and counterparty, and audits who allowed it', async () => {
    const t = db({ id: 'r1', propertyId: 'p', status: 'confirmed', priceType: 'standard' });
    const svc = new ReservationAdjustmentsService(t.db as any, { onModified: vi.fn() } as any);
    await expect(svc.setPriceType('r1', 'p', { priceType: 'barter', reason: 'Блогер' }, actor)).rejects.toThrow(/counterparty/);
    const row = await svc.setPriceType('r1', 'p', { priceType: 'barter', reason: 'Обзор в Instagram', counterparty: 'ИП Блогер' }, actor);
    expect(row).toMatchObject({ priceType: 'barter', priceTypeCounterparty: 'ИП Блогер', priceTypeApprovedBy: 'u-rop' });
    expect(t.inserted[0]).toMatchObject({ action: 'price_type_set', entityId: 'r1', description: 'Бартер: Обзор в Instagram' });
  });

  it('corrects only a closed stay, with a reason, and records before / after', async () => {
    const open = db({ id: 'r1', propertyId: 'p', status: 'confirmed', totalAmount: '100000.00' });
    const allocations = { onModified: vi.fn() };
    await expect(new ReservationAdjustmentsService(open.db as any, allocations as any).correctClosed('r1', 'p', { reason: 'Ошибка', totalAmount: '90000' }, actor)).rejects.toThrow(/normal change/);
    const closed = db({ id: 'r1', propertyId: 'p', status: 'checked_out', totalAmount: '100000.00' });
    await new ReservationAdjustmentsService(closed.db as any, allocations as any).correctClosed('r1', 'p', { reason: 'Ошибка в сумме', totalAmount: '90000' }, actor);
    expect(closed.inserted[0]).toMatchObject({ action: 'closed_corrected', previousValue: { totalAmount: '100000.00' }, newValue: { totalAmount: '90000.00' } });
    expect(allocations.onModified).toHaveBeenCalled();
  });
});
