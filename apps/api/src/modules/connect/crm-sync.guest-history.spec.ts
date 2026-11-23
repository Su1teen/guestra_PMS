import { describe, expect, it, vi } from 'vitest';
import { CrmSyncService } from './crm-sync.service';

const propertyId = '10000000-0000-4000-8000-000000000001';

function setup(rows: any[][]) {
  const queue = [...rows]; const wheres: any[] = [];
  const builder: any = { from: () => builder, leftJoin: () => builder, orderBy: () => builder, limit: () => builder,
    where: (w: any) => { wheres.push(w); return builder; }, then: (r: any) => Promise.resolve(queue.shift() ?? []).then(r) };
  const db = { select: vi.fn(() => builder) };
  return { service: new CrmSyncService(db as any, {} as any, {} as any, {} as any, {} as any), db };
}

describe('PMS stay history of a CRM customer', () => {
  it('returns nothing for a customer without a recorded link at this property', async () => {
    const { service, db } = setup([[]]);
    await expect(service.guestHistory(propertyId, 'customer_1')).resolves.toMatchObject({ linked: false, guest: null, stays: [] });
    expect(db.select).toHaveBeenCalledTimes(1);
  });
  it('lists the linked guest stays with completed nights', async () => {
    const { service } = setup([[{ localEntityId: 'guest-1' }], [{ id: 'guest-1', firstName: 'Айгерим', guestTier: 'returning', privileges: 'Поздний выезд' }],
      [{ id: 'r2', arrivalDate: '2027-03-01', departureDate: '2027-03-04', status: 'checked_out' },
        { id: 'r1', arrivalDate: '2027-01-10', departureDate: '2027-01-12', status: 'checked_out' },
        { id: 'r3', arrivalDate: '2027-05-01', departureDate: '2027-05-03', status: 'confirmed' }]]);
    const history = await service.guestHistory(propertyId, 'customer_1');
    expect(history).toMatchObject({ linked: true, guest: { guestTier: 'returning' }, totals: { stays: 3, completedStays: 2, nights: 5 } });
    expect(history.stays.map((s: any) => s.id)).toEqual(['r2', 'r1', 'r3']);
  });
});
