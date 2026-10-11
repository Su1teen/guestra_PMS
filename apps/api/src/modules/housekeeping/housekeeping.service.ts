import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  eq,
  and,
  sql,
  desc,
  asc,
  inArray,
  gte,
  lt,
  lte,
  gt,
} from 'drizzle-orm';
import {
  auditLogs,
  housekeepingTasks,
  rooms,
  reservations,
  guests,
  properties,
  roomTypes,
} from '@telivityhaip/database';
import { randomUUID } from 'node:crypto';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { StaffShiftService } from './staff-shift.service';
import { DRIZZLE } from '../../database/database.module';
import {
  WebhookService,
  type WebhookPayload,
} from '../webhook/webhook.service';
import { RoomStatusService } from '../room/room-status.service';
import { type CreateTaskDto } from './dto/create-task.dto';
import { type UpdateTaskDto } from './dto/update-task.dto';
import { type ListTasksDto } from './dto/list-tasks.dto';
import { type AssignTaskDto } from './dto/assign-task.dto';
import { type AutoAssignDto } from './dto/auto-assign.dto';
import { type CompleteTaskDto } from './dto/complete-task.dto';
import { type InspectTaskDto } from './dto/inspect-task.dto';
import {
  CHECKLIST_TEMPLATES,
  ADA_EXTRA_ITEMS,
  VIP_EXTRA_ITEMS,
} from './checklist-templates';

@Injectable()
export class HousekeepingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly webhookService: WebhookService,
    private readonly roomStatusService: RoomStatusService,
    @Optional() private readonly outbox?: DomainEventOutboxService,
    @Optional() private readonly shifts?: StaffShiftService,
  ) {}

  async create(dto: CreateTaskDto, db: any = this.db) {
    // FK ownership (security audit #6): verify roomId belongs to dto.propertyId
    // BEFORE generating the checklist or inserting the task. Without this, a
    // caller at property A could create a housekeeping task pointing at a room
    // in property B (and the checklist generator would happily read B's room
    // metadata — though the inner generate() lookups are now also scoped).
    const [room] = await db
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        and(eq(rooms.id, dto.roomId), eq(rooms.propertyId, dto.propertyId)),
      );
    if (!room) {
      throw new BadRequestException(
        `room ${dto.roomId} not found in this property`,
      );
    }

    let checklist = dto.checklist;
    let priority = dto.priority ?? 0;

    if (!checklist) {
      const generated = await this.generateChecklist(
        dto.type,
        dto.roomId,
        dto.propertyId,
      );
      checklist = generated.items;
      if (generated.isVip && priority <= 0) {
        priority = 5;
      }
    } else {
      const isVip = await this.nextGuestIsVip(dto.roomId, dto.propertyId);
      if (isVip && priority <= 0) {
        priority = 5;
      }
    }

    const [task] = await db
      .insert(housekeepingTasks)
      .values({
        propertyId: dto.propertyId,
        roomId: dto.roomId,
        type: dto.type,
        status: 'pending',
        priority,
        // serviceDate arrives as a YYYY-MM-DD string; the column is a timestamp, so Drizzle
        // needs a Date (a raw string throws "value.toISOString is not a function").
        serviceDate: new Date(dto.serviceDate),
        notes: dto.notes,
        checklist,
      })
      .returning();

    return task;
  }

  async findById(id: string, propertyId: string) {
    const results = await this.db
      .select({
        task: housekeepingTasks,
        roomNumber: rooms.number,
        roomFloor: rooms.floor,
        roomBuilding: rooms.building,
      })
      .from(housekeepingTasks)
      .leftJoin(rooms, eq(housekeepingTasks.roomId, rooms.id))
      .where(
        and(
          eq(housekeepingTasks.id, id),
          eq(housekeepingTasks.propertyId, propertyId),
        ),
      );

    if (!results.length) {
      throw new NotFoundException(`Housekeeping task ${id} not found`);
    }

    const { task, roomNumber, roomFloor, roomBuilding } = results[0];
    return {
      ...task,
      room: { number: roomNumber, floor: roomFloor, building: roomBuilding },
    };
  }

  async list(dto: ListTasksDto) {
    const conditions: any[] = [
      eq(housekeepingTasks.propertyId, dto.propertyId),
    ];

    if (dto.status)
      conditions.push(eq(housekeepingTasks.status, dto.status as any));
    if (dto.type) conditions.push(eq(housekeepingTasks.type, dto.type as any));
    if (dto.assignedTo)
      conditions.push(eq(housekeepingTasks.assignedTo, dto.assignedTo));
    if (dto.serviceDate) {
      const dayStart = new Date(dto.serviceDate + 'T00:00:00Z');
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      conditions.push(gte(housekeepingTasks.serviceDate, dayStart));
      conditions.push(lt(housekeepingTasks.serviceDate, dayEnd));
    }
    if (dto.roomId) conditions.push(eq(housekeepingTasks.roomId, dto.roomId));

    const page = dto.page ?? 1;
    const limit = dto.limit ?? 50;
    const offset = (page - 1) * limit;
    const whereClause = and(...conditions);

    const [rows, countResult] = await Promise.all([
      this.db
        .select({
          task: housekeepingTasks,
          roomNumber: rooms.number,
        })
        .from(housekeepingTasks)
        .leftJoin(rooms, eq(housekeepingTasks.roomId, rooms.id))
        .where(whereClause)
        .orderBy(
          desc(housekeepingTasks.priority),
          asc(housekeepingTasks.serviceDate),
        )
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(housekeepingTasks)
        .where(whereClause),
    ]);

    const data = rows.map((r: any) => ({
      ...r.task,
      roomNumber: r.roomNumber,
    }));

    return {
      data,
      total: Number(countResult[0]?.count ?? 0),
      page,
      limit,
    };
  }

  private assertWorker(task: any, workerId?: string) {
    if (workerId && task.assignedTo !== workerId)
      throw new ForbiddenException(
        'Задача больше не назначена этому сотруднику. Обновите список.',
      );
  }
  private assertWorkerChecklist(
    task: any,
    checklist: UpdateTaskDto['checklist'],
    workerId?: string,
  ) {
    if (
      workerId &&
      checklist &&
      (checklist.length !== (task.checklist ?? []).length ||
        checklist.some((v, i) => v.item !== task.checklist[i]?.item))
    )
      throw new ForbiddenException(
        'Состав чек-листа меняет руководитель. Сотрудник отмечает выполнение пунктов.',
      );
  }
  async update(
    id: string,
    propertyId: string,
    dto: UpdateTaskDto,
    workerId?: string,
    actor?: AuditActor,
  ) {
    return this.db.transaction(async (tx: any) => {
      const task = await this.findByIdRaw(id, propertyId, tx, true);
      this.assertWorker(task, workerId);
      this.assertWorkerChecklist(task, dto.checklist, workerId);
      if (['completed', 'inspected'].includes(task.status))
        throw new BadRequestException('Завершённую задачу изменяет инспектор.');
      const values: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of [
        'priority',
        'notes',
        'maintenanceRequired',
        'maintenanceNotes',
        'checklist',
      ] as const)
        if (dto[key] !== undefined) values[key] = dto[key];
      const [updated] = await tx
        .update(housekeepingTasks)
        .set(values)
        .where(
          and(
            eq(housekeepingTasks.id, id),
            eq(housekeepingTasks.propertyId, propertyId),
          ),
        )
        .returning();
      await this.taskAudit(tx, task, updated, 'update', actor);
      return updated;
    });
  }

  async delete(id: string, propertyId: string) {
    const task = await this.findByIdRaw(id, propertyId);

    const nonDeletable = ['in_progress', 'completed', 'inspected'];
    if (nonDeletable.includes(task.status)) {
      throw new BadRequestException(
        `Cannot delete task in '${task.status}' status`,
      );
    }

    await this.db
      .delete(housekeepingTasks)
      .where(
        and(
          eq(housekeepingTasks.id, id),
          eq(housekeepingTasks.propertyId, propertyId),
        ),
      );

    return { deleted: true };
  }

  async assign(
    taskId: string,
    propertyId: string,
    dto: AssignTaskDto,
    actor?: AuditActor,
  ) {
    const ids: string[] = [];
    const updated = await this.db.transaction(async (tx: any) => {
      // Serialize shift edits and assignment capacity at this property before taking task locks.
      if (this.shifts) await this.shifts.lockAssignments(propertyId, tx);
      const task = await this.findByIdRaw(taskId, propertyId, tx, true);
      if (task.status !== 'pending')
        throw new ConflictException(
          'Задача уже назначена или её статус изменился.',
        );
      if (this.shifts) {
        const staff = await this.shifts.availability(
          propertyId,
          new Date(task.serviceDate).toISOString().slice(0, 10),
          tx,
        );
        const worker = staff.find((u: any) => u.id === dto.assignedTo);
        if (!worker?.available)
          throw new ConflictException({
            code: 'STAFF_UNAVAILABLE',
            message:
              'Нет подтверждённого рабочего времени на эту дату или достигнут лимит незавершённых задач.',
          });
      }
      const row = await this.claimTaskTransition(
        taskId,
        propertyId,
        ['pending'],
        {
          assignedTo: dto.assignedTo,
          assignedAt: new Date(),
          status: 'assigned',
          updatedAt: new Date(),
        },
        'assigned',
        tx,
      );
      await this.taskAudit(tx, task, row, 'assign', actor);
      await this.recordEvent(
        tx,
        propertyId,
        'housekeeping.task_assigned',
        'housekeeping_task',
        taskId,
        { assignedTo: dto.assignedTo, roomId: task.roomId, type: task.type },
        ids,
      );
      return row;
    });
    await this.deliverEvents(propertyId, ids, () =>
      this.webhookService.emit(
        'housekeeping.task_assigned',
        'housekeeping_task',
        taskId,
        {
          assignedTo: dto.assignedTo,
          roomId: updated.roomId,
          type: updated.type,
        },
        propertyId,
      ),
    );
    return updated;
  }
  async startTask(
    taskId: string,
    propertyId: string,
    workerId?: string,
    actor?: AuditActor,
  ) {
    return this.db.transaction(async (tx: any) => {
      if (this.shifts) await this.shifts.lockAssignments(propertyId, tx);
      const task = await this.findByIdRaw(taskId, propertyId, tx, true);
      this.assertWorker(task, workerId);
      if (task.status !== 'assigned')
        throw new BadRequestException(
          'Начать можно только назначенную задачу.',
        );
      if (workerId && this.shifts) {
        const staff = await this.shifts.availability(
          propertyId,
          new Date(task.serviceDate).toISOString().slice(0, 10),
          tx,
        );
        if (!staff.find((u: any) => u.id === workerId)?.workingNow)
          throw new ConflictException({
            code: 'OUTSIDE_WORKING_SHIFT',
            message: 'Начать задачу можно в подтверждённую смену вне перерыва.',
          });
      }
      const row = await this.claimTaskTransition(
        taskId,
        propertyId,
        ['assigned'],
        { status: 'in_progress', startedAt: new Date(), updatedAt: new Date() },
        'in_progress',
        tx,
      );
      await this.taskAudit(tx, task, row, 'start', actor);
      return row;
    });
  }

  async unassign(taskId: string, propertyId: string) {
    const task = await this.findByIdRaw(taskId, propertyId);

    if (task.status !== 'assigned') {
      throw new BadRequestException(
        `Cannot unassign task in '${task.status}' status — must be assigned`,
      );
    }

    // Bug 5: atomic claim
    const updated = await this.claimTaskTransition(
      taskId,
      propertyId,
      ['assigned'],
      {
        assignedTo: null,
        assignedAt: null,
        status: 'pending',
        updatedAt: new Date(),
      },
      'pending',
    );

    return updated;
  }

  async autoAssign(dto: AutoAssignDto, actor?: AuditActor) {
    // Get all pending tasks for this property + date, joined with rooms for sorting
    const tasks = await this.db
      .select({
        taskId: housekeepingTasks.id,
        priority: housekeepingTasks.priority,
        floor: rooms.floor,
        building: rooms.building,
      })
      .from(housekeepingTasks)
      .leftJoin(rooms, eq(housekeepingTasks.roomId, rooms.id))
      .where(
        and(
          eq(housekeepingTasks.propertyId, dto.propertyId),
          eq(housekeepingTasks.serviceDate, new Date(dto.serviceDate)),
          eq(housekeepingTasks.status, 'pending' as any),
        ),
      )
      .orderBy(
        desc(housekeepingTasks.priority),
        asc(rooms.floor),
        asc(rooms.building),
      );

    // Bug 5: each assign() now uses a conditional-update-by-status claim.
    // If another request claimed a task in between the SELECT above and the
    // UPDATE here (e.g. concurrent autoAssign or manual assign), the claim
    // fails and we simply skip that task rather than 500. Order: claim first,
    // webhook after — handled inside assign().
    let assigned = 0;
    for (let i = 0; i < tasks.length; i++) {
      const available = this.shifts
        ? (await this.shifts.availability(dto.propertyId, dto.serviceDate))
            .filter((u: any) => u.available && dto.housekeepers.includes(u.id))
            .sort(
              (a: any, b: any) => a.load - b.load || a.id.localeCompare(b.id),
            )
        : [];
      const housekeeper = this.shifts
        ? available[0]?.id
        : dto.housekeepers[i % dto.housekeepers.length];
      if (!housekeeper) break;
      try {
        await this.assign(
          tasks[i]!.taskId,
          dto.propertyId,
          { assignedTo: housekeeper },
          actor,
        );
        assigned++;
      } catch (err: any) {
        // Task was already claimed by a concurrent caller, or transitioned
        // out of 'pending' between the select and the update — skip.
        if (
          err instanceof ConflictException ||
          err instanceof BadRequestException
        ) {
          continue;
        }
        throw err;
      }
    }

    return { assigned, total: tasks.length };
  }

  private async deliverEvents(
    propertyId: string,
    ids: string[],
    fallback?: () => Promise<unknown>,
  ) {
    if (!this.outbox) {
      await fallback?.();
      return;
    }
    for (const id of ids) {
      try {
        await this.outbox.deliver(propertyId, id);
      } catch {
        /* Durable outbox retries delivery after commit. */
      }
    }
  }

  private async recordEvent(
    tx: any,
    propertyId: string,
    event: string,
    entityType: string,
    entityId: string,
    data: Record<string, unknown>,
    ids: string[],
  ) {
    if (!this.outbox) return;
    const id = randomUUID();
    await this.outbox.persist(
      tx,
      {
        event: event as any,
        entityType,
        entityId,
        propertyId,
        timestamp: new Date().toISOString(),
        data,
      },
      id,
    );
    ids.push(id);
  }

  private async taskAudit(
    tx: any,
    previous: any,
    next: any,
    action: string,
    actor?: AuditActor,
  ) {
    await tx
      .insert(auditLogs)
      .values({
        propertyId: previous.propertyId,
        entityType: 'housekeeping_task',
        entityId: previous.id,
        action,
        previousValue: previous,
        newValue: next,
        description: action,
        ...actorFields(actor),
      });
  }

  async completeTask(
    taskId: string,
    propertyId: string,
    dto: CompleteTaskDto = {},
    actor?: AuditActor,
    workerId?: string,
  ) {
    const ids: string[] = [];
    const updated = await this.db.transaction(async (tx: any) => {
      const task = await this.findByIdRaw(taskId, propertyId, tx, true);
      this.assertWorker(task, workerId);
      this.assertWorkerChecklist(task, dto.checklist, workerId);
      if (task.status !== 'in_progress')
        throw new BadRequestException(
          `Cannot complete task in '${task.status}' status — must be in_progress`,
        );
      await this.roomStatusService.lockRoom(task.roomId, propertyId, tx);
      const [property] = await tx
        .select({
          settings: properties.settings,
          timezone: properties.timezone,
        })
        .from(properties)
        .where(eq(properties.id, propertyId));
      const requireInspection =
        (property?.settings as any)?.requireInspection ?? true;
      const values: Record<string, unknown> = {
        status: requireInspection ? 'completed' : 'inspected',
        completedAt: new Date(),
        updatedAt: new Date(),
      };
      if (!requireInspection) values['inspectedAt'] = new Date();
      for (const key of [
        'checklist',
        'notes',
        'maintenanceRequired',
        'maintenanceNotes',
      ] as const)
        if (dto[key] !== undefined) values[key] = dto[key];
      const result = await this.claimTaskTransition(
        taskId,
        propertyId,
        ['in_progress'],
        values,
        values['status'] as string,
        tx,
      );
      const room = await this.roomStatusService.getRoomStatus(
        task.roomId,
        propertyId,
        tx,
      );
      let status = room.status;
      const transition = async (
        next: 'clean' | 'inspected' | 'guest_ready',
      ) => {
        await this.roomStatusService.transitionStatus(
          task.roomId,
          propertyId,
          next,
          undefined,
          tx,
        );
        await this.recordEvent(
          tx,
          propertyId,
          'room.status_changed',
          'room',
          task.roomId,
          { previousStatus: status, newStatus: next, roomNumber: room.number },
          ids,
        );
        status = next;
      };
      // Stayover work keeps an occupied room occupied. Repairs never return OOO/OOS inventory to sale.
      if (task.type !== 'maintenance' && status === 'vacant_dirty')
        await transition('clean');
      if (
        task.type !== 'maintenance' &&
        !requireInspection &&
        status === 'clean'
      ) {
        await transition('inspected');
        await transition('guest_ready');
      }
      if (dto.maintenanceRequired) {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en', {
            timeZone: property?.timezone ?? 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })
            .formatToParts(new Date())
            .map((p) => [p.type, p.value]),
        );
        await this.create(
          {
            propertyId,
            roomId: task.roomId,
            type: 'maintenance',
            priority: 5,
            serviceDate:
              parts['year'] + '-' + parts['month'] + '-' + parts['day'],
            notes: dto.maintenanceNotes,
          },
          tx,
        );
      }
      await this.taskAudit(tx, task, result, 'complete', actor);
      await this.recordEvent(
        tx,
        propertyId,
        'housekeeping.task_completed',
        'housekeeping_task',
        taskId,
        {
          roomId: task.roomId,
          type: task.type,
          maintenanceRequired: dto.maintenanceRequired ?? false,
        },
        ids,
      );
      return result;
    });
    await this.deliverEvents(propertyId, ids, () =>
      this.webhookService.emit(
        'housekeeping.task_completed',
        'housekeeping_task',
        taskId,
        {
          roomId: updated.roomId,
          type: updated.type,
          maintenanceRequired: dto.maintenanceRequired ?? false,
        },
        propertyId,
      ),
    );
    return updated;
  }

  async inspectTask(
    taskId: string,
    propertyId: string,
    dto: InspectTaskDto,
    actor?: AuditActor,
  ) {
    const ids: string[] = [];
    const result = await this.db.transaction(async (tx: any) => {
      const task = await this.findByIdRaw(taskId, propertyId, tx, true);
      if (task.status !== 'completed')
        throw new BadRequestException(
          `Cannot inspect task in '${task.status}' status — must be completed`,
        );
      await this.roomStatusService.lockRoom(task.roomId, propertyId, tx);
      const values: Record<string, unknown> = dto.passed
        ? {
            status: 'inspected',
            inspectedBy: dto.inspectedBy,
            inspectedAt: new Date(),
            updatedAt: new Date(),
          }
        : {
            status: 'pending',
            assignedTo: null,
            assignedAt: null,
            startedAt: null,
            completedAt: null,
            updatedAt: new Date(),
          };
      if (dto.checklist) values['checklist'] = dto.checklist;
      if (dto.notes !== undefined)
        values['notes'] = dto.passed
          ? dto.notes
          : 'Замечания инспектора: ' +
            dto.notes +
            (task.notes ? '\n' + task.notes : '');
      const updated = await this.claimTaskTransition(
        taskId,
        propertyId,
        ['completed'],
        values,
        values['status'] as string,
        tx,
      );
      const room = await this.roomStatusService.getRoomStatus(
        task.roomId,
        propertyId,
        tx,
      );
      if (
        dto.passed &&
        task.type !== 'maintenance' &&
        room.status === 'clean'
      ) {
        await this.roomStatusService.transitionStatus(
          task.roomId,
          propertyId,
          'inspected',
          undefined,
          tx,
        );
        await this.roomStatusService.transitionStatus(
          task.roomId,
          propertyId,
          'guest_ready',
          undefined,
          tx,
        );
        await this.recordEvent(
          tx,
          propertyId,
          'room.status_changed',
          'room',
          task.roomId,
          {
            previousStatus: 'clean',
            newStatus: 'guest_ready',
            roomNumber: room.number,
          },
          ids,
        );
      }
      await this.taskAudit(
        tx,
        task,
        updated,
        dto.passed ? 'inspect_passed' : 'inspect_failed',
        actor,
      );
      await this.recordEvent(
        tx,
        propertyId,
        'housekeeping.task_inspected',
        'housekeeping_task',
        taskId,
        { roomId: task.roomId, passed: dto.passed, status: updated.status },
        ids,
      );
      return updated;
    });
    await this.deliverEvents(propertyId, ids);
    return result;
  }

  async skipTask(taskId: string, propertyId: string, reason?: string) {
    const task = await this.findByIdRaw(taskId, propertyId);

    if (task.status !== 'pending' && task.status !== 'assigned') {
      throw new BadRequestException(
        `Cannot skip task in '${task.status}' status — must be pending or assigned`,
      );
    }

    // Bug 5: atomic claim — only pending/assigned can skip
    const updated = await this.claimTaskTransition(
      taskId,
      propertyId,
      ['pending', 'assigned'],
      {
        status: 'skipped',
        notes: reason ? `Skipped: ${reason}` : task.notes,
        updatedAt: new Date(),
      },
      'skipped',
    );

    return updated;
  }

  /**
   * Atomic state-machine transition for housekeeping tasks (Bug 5,
   * PR-A pattern). See ReservationService.claimTransition for rationale.
   */
  private async claimTaskTransition(
    taskId: string,
    propertyId: string,
    allowedFromStatuses: string[],
    updateData: Record<string, unknown>,
    targetStatus: string,
    db: any = this.db,
  ) {
    const statusCondition =
      allowedFromStatuses.length === 1
        ? eq(housekeepingTasks.status, allowedFromStatuses[0]! as any)
        : inArray(housekeepingTasks.status, allowedFromStatuses as any);

    const claimed = await db
      .update(housekeepingTasks)
      .set(updateData)
      .where(
        and(
          eq(housekeepingTasks.id, taskId),
          eq(housekeepingTasks.propertyId, propertyId),
          statusCondition,
        ),
      )
      .returning();

    if (claimed && claimed.length > 0) {
      return claimed[0];
    }

    const [current] = await db
      .select()
      .from(housekeepingTasks)
      .where(
        and(
          eq(housekeepingTasks.id, taskId),
          eq(housekeepingTasks.propertyId, propertyId),
        ),
      );
    if (!current) {
      throw new NotFoundException(`Housekeeping task ${taskId} not found`);
    }
    throw new ConflictException(
      `Cannot transition task from '${current.status}' to '${targetStatus}' ` +
        `(concurrent modification? expected one of: ${allowedFromStatuses.join(', ')})`,
    );
  }

  // propertyId is REQUIRED so the room/reservation reads below stay tenant-scoped:
  // roomId comes from the request body, so without an `eq(...propertyId)` filter a
  // caller at property A could pass a roomId from property B and leak that room's
  // ADA status / next-guest VIP level (cross-tenant IDOR).
  private async nextGuestIsVip(
    roomId: string,
    propertyId: string,
  ): Promise<boolean> {
    const [nextReservation] = await this.db
      .select({ vipLevel: guests.vipLevel })
      .from(reservations)
      .leftJoin(guests, eq(reservations.guestId, guests.id))
      .where(
        and(
          eq(reservations.roomId, roomId),
          eq(reservations.propertyId, propertyId),
          inArray(reservations.status, ['confirmed', 'assigned'] as any),
        ),
      )
      .orderBy(asc(reservations.arrivalDate))
      .limit(1);

    return !!(nextReservation?.vipLevel && nextReservation.vipLevel !== 'none');
  }

  private async generateChecklist(
    taskType: string,
    roomId: string,
    propertyId: string,
  ): Promise<{
    items: Array<{ item: string; checked: boolean; notes?: string }>;
    isVip: boolean;
  }> {
    const template = CHECKLIST_TEMPLATES[taskType];
    if (!template) return { items: [], isVip: false };

    const items = template.map((item) => ({ ...item }));

    // Check if room is ADA accessible (scoped to the property)
    const [room] = await this.db
      .select({ isAccessible: rooms.isAccessible })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId)));

    if (room?.isAccessible) {
      items.push(...ADA_EXTRA_ITEMS.map((item) => ({ ...item })));
    }

    const isVip = await this.nextGuestIsVip(roomId, propertyId);
    if (isVip) {
      items.push(...VIP_EXTRA_ITEMS.map((item) => ({ ...item })));
    }

    return { items, isVip };
  }

  async getDashboard(propertyId: string, serviceDate?: string) {
    const resolvedDate = await this.resolveServiceDate(propertyId, serviceDate);
    const { dayStart, dayEnd } = this.serviceDateDayRange(resolvedDate);

    // Room summary
    const roomSummaryRaw =
      await this.roomStatusService.getPropertyRoomSummary(propertyId);
    const roomSummary: Record<string, number> = {
      total: 0,
      vacant_clean: 0,
      vacant_dirty: 0,
      clean: 0,
      inspected: 0,
      guest_ready: 0,
      occupied: 0,
      out_of_order: 0,
      out_of_service: 0,
    };
    for (const row of roomSummaryRaw) {
      const count = Number(row.count);
      roomSummary[row.status] = count;
      roomSummary['total'] = (roomSummary['total'] ?? 0) + count;
    }

    // Task summary
    const taskSummaryRaw = await this.db
      .select({
        status: housekeepingTasks.status,
        count: sql<number>`count(*)::int`,
      })
      .from(housekeepingTasks)
      .where(
        and(
          eq(housekeepingTasks.propertyId, propertyId),
          gte(housekeepingTasks.serviceDate, dayStart),
          lt(housekeepingTasks.serviceDate, dayEnd),
        ),
      )
      .groupBy(housekeepingTasks.status);

    const taskSummary: Record<string, number> = {
      total: 0,
      pending: 0,
      assigned: 0,
      in_progress: 0,
      completed: 0,
      inspected: 0,
      skipped: 0,
    };
    for (const row of taskSummaryRaw) {
      const count = Number(row.count);
      taskSummary[row.status] = count;
      taskSummary['total'] = (taskSummary['total'] ?? 0) + count;
    }

    // Housekeeper summary
    const housekeeperSummary = await this.db
      .select({
        housekeeperId: housekeepingTasks.assignedTo,
        tasksAssigned: sql<number>`count(*)::int`,
        tasksCompleted: sql<number>`count(*) filter (where ${housekeepingTasks.status} in ('completed', 'inspected'))::int`,
        tasksInProgress: sql<number>`count(*) filter (where ${housekeepingTasks.status} = 'in_progress')::int`,
        avgTurnTimeMinutes: sql<number>`avg(extract(epoch from (${housekeepingTasks.completedAt} - ${housekeepingTasks.startedAt})) / 60)`,
      })
      .from(housekeepingTasks)
      .where(
        and(
          eq(housekeepingTasks.propertyId, propertyId),
          gte(housekeepingTasks.serviceDate, dayStart),
          lt(housekeepingTasks.serviceDate, dayEnd),
          sql`${housekeepingTasks.assignedTo} is not null`,
        ),
      )
      .groupBy(housekeepingTasks.assignedTo);

    // Urgent rooms — high priority or maintenance flagged
    const urgentRooms = await this.db
      .select({
        roomId: housekeepingTasks.roomId,
        roomNumber: rooms.number,
        floor: rooms.floor,
        status: rooms.status,
        taskStatus: housekeepingTasks.status,
        priority: housekeepingTasks.priority,
        maintenanceRequired: housekeepingTasks.maintenanceRequired,
      })
      .from(housekeepingTasks)
      .leftJoin(rooms, eq(housekeepingTasks.roomId, rooms.id))
      .where(
        and(
          eq(housekeepingTasks.propertyId, propertyId),
          gte(housekeepingTasks.serviceDate, dayStart),
          lt(housekeepingTasks.serviceDate, dayEnd),
          sql`(${housekeepingTasks.priority} >= 5 or ${housekeepingTasks.maintenanceRequired} = true)`,
        ),
      )
      .orderBy(desc(housekeepingTasks.priority));

    return {
      date: resolvedDate,
      roomSummary,
      taskSummary,
      housekeeperSummary: housekeeperSummary.map((h: any) => ({
        ...h,
        avgTurnTimeMinutes: h.avgTurnTimeMinutes
          ? Number(h.avgTurnTimeMinutes)
          : null,
      })),
      urgentRooms: urgentRooms.map((r: any) => ({
        roomId: r.roomId,
        roomNumber: r.roomNumber,
        floor: r.floor,
        status: r.status,
        taskStatus: r.taskStatus,
        priority: r.priority,
        reason: r.maintenanceRequired ? 'maintenance flagged' : 'high priority',
      })),
    };
  }

  async getAnalytics(propertyId: string, startDate?: string, endDate?: string) {
    const period = await this.resolveAnalyticsPeriod(
      propertyId,
      startDate,
      endDate,
    );
    const { dayStart } = this.serviceDateDayRange(period.start);
    const { dayEnd } = this.serviceDateDayRange(period.end);

    const baseWhere = and(
      eq(housekeepingTasks.propertyId, propertyId),
      gte(housekeepingTasks.serviceDate, dayStart),
      lt(housekeepingTasks.serviceDate, dayEnd),
      sql`${housekeepingTasks.status} in ('completed', 'inspected')`,
    );

    // Overall metrics
    const metrics = (
      await this.db
        .select({
          avgTurnTimeMinutes: sql<number>`avg(extract(epoch from (${housekeepingTasks.completedAt} - ${housekeepingTasks.startedAt})) / 60)`,
          medianTurnTimeMinutes: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from (${housekeepingTasks.completedAt} - ${housekeepingTasks.startedAt})) / 60)`,
          totalTasksCompleted: sql<number>`count(*)::int`,
          maintenanceIssueCount: sql<number>`count(*) filter (where ${housekeepingTasks.maintenanceRequired} = true)::int`,
          inspectedCount: sql<number>`count(*) filter (where ${housekeepingTasks.status} = 'inspected')::int`,
        })
        .from(housekeepingTasks)
        .where(baseWhere)
    )[0] ?? {
      avgTurnTimeMinutes: 0,
      medianTurnTimeMinutes: 0,
      totalTasksCompleted: 0,
      maintenanceIssueCount: 0,
      inspectedCount: 0,
    };

    // Tasks by type
    const tasksByTypeRaw = await this.db
      .select({
        type: housekeepingTasks.type,
        count: sql<number>`count(*)::int`,
      })
      .from(housekeepingTasks)
      .where(baseWhere)
      .groupBy(housekeepingTasks.type);

    const tasksByType: Record<string, number> = {};
    for (const row of tasksByTypeRaw) {
      tasksByType[row.type] = Number(row.count);
    }

    // By room type
    const byRoomType = await this.db
      .select({
        roomTypeName: roomTypes.name,
        avgTurnTimeMinutes: sql<number>`avg(extract(epoch from (${housekeepingTasks.completedAt} - ${housekeepingTasks.startedAt})) / 60)`,
        taskCount: sql<number>`count(*)::int`,
      })
      .from(housekeepingTasks)
      .leftJoin(rooms, eq(housekeepingTasks.roomId, rooms.id))
      .leftJoin(roomTypes, eq(rooms.roomTypeId, roomTypes.id))
      .where(baseWhere)
      .groupBy(roomTypes.name);

    // By housekeeper
    const byHousekeeper = await this.db
      .select({
        housekeeperId: housekeepingTasks.assignedTo,
        tasksCompleted: sql<number>`count(*)::int`,
        avgTurnTimeMinutes: sql<number>`avg(extract(epoch from (${housekeepingTasks.completedAt} - ${housekeepingTasks.startedAt})) / 60)`,
      })
      .from(housekeepingTasks)
      .where(and(baseWhere, sql`${housekeepingTasks.assignedTo} is not null`))
      .groupBy(housekeepingTasks.assignedTo);

    const total = Number(metrics.totalTasksCompleted ?? 0);
    const inspectionPassRate =
      total > 0 ? Number(metrics.inspectedCount ?? 0) / total : 0;
    const maintenanceIssueRate =
      total > 0 ? Number(metrics.maintenanceIssueCount ?? 0) / total : 0;

    // Distinct housekeepers
    const housekeeperCount = byHousekeeper.length || 1;

    return {
      period: { start: period.start, end: period.end },
      metrics: {
        avgTurnTimeMinutes: metrics.avgTurnTimeMinutes
          ? Number(metrics.avgTurnTimeMinutes)
          : 0,
        medianTurnTimeMinutes: metrics.medianTurnTimeMinutes
          ? Number(metrics.medianTurnTimeMinutes)
          : 0,
        totalTasksCompleted: total,
        tasksByType,
        inspectionPassRate,
        maintenanceIssueRate,
        avgTasksPerHousekeeper: total / housekeeperCount,
      },
      byRoomType: byRoomType.map((r: any) => ({
        roomTypeName: r.roomTypeName,
        avgTurnTimeMinutes: r.avgTurnTimeMinutes
          ? Number(r.avgTurnTimeMinutes)
          : 0,
        taskCount: Number(r.taskCount),
      })),
      byHousekeeper: byHousekeeper.map((h: any) => ({
        housekeeperId: h.housekeeperId,
        tasksCompleted: Number(h.tasksCompleted),
        avgTurnTimeMinutes: h.avgTurnTimeMinutes
          ? Number(h.avgTurnTimeMinutes)
          : 0,
      })),
    };
  }

  /**
   * Ops forecast for a service date: expected checkout vs stayover task volumes
   * derived from in-house reservations (same signals as generate-stayover-tasks).
   */
  async getOpsForecast(propertyId: string, date: string) {
    const inHouseStatuses = [
      'assigned',
      'checked_in',
      'stayover',
      'due_out',
    ] as const;
    const baseWhere = and(
      eq(reservations.propertyId, propertyId),
      inArray(reservations.status, [...inHouseStatuses]),
      sql`${reservations.roomId} is not null`,
    );

    const [checkoutRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(and(baseWhere, eq(reservations.departureDate, date)));

    const [stayoverRow] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        and(
          baseWhere,
          lte(reservations.arrivalDate, date),
          gt(reservations.departureDate, date),
        ),
      );

    return {
      date,
      expectedCheckouts: Number(checkoutRow?.count ?? 0),
      expectedStayovers: Number(stayoverRow?.count ?? 0),
    };
  }

  async generateStayoverTasks(propertyId: string, serviceDate: string) {
    const occupiedRooms = await this.roomStatusService.getRoomsByStatus(
      propertyId,
      'occupied',
    );

    let created = 0;
    let skipped = 0;

    for (const room of occupiedRooms) {
      // Check if a stayover task already exists for this room + date
      const [existing] = await this.db
        .select({ id: housekeepingTasks.id })
        .from(housekeepingTasks)
        .where(
          and(
            eq(housekeepingTasks.propertyId, propertyId),
            eq(housekeepingTasks.roomId, room.id),
            eq(housekeepingTasks.serviceDate, new Date(serviceDate)),
            eq(housekeepingTasks.type, 'stayover' as any),
          ),
        );

      if (existing) {
        skipped++;
        continue;
      }

      await this.create({
        propertyId,
        roomId: room.id,
        type: 'stayover',
        priority: 0,
        serviceDate,
      });
      created++;
    }

    return { created, skipped };
  }

  @OnEvent('room.status_changed')
  async handleRoomStatusChanged(payload: WebhookPayload) {
    if (payload.data['newStatus'] !== 'vacant_dirty') return;

    const propertyId = payload.propertyId!;
    const roomId = payload.entityId;

    // Bug 6: resolve the service date in the property's local timezone, not
    // server UTC. A 23:30 local checkout in America/Los_Angeles was landing
    // on tomorrow's UTC date and creating the task under the wrong day.
    const today = await this.getPropertyBusinessDate(propertyId);

    // Check for existing checkout task for this room + date to avoid duplicates
    const [existing] = await this.db
      .select({ id: housekeepingTasks.id })
      .from(housekeepingTasks)
      .where(
        and(
          eq(housekeepingTasks.propertyId, propertyId),
          eq(housekeepingTasks.roomId, roomId),
          eq(housekeepingTasks.serviceDate, new Date(today)),
          eq(housekeepingTasks.type, 'checkout' as any),
          sql`${housekeepingTasks.status} not in ('skipped', 'inspected')`,
        ),
      );

    if (existing) return;

    await this.create({
      propertyId,
      roomId,
      type: 'checkout',
      priority: 0,
      serviceDate: today,
    });
  }

  private static readonly BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  private isValidBusinessDate(date: string): boolean {
    if (!HousekeepingService.BUSINESS_DATE_RE.test(date)) return false;
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d));
    return (
      dt.getUTCFullYear() === y &&
      dt.getUTCMonth() === m! - 1 &&
      dt.getUTCDate() === d
    );
  }

  private serviceDateDayRange(dateStr: string): {
    dayStart: Date;
    dayEnd: Date;
  } {
    const dayStart = new Date(dateStr + 'T00:00:00');
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return { dayStart, dayEnd };
  }

  private addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0]!;
  }

  private async resolveServiceDate(
    propertyId: string,
    serviceDate?: string,
  ): Promise<string> {
    if (!serviceDate) {
      return this.getPropertyBusinessDate(propertyId);
    }
    if (!this.isValidBusinessDate(serviceDate)) {
      throw new BadRequestException(
        'serviceDate must be a valid date (YYYY-MM-DD)',
      );
    }
    return serviceDate;
  }

  private async resolveAnalyticsPeriod(
    propertyId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<{ start: string; end: string }> {
    const today = await this.getPropertyBusinessDate(propertyId);
    const end = endDate ?? today;
    if (!this.isValidBusinessDate(end)) {
      throw new BadRequestException(
        'endDate must be a valid date (YYYY-MM-DD)',
      );
    }
    const start = startDate ?? this.addDays(end, -30);
    if (!this.isValidBusinessDate(start)) {
      throw new BadRequestException(
        'startDate must be a valid date (YYYY-MM-DD)',
      );
    }
    if (start > end) {
      throw new BadRequestException('startDate must be on or before endDate');
    }
    return { start, end };
  }

  /**
   * Bug 6: compute today's business date (YYYY-MM-DD) in the property's
   * configured timezone rather than server UTC. Intl.DateTimeFormat + en-CA
   * gives ISO-ordered parts which we concatenate directly.
   */
  private async getPropertyBusinessDate(propertyId: string): Promise<string> {
    const [property] = await this.db
      .select({ timezone: properties.timezone })
      .from(properties)
      .where(eq(properties.id, propertyId));

    const tz = (property?.timezone as string | undefined) ?? 'UTC';
    try {
      // en-CA formats as YYYY-MM-DD natively
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      // Bad timezone on the property row — fall back to UTC rather than throw.
      return new Date().toISOString().split('T')[0]!;
    }
  }

  private async findByIdRaw(
    id: string,
    propertyId: string,
    db: any = this.db,
    lock = false,
  ) {
    const query = db
      .select()
      .from(housekeepingTasks)
      .where(
        and(
          eq(housekeepingTasks.id, id),
          eq(housekeepingTasks.propertyId, propertyId),
        ),
      );
    const [task] = await (lock ? query.for('update') : query);

    if (!task) {
      throw new NotFoundException(`Housekeeping task ${id} not found`);
    }

    return task;
  }
}
