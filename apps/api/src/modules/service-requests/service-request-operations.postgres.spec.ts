import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
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
  serviceRequests,
  maintenanceTickets,
  housekeepingTasks,
  auditLogs,
  domainEventOutbox,
} from '@telivityhaip/database';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { ServiceRequestsService } from './service-requests.service';
describe.runIf(process.env.PMS_LIVE_PG === '1')(
  'Guest request coordination on PostgreSQL',
  () => {
    const client = postgres(process.env.DATABASE_URL!, { max: 8 }),
      db = drizzle(client);
    const ids = {
      property: randomUUID(),
      other: randomUUID(),
      room: randomUUID(),
      type: randomUUID(),
    };
    const hooks = {
      emit: vi.fn().mockResolvedValue(undefined),
      dispatchPersisted: vi.fn().mockResolvedValue(undefined),
    };
    const state = new RoomStatusService(db, hooks as any),
      outbox = new DomainEventOutboxService(db, hooks as any);
    const maintenance = new MaintenanceService(db, state, outbox),
      hk = new HousekeepingService(db, hooks as any, state, outbox);
    const service = new ServiceRequestsService(
      db,
      hk,
      hooks as any,
      maintenance,
      outbox,
    );
    const request = async (type = 'technical_problem') => {
      const [row] = await db
        .insert(serviceRequests)
        .values({
          propertyId: ids.property,
          roomId: ids.room,
          type: type as any,
          title: 'Просьба гостя',
          description: 'Проверить воду',
          priority: 2,
        })
        .returning();
      return row!;
    };
    const all = (table: any) =>
      db.select().from(table).where(eq(table.propertyId, ids.property));
    beforeAll(async () => {
      await db
        .insert(properties)
        .values(
          [ids.property, ids.other].map((id) => ({
            id,
            name: 'Request operations',
            code: id.slice(0, 8),
            countryCode: 'KZ',
            currencyCode: 'KZT',
            timezone: 'Asia/Almaty',
            totalRooms: 1,
            settings: { requireInspection: true },
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
          status: 'guest_ready',
        });
    });
    const clear = async () => {
      for (const table of [
        domainEventOutbox,
        auditLogs,
        serviceRequests,
        maintenanceTickets,
        housekeepingTasks,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
    };
    beforeEach(async () => {
      vi.restoreAllMocks();
      await clear();
    });
    afterAll(async () => {
      await clear();
      for (const table of [rooms, roomTypes])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      for (const id of [ids.property, ids.other])
        await db.delete(properties).where(eq(properties.id, id));
      await client.end();
    });
    it('creates exactly one Maintenance ticket for concurrent handoffs and no second housekeeping task', async () => {
      const row = await request();
      const result = await Promise.all([
        service.createLinkedTask(row.id, { propertyId: ids.property }),
        service.createLinkedTask(row.id, { propertyId: ids.property }),
      ]);
      expect(result[0].task.id).toBe(result[1].task.id);
      expect(await all(maintenanceTickets)).toHaveLength(1);
      expect(await all(housekeepingTasks)).toHaveLength(0);
      expect(await all(domainEventOutbox)).toHaveLength(2);
      expect(result[0].request.linkedOperation.kind).toBe('maintenance');
      expect(new URL(result[0].request.linkedOperation.href, 'http://local.test').searchParams.get('propertyId')).toBe(ids.property);
      expect(
        (await service.findById(row.id, ids.property))
          .linkedMaintenanceTicketId,
      ).toBe(result[0].task.id);
    });
    it('rolls back request link, new ticket, audit and outbox when the coordination event cannot be persisted', async () => {
      const row = await request();
      const persist = outbox.persist.bind(outbox);
      vi.spyOn(outbox, 'persist').mockImplementation(
        async (tx: any, payload: any, id: string) => {
          if (payload.entityType === 'service_request')
            throw new Error('coordination failure');
          return persist(tx, payload, id);
        },
      );
      await expect(
        service.createLinkedTask(row.id, { propertyId: ids.property }),
      ).rejects.toThrow('coordination failure');
      expect(await all(maintenanceTickets)).toHaveLength(0);
      expect(await all(domainEventOutbox)).toHaveLength(0);
      expect(await all(auditLogs)).toHaveLength(0);
      expect(
        (await service.findById(row.id, ids.property))
          .linkedMaintenanceTicketId,
      ).toBeNull();
    });
    it('projects actual repair progress and completion in both detail and filtered queue', async () => {
      const row = await request();
      const { task } = await service.createLinkedTask(row.id, {
        propertyId: ids.property,
      });
      await maintenance.update(task.id, ids.property, {
        status: 'in_progress',
      });
      expect((await service.findById(row.id, ids.property)).status).toBe(
        'in_progress',
      );
      await maintenance.update(task.id, ids.property, {
        status: 'resolved',
        resolution: 'Исправлено',
      });
      expect((await service.findById(row.id, ids.property)).status).toBe(
        'completed',
      );
      expect(
        await service.list({ propertyId: ids.property, status: 'completed' }),
      ).toHaveLength(1);
      await expect(
        service.update(row.id, ids.property, { status: 'cancelled' }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(service.delete(row.id, ids.property)).rejects.toMatchObject({ status: 409 });
      expect((await service.findById(row.id, ids.property)).linkedMaintenanceTicketId).toBe(task.id);
    });
    it('creates one existing housekeeping task and retains the inspection gate', async () => {
      const row = await request('checkout');
      const results = await Promise.all([
        service.createLinkedTask(row.id, {
          propertyId: ids.property,
          serviceDate: '2027-01-01',
        }),
        service.createLinkedTask(row.id, {
          propertyId: ids.property,
          serviceDate: '2027-01-01',
        }),
      ]);
      expect(results[0].task.id).toBe(results[1].task.id);
      expect(await all(housekeepingTasks)).toHaveLength(1);
      expect(await all(maintenanceTickets)).toHaveLength(0);
      await db
        .update(housekeepingTasks)
        .set({ status: 'completed' })
        .where(eq(housekeepingTasks.id, results[0].task.id));
      expect((await service.findById(row.id, ids.property)).status).toBe(
        'in_progress',
      );
      await db
        .update(housekeepingTasks)
        .set({ status: 'inspected' })
        .where(eq(housekeepingTasks.id, results[0].task.id));
      expect((await service.findById(row.id, ids.property)).status).toBe(
        'completed',
      );
      await expect(
        service.createLinkedTask(row.id, {
          propertyId: ids.property,
          serviceDate: '2027-01-02',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('enforces tenant and destination RBAC at the locked handoff without orphan work', async () => {
      const row = await request();
      await expect(
        service.createLinkedTask(row.id, { propertyId: ids.other }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.createLinkedTask(
          row.id,
          { propertyId: ids.property },
          undefined,
          ['housekeeping.manage'],
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(await all(maintenanceTickets)).toHaveLength(0);
      expect(await all(housekeepingTasks)).toHaveLength(0);
    });
  },
);
