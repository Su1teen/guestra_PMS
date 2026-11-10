import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CrmSyncService } from './crm-sync.service';

const propertyId = '10000000-0000-4000-8000-000000000001', reservationId = '30000000-0000-4000-8000-000000000003';
const dto = { propertyId, customerId: 'customer_1', confirmationId: 'document_1', kind: 'proposal', confirmedBy: 'guest', confirmedAt: '2027-01-02T10:00:00.000Z' };

function setup(rows: any[][]) {
  const queue = [...rows];
  const builder: any = { from: () => builder, where: () => builder, limit: () => builder, for: () => builder,
    then: (r: any) => Promise.resolve(queue.shift() ?? []).then(r) };
  const writes: any[] = [];
  const tx = { select: vi.fn(() => builder), update: vi.fn(() => ({ set: (v: any) => ({ where: async () => writes.push(v) }) })),
    insert: vi.fn(() => ({ values: (v: any) => { writes.push(v); return { onConflictDoNothing: async () => undefined, then: (r: any) => Promise.resolve().then(r) }; } })) };
  const webhooks = { emit: vi.fn() };
  const service = new CrmSyncService({ transaction: async (work: any) => work(tx) } as any, {} as any, {} as any, webhooks as any, {} as any);
  return { service, writes, webhooks };
}

describe('guest confirmation of booking details from a CRM chat', () => {
  it('stamps every room of the booking, audits it and emits reservation.details_confirmed', async () => {
    const { service, writes, webhooks } = setup([[{ id: reservationId, bookingId: 'b1', guestId: 'guest-1', detailsConfirmationRef: null }], [{ localEntityId: 'guest-1' }]]);
    await expect(service.confirmDetails(reservationId, dto as any)).resolves.toMatchObject({ detailsConfirmed: true, duplicate: false });
    expect(writes[0]).toMatchObject({ detailsConfirmedBy: 'guest', detailsConfirmationRef: 'document_1' });
    expect(writes[0].detailsConfirmedAt.toISOString()).toBe('2027-01-02T10:00:00.000Z');
    expect(writes[1]).toMatchObject({ action: 'details_confirmed', entityId: reservationId });
    expect(webhooks.emit).toHaveBeenCalledWith('reservation.details_confirmed', 'reservation', reservationId, expect.objectContaining({ bookingId: 'b1' }), propertyId);
  });
  it('is idempotent per CRM confirmation', async () => {
    const { service, webhooks } = setup([[{ id: reservationId, bookingId: 'b1', guestId: 'guest-1', detailsConfirmationRef: 'document_1' }], [{ localEntityId: 'guest-1' }]]);
    await expect(service.confirmDetails(reservationId, dto as any)).resolves.toMatchObject({ duplicate: true });
    expect(webhooks.emit).not.toHaveBeenCalled();
  });
  it('refuses a customer linked to another guest and an unknown stay', async () => {
    await expect(setup([[{ id: reservationId, bookingId: 'b1', guestId: 'guest-1' }], [{ localEntityId: 'guest-2' }]]).service
      .confirmDetails(reservationId, dto as any)).rejects.toThrow(ConflictException);
    await expect(setup([[]]).service.confirmDetails(reservationId, dto as any)).rejects.toThrow(NotFoundException);
  });
});
