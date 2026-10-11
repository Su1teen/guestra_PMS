import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, gt, lt, asc, desc, like, sql } from 'drizzle-orm';
import {
  staffShifts,
  staffShiftTemplates,
  users,
  userRoles,
  rolePermissions,
  housekeepingTasks,
  properties,
  auditLogs,
} from '@telivityhaip/database';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import {
  StaffShiftDto,
  StaffShiftTemplateDto,
  ApplyShiftTemplateDto,
} from './dto/staff-shift.dto';

const error = (code: string, message: string) => ({ code, message });
export function shiftInterval(start: string, end: string, maxHours = 25) {
  const offset = /(?:Z|[+-]\d{2}:\d{2})$/;
  const a = new Date(start),
    b = new Date(end);
  if (
    !offset.test(start) ||
    !offset.test(end) ||
    !Number.isFinite(a.getTime()) ||
    !Number.isFinite(b.getTime()) ||
    b <= a ||
    +b - +a > maxHours * 3600000
  )
    throw new BadRequestException(
      error(
        'INVALID_SHIFT_INTERVAL',
        'Укажите начало и конец с часовым поясом, период до ' +
          (maxHours === 25 ? '25 часов.' : '93 дней.'),
      ),
    );
  return { start: a, end: b };
}
export function onDate(instant: Date, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(instant)
      .map((v) => [v.type, v.value]),
  );
  return p['year'] + '-' + p['month'] + '-' + p['day'];
}
/** Actual work segments exclude explicit breaks, including overnight shifts. */
export function shiftWorkSegments(shift: {
  startAt: Date | string;
  endAt: Date | string;
  breaks?: { startAt: string; endAt: string }[];
}) {
  let cursor = +new Date(shift.startAt);
  const end = +new Date(shift.endAt);
  const segments: { start: Date; end: Date }[] = [];
  for (const pause of shift.breaks ?? []) {
    const a = Date.parse(pause.startAt),
      b = Date.parse(pause.endAt);
    if (a > cursor)
      segments.push({ start: new Date(cursor), end: new Date(a) });
    cursor = b;
  }
  if (cursor < end)
    segments.push({ start: new Date(cursor), end: new Date(end) });
  return segments;
}
export function subtractAbsences(
  segment: { start: Date; end: Date },
  absences: Array<{ startAt: Date | string; endAt: Date | string }>,
) {
  let result = [segment];
  for (const absence of absences) {
    const a = +new Date(absence.startAt),
      b = +new Date(absence.endAt);
    result = result.flatMap((s) =>
      a >= +s.end || b <= +s.start
        ? [s]
        : [
            ...(a > +s.start ? [{ start: s.start, end: new Date(a) }] : []),
            ...(b < +s.end ? [{ start: new Date(b), end: s.end }] : []),
          ],
    );
  }
  return result;
}
export function shiftWallInstant(local: string, zone: string) {
  const render = (d: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(d)
        .map((v) => [v.type, v.value]),
    );
    return `${p['year']}-${p['month']}-${p['day']}T${p['hour']}:${p['minute']}`;
  };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new BadRequestException('Укажите дату и время шаблона.');
  const wall = Date.parse(local + ':00Z');
  const offsets = new Set(
    [-24, 0, 24].map((h) => {
      const d = new Date(wall + h * 3600000);
      return Date.parse(render(d) + ':00Z') - +d;
    }),
  );
  const matches = [...offsets]
    .map((offset) => new Date(wall - offset))
    .filter((d) => render(d) === local);
  if (matches.length !== 1)
    throw new BadRequestException(
      'Время отсутствует или неоднозначно из-за перевода часов. Выберите другое время шаблона.',
    );
  return matches[0]!.toISOString();
}
function publicShift(row: any) {
  const {
    idempotencyKey: _key,
    requestFingerprint: _fingerprint,
    ...result
  } = row;
  for (const field of ['startAt', 'endAt', 'createdAt', 'updatedAt'])
    result[field] = new Date(result[field]).toISOString();
  return result;
}
@Injectable()
export class StaffShiftService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly outbox: DomainEventOutboxService,
  ) {}
  async history(propertyId: string, id: string, workerId?: string) {
    const conditions = [
      eq(staffShifts.propertyId, propertyId),
      eq(staffShifts.id, id),
    ];
    if (workerId) conditions.push(eq(staffShifts.userId, workerId));
    const [shift] = await this.db
      .select({ id: staffShifts.id })
      .from(staffShifts)
      .where(and(...conditions));
    if (!shift)
      throw new NotFoundException(
        error('SHIFT_NOT_FOUND', 'Смена не найдена в этом объекте.'),
      );
    const rows = await this.db
      .select({
        action: auditLogs.action,
        occurredAt: auditLogs.occurredAt,
        authorName: users.name,
        next: auditLogs.newValue,
        previous: auditLogs.previousValue,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(
        and(
          eq(auditLogs.propertyId, propertyId),
          eq(auditLogs.entityType, 'staff_shift'),
          eq(auditLogs.entityId, id),
          like(auditLogs.description, 'staff_shift.request:%'),
          inArray(auditLogs.action, ['create', 'update']),
        ),
      )
      .orderBy(desc(auditLogs.occurredAt))
      .limit(100);
    return rows.map((row: any) => ({
      ...row,
      next: row.next?.response ?? null,
    }));
  }
  async staff(propertyId: string, db: any = this.db) {
    return db
      .selectDistinct({ id: users.id, name: users.name })
      .from(users)
      .innerJoin(
        userRoles,
        and(
          eq(userRoles.userId, users.id),
          eq(userRoles.propertyId, propertyId),
        ),
      )
      .innerJoin(
        rolePermissions,
        and(
          eq(rolePermissions.roleId, userRoles.roleId),
          eq(rolePermissions.propertyId, propertyId),
        ),
      )
      .where(
        and(
          eq(users.status, 'active'),
          inArray(rolePermissions.permissionKey, [
            'housekeeping.execute',
            'housekeeping.manage',
          ]),
        ),
      )
      .orderBy(asc(users.name));
  }
  async list(
    propertyId: string,
    startAt: string,
    endAt: string,
    userId?: string,
  ) {
    const a = new Date(startAt),
      b = new Date(endAt);
    if (
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(startAt ?? '') ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(endAt ?? '') ||
      !Number.isFinite(+a) ||
      !Number.isFinite(+b) ||
      b <= a ||
      +b - +a > 35 * 86400000
    )
      throw new BadRequestException(
        error(
          'INVALID_SHIFT_RANGE',
          'Период календаря смен — от одного дня до 35 дней с явным часовым поясом.',
        ),
      );
    const conditions = [
      eq(staffShifts.propertyId, propertyId),
      lt(staffShifts.startAt, b),
      gt(staffShifts.endAt, a),
    ];
    if (userId) conditions.push(eq(staffShifts.userId, userId));
    const rows = await this.db
      .select()
      .from(staffShifts)
      .where(and(...conditions))
      .orderBy(asc(staffShifts.startAt))
      .limit(2001);
    if (rows.length > 2000)
      throw new BadRequestException(
        error(
          'SHIFT_RANGE_TOO_LARGE',
          'Сузьте период или выберите сотрудника.',
        ),
      );
    return rows.map(publicShift);
  }
  async save(
    dto: StaffShiftDto,
    id?: string,
    actor?: AuditActor,
    transaction?: any,
    deferredEvents?: string[],
  ) {
    if (!dto.idempotencyKey?.trim())
      throw new BadRequestException(
        error('INVALID_REQUEST_KEY', 'Укажите ключ операции.'),
      );
    const kind = dto.kind ?? 'shift';
    if (
      kind === 'absence' &&
      (!dto.absenceType || dto.breaks?.length || dto.maxOpenTasks != null)
    )
      throw new BadRequestException(
        'Укажите вид отсутствия без перерывов и лимита задач.',
      );
    if (kind === 'shift' && dto.absenceType)
      throw new BadRequestException(
        'Для рабочей смены не указывают вид отсутствия.',
      );
    const interval = shiftInterval(
      dto.startAt,
      dto.endAt,
      kind === 'absence' ? 93 * 24 : 25,
    );
    const breaks = (dto.breaks ?? [])
      .map((b) => {
        const time = shiftInterval(b.startAt, b.endAt);
        return {
          startAt: time.start.toISOString(),
          endAt: time.end.toISOString(),
        };
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    for (let i = 0; i < breaks.length; i++)
      if (
        Date.parse(breaks[i]!.startAt) < +interval.start ||
        Date.parse(breaks[i]!.endAt) > +interval.end ||
        (i > 0 && breaks[i]!.startAt < breaks[i - 1]!.endAt)
      )
        throw new BadRequestException(
          error(
            'INVALID_SHIFT_BREAKS',
            'Перерывы должны находиться внутри смены и не пересекаться.',
          ),
        );
    const values = {
      ...(dto.kind ? { kind, absenceType: dto.absenceType ?? null } : {}),
      userId: dto.userId,
      startAt: interval.start.toISOString(),
      endAt: interval.end.toISOString(),
      status: dto.status,
      breaks,
      maxOpenTasks: dto.maxOpenTasks ?? null,
      notes: dto.notes ?? null,
    };
    const fingerprint = JSON.stringify({
      id: id ?? null,
      expectedRevision: dto.expectedRevision ?? null,
      ...values,
    });
    const eventIds: string[] = [];
    let result: any;
    try {
      const mutate = async (tx: any) => {
        await this.lockAssignments(dto.propertyId, tx);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${dto.propertyId + ':staff-shift:' + dto.idempotencyKey},0))`,
        );
        const receiptDescription = 'staff_shift.request:' + dto.idempotencyKey;
        const [receipt] = await tx
          .select({ value: auditLogs.newValue })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.propertyId, dto.propertyId),
              eq(auditLogs.entityType, 'staff_shift'),
              eq(auditLogs.description, receiptDescription),
            ),
          )
          .limit(1);
        if (receipt) {
          if (receipt.value.closed)
            throw new ConflictException(
              error(
                'REQUEST_CLOSED',
                'Запрос закрыт. Эта смена не будет создана поздним повтором.',
              ),
            );
          if (receipt.value.fingerprint !== fingerprint)
            throw new ConflictException(
              error(
                'IDEMPOTENCY_CONFLICT',
                'Этот ключ уже использован для другой операции.',
              ),
            );
          return receipt.value.response;
        }
        const staff = await this.staff(dto.propertyId, tx);
        if (!staff.some((u: any) => u.id === dto.userId))
          throw new BadRequestException(
            error(
              'INVALID_SHIFT_ASSIGNEE',
              'Сотрудник неактивен или не имеет прав уборки в этом объекте.',
            ),
          );
        let previous: any;
        if (id) {
          [previous] = await tx
            .select()
            .from(staffShifts)
            .where(
              and(
                eq(staffShifts.id, id),
                eq(staffShifts.propertyId, dto.propertyId),
              ),
            )
            .for('update');
          if (!previous)
            throw new NotFoundException(
              error('SHIFT_NOT_FOUND', 'Смена не найдена в этом объекте.'),
            );
          if ((previous.kind ?? 'shift') !== kind)
            throw new ConflictException(
              'Вид записи календаря нельзя менять. Создайте отдельную запись.',
            );
          if (dto.expectedRevision !== previous.revision)
            throw new ConflictException(
              error('STALE_REVISION', 'Смена изменилась. Обновите календарь.'),
            );
        }
        const record = {
          ...values,
          startAt: interval.start,
          endAt: interval.end,
          updatedAt: new Date(),
        };
        const [row] = id
          ? await tx
              .update(staffShifts)
              .set({ ...record, revision: previous.revision + 1 })
              .where(
                and(
                  eq(staffShifts.id, id),
                  eq(staffShifts.propertyId, dto.propertyId),
                ),
              )
              .returning()
          : await tx
              .insert(staffShifts)
              .values({
                ...record,
                propertyId: dto.propertyId,
                idempotencyKey: dto.idempotencyKey,
                requestFingerprint: fingerprint,
              })
              .returning();
        const response = publicShift(row);
        await tx.insert(auditLogs).values({
          propertyId: dto.propertyId,
          entityType: 'staff_shift',
          entityId: row.id,
          action: id ? 'update' : 'create',
          description: receiptDescription,
          previousValue: previous ? publicShift(previous) : null,
          newValue: { fingerprint, response },
          ...actorFields(actor),
        });
        const eventId = randomUUID();
        await this.outbox.persist(
          tx,
          {
            propertyId: dto.propertyId,
            event: 'staff_shift.updated' as any,
            entityType: 'staff_shift',
            entityId: row.id,
            timestamp: new Date().toISOString(),
            data: {
              shiftId: row.id,
              userId: row.userId,
              status: row.status,
              revision: row.revision,
            },
          },
          eventId,
        );
        eventIds.push(eventId);
        return response;
      };
      result = transaction
        ? await mutate(transaction)
        : await this.db.transaction(mutate);
    } catch (e: any) {
      if (e.code === '23P01' || e.cause?.code === '23P01')
        throw new ConflictException(
          error('SHIFT_CONFLICT', 'У сотрудника уже есть смена на это время.'),
        );
      throw e;
    }
    if (transaction) {
      deferredEvents?.push(...eventIds);
      return result;
    }
    for (const eventId of eventIds) {
      try {
        await this.outbox.deliver(dto.propertyId, eventId);
      } catch {
        /* Durable outbox owns retry. */
      }
    }
    return result;
  }
  async templates(propertyId: string) {
    const rows = await this.db
      .select()
      .from(staffShiftTemplates)
      .where(eq(staffShiftTemplates.propertyId, propertyId))
      .orderBy(asc(staffShiftTemplates.name))
      .limit(501);
    if (rows.length > 500)
      throw new BadRequestException(
        'Сузьте каталог шаблонов смен: максимум 500 шаблонов.',
      );
    return JSON.parse(JSON.stringify(rows));
  }
  private async templateMutation(
    propertyId: string,
    key: string,
    fingerprint: string,
    actor: AuditActor | undefined,
    work: (tx: any, events: string[]) => Promise<any>,
  ) {
    if (!key?.trim() || key.length > 200)
      throw new BadRequestException('Укажите ключ операции календаря.');
    const events: string[] = [];
    const result = await this.db.transaction(async (tx: any) => {
      await this.lockAssignments(propertyId, tx);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':staff-shift:' + key},0))`,
      );
      const description = 'staff_shift.request:' + key;
      const [receipt] = await tx
        .select({ value: auditLogs.newValue })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.propertyId, propertyId),
            eq(auditLogs.entityType, 'staff_shift'),
            eq(auditLogs.description, description),
          ),
        )
        .limit(1);
      if (receipt) {
        if (receipt.value.closed)
          throw new ConflictException(
            error('REQUEST_CLOSED', 'Запрос календаря закрыт.'),
          );
        if (receipt.value.fingerprint !== fingerprint)
          throw new ConflictException(
            error(
              'IDEMPOTENCY_CONFLICT',
              'Ключ использован для другой операции календаря.',
            ),
          );
        return receipt.value.response;
      }
      const response = JSON.parse(JSON.stringify(await work(tx, events)));
      await tx
        .insert(auditLogs)
        .values({
          propertyId,
          entityType: 'staff_shift',
          entityId: response.id,
          action: 'update',
          description,
          newValue: { fingerprint, response },
          ...actorFields(actor),
        });
      const eventId = randomUUID();
      await this.outbox.persist(
        tx,
        {
          propertyId,
          event: 'staff_shift.updated',
          entityType: 'staff_shift_template',
          entityId: response.id,
          timestamp: new Date().toISOString(),
          data: response,
        },
        eventId,
      );
      events.push(eventId);
      return response;
    });
    for (const eventId of events) {
      try {
        await this.outbox.deliver(propertyId, eventId);
      } catch {
        /* durable retry */
      }
    }
    return result;
  }
  async saveTemplate(
    dto: StaffShiftTemplateDto,
    id?: string,
    actor?: AuditActor,
  ) {
    if (
      !dto.name?.trim() ||
      !dto.weekdays?.length ||
      dto.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(dto.startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(dto.endTime) ||
      ![0, 1].includes(dto.overnight)
    )
      throw new BadRequestException(
        'Проверьте название, дни недели и время шаблона.',
      );
    const values = {
      userId: dto.userId,
      name: dto.name.trim(),
      weekdays: [...new Set(dto.weekdays)].sort(),
      startTime: dto.startTime,
      endTime: dto.endTime,
      overnight: dto.overnight,
      maxOpenTasks: dto.maxOpenTasks ?? null,
      notes: dto.notes ?? null,
    };
    const sampleStart = '2027-01-01T' + dto.startTime + ':00Z',
      sampleEnd =
        (dto.overnight ? '2027-01-02' : '2027-01-01') +
        'T' +
        dto.endTime +
        ':00Z';
    shiftInterval(sampleStart, sampleEnd);
    const fingerprint = JSON.stringify({
      operation: 'template',
      id: id ?? null,
      expectedRevision: dto.expectedRevision ?? null,
      ...values,
    });
    return this.templateMutation(
      dto.propertyId,
      dto.idempotencyKey,
      fingerprint,
      actor,
      async (tx) => {
        if (
          !(await this.staff(dto.propertyId, tx)).some(
            (u: any) => u.id === dto.userId,
          )
        )
          throw new BadRequestException(
            'Сотрудник не имеет действующих прав в этом объекте.',
          );
        if (id) {
          const [previous] = await tx
            .select()
            .from(staffShiftTemplates)
            .where(
              and(
                eq(staffShiftTemplates.id, id),
                eq(staffShiftTemplates.propertyId, dto.propertyId),
              ),
            )
            .for('update');
          if (!previous)
            throw new NotFoundException('Шаблон не найден в этом объекте.');
          if (previous.revision !== dto.expectedRevision)
            throw new ConflictException(
              error('STALE_REVISION', 'Шаблон изменился. Обновите календарь.'),
            );
          const [row] = await tx
            .update(staffShiftTemplates)
            .set({
              ...values,
              revision: previous.revision + 1,
              updatedAt: new Date(),
            })
            .where(eq(staffShiftTemplates.id, id))
            .returning();
          return { ...row, operation: 'template_saved', previous };
        }
        const [row] = await tx
          .insert(staffShiftTemplates)
          .values({ ...values, propertyId: dto.propertyId })
          .returning();
        return { ...row, operation: 'template_saved' };
      },
    );
  }
  async previewTemplate(
    id: string,
    dto: ApplyShiftTemplateDto,
    db: any = this.db,
  ) {
    const [template] = await db
      .select()
      .from(staffShiftTemplates)
      .where(
        and(
          eq(staffShiftTemplates.propertyId, dto.propertyId),
          eq(staffShiftTemplates.id, id),
        ),
      );
    if (!template)
      throw new NotFoundException('Шаблон не найден в этом объекте.');
    if (template.revision !== dto.expectedRevision)
      throw new ConflictException(
        error('STALE_REVISION', 'Шаблон изменился. Обновите календарь.'),
      );
    const a = Date.parse(dto.startDate + 'T00:00Z'),
      b = Date.parse(dto.endDate + 'T00:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dto.startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dto.endDate) ||
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      b < a ||
      b - a > 92 * 86400000 ||
      new Date(a).toISOString().slice(0, 10) !== dto.startDate ||
      new Date(b).toISOString().slice(0, 10) !== dto.endDate
    )
      throw new BadRequestException(
        'Период применения шаблона — до 93 календарных дней включительно.',
      );
    const [property] = await db
      .select({ timezone: properties.timezone })
      .from(properties)
      .where(eq(properties.id, dto.propertyId));
    if (!property) throw new NotFoundException('Объект не найден.');
    const candidates: StaffShiftDto[] = [];
    for (let day = a; day <= b; day += 86400000) {
      const d = new Date(day);
      if (!template.weekdays.includes(d.getUTCDay())) continue;
      const start = d.toISOString().slice(0, 10),
        end = new Date(day + template.overnight * 86400000)
          .toISOString()
          .slice(0, 10);
      const startAt = shiftWallInstant(
          start + 'T' + template.startTime,
          property.timezone,
        ),
        endAt = shiftWallInstant(
          end + 'T' + template.endTime,
          property.timezone,
        );
      shiftInterval(startAt, endAt);
      candidates.push({
        propertyId: dto.propertyId,
        userId: template.userId,
        startAt,
        endAt,
        status: dto.status,
        breaks: [],
        ...(template.maxOpenTasks != null
          ? { maxOpenTasks: template.maxOpenTasks }
          : {}),
        notes: template.notes ?? '',
        idempotencyKey: dto.idempotencyKey + ':' + start,
      });
    }
    if (!candidates.length)
      throw new BadRequestException('В выбранном периоде нет дней шаблона.');
    const first = new Date(candidates[0]!.startAt),
      last = new Date(candidates[candidates.length - 1]!.endAt);
    // Cross-property collision must reject, without disclosing the other hotel's details.
    const existing = await db
      .select({
        id: staffShifts.id,
        propertyId: staffShifts.propertyId,
        startAt: staffShifts.startAt,
        endAt: staffShifts.endAt,
        kind: staffShifts.kind,
      })
      .from(staffShifts)
      .where(
        and(
          eq(staffShifts.userId, template.userId),
          lt(staffShifts.startAt, last),
          gt(staffShifts.endAt, first),
          inArray(staffShifts.status, ['planned', 'confirmed']),
        ),
      );
    const conflicts = existing.filter(
      (s: any) =>
        s.kind === 'shift' &&
        candidates.some(
          (c) =>
            +s.startAt < Date.parse(c.endAt) &&
            +s.endAt > Date.parse(c.startAt),
        ),
    );
    const absences = existing.filter(
      (s: any) =>
        s.kind === 'absence' &&
        s.propertyId === dto.propertyId &&
        candidates.some(
          (c) =>
            +s.startAt < Date.parse(c.endAt) &&
            +s.endAt > Date.parse(c.startAt),
        ),
    );
    return {
      id,
      template,
      candidates,
      canApply: !conflicts.length,
      conflictingShiftIds: conflicts
        .filter((s: any) => s.propertyId === dto.propertyId)
        .map((s: any) => s.id),
      foreignConflict: conflicts.some(
        (s: any) => s.propertyId !== dto.propertyId,
      ),
      absenceWarnings: absences.map((s: any) => s.id),
    };
  }
  async applyTemplate(
    id: string,
    dto: ApplyShiftTemplateDto,
    actor?: AuditActor,
  ) {
    return this.templateMutation(
      dto.propertyId,
      dto.idempotencyKey,
      JSON.stringify({ operation: 'apply_template', id, ...dto }),
      actor,
      async (tx, events) => {
        const preview = await this.previewTemplate(id, dto, tx);
        if (!preview.canApply)
          throw new ConflictException(
            error(
              'SHIFT_CONFLICT',
              'Шаблон пересекается с существующими сменами. Индивидуальные изменения сохранены.',
            ),
          );
        const generated = [];
        for (const candidate of preview.candidates)
          generated.push(
            await this.save(candidate, undefined, actor, tx, events),
          );
        return {
          id,
          operation: 'template_applied',
          revision: preview.template.revision,
          generated,
          absenceWarnings: preview.absenceWarnings,
        };
      },
    );
  }
  async requestStatus(propertyId: string, key: string, db: any = this.db) {
    if (!key?.trim() || key.length > 200)
      throw new BadRequestException(
        error('INVALID_REQUEST_KEY', 'Укажите ключ операции.'),
      );
    const [receipt] = await db
      .select({ value: auditLogs.newValue })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.propertyId, propertyId),
          eq(auditLogs.entityType, 'staff_shift'),
          eq(auditLogs.description, 'staff_shift.request:' + key),
        ),
      )
      .limit(1);
    return !receipt
      ? { state: 'unconfirmed' as const }
      : receipt.value.closed
        ? { state: 'closed' as const }
        : { state: 'committed' as const, shift: receipt.value.response };
  }
  async closeRequest(propertyId: string, key: string, actor?: AuditActor) {
    return this.db.transaction(async (tx: any) => {
      await this.lockAssignments(propertyId, tx);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':staff-shift:' + key},0))`,
      );
      const result = await this.requestStatus(propertyId, key, tx);
      if (result.state !== 'unconfirmed') return result;
      const [property] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, propertyId));
      if (!property)
        throw new NotFoundException(
          error('PROPERTY_NOT_FOUND', 'Объект не найден.'),
        );
      await tx.insert(auditLogs).values({
        propertyId,
        entityType: 'staff_shift',
        entityId: randomUUID(),
        action: 'request_closed',
        description: 'staff_shift.request:' + key,
        newValue: { closed: true },
        ...actorFields(actor),
      });
      return { state: 'closed' as const };
    });
  }
  /** Date-based assignment uses explicit confirmed shifts; task durations are not guessed. */
  async lockAssignments(propertyId: string, tx: any) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':housekeeping-assignment'},0))`,
    );
  }
  async availability(
    propertyId: string,
    serviceDate: string,
    db: any = this.db,
    now = new Date(),
  ) {
    const [property] = await db
      .select({ timezone: properties.timezone })
      .from(properties)
      .where(eq(properties.id, propertyId));
    if (!property)
      throw new NotFoundException(
        error('PROPERTY_NOT_FOUND', 'Объект не найден.'),
      );
    const parsed = new Date(serviceDate + 'T12:00Z');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(serviceDate) ||
      !Number.isFinite(+parsed) ||
      parsed.toISOString().slice(0, 10) !== serviceDate
    )
      throw new BadRequestException(
        error('INVALID_SERVICE_DATE', 'Укажите дату работы.'),
      );
    const day = new Date(serviceDate + 'T00:00Z');
    const [staff, shifts, tasks] = await Promise.all([
      this.staff(propertyId, db),
      db
        .select()
        .from(staffShifts)
        .where(
          and(
            eq(staffShifts.propertyId, propertyId),
            eq(staffShifts.status, 'confirmed'),
            lt(staffShifts.startAt, new Date(+day + 2 * 86400000)),
            gt(staffShifts.endAt, new Date(+day - 86400000)),
          ),
        ),
      db
        .select({
          id: housekeepingTasks.id,
          status: housekeepingTasks.status,
          serviceDate: housekeepingTasks.serviceDate,
          assignedTo: housekeepingTasks.assignedTo,
        })
        .from(housekeepingTasks)
        .where(
          and(
            eq(housekeepingTasks.propertyId, propertyId),
            lt(housekeepingTasks.serviceDate, new Date(+day + 86400000)),
            inArray(housekeepingTasks.status, [
              'assigned',
              'in_progress',
              'completed',
            ]),
          ),
        ),
    ]);
    return staff.map((u: any) => {
      const active = shifts.filter(
        (s: any) =>
          (s.kind ?? 'shift') === 'shift' &&
          s.userId === u.id &&
          onDate(s.startAt, property.timezone) <= serviceDate &&
          onDate(new Date(+s.endAt - 1), property.timezone) >= serviceDate,
      );
      const absences = shifts.filter(
        (s: any) => s.kind === 'absence' && s.userId === u.id,
      );
      const segments = active
        .flatMap(shiftWorkSegments)
        .flatMap((s: any) => subtractAbsences(s, absences))
        .filter(
          (s: any) =>
            onDate(s.start, property.timezone) <= serviceDate &&
            onDate(new Date(+s.end - 1), property.timezone) >= serviceDate,
        );
      const hasWork =
        serviceDate >= onDate(now, property.timezone) &&
        segments.some((s: any) => +s.end > +now);
      const workingNow = segments.some(
        (s: any) => +s.start <= +now && +s.end > +now,
      );
      const onLeave = absences.some(
        (s: any) => +s.startAt <= +now && +s.endAt > +now,
      );
      const onBreak =
        !onLeave &&
        active.some((s: any) => +s.startAt <= +now && +s.endAt > +now) &&
        !workingNow;
      const load = tasks.filter((t: any) => t.assignedTo === u.id).length;
      const limits = active
        .map((s: any) => s.maxOpenTasks)
        .filter((v: any) => v != null);
      const limit = limits.length ? Math.min(...limits) : null;
      return {
        ...u,
        load,
        maxOpenTasks: limit,
        shiftConfirmed: active.length > 0,
        workingNow,
        onBreak,
        onLeave,
        reassignmentRequired:
          (!hasWork ||
            absences.some(
              (s: any) =>
                onDate(s.startAt, property.timezone) <= serviceDate &&
                onDate(new Date(+s.endAt - 1), property.timezone) >=
                  serviceDate,
            )) &&
          tasks.some(
            (t: any) =>
              t.assignedTo === u.id &&
              ['assigned', 'in_progress'].includes(t.status),
          ),
        tasksToReview:
          !hasWork ||
          absences.some(
            (s: any) =>
              onDate(s.startAt, property.timezone) <= serviceDate &&
              onDate(new Date(+s.endAt - 1), property.timezone) >= serviceDate,
          )
            ? tasks
                .filter(
                  (t: any) =>
                    t.assignedTo === u.id &&
                    ['assigned', 'in_progress'].includes(t.status),
                )
                .map((t: any) => ({
                  id: t.id,
                  serviceDate: t.serviceDate,
                  status: t.status,
                }))
            : [],
        available: hasWork && (limit == null || load < limit),
      };
    });
  }
}
