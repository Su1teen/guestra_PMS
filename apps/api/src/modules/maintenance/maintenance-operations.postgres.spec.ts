import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import {
  properties,
  rooms,
  roomTypes,
  maintenanceTickets,
  auditLogs,
  domainEventOutbox,
  roomInventoryBlocks,
} from '@telivityhaip/database';
import { MaintenanceService } from './maintenance.service';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')(
  'Maintenance operations on real PostgreSQL',
  () => {
    const client = postgres(process.env.DATABASE_URL!, { max: 8 });
    const db = drizzle(client);
    const ids = {
      property: randomUUID(),
      other: randomUUID(),
      type: randomUUID(),
      room: randomUUID(),
    };
    const hook = {
      emit: vi.fn(),
      dispatchPersisted: vi.fn().mockResolvedValue(undefined),
    };
    const roomState = new RoomStatusService(db, hook as any);
    const outbox = new DomainEventOutboxService(db, hook as any);
    const service = new MaintenanceService(db, roomState, outbox);
    const dto = (extra: any = {}) => ({
      propertyId: ids.property,
      roomId: ids.room,
      category: 'plumbing',
      title: 'Проверка воды',
      description: 'Протечка',
      idempotencyKey: randomUUID(),
      ...extra,
    });
    const room = () => roomState.getRoomStatus(ids.room, ids.property);
    const rows = (table: any) =>
      db.select().from(table).where(eq(table.propertyId, ids.property));
    beforeAll(async () => {
      await db
        .insert(properties)
        .values(
          [ids.property, ids.other].map((id) => ({
            id,
            name: 'Maintenance SQL',
            code: id.slice(0, 8),
            countryCode: 'KZ',
            currencyCode: 'KZT',
            timezone: 'Asia/Almaty',
            totalRooms: 1,
          })),
        );
      await db
        .insert(roomTypes)
        .values({
          id: ids.type,
          propertyId: ids.property,
          code: 'MNT',
          name: 'Test',
          maxOccupancy: 2,
          defaultOccupancy: 2,
        });
      await db
        .insert(rooms)
        .values({
          id: ids.room,
          propertyId: ids.property,
          roomTypeId: ids.type,
          number: '1',
          status: 'guest_ready',
        });
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      hook.dispatchPersisted.mockResolvedValue(undefined);
      for (const table of [
        domainEventOutbox,
        auditLogs,
        roomInventoryBlocks,
        maintenanceTickets,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      await db
        .update(rooms)
        .set({ status: 'guest_ready' })
        .where(eq(rooms.id, ids.room));
    });
    afterAll(async () => {
      for (const table of [
        domainEventOutbox,
        auditLogs,
        roomInventoryBlocks,
        maintenanceTickets,
        rooms,
        roomTypes,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      for (const id of [ids.property, ids.other])
        await db.delete(properties).where(eq(properties.id, id));
      await client.end();
    });
    it('pages a scoped filtered queue without dropping rows beyond the old 500 limit',async()=>{
      await db.insert(maintenanceTickets).values(Array.from({length:505},(_,index)=>({propertyId:ids.property,roomId:ids.room,category:'other',title:'Очередь '+index,description:'Работа',priority:index%2?'high':'normal'})));
      const first=await service.page({propertyId:ids.property,page:1,limit:50});const last=await service.page({propertyId:ids.property,page:11,limit:50});
      expect(first.total).toBe(505);expect(first.data).toHaveLength(50);expect(last.data).toHaveLength(5);
      expect(new Set([...first.data,...last.data].map((row:any)=>row.ticket.id)).size).toBe(55);
      expect((await service.page({propertyId:ids.other})).total).toBe(0);
      expect((await service.page({propertyId:ids.property,priority:'high'})).total).toBe(252);
    });
    it('commits ticket, OOO, audit and durable events once for concurrent same-key create', async () => {
      const request = dto({ blocksInventory: true });
      const [a, b] = await Promise.all([
        service.create(request),
        service.create(request),
      ]);
      expect(a).toEqual(b);
      expect(await rows(maintenanceTickets)).toHaveLength(1);
      expect((await room()).status).toBe('out_of_order');
      expect(await rows(domainEventOutbox)).toHaveLength(2);
      expect(
        (await rows(auditLogs)).filter(
          (r: any) => r.entityType === 'maintenance_request',
        ),
      ).toHaveLength(1);
      expect((await service.findById(a.id, ids.property)).history).toHaveLength(
        1,
      );
    });
    it('rolls back the inserted ticket and room when outbox persistence fails', async () => {
      vi.spyOn(outbox, 'persist').mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );
      await expect(
        service.create(dto({ blocksInventory: true })),
      ).rejects.toThrow('outbox unavailable');
      expect(await rows(maintenanceTickets)).toHaveLength(0);
      expect(await rows(auditLogs)).toHaveLength(0);
      expect((await room()).status).toBe('guest_ready');
    });
    it('retains committed events after dispatch failure without returning a false booking failure', async () => {
      hook.dispatchPersisted.mockRejectedValue(new Error('consumer offline'));
      const ticket = await service.create(dto());
      expect(ticket.id).toBeTruthy();
      const [event] = await rows(domainEventOutbox);
      expect(event.deliveredAt).toBeNull();
      expect(event.attempts).toBe(1);
    });
    it('keeps a resolved room blocked until explicit return, then sends it to housekeeping', async () => {
      const ticket = await service.create(dto({ blocksInventory: true }));
      await service.update(ticket.id, ids.property, {
        status: 'resolved',
        resolution: 'Устранено',
      });
      expect((await room()).status).toBe('out_of_order');
      const returned = await service.confirmReturnToService(
        ticket.id,
        ids.property,
        'Проверено',
      );
      expect(returned.roomReturned).toBe(true);
      expect((await room()).status).toBe('vacant_dirty');
    });
    it('rejects the direct room-status return while a resolved repair still requires inspection', async () => {
      const ticket = await service.create(dto({ blocksInventory: true }));
      await service.update(ticket.id, ids.property, {
        status: 'resolved',
        resolution: 'Устранено',
      });
      await expect(
        roomState.markBackInService(ids.room, ids.property),
      ).rejects.toMatchObject({ status: 409 });
      expect((await room()).status).toBe('out_of_order');
    });
    it('clears only the acknowledged ticket and preserves another blocking repair', async () => {
      const first = await service.create(dto({ blocksInventory: true }));
      const second = await service.create(dto({ blocksInventory: true }));
      for (const ticket of [first, second])
        await service.update(ticket.id, ids.property, {
          status: 'resolved',
          resolution: 'Устранено',
        });
      const a = await service.confirmReturnToService(
        first.id,
        ids.property,
        undefined,
      );
      expect(a.roomReturned).toBe(false);
      expect(a.remainingBlockingTicketIds).toEqual([second.id]);
      expect((await room()).status).toBe('out_of_order');
      const firstReturn = (await rows(domainEventOutbox)).find((event:any) => event.payload.entityId === first.id && event.payload.data.action === 'returned_to_service');
      expect(firstReturn.payload.data).toMatchObject({roomStatus:'out_of_order',roomReturned:false});
      const b = await service.confirmReturnToService(
        second.id,
        ids.property,
        undefined,
      );
      expect(b.roomReturned).toBe(true);
      expect((await room()).status).toBe('vacant_dirty');
      const lastReturn = (await rows(domainEventOutbox)).find((event:any) => event.payload.entityId === second.id && event.payload.data.action === 'returned_to_service');
      expect(lastReturn.payload.data).toMatchObject({roomStatus:'vacant_dirty',roomReturned:true});
    });
    it('serializes concurrent acknowledgements so exactly the final one returns the room', async () => {
      const first = await service.create(dto({ blocksInventory: true }));
      const second = await service.create(dto({ blocksInventory: true }));
      for (const ticket of [first, second])
        await service.update(ticket.id, ids.property, {
          status: 'resolved',
          resolution: 'Устранено',
        });
      const results = await Promise.all(
        [first, second].map((t) =>
          service.confirmReturnToService(t.id, ids.property, undefined),
        ),
      );
      expect(results.filter((r) => r.roomReturned)).toHaveLength(1);
      expect((await room()).status).toBe('vacant_dirty');
    });
    it('does not lose concurrent comments', async () => {
      const t = await service.create(dto());
      await Promise.all(
        ['Первый', 'Второй'].map((body) =>
          service.addComment(t.id, ids.property, body),
        ),
      );
      const { ticket } = await service.findById(t.id, ids.property);
      expect(ticket.comments.map((c: any) => c.body).sort()).toEqual([
        'Второй',
        'Первый',
      ]);
      expect(ticket.revision).toBe(3);
      expect((await rows(domainEventOutbox)).filter((event:any) => event.payload.data.action === 'comment_added')).toHaveLength(2);
    });
    it('accepts one of two stale-revision updates and audits only the winning change', async () => {
      const t = await service.create(dto());
      const results = await Promise.allSettled(
        ['high', 'critical'].map((priority) =>
          service.update(t.id, ids.property, { priority, expectedRevision: 1 }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await service.findById(t.id, ids.property)).history).toHaveLength(
        2,
      );
    });
    it('replays the original accepted update after later revisions and rejects changed payload', async () => {
      const t = await service.create(dto());
      const request = {
        status: 'in_progress',
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      };
      const first = await service.update(t.id, ids.property, request);
      await service.update(t.id, ids.property, { priority: 'high' });
      expect(await service.update(t.id, ids.property, request)).toEqual(first);
      await expect(
        service.update(t.id, ids.property, {
          ...request,
          priority: 'critical',
        }),
      ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
    });
    it('rejects occupied-room block creation without orphan side effects', async () => {
      await db
        .update(rooms)
        .set({ status: 'occupied' })
        .where(eq(rooms.id, ids.room));
      await expect(
        service.create(dto({ blocksInventory: true })),
      ).rejects.toMatchObject({ status: 409 });
      expect(await rows(maintenanceTickets)).toHaveLength(0);
      expect(await rows(domainEventOutbox)).toHaveLength(0);
    });
    it('prevents direct flag removal from bypassing return-to-service', async () => {
      const t = await service.create(dto({ blocksInventory: true }));
      await expect(
        service.update(t.id, ids.property, { blocksInventory: false }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await room()).status).toBe('out_of_order');
    });
    it('denies foreign room, ticket and assignee access', async () => {
      await expect(
        service.create(dto({ propertyId: ids.other })),
      ).rejects.toMatchObject({ status: 404 });
      const t = await service.create(dto());
      await expect(
        service.addComment(t.id, ids.other, 'Чужой'),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.update(t.id, ids.property, { assigneeId: randomUUID() }),
      ).rejects.toMatchObject({ status: 400 });
      expect((await service.findById(t.id, ids.property)).ticket.revision).toBe(
        1,
      );
    });
    it('fences an unaccepted create against late arrival and preserves committed race outcomes', async () => {
      const closed = dto();
      await service.closeRequest(ids.property, closed.idempotencyKey);
      await expect(service.create(closed)).rejects.toMatchObject({
        response: { code: 'REQUEST_CLOSED' },
      });
      const request = dto();
      await Promise.allSettled([
        service.create(request),
        service.closeRequest(ids.property, request.idempotencyKey),
      ]);
      const status = await service.requestStatus(
        ids.property,
        request.idempotencyKey,
      );
      expect(['closed', 'committed']).toContain(status.state);
      expect(await rows(maintenanceTickets)).toHaveLength(
        status.state === 'committed' ? 1 : 0,
      );
    });
  },
);
