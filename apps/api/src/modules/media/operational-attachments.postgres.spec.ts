import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import {
  UnauthorizedException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  properties,
  rooms,
  roomTypes,
  users,
  housekeepingTasks,
  maintenanceTickets,
  auditLogs,
  domainEventOutbox,
} from '@telivityhaip/database';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { LocalDriver } from './storage/local.driver';
import { OperationalAttachmentsService } from './operational-attachments.service';
import { OperationalAttachmentsController } from './operational-attachments.controller';

// This principal is a test fixture, not a verification of Keycloak/JWKS.
class TestIdentityGuard {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    if (!req.headers['x-test-user']) throw new UnauthorizedException();
    req.user = { sub: req.headers['x-test-user'] };
    return true;
  }
}
describe.runIf(process.env.PMS_LIVE_PG === '1')(
  'Private operational photos through HTTP and PostgreSQL',
  () => {
    const client = postgres(process.env.DATABASE_URL!, { max: 8 });
    const db = drizzle(client);
    const ids = {
      property: randomUUID(),
      other: randomUUID(),
      room: randomUUID(),
      type: randomUUID(),
      task: randomUUID(),
      worker: randomUUID(),
      second: randomUUID(),
    };
    const hook = {
      emit: vi.fn(),
      dispatchPersisted: vi.fn().mockResolvedValue(undefined),
    };
    const roomState = new RoomStatusService(db, hook as any),
      outbox = new DomainEventOutboxService(db, hook as any);
    const maintenance = new MaintenanceService(db, roomState, outbox),
      hk = new HousekeepingService(db, hook as any, roomState, outbox);
    let ticketId: string,
      directory: string,
      driver: LocalDriver,
      service: OperationalAttachmentsService,
      app: INestApplication;
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const grants: Record<string, string[]> = {
      manager: [
        'housekeeping.read',
        'housekeeping.manage',
        'maintenance.view',
        'maintenance.update',
      ],
      worker: ['housekeeping.read', 'housekeeping.execute'],
      second: ['housekeeping.read', 'housekeeping.execute'],
      reader: ['maintenance.view'],
      none: [],
    };
    const permissions = {
      findLocalUser: async (sub: string) => ({
        id:
          sub === 'worker'
            ? ids.worker
            : sub === 'second'
              ? ids.second
              : ids.worker,
        status: 'active',
      }),
      getEffectivePermissions: vi.fn(async (_id: string, propertyId: string) =>
        propertyId === ids.property ? (grants[principal] ?? []) : [],
      ),
    };
    // Authorization service is mocked; ownership, attachment manifests, locks, audit, outbox and files are real.
    let principal = 'manager';
    const endpoint = (kind = 'maintenance', id = ticketId) =>
      `/operational-attachments/${kind}/${id}`;
    const upload = (
      key: string,
      kind = 'maintenance',
      id = ticketId,
      propertyId = ids.property,
      content = bytes,
    ) =>
      request(app.getHttpServer())
        .post(endpoint(kind, id))
        .query({ propertyId })
        .set('x-test-user', principal)
        .field('idempotencyKey', key)
        .attach('file', content, {
          filename: 'Фото.png',
          contentType: 'image/png',
        });
    const all = (table: any) =>
      db.select().from(table).where(eq(table.propertyId, ids.property));
    beforeAll(async () => {
      await db
        .insert(properties)
        .values(
          [ids.property, ids.other].map((id) => ({
            id,
            name: 'Private photos',
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
          code: 'PHOTO',
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
      await db
        .insert(users)
        .values(
          [ids.worker, ids.second].map((id) => ({
            id,
            email: id + '@example.test',
            name: 'Test',
            propertyId: ids.property,
          })),
        );
      directory = await mkdtemp(join(tmpdir(), 'guestra-photo-http-'));
      driver = new LocalDriver(directory);
      service = new OperationalAttachmentsService(
        driver as any,
        hk,
        maintenance,
        permissions as any,
        { get: () => 'true' } as any,
      );
      const module = await Test.createTestingModule({
        controllers: [OperationalAttachmentsController],
        providers: [
          { provide: OperationalAttachmentsService, useValue: service },
          { provide: APP_GUARD, useClass: TestIdentityGuard },
        ],
      }).compile();
      app = module.createNestApplication();
      await app.init();
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      principal = 'manager';
      hook.dispatchPersisted.mockResolvedValue(undefined);
      for (const table of [
        domainEventOutbox,
        auditLogs,
        maintenanceTickets,
        housekeepingTasks,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      await db
        .insert(housekeepingTasks)
        .values({
          id: ids.task,
          propertyId: ids.property,
          roomId: ids.room,
          type: 'stayover',
          status: 'assigned',
          assignedTo: ids.worker,
          serviceDate: new Date(),
          checklist: [],
        });
      ticketId = (
        await maintenance.create({
          propertyId: ids.property,
          roomId: ids.room,
          category: 'other',
          title: 'Фото',
          description: 'Осмотр',
        })
      ).id;
    });
    afterAll(async () => {
      await app?.close();
      for (const table of [
        domainEventOutbox,
        auditLogs,
        maintenanceTickets,
        housekeepingTasks,
        users,
        rooms,
        roomTypes,
      ])
        await db.delete(table).where(eq(table.propertyId, ids.property));
      for (const id of [ids.property, ids.other])
        await db.delete(properties).where(eq(properties.id, id));
      await client.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    it('rejects anonymous, wrong-property and read-only uploads without persisting a manifest', async () => {
      await request(app.getHttpServer())
        .get(endpoint() + '/capabilities')
        .query({ propertyId: ids.property })
        .expect(401);
      await upload(randomUUID(), 'maintenance', ticketId, ids.other).expect(
        403,
      );
      principal = 'reader';
      await upload(randomUUID()).expect(403);
      expect(
        (await maintenance.findById(ticketId, ids.property)).ticket.attachments,
      ).toHaveLength(0);
    });
    it('serves a private photo only via scoped authenticated HTTP with non-cacheable headers', async () => {
      const response = await upload(randomUUID()).expect(201);
      expect(response.body).not.toHaveProperty('url');
      const result = await request(app.getHttpServer())
        .get(endpoint() + '/' + response.body.id)
        .query({ propertyId: ids.property })
        .set('x-test-user', 'manager')
        .expect(200);
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.body).toEqual(bytes);
      principal = 'worker';
      await request(app.getHttpServer())
        .get(endpoint() + '/' + response.body.id)
        .query({ propertyId: ids.property })
        .set('x-test-user', 'worker')
        .expect(403);
    });
    it('retains one housekeeping manifest, audit and outbox event across concurrent and later retries', async () => {
      principal = 'worker';
      const key = randomUUID();
      const responses = await Promise.all([
        upload(key, 'housekeeping', ids.task),
        upload(key, 'housekeeping', ids.task),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      await upload(key, 'housekeeping', ids.task).expect(201);
      expect(
        (await hk.findById(ids.task, ids.property)).attachments,
      ).toHaveLength(1);
      expect(
        (await all(domainEventOutbox)).filter(
          (e: any) => e.payload.entityType === 'housekeeping_task',
        ),
      ).toHaveLength(1);
      expect(
        (await all(auditLogs)).filter(
          (e: any) =>
            e.entityType === 'housekeeping_task' && e.action === 'attachment',
        ),
      ).toHaveLength(1);
      const recovered = await request(app.getHttpServer())
        .get(endpoint('housekeeping', ids.task) + '/request')
        .query({ propertyId: ids.property, idempotencyKey: key })
        .set('x-test-user', 'worker')
        .expect(200);
      expect(recovered.body.state).toBe('committed');
    });
    it('rejects workers on another assignment and foreign owner IDs', async () => {
      principal = 'second';
      await upload(randomUUID(), 'housekeeping', ids.task).expect(403);
      principal = 'manager';
      await upload(randomUUID(), 'housekeeping', randomUUID()).expect(404);
    });
    it('rolls back the database when outbox fails, then recovers with the same immutable file and key', async () => {
      const key = randomUUID();
      vi.spyOn(outbox, 'persist').mockRejectedValueOnce(
        new Error('outbox unavailable'),
      );
      await upload(key, 'housekeeping', ids.task).expect(500);
      expect(
        (await hk.findById(ids.task, ids.property)).attachments,
      ).toHaveLength(0);
      await upload(key, 'housekeeping', ids.task).expect(201);
      expect(
        (await hk.findById(ids.task, ids.property)).attachments,
      ).toHaveLength(1);
    });
    it('rejects altered same-key bytes and unsupported content while preserving the first photo', async () => {
      const key = randomUUID();
      await upload(key).expect(201);
      const changed = Buffer.from(bytes);
      changed[changed.length - 1] ^= 1;
      await upload(key, 'maintenance', ticketId, ids.property, changed).expect(
        409,
      );
      await upload(
        randomUUID(),
        'maintenance',
        ticketId,
        ids.property,
        Buffer.from('<svg/>'),
      ).expect(400);
      expect(
        (await maintenance.findById(ticketId, ids.property)).ticket.attachments,
      ).toHaveLength(1);
    });
    it('returns a Russian 404 if a referenced private file is missing', async () => {
      const result = await upload(randomUUID()).expect(201);
      vi.spyOn(driver, 'readPrivate').mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
      const response = await request(app.getHttpServer())
        .get(endpoint() + '/' + result.body.id)
        .query({ propertyId: ids.property })
        .set('x-test-user', 'manager')
        .expect(404);
      expect(response.body.message).toMatch(/недоступна/);
    });
  },
);
