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
import { eq, and, inArray } from 'drizzle-orm';
import {
  properties,
  staffShifts,
  staffShiftTemplates,
  users,
  roles,
  userRoles,
  rolePermissions,
  auditLogs,
  domainEventOutbox,
  rooms,
  roomTypes,
  housekeepingTasks,
} from '@telivityhaip/database';
import { StaffShiftService } from './staff-shift.service';
import { HousekeepingService } from './housekeeping.service';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')(
  'Staff calendar and assignment on real PostgreSQL',
  () => {
    const client = postgres(process.env.DATABASE_URL!, { max: 8 });
    const db = drizzle(client);
    const ids = {
      property: randomUUID(),
      other: randomUUID(),
      user: randomUUID(),
      second: randomUUID(),
      disabled: randomUUID(),
      role: randomUUID(),
      type: randomUUID(),
      room: randomUUID(),
    };
    const hook = {
      emit: vi.fn(),
      dispatchPersisted: vi.fn().mockResolvedValue(undefined),
    };
    const outbox = new DomainEventOutboxService(db, hook as any);
    const shifts = new StaffShiftService(db, outbox);
    const hk = new HousekeepingService(
      db,
      hook as any,
      new RoomStatusService(db, hook as any),
      outbox,
      shifts,
    );
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const dto = (extra: any = {}) => ({
      propertyId: ids.property,
      userId: ids.user,
      startAt: date + 'T09:00+05:00',
      endAt: date + 'T18:00+05:00',
      status: 'confirmed' as const,
      breaks: [
        { startAt: date + 'T12:00+05:00', endAt: date + 'T13:00+05:00' },
      ],
      idempotencyKey: randomUUID(),
      ...extra,
    });
    const createTask = async () => {
      const [t] = await db
        .insert(housekeepingTasks)
        .values({
          propertyId: ids.property,
          roomId: ids.room,
          type: 'checkout',
          status: 'pending',
          serviceDate: new Date(date),
        })
        .returning();
      return t!;
    };
    beforeAll(async () => {
      await db.insert(properties).values(
        [ids.property, ids.other].map((id) => ({
          id,
          name: 'Shift SQL',
          code: id.slice(0, 8),
          countryCode: 'KZ',
          currencyCode: 'KZT',
          timezone: 'Asia/Almaty',
          totalRooms: 1,
        })),
      );
      await db.insert(users).values(
        [ids.user, ids.second, ids.disabled].map((id, i) => ({
          id,
          name: 'Worker ' + i,
          email: id + '@test.invalid',
          status: i === 2 ? ('disabled' as const) : ('active' as const),
        })),
      );
      await db.insert(roles).values({
        id: ids.role,
        propertyId: ids.property,
        key: 'shift-test',
        name: 'Shift worker',
      });
      for (const propertyId of [ids.property, ids.other]) {
        await db.insert(rolePermissions).values({
          propertyId,
          roleId: ids.role,
          permissionKey: 'housekeeping.execute',
        });
        await db.insert(userRoles).values(
          [ids.user, ids.second, ids.disabled].map((userId) => ({
            propertyId,
            roleId: ids.role,
            userId,
          })),
        );
      }
      await db.insert(roomTypes).values({
        id: ids.type,
        propertyId: ids.property,
        code: 'SHF',
        name: 'Shift room',
        maxOccupancy: 2,
        defaultOccupancy: 2,
      });
      await db.insert(rooms).values({
        id: ids.room,
        propertyId: ids.property,
        roomTypeId: ids.type,
        number: '1',
        status: 'vacant_dirty',
      });
    });
    beforeEach(async () => {
      vi.restoreAllMocks();
      hook.dispatchPersisted.mockResolvedValue(undefined);
      for (const t of [
        domainEventOutbox,
        auditLogs,
        housekeepingTasks,
        staffShifts,
        staffShiftTemplates,
      ])
        await db
          .delete(t)
          .where(inArray(t.propertyId, [ids.property, ids.other]));
    });
    afterAll(async () => {
      for (const t of [
        domainEventOutbox,
        auditLogs,
        housekeepingTasks,
        staffShifts,
        staffShiftTemplates,
        rooms,
        roomTypes,
        userRoles,
        rolePermissions,
      ])
        await db
          .delete(t)
          .where(inArray(t.propertyId, [ids.property, ids.other]));
      await db.delete(roles).where(eq(roles.id, ids.role));
      await db
        .delete(users)
        .where(inArray(users.id, [ids.user, ids.second, ids.disabled]));
      await db
        .delete(properties)
        .where(inArray(properties.id, [ids.property, ids.other]));
      await client.end();
    });
    const templateDto = (extra: any = {}) => ({
      propertyId: ids.property,
      userId: ids.user,
      name: 'Будние дни',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startTime: '09:00',
      endTime: '18:00',
      overnight: 0,
      idempotencyKey: randomUUID(),
      ...extra,
    });
    const applyDto = (extra: any = {}) => ({
      propertyId: ids.property,
      startDate: date,
      endDate: new Date(Date.parse(date + 'T12:00Z') + 2 * 86400000)
        .toISOString()
        .slice(0, 10),
      expectedRevision: 1,
      status: 'confirmed' as const,
      idempotencyKey: randomUUID(),
      ...extra,
    });
    it('creates reusable patterns and atomically materializes explicit shifts with original replay', async () => {
      const t = await shifts.saveTemplate(templateDto());
      const request = applyDto();
      const [a, b] = await Promise.all([
        shifts.applyTemplate(t.id, request, { userId: ids.user }),
        shifts.applyTemplate(t.id, request),
      ]);
      expect(a).toEqual(b);
      expect(a.generated).toHaveLength(3);
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toHaveLength(3);
      expect(
        await db
          .select()
          .from(domainEventOutbox)
          .where(eq(domainEventOutbox.propertyId, ids.property)),
      ).toHaveLength(5);
      await expect(
        shifts.applyTemplate(t.id, { ...request, status: 'planned' }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('preserves edited exceptions and rolls back the entire generated batch on conflict or outbox failure', async () => {
      const t = await shifts.saveTemplate(templateDto());
      const existing = await shifts.save(dto());
      const preview = await shifts.previewTemplate(t.id, applyDto());
      expect(preview.canApply).toBe(false);
      expect(preview.conflictingShiftIds).toEqual([existing.id]);
      await expect(
        shifts.applyTemplate(t.id, applyDto()),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toHaveLength(1);
      await db
        .delete(staffShifts)
        .where(eq(staffShifts.propertyId, ids.property));
      vi.spyOn(outbox, 'persist').mockRejectedValueOnce(
        new Error('batch durability failed'),
      );
      await expect(shifts.applyTemplate(t.id, applyDto())).rejects.toThrow(
        'batch durability failed',
      );
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toHaveLength(0);
    });
    it('rejects stale and foreign templates and fences unaccepted generation', async () => {
      const t = await shifts.saveTemplate(templateDto());
      await shifts.saveTemplate(templateDto({ expectedRevision: 1 }), t.id);
      await expect(
        shifts.applyTemplate(t.id, applyDto()),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        shifts.previewTemplate(t.id, applyDto({ propertyId: ids.other })),
      ).rejects.toMatchObject({ status: 404 });
      const request = applyDto({ expectedRevision: 2 });
      await shifts.closeRequest(ids.property, request.idempotencyKey);
      await expect(shifts.applyTemplate(t.id, request)).rejects.toMatchObject({
        response: { code: 'REQUEST_CLOSED' },
      });
    });
    it('records absence in the same calendar without cancelling a shift or reassigning existing tasks', async () => {
      await shifts.save(dto());
      const task = await createTask();
      await hk.assign(task.id, ids.property, { assignedTo: ids.user });
      const request = dto({
        kind: 'absence',
        absenceType: 'vacation',
        breaks: [],
      });
      const saved = await shifts.save(request);
      expect(saved.kind).toBe('absence');
      expect(await shifts.save(request)).toEqual(saved);
      const coverage = await shifts.availability(
        ids.property,
        date,
        db,
        new Date(date + 'T10:00+05:00'),
      );
      expect(coverage.find((u: any) => u.id === ids.user)).toMatchObject({
        workingNow: false,
        available: false,
        onLeave: true,
        reassignmentRequired: true,
        tasksToReview: [{ id: task.id }],
      });
      const [stored] = await db
        .select()
        .from(housekeepingTasks)
        .where(eq(housekeepingTasks.id, task.id));
      expect(stored.assignedTo).toBe(ids.user);
      expect(stored.status).toBe('assigned');
      await expect(
        hk.assign((await createTask()).id, ids.property, {
          assignedTo: ids.user,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await shifts.save(
        {
          ...request,
          idempotencyKey: randomUUID(),
          status: 'cancelled',
          expectedRevision: 1,
        },
        saved.id,
      );
      expect(
        (
          await shifts.availability(
            ids.property,
            date,
            db,
            new Date(date + 'T10:00+05:00'),
          )
        ).find((u: any) => u.id === ids.user)?.workingNow,
      ).toBe(true);
    });
    it('keeps partial absence outside remaining work and prevents direct worker start during absence', async () => {
      await shifts.save(dto());
      const task = await createTask();
      await hk.assign(task.id, ids.property, { assignedTo: ids.user });
      await shifts.save(
        dto({
          kind: 'absence',
          absenceType: 'other',
          startAt: date + 'T09:00+05:00',
          endAt: date + 'T11:00+05:00',
          breaks: [],
        }),
      );
      expect(
        (
          await shifts.availability(
            ids.property,
            date,
            db,
            new Date(date + 'T10:00+05:00'),
          )
        ).find((u: any) => u.id === ids.user),
      ).toMatchObject({ available: true, workingNow: false, onLeave: true });
      expect(
        (
          await shifts.availability(
            ids.property,
            date,
            db,
            new Date(date + 'T14:00+05:00'),
          )
        ).find((u: any) => u.id === ids.user)?.workingNow,
      ).toBe(true);
      vi.spyOn(shifts, 'availability').mockImplementation((p, d, tx) =>
        StaffShiftService.prototype.availability.call(
          shifts,
          p,
          d,
          tx,
          new Date(date + 'T10:00+05:00'),
        ),
      );
      await expect(
        hk.startTask(task.id, ids.property, ids.user),
      ).rejects.toMatchObject({ response: { code: 'OUTSIDE_WORKING_SHIFT' } });
      const [absence] = await db
        .select()
        .from(staffShifts)
        .where(eq(staffShifts.kind, 'absence'));
      await shifts.save(
        dto({
          kind: 'absence',
          absenceType: 'other',
          startAt: date + 'T09:00+05:00',
          endAt: date + 'T11:00+05:00',
          breaks: [],
          status: 'cancelled',
          expectedRevision: 1,
        }),
        absence!.id,
      );
      expect((await hk.startTask(task.id, ids.property, ids.user)).status).toBe(
        'in_progress',
      );
    });
    it('serializes absence with task assignment and exposes any existing assignment for review', async () => {
      await shifts.save(dto());
      const task = await createTask();
      const outcomes = await Promise.allSettled([
        shifts.save(
          dto({ kind: 'absence', absenceType: 'vacation', breaks: [] }),
        ),
        hk.assign(task.id, ids.property, { assignedTo: ids.user }),
      ]);
      expect(outcomes[0].status).toBe('fulfilled');
      const [stored] = await db
        .select()
        .from(housekeepingTasks)
        .where(eq(housekeepingTasks.id, task.id));
      const person = (
        await shifts.availability(
          ids.property,
          date,
          db,
          new Date(date + 'T10:00+05:00'),
        )
      ).find((u: any) => u.id === ids.user);
      expect(person.available).toBe(false);
      if (outcomes[1].status === 'fulfilled') {
        expect(stored.assignedTo).toBe(ids.user);
        expect(person.reassignmentRequired).toBe(true);
      } else {
        expect(stored.assignedTo).toBeNull();
      }
    });
    it('supports multi-day absence, preserves kind and limits worker visibility to own facts', async () => {
      const end = new Date(
        Date.parse(date + 'T00:00Z') + 14 * 86400000,
      ).toISOString();
      const a = await shifts.save(
        dto({
          kind: 'absence',
          absenceType: 'sickness',
          breaks: [],
          endAt: end,
        }),
      );
      expect(
        await shifts.list(ids.property, date + 'T00:00Z', end, ids.second),
      ).toEqual([]);
      expect(
        (await shifts.list(ids.property, date + 'T00:00Z', end, ids.user))[0],
      ).toMatchObject({ id: a.id, kind: 'absence' });
      await expect(
        shifts.save(dto({ expectedRevision: 1 }), a.id),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        shifts.save(
          dto({ kind: 'absence', breaks: [], absenceType: undefined }),
        ),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('replays the original accepted revision, with one shift and durable event', async () => {
      const request = dto();
      const [a, b] = await Promise.all([
        shifts.save(request),
        shifts.save(request),
      ]);
      expect(a.id).toBe(b.id);
      await shifts.save(
        dto({ expectedRevision: a.revision, notes: 'changed' }),
        a.id,
        { userId: ids.user },
      );
      const history = await shifts.history(ids.property, a.id, ids.user);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        action: 'update',
        authorName: 'Worker 0',
        next: { revision: 2 },
      });
      expect(JSON.stringify(history)).not.toContain(request.idempotencyKey);
      await expect(
        shifts.history(ids.property, a.id, ids.second),
      ).rejects.toMatchObject({ status: 404 });
      expect(await shifts.save(request)).toEqual(a);
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(domainEventOutbox)
          .where(eq(domainEventOutbox.propertyId, ids.property)),
      ).toHaveLength(2);
      await expect(
        shifts.save({ ...request, notes: 'other' }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('fences an unaccepted request and never treats a missing readback as safe to forget', async () => {
      const request = dto();
      expect(
        await shifts.requestStatus(ids.property, request.idempotencyKey),
      ).toEqual({ state: 'unconfirmed' });
      expect(
        await shifts.closeRequest(ids.property, request.idempotencyKey),
      ).toEqual({ state: 'closed' });
      await expect(shifts.save(request)).rejects.toMatchObject({
        response: { code: 'REQUEST_CLOSED' },
      });
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toEqual([]);
      expect(
        await shifts.requestStatus(ids.other, request.idempotencyKey),
      ).toEqual({ state: 'unconfirmed' });
    });
    it('serializes concurrent create versus closure with one final receipt', async () => {
      const request = dto();
      const results = await Promise.allSettled([
        shifts.save(request),
        shifts.closeRequest(ids.property, request.idempotencyKey),
      ]);
      const result = await shifts.requestStatus(
        ids.property,
        request.idempotencyKey,
      );
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.propertyId, ids.property),
              eq(
                auditLogs.description,
                'staff_shift.request:' + request.idempotencyKey,
              ),
            ),
          ),
      ).toHaveLength(1);
      if (result.state === 'committed') {
        expect(results[0]?.status).toBe('fulfilled');
        expect(await shifts.save(request)).toEqual(result.shift);
      } else {
        expect(result.state).toBe('closed');
        await expect(shifts.save(request)).rejects.toMatchObject({
          status: 409,
        });
      }
    });
    it('allows only one overlapping create across concurrent requests', async () => {
      const results = await Promise.allSettled([
        shifts.save(dto()),
        shifts.save(dto()),
      ]);
      expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((v) => v.status === 'rejected') as PromiseRejectedResult)
          .reason,
      ).toMatchObject({ status: 409 });
    });
    it('prevents cross-property overlap without returning foreign shift data', async () => {
      await shifts.save(dto());
      await expect(
        shifts.save(dto({ propertyId: ids.other })),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await shifts.list(ids.other, date + 'T00:00Z', date + 'T23:59Z'),
      ).toEqual([]);
    });
    it('uses half-open boundaries and cancellation releases the interval', async () => {
      const a = await shifts.save(dto());
      await shifts.save(
        dto({
          startAt: date + 'T18:00+05:00',
          endAt: date + 'T20:00+05:00',
          breaks: [],
        }),
      );
      await shifts.save(
        dto({ status: 'cancelled', expectedRevision: a.revision }),
        a.id,
      );
      await shifts.save(dto());
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toHaveLength(3);
    });
    it('rejects stale revisions, foreign updates, disabled staff and overlapping breaks', async () => {
      const a = await shifts.save(dto());
      await shifts.save(dto({ expectedRevision: 1, notes: 'new' }), a.id);
      await expect(
        shifts.save(dto({ expectedRevision: 1 }), a.id),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        shifts.save(dto({ propertyId: ids.other, expectedRevision: 2 }), a.id),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        shifts.save(dto({ userId: ids.disabled })),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        shifts.save(
          dto({
            breaks: [
              { startAt: date + 'T12:00Z', endAt: date + 'T13:00Z' },
              { startAt: date + 'T12:30Z', endAt: date + 'T14:00Z' },
            ],
          }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        shifts.availability(ids.property, '2026-99-99'),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('rolls back a shift if event persistence fails and retains accepted state if delivery fails', async () => {
      vi.spyOn(outbox, 'persist').mockRejectedValueOnce(
        new Error('durability failed'),
      );
      await expect(shifts.save(dto())).rejects.toThrow('durability failed');
      expect(
        await db
          .select()
          .from(staffShifts)
          .where(eq(staffShifts.propertyId, ids.property)),
      ).toEqual([]);
      hook.dispatchPersisted.mockRejectedValue(new Error('receiver failed'));
      expect((await shifts.save(dto())).status).toBe('confirmed');
    });
    it('excludes breaks and ended shifts from working time while retaining future daily assignment coverage', async () => {
      await shifts.save(dto());
      const at = (time: string) =>
        shifts.availability(
          ids.property,
          date,
          db,
          new Date(date + 'T' + time + '+05:00'),
        );
      expect((await at('11:00'))[0]).toMatchObject({
        shiftConfirmed: true,
        workingNow: true,
        onBreak: false,
        available: true,
      });
      expect((await at('12:30'))[0]).toMatchObject({
        workingNow: false,
        onBreak: true,
        available: true,
      });
      expect((await at('19:00'))[0]).toMatchObject({
        workingNow: false,
        onBreak: false,
        available: false,
      });
    });
    it('never assigns without a confirmed shift and respects one remaining slot under concurrency', async () => {
      const a = await createTask(),
        b = await createTask();
      await expect(
        hk.assign(a.id, ids.property, { assignedTo: ids.user }),
      ).rejects.toMatchObject({ status: 409 });
      await shifts.save(dto({ maxOpenTasks: 1 }));
      const results = await Promise.allSettled([
        hk.assign(a.id, ids.property, { assignedTo: ids.user }),
        hk.assign(b.id, ids.property, { assignedTo: ids.user }),
      ]);
      expect(results.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
      expect(
        await db
          .select()
          .from(housekeepingTasks)
          .where(
            and(
              eq(housekeepingTasks.propertyId, ids.property),
              eq(housekeepingTasks.status, 'assigned'),
            ),
          ),
      ).toHaveLength(1);
    });
    it('includes overdue and non-midnight legacy task dates in actual outstanding load', async () => {
      await shifts.save(dto({ maxOpenTasks: 2 }));
      const old = await createTask(),
        sameDay = await createTask();
      await db
        .update(housekeepingTasks)
        .set({
          status: 'assigned',
          assignedTo: ids.user,
          serviceDate: new Date(Date.parse(date + 'T00:00Z') - 86400000),
        })
        .where(eq(housekeepingTasks.id, old.id));
      await db
        .update(housekeepingTasks)
        .set({
          status: 'completed',
          assignedTo: ids.user,
          serviceDate: new Date(date + 'T12:00Z'),
        })
        .where(eq(housekeepingTasks.id, sameDay.id));
      expect(
        (await shifts.availability(ids.property, date)).find(
          (u: any) => u.id === ids.user,
        ),
      ).toMatchObject({ load: 2, available: false });
      const next = await createTask();
      await expect(
        hk.assign(next.id, ids.property, { assignedTo: ids.user }),
      ).rejects.toMatchObject({ status: 409 });
    });
    it('auto-assigns to the least loaded eligible staff and never a cancelled shift', async () => {
      await shifts.save(dto({ maxOpenTasks: 1 }));
      await shifts.save(dto({ userId: ids.second, maxOpenTasks: 1 }));
      await createTask();
      await createTask();
      await createTask();
      expect(
        await hk.autoAssign({
          propertyId: ids.property,
          serviceDate: date,
          housekeepers: [ids.user, ids.second],
        }),
      ).toMatchObject({ assigned: 2, total: 3 });
      const rows = await db
        .select()
        .from(housekeepingTasks)
        .where(eq(housekeepingTasks.propertyId, ids.property));
      expect(
        new Set(
          rows.filter((t) => t.status === 'assigned').map((t) => t.assignedTo),
        ).size,
      ).toBe(2);
    });
    it('rejects stale worker ownership for checklist, start and completion at the service boundary', async () => {
      const task = await createTask();
      await shifts.save(dto());
      await hk.assign(task.id, ids.property, { assignedTo: ids.user });
      await expect(
        hk.update(task.id, ids.property, { notes: 'unauthorized' }, ids.second),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        hk.startTask(task.id, ids.property, ids.second),
      ).rejects.toMatchObject({ status: 403 });
      await hk.startTask(task.id, ids.property);
      await expect(
        hk.completeTask(task.id, ids.property, {}, undefined, ids.second),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          await db
            .select()
            .from(housekeepingTasks)
            .where(eq(housekeepingTasks.id, task.id))
        )[0]?.status,
      ).toBe('in_progress');
    });
  },
);
