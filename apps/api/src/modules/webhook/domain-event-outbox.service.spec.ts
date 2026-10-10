import { describe, expect, it, vi } from 'vitest';
import { DomainEventOutboxService } from './domain-event-outbox.service';
describe('committed event recovery', () => {
  function harness(fail = false, pending = true) {
    const values: any[] = [];
    const row = { id: 'row', logicalEventId: 'stable', attempts: 1, payload: { event: 'reservation.created', propertyId: 'hotel-a' } };
    const tx: any = { select: () => ({ from: () => ({ where: () => ({ for: async () => pending ? [row] : [] }) }) }),
      update: () => ({ set: (value: any) => { values.push(value); return { where: vi.fn() }; } }) };
    const webhooks: any = { dispatchPersisted: fail ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn() };
    return { values, webhooks, service: new DomainEventOutboxService({ transaction: async (fn: any) => fn(tx) } as any, webhooks) };
  }
  it('retains failed consequences with a bounded retry time rather than rolling back the stay', async () => {
    const h = harness(true); await expect(h.service.deliver('hotel-a', 'stable')).resolves.toBeUndefined();
    expect(h.values[0]).toMatchObject({ attempts: 2, availableAt: expect.any(Date) });
    expect(h.values[0].deliveredAt).toBeUndefined();
  });
  it('reuses the immutable event id and marks successful delivery', async () => {
    const h = harness(); await h.service.deliver('hotel-a', 'stable');
    expect(h.webhooks.dispatchPersisted).toHaveBeenCalledWith(expect.any(Object), 'stable');
    expect(h.values[0]).toMatchObject({ deliveredAt: expect.any(Date), attempts: 2 });
  });
  it('does not redispatch a delivered or concurrently locked event', async () => {
    const h = harness(false, false); await h.service.deliver('hotel-a', 'stable');
    expect(h.webhooks.dispatchPersisted).not.toHaveBeenCalled(); expect(h.values).toEqual([]);
  });
});
