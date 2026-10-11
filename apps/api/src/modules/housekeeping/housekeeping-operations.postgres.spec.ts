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
import { eq, and } from 'drizzle-orm';
import {
  properties,
  rooms,
  roomTypes,
  housekeepingTasks,
  auditLogs,
  domainEventOutbox,
  maintenanceTickets,
} from '@telivityhaip/database';
import { HousekeepingService } from './housekeeping.service';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')(
  'Housekeeping lifecycle on real PostgreSQL',
  () => {
    const client = postgres(process.env.DATABASE_URL!, { max: 6 });
    const db = drizzle(client);
    const ids = {
      property: randomUUID(),
      other: randomUUID(),
      type: randomUUID(),
      room: randomUUID(),
      task: randomUUID(),
      inspector: randomUUID(),
    };
    const webhook = {
      emit: vi.fn(),
      dispatchPersisted: vi.fn().mockResolvedValue(undefined),
    };
    const roomState = new RoomStatusService(db, webhook as any);
    const outbox = new DomainEventOutboxService(db, webhook as any);
    const service = new HousekeepingService(
      db,
      webhook as any,
      roomState,
      outbox,
    );
    const date = new Date().toISOString().slice(0, 10);
    const task = () =>
      db
        .select()
        .from(housekeepingTasks)
        .where(eq(housekeepingTasks.id, ids.task))
        .then((r) => r[0]!);
    const room = () => roomState.getRoomStatus(ids.room, ids.property);
    beforeAll(async () => {
      await db
        .insert(properties)
        .values(
          [ids.property, ids.other].map((id) => ({
            id,
            name: 'Operations SQL',
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
          code: 'OPS',
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
          status: 'vacant_dirty',
        });
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      webhook.dispatchPersisted.mockResolvedValue(undefined);
      for (const table of [
        domainEventOutbox,
        auditLogs,
        maintenanceTickets,
        housekeepingTasks,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      await db
        .update(properties)
        .set({ settings: { requireInspection: true } })
        .where(eq(properties.id, ids.property));
      await db
        .update(rooms)
        .set({ status: 'vacant_dirty' })
        .where(eq(rooms.id, ids.room));
      await db
        .insert(housekeepingTasks)
        .values({
          id: ids.task,
          propertyId: ids.property,
          roomId: ids.room,
          type: 'checkout',
          status: 'in_progress',
          serviceDate: new Date(date),
          checklist: [],
        });
    });
    afterAll(async () => {
      for (const table of [
        domainEventOutbox,
        auditLogs,
        maintenanceTickets,
        housekeepingTasks,
        rooms,
        roomTypes,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      await db.delete(properties).where(eq(properties.id, ids.property));
      await db.delete(properties).where(eq(properties.id, ids.other));
      await client.end();
    });
    it('commits completion, room cleaning, audit and durable events together, then inspection makes it ready', async () => {
      await service.completeTask(ids.task, ids.property);
      expect((await task()).status).toBe('completed');
      expect((await room()).status).toBe('clean');
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.propertyId, ids.property),
              eq(auditLogs.action, 'complete'),
            ),
          ),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(domainEventOutbox)
          .where(eq(domainEventOutbox.propertyId, ids.property)),
      ).toHaveLength(2);
      expect(
        (await roomState.operationalReadiness(ids.property, date))[0],
      ).toMatchObject({
        ready: false,
        reasons: [expect.objectContaining({ code: 'inspection' })],
      });
      await service.inspectTask(ids.task, ids.property, {
        passed: true,
        inspectedBy: ids.inspector,
      });
      expect((await room()).status).toBe('guest_ready');
      expect(
        (await roomState.operationalReadiness(ids.property, date))[0].ready,
      ).toBe(true);
    });
    it('rolls the task back when the room transition fails', async () => {
      vi.spyOn(roomState, 'transitionStatus').mockRejectedValueOnce(
        new Error('room transition failed'),
      );
      await expect(
        service.completeTask(ids.task, ids.property),
      ).rejects.toThrow('room transition failed');
      expect((await task()).status).toBe('in_progress');
      expect((await room()).status).toBe('vacant_dirty');
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.propertyId, ids.property)),
      ).toHaveLength(0);
    });
    it('rolls back the room and audit when durable event persistence fails', async () => {
      vi.spyOn(outbox, 'persist').mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );
      await expect(
        service.completeTask(ids.task, ids.property),
      ).rejects.toThrow('outbox unavailable');
      expect((await task()).status).toBe('in_progress');
      expect((await room()).status).toBe('vacant_dirty');
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.propertyId, ids.property)),
      ).toHaveLength(0);
    });
    it('allows one concurrent completion and one audit, retaining committed state on receiver failure', async () => {
      webhook.dispatchPersisted.mockRejectedValue(
        new Error('receiver unavailable'),
      );
      const outcomes = await Promise.allSettled([
        service.completeTask(ids.task, ids.property),
        service.completeTask(ids.task, ids.property),
      ]);
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await task()).status).toBe('completed');
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.propertyId, ids.property),
              eq(auditLogs.action, 'complete'),
            ),
          ),
      ).toHaveLength(1);
    });
    it('keeps an occupied stayover occupied when inspection is disabled', async () => {
      await db
        .update(properties)
        .set({ settings: { requireInspection: false } })
        .where(eq(properties.id, ids.property));
      await db
        .update(rooms)
        .set({ status: 'occupied' })
        .where(eq(rooms.id, ids.room));
      await db
        .update(housekeepingTasks)
        .set({ type: 'stayover' })
        .where(eq(housekeepingTasks.id, ids.task));
      await service.completeTask(ids.task, ids.property);
      expect((await task()).status).toBe('inspected');
      expect((await room()).status).toBe('occupied');
    });
    it('does not return an OOO room to service by completing or inspecting repair work', async () => {
      await db
        .update(rooms)
        .set({ status: 'out_of_order' })
        .where(eq(rooms.id, ids.room));
      await db
        .update(housekeepingTasks)
        .set({ type: 'maintenance' })
        .where(eq(housekeepingTasks.id, ids.task));
      await service.completeTask(ids.task, ids.property);
      await service.inspectTask(ids.task, ids.property, {
        passed: true,
        inspectedBy: ids.inspector,
      });
      expect((await room()).status).toBe('out_of_order');
      expect(
        (await roomState.operationalReadiness(ids.property, date))[0].ready,
      ).toBe(false);
    });
    it('keeps failed inspection visibly blocked and rejects a foreign-property lifecycle call', async () => {
      await service.completeTask(ids.task, ids.property);
      await service.inspectTask(ids.task, ids.property, {
        passed: false,
        inspectedBy: ids.inspector,
        notes: 'Замечание',
      });
      expect((await task()).status).toBe('pending');
      expect((await room()).status).toBe('clean');
      expect(
        (await roomState.operationalReadiness(ids.property, date))[0].reasons,
      ).toContainEqual(expect.objectContaining({ code: 'blocking_task' }));
      await expect(
        service.completeTask(ids.task, ids.other),
      ).rejects.toMatchObject({ status: 404 });
      expect(await roomState.operationalReadiness(ids.other, date)).toEqual([]);
    });
    it('does not hide unresolved return-to-service behind a clean room status', async () => {
      await db
        .delete(housekeepingTasks)
        .where(eq(housekeepingTasks.propertyId, ids.property));
      await db
        .update(rooms)
        .set({ status: 'guest_ready' })
        .where(eq(rooms.id, ids.room));
      await db
        .insert(maintenanceTickets)
        .values({
          propertyId: ids.property,
          roomId: ids.room,
          title: 'Ремонт',
          description: 'Проверка',
          status: 'resolved',
          blocksInventory: true,
          returnToServiceRequired: true,
        });
      expect(
        (await roomState.operationalReadiness(ids.property, date))[0],
      ).toMatchObject({
        ready: false,
        operational: false,
        reasons: [expect.objectContaining({ code: 'maintenance' })],
      });
    });
  },
);
