import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { HousekeepingController } from './housekeeping.controller';
import { HousekeepingService } from './housekeeping.service';
import { StaffShiftService } from './staff-shift.service';
import { RoomService } from '../room/room.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { PermissionsService } from '../auth/permissions.service';
const P = '10000000-0000-4000-a000-000000000001',
  O = '10000000-0000-4000-a000-000000000002',
  U = '10000000-0000-4000-a000-000000000003',
  ID = '10000000-0000-4000-a000-000000000004';
describe('Staff shift and worker HTTP permissions', () => {
  let app: INestApplication;
  let granted: string[];
  const shift = {
    templates: vi.fn().mockResolvedValue([]),
    saveTemplate: vi.fn().mockResolvedValue({ id: ID }),
    previewTemplate: vi.fn().mockResolvedValue({ canApply: true }),
    applyTemplate: vi.fn().mockResolvedValue({ id: ID }),
    save: vi.fn().mockResolvedValue({ id: ID }),
    list: vi.fn().mockResolvedValue([]),
    staff: vi.fn().mockResolvedValue([]),
    availability: vi.fn(),
    requestStatus: vi.fn().mockResolvedValue({ state: 'unconfirmed' }),
    closeRequest: vi.fn().mockResolvedValue({ state: 'closed' }),
    history: vi.fn().mockResolvedValue([]),
  };
  const hk = {
    findById: vi.fn(),
    startTask: vi.fn().mockResolvedValue({ id: ID }),
    completeTask: vi.fn().mockResolvedValue({ id: ID }),
    inspectTask: vi.fn().mockResolvedValue({ id: ID }),
    update: vi.fn().mockResolvedValue({ id: ID }),
    list: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  };
  beforeEach(async () => {
    granted = ['housekeeping.read', 'housekeeping.execute'];
    vi.clearAllMocks();
    hk.findById.mockResolvedValue({ id: ID, assignedTo: U });
    const config = { get: () => 'true' };
    const permissions = {
      findLocalUser: async () => ({ id: U, status: 'active' }),
      getEffectivePermissions: async (_id: string, propertyId: string) =>
        propertyId === P ? granted : [],
    };
    const module = await Test.createTestingModule({
      controllers: [HousekeepingController],
      providers: [
        { provide: HousekeepingService, useValue: hk },
        { provide: StaffShiftService, useValue: shift },
        { provide: RoomService, useValue: {} },
        { provide: PermissionsService, useValue: permissions },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = { sub: 'external-subject', email: 'staff@test.invalid' };
      next();
    });
    app.useGlobalGuards(
      new PermissionsGuard(new Reflector(), config as any, permissions as any),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterEach(async () => app.close());
  const body = () => ({
    propertyId: P,
    userId: U,
    startAt: '2027-01-01T09:00:00+05:00',
    endAt: '2027-01-01T18:00:00+05:00',
    status: 'confirmed',
    breaks: [],
    idempotencyKey: 'shift-key',
  });
  it('protects recurring templates and application by manager and property scope', async () => {
    const template = {
      propertyId: P,
      userId: U,
      name: 'Будни',
      weekdays: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '18:00',
      overnight: 0,
      idempotencyKey: 'template-key',
    };
    await request(app.getHttpServer())
      .get('/housekeeping/shift-templates')
      .query({ propertyId: P })
      .expect(403);
    await request(app.getHttpServer())
      .post('/housekeeping/shift-templates')
      .send(template)
      .expect(403);
    granted = ['housekeeping.manage'];
    await request(app.getHttpServer())
      .post('/housekeeping/shift-templates')
      .send({ ...template, propertyId: O })
      .expect(403);
    await request(app.getHttpServer())
      .post('/housekeeping/shift-templates')
      .send(template)
      .expect(201);
    const apply = {
      propertyId: P,
      startDate: '2027-01-01',
      endDate: '2027-01-07',
      status: 'planned',
      expectedRevision: 1,
      idempotencyKey: 'apply-key',
    };
    await request(app.getHttpServer())
      .post('/housekeeping/shift-templates/' + ID + '/apply')
      .send({ ...apply, propertyId: O })
      .expect(403);
    await request(app.getHttpServer())
      .post('/housekeeping/shift-templates/' + ID + '/apply')
      .send(apply)
      .expect(201);
    expect(shift.applyTemplate).toHaveBeenCalledWith(
      ID,
      apply,
      expect.objectContaining({ userId: U }),
    );
  });
  it('accepts a validated absence through the existing shift endpoint and rejects invented policy fields', async () => {
    granted = ['housekeeping.manage'];
    await request(app.getHttpServer())
      .post('/housekeeping/shifts')
      .send({ ...body(), kind: 'absence', absenceType: 'vacation' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/housekeeping/shifts')
      .send({ ...body(), kind: 'absence', absenceType: 'unapproved' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/housekeeping/shifts')
      .send({ ...body(), payroll: true })
      .expect(400);
  });
  it('denies worker shift writes and foreign-property reads', async () => {
    await request(app.getHttpServer())
      .post('/housekeeping/shifts')
      .send(body())
      .expect(403);
    await request(app.getHttpServer())
      .get('/housekeeping/shifts')
      .query({ propertyId: O, startAt: body().startAt, endAt: body().endAt })
      .expect(403);
    expect(shift.save).not.toHaveBeenCalled();
  });
  it('protects shift recovery reads and closure with manager property permissions', async () => {
    await request(app.getHttpServer())
      .get('/housekeeping/shift-request')
      .query({ propertyId: P, idempotencyKey: 'key' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/housekeeping/shift-request/close')
      .send({ propertyId: P, idempotencyKey: 'key' })
      .expect(403);
    granted = ['housekeeping.manage'];
    await request(app.getHttpServer())
      .post('/housekeeping/shift-request/close')
      .send({ propertyId: O, idempotencyKey: 'key' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/housekeeping/shift-request/close')
      .send({ propertyId: P, idempotencyKey: 'key' })
      .expect(201);
    expect(shift.closeRequest).toHaveBeenCalledWith(
      P,
      'key',
      expect.anything(),
    );
  });
  it('limits worker and read-only calendars to the authenticated local user', async () => {
    granted = ['housekeeping.read'];
    await request(app.getHttpServer())
      .get('/housekeeping/shifts')
      .query({
        propertyId: P,
        startAt: body().startAt,
        endAt: body().endAt,
        userId: O,
      })
      .expect(200);
    expect(shift.list).toHaveBeenCalledWith(P, body().startAt, body().endAt, U);
    await request(app.getHttpServer())
      .get('/housekeeping/shifts/' + ID + '/history')
      .query({ propertyId: P })
      .expect(200);
    expect(shift.history).toHaveBeenCalledWith(P, ID, U);
    await request(app.getHttpServer())
      .get('/housekeeping/tasks/mine')
      .query({ propertyId: P, assignedTo: O })
      .expect(200);
    expect(hk.list).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: U }),
    );
  });
  it('passes worker ownership into the authoritative start and completion transition', async () => {
    await request(app.getHttpServer())
      .patch('/housekeeping/tasks/' + ID + '/start')
      .query({ propertyId: P })
      .send({})
      .expect(200);
    expect(hk.startTask).toHaveBeenCalledWith(
      ID,
      P,
      U,
      expect.objectContaining({ userId: U }),
    );
    await request(app.getHttpServer())
      .patch('/housekeeping/tasks/' + ID + '/complete')
      .query({ propertyId: P })
      .send({})
      .expect(200);
    expect(hk.completeTask).toHaveBeenCalledWith(
      ID,
      P,
      expect.anything(),
      expect.objectContaining({ userId: U }),
      U,
    );
    hk.findById.mockResolvedValueOnce({ id: ID, assignedTo: O });
    await request(app.getHttpServer())
      .patch('/housekeeping/tasks/' + ID + '/start')
      .query({ propertyId: P })
      .send({})
      .expect(403);
    expect(hk.startTask).toHaveBeenCalledTimes(1);
  });
  it('denies execution to a reader and priority changes to a worker', async () => {
    granted = ['housekeeping.read'];
    await request(app.getHttpServer())
      .patch('/housekeeping/tasks/' + ID + '/start')
      .query({ propertyId: P })
      .send({})
      .expect(403);
    granted.push('housekeeping.execute');
    await request(app.getHttpServer())
      .patch('/housekeeping/tasks/' + ID)
      .query({ propertyId: P })
      .send({ priority: 5 })
      .expect(403);
    expect(hk.update).not.toHaveBeenCalled();
  });
  it('validates shift fields and never trusts a browser inspector identity', async () => {
    granted = ['housekeeping.read', 'housekeeping.manage'];
    for (const extra of [
      { maxOpenTasks: -1 },
      { status: 'published' },
      { breaks: [{ startAt: 'bad', endAt: 'bad' }] },
      { revision: 999 },
    ])
      await request(app.getHttpServer())
        .post('/housekeeping/shifts')
        .send({ ...body(), ...extra })
        .expect(400);
    await request(app.getHttpServer())
      .post('/housekeeping/shifts')
      .send(body())
      .expect(201);
    expect(shift.save).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer())
      .patch('/housekeeping/tasks/' + ID + '/inspect')
      .query({ propertyId: P })
      .send({ passed: true, inspectedBy: O })
      .expect(200);
    expect(hk.inspectTask).toHaveBeenCalledWith(
      ID,
      P,
      expect.objectContaining({ inspectedBy: U }),
      expect.objectContaining({ userId: U }),
    );
  });
});
