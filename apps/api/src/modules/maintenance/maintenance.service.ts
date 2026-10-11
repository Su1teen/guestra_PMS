import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  like,
  lt,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm';
import {
  auditLogs,
  guestPropertyLinks,
  guests,
  maintenanceTickets,
  properties,
  reservationGuests,
  reservations,
  rooms,
  users,
  userRoles,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import type {
  CreateMaintenanceTicketDto,
  ListMaintenanceTicketsDto,
  UpdateMaintenanceTicketDto,
} from './dto/maintenance.dto';

const publicRecord = (value: any) => JSON.parse(JSON.stringify(value));
const failure = (code: string, message: string) => ({ code, message });
type Action = { idempotencyKey?: string; expectedRevision?: number };

@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly roomStatus: RoomStatusService,
    private readonly outbox: DomainEventOutboxService,
  ) {}

  private async ticket(
    id: string,
    propertyId: string,
    db: any = this.db,
    lock = false,
  ) {
    const query = db
      .select()
      .from(maintenanceTickets)
      .where(
        and(
          eq(maintenanceTickets.id, id),
          eq(maintenanceTickets.propertyId, propertyId),
        ),
      );
    const [row] = await (lock ? query.for('update') : query);
    if (!row)
      throw new NotFoundException(
        failure('TICKET_NOT_FOUND', 'Заявка не найдена в этом объекте.'),
      );
    return row;
  }
  private async verifyLinks(dto: any, propertyId: string, tx: any) {
    if (dto.reservationId) {
      const [stay] = await tx
        .select({ id: reservations.id })
        .from(reservations)
        .where(
          and(
            eq(reservations.id, dto.reservationId),
            eq(reservations.propertyId, propertyId),
          ),
        );
      if (!stay)
        throw new BadRequestException('Бронь не найдена в этом объекте.');
    }
    if (dto.guestId) {
      const [link] = await tx
        .select({ id: guests.id })
        .from(guests)
        .leftJoin(reservations, eq(reservations.guestId, guests.id))
        .leftJoin(reservationGuests, eq(reservationGuests.guestId, guests.id))
        .leftJoin(guestPropertyLinks, eq(guestPropertyLinks.guestId, guests.id))
        .where(
          and(
            eq(guests.id, dto.guestId),
            or(
              eq(reservations.propertyId, propertyId),
              eq(reservationGuests.propertyId, propertyId),
              eq(guestPropertyLinks.propertyId, propertyId),
            ),
          ),
        )
        .limit(1);
      if (!link)
        throw new BadRequestException('Гость не найден в этом объекте.');
    }
    if (dto.assigneeId) {
      const [staff] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(
          userRoles,
          and(
            eq(userRoles.userId, users.id),
            eq(userRoles.propertyId, propertyId),
          ),
        )
        .where(and(eq(users.id, dto.assigneeId), eq(users.status, 'active')))
        .limit(1);
      if (!staff)
        throw new BadRequestException(
          'Ответственный неактивен или не назначен в этот объект.',
        );
    }
  }
  /** Original response receipts reuse audit; effects use the established durable outbox. */
  private async mutate(
    propertyId: string,
    id: string | undefined,
    input: any,
    actor: AuditActor | undefined,
    action: string,
    work: (tx: any, current: any, room: any, events: string[]) => Promise<any>,
    options: { transaction?: any; eventIds?: string[] } = {},
  ) {
    const key = input.idempotencyKey;
    if (
      key !== undefined &&
      (typeof key !== 'string' || !key.trim() || key.length > 200)
    )
      throw new BadRequestException('Укажите корректный ключ операции.');
    const { idempotencyKey: _key, ...data } = input;
    const fingerprint = JSON.stringify({ action, id: id ?? null, data });
    const events: string[] = options.eventIds ?? [];
    const operation = async (tx: any) => {
      const initial = id ? await this.ticket(id, propertyId, tx) : null;
      const roomId = initial?.roomId ?? input.roomId;
      // Room relation is immutable; inventory writers consistently lock type -> room -> ticket.
      const room = roomId
        ? await this.roomStatus.lockRoomInventory(roomId, propertyId, tx)
        : null;
      if (key) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':maintenance:' + key},0))`,
        );
        const [receipt] = await tx
          .select({ value: auditLogs.newValue })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.propertyId, propertyId),
              eq(auditLogs.entityType, 'maintenance_request'),
              eq(auditLogs.description, 'maintenance.request:' + key),
            ),
          )
          .limit(1);
        if (receipt) {
          if (receipt.value.closed)
            throw new ConflictException(
              failure(
                'REQUEST_CLOSED',
                'Запрос закрыт; поздняя попытка не будет выполнена.',
              ),
            );
          if (receipt.value.fingerprint !== fingerprint)
            throw new ConflictException(
              failure(
                'IDEMPOTENCY_CONFLICT',
                'Этот ключ использован для другой операции.',
              ),
            );
          return receipt.value.response;
        }
      }
      const current = id ? await this.ticket(id, propertyId, tx, true) : null;
      if (
        current &&
        input.expectedRevision !== undefined &&
        current.revision !== input.expectedRevision
      )
        throw new ConflictException(
          failure(
            'STALE_REVISION',
            'Заявка изменилась. Обновите её перед сохранением.',
          ),
        );
      const response = publicRecord(await work(tx, current, room, events));
      if (key)
        await tx
          .insert(auditLogs)
          .values({
            propertyId,
            entityType: 'maintenance_request',
            entityId: response.id ?? id,
            action: 'create',
            description: 'maintenance.request:' + key,
            newValue: { fingerprint, response },
            ...actorFields(actor),
          });
      return response;
    };
    const result = options.transaction
      ? await operation(options.transaction)
      : await this.db.transaction(operation);
    if (!options.transaction)
      for (const eventId of events) {
        try {
          await this.outbox.deliver(propertyId, eventId);
        } catch {
          /* Durable outbox owns retry. */
        }
      }
    return result;
  }
  private async commit(
    tx: any,
    next: any,
    previous: any,
    actor: AuditActor | undefined,
    action: string,
    events: string[],
    event?: string,
  ) {
    await tx
      .insert(auditLogs)
      .values({
        propertyId: next.propertyId,
        entityType: 'maintenance_ticket',
        entityId: next.id,
        action,
        description: action,
        previousValue: previous ? publicRecord(previous) : null,
        newValue: publicRecord(next),
        ...actorFields(actor),
      });
    const eventId = randomUUID();
    await this.outbox.persist(
      tx,
      {
        propertyId: next.propertyId,
        event: (event ?? 'maintenance.updated') as any,
        entityType: 'maintenance_ticket',
        entityId: next.id,
        timestamp: new Date().toISOString(),
        data: {
          ticketId: next.id,
          roomId: next.roomId,
          previousStatus: previous?.status ?? null,
          status: next.status,
          revision: next.revision,
          action,
        },
      },
      eventId,
    );
    events.push(eventId);
  }
  private async roomEvent(tx: any, room: any, next: any, events: string[]) {
    if (next.status === room.status) return;
    const eventId = randomUUID();
    await this.outbox.persist(
      tx,
      {
        propertyId: room.propertyId,
        event: 'room.status_changed',
        entityType: 'room',
        entityId: room.id,
        timestamp: new Date().toISOString(),
        data: {
          previousStatus: room.status,
          newStatus: next.status,
          roomNumber: room.number,
        },
      },
      eventId,
    );
    events.push(eventId);
  }
  async create(
    dto: CreateMaintenanceTicketDto,
    actor?: AuditActor,
    options: { transaction?: any; eventIds?: string[] } = {},
  ) {
    return this.mutate(
      dto.propertyId,
      undefined,
      dto,
      actor,
      'create',
      async (tx, _current, room, events) => {
        await this.verifyLinks(dto, dto.propertyId, tx);
        if (!dto.title.trim() || !dto.description.trim())
          throw new BadRequestException('Введите название и описание заявки.');
        if (dto.blocksInventory && !room)
          throw new BadRequestException('Для блокировки нужен номер.');
        if (dto.blocksInventory && room?.status === 'occupied')
          throw new ConflictException(
            'Переселите гостя перед выводом номера из эксплуатации.',
          );
        const [ticket] = await tx
          .insert(maintenanceTickets)
          .values({
            propertyId: dto.propertyId,
            roomId: dto.roomId,
            reservationId: dto.reservationId,
            guestId: dto.guestId,
            category: dto.category,
            title: dto.title.trim(),
            description: dto.description.trim(),
            priority: dto.priority ?? 'normal',
            status: dto.assigneeId ? 'assigned' : 'open',
            department: dto.department ?? 'maintenance',
            assigneeId: dto.assigneeId,
            reportedBy: actor?.userId ?? null,
            slaDeadline: dto.slaDeadline ? new Date(dto.slaDeadline) : null,
            blocksInventory: dto.blocksInventory ?? false,
            returnToServiceRequired: dto.blocksInventory ?? false,
          })
          .returning();
        if (dto.blocksInventory && room.status !== 'out_of_order') {
          const changed = await this.roomStatus.markOutOfOrder(
            room.id,
            dto.propertyId,
            'Ремонт: ' + ticket.title,
            tx,
          );
          await this.roomEvent(tx, room, changed, events);
        }
        await this.commit(
          tx,
          ticket,
          null,
          actor,
          'create',
          events,
          'maintenance.created',
        );
        return ticket;
      },
      options,
    );
  }
  async update(
    id: string,
    propertyId: string,
    dto: UpdateMaintenanceTicketDto,
    actor?: AuditActor,
  ) {
    return this.mutate(
      propertyId,
      id,
      dto,
      actor,
      'update',
      async (tx, current, room, events) => {
        await this.verifyLinks(dto, propertyId, tx);
        for (const key of [
          'title',
          'description',
          'category',
          'priority',
          'status',
          'department',
          'blocksInventory',
        ] as const) {
          if ((dto as any)[key] === null)
            throw new BadRequestException(
              'Обязательные поля заявки не могут быть пустыми.',
            );
        }
        for (const key of ['title', 'description'] as const)
          if (dto[key] !== undefined && !dto[key]!.trim())
            throw new BadRequestException(
              'Введите название и описание заявки.',
            );
        if (dto.blocksInventory === false && current.returnToServiceRequired)
          throw new ConflictException(
            'Для снятия блокировки используйте подтверждённый возврат в эксплуатацию.',
          );
        if (dto.blocksInventory === true && !room)
          throw new BadRequestException('Для блокировки нужен номер.');
        if (dto.blocksInventory === true && room.status === 'occupied')
          throw new ConflictException(
            'Переселите гостя перед блокировкой номера.',
          );
        if (
          ['resolved', 'closed'].includes(dto.status ?? '') &&
          !(dto.resolution?.trim() || current.resolution?.trim())
        )
          throw new BadRequestException(
            'Укажите результат ремонта перед завершением заявки.',
          );
        const {
          idempotencyKey: _key,
          expectedRevision: _revision,
          ...data
        } = dto;
        const values: any = {
          ...data,
          revision: current.revision + 1,
          updatedAt: new Date(),
        };
        if (dto.slaDeadline) values.slaDeadline = new Date(dto.slaDeadline);
        if (dto.assigneeId && !dto.status && current.status === 'open')
          values.status = 'assigned';
        if (dto.status === 'in_progress' && !current.startedAt)
          values.startedAt = new Date();
        if (['resolved', 'closed'].includes(dto.status ?? ''))
          values.completedAt = new Date();
        else if (
          dto.status &&
          ['open', 'assigned', 'in_progress', 'waiting_parts'].includes(
            dto.status,
          )
        )
          values.completedAt = null;
        if (dto.blocksInventory === true) values.returnToServiceRequired = true;
        const [next] = await tx
          .update(maintenanceTickets)
          .set(values)
          .where(
            and(
              eq(maintenanceTickets.id, id),
              eq(maintenanceTickets.propertyId, propertyId),
            ),
          )
          .returning();
        if (dto.blocksInventory === true && room.status !== 'out_of_order') {
          const changed = await this.roomStatus.markOutOfOrder(
            room.id,
            propertyId,
            'Ремонт: ' + next.title,
            tx,
          );
          await this.roomEvent(tx, room, changed, events);
        }
        await this.commit(
          tx,
          next,
          current,
          actor,
          'update',
          events,
          ['resolved', 'closed'].includes(dto.status ?? '')
            ? 'maintenance.completed'
            : undefined,
        );
        return next;
      },
    );
  }
  async addComment(
    id: string,
    propertyId: string,
    body: string,
    actor?: AuditActor,
    options: Action = {},
  ) {
    return this.mutate(
      propertyId,
      id,
      { body, ...options },
      actor,
      'comment',
      async (tx, current, _room, events) => {
        if (!body.trim() || body.length > 10000)
          throw new BadRequestException(
            'Введите комментарий до 10 000 символов.',
          );
        const comment = {
          id: randomUUID(),
          body: body.trim(),
          authorId: actor?.userId ?? null,
          createdAt: new Date().toISOString(),
        };
        const [next] = await tx
          .update(maintenanceTickets)
          .set({
            comments: [...current.comments, comment],
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(maintenanceTickets.id, id),
              eq(maintenanceTickets.propertyId, propertyId),
            ),
          )
          .returning();
        await this.commit(tx, next, current, actor, 'comment', events);
        return next;
      },
    );
  }
  async addAttachment(
    id: string,
    propertyId: string,
    attachment: any,
    actor?: AuditActor,
    options: Action = {},
  ) {
    if (
      !attachment.storageKey ||
      !attachment.id ||
      !attachment.storageKey.startsWith(
        `properties/${propertyId}/private/maintenance/${id}/`,
      )
    )
      throw new BadRequestException(
        'Загрузите приватный файл через защищённый endpoint. Публичные URL не принимаются.',
      );
    return this.mutate(
      propertyId,
      id,
      { attachment, ...options },
      actor,
      'attachment',
      async (tx, current, _room, events) => {
        if (current.attachments.length >= 50)
          throw new BadRequestException('В заявке уже 50 вложений.');
        const [next] = await tx
          .update(maintenanceTickets)
          .set({
            attachments: [...current.attachments, attachment],
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(maintenanceTickets.id, id),
              eq(maintenanceTickets.propertyId, propertyId),
            ),
          )
          .returning();
        await this.commit(tx, next, current, actor, 'attachment', events);
        return next;
      },
    );
  }
  async confirmReturnToService(
    id: string,
    propertyId: string,
    note: string | undefined,
    actor?: AuditActor,
    options: Action = {},
  ) {
    return this.mutate(
      propertyId,
      id,
      { note: note ?? null, ...options },
      actor,
      'return_to_service',
      async (tx, current, room, events) => {
        if (!room || !current.returnToServiceRequired)
          throw new BadRequestException(
            'Эта заявка не ожидает возврата номера.',
          );
        if (!['resolved', 'closed', 'cancelled'].includes(current.status))
          throw new ConflictException(
            'Завершите ремонт перед подтверждением возврата.',
          );
        if (room.status === 'occupied')
          throw new ConflictException(
            'Номер занят; возврат в эксплуатацию невозможен.',
          );
        const [next] = await tx
          .update(maintenanceTickets)
          .set({
            returnToServiceRequired: false,
            blocksInventory: false,
            status: 'closed',
            revision: current.revision + 1,
            updatedAt: new Date(),
            resolution: note
              ? [current.resolution, note].filter(Boolean).join('\n')
              : current.resolution,
          })
          .where(
            and(
              eq(maintenanceTickets.id, id),
              eq(maintenanceTickets.propertyId, propertyId),
            ),
          )
          .returning();
        const others = await tx
          .select({ id: maintenanceTickets.id })
          .from(maintenanceTickets)
          .where(
            and(
              eq(maintenanceTickets.propertyId, propertyId),
              eq(maintenanceTickets.roomId, room.id),
              ne(maintenanceTickets.id, id),
              or(
                eq(maintenanceTickets.returnToServiceRequired, true),
                and(
                  eq(maintenanceTickets.blocksInventory, true),
                  inArray(maintenanceTickets.status, [
                    'open',
                    'assigned',
                    'in_progress',
                    'waiting_parts',
                  ]),
                ),
              ),
            ),
          );
        let roomReturned = false;
        if (
          !others.length &&
          ['out_of_order', 'out_of_service'].includes(room.status)
        ) {
          const changed = await this.roomStatus.transitionStatus(
            room.id,
            propertyId,
            'vacant_dirty',
            undefined,
            tx,
          );
          await this.roomEvent(tx, room, changed, events);
          roomReturned = true;
        }
        await this.commit(
          tx,
          next,
          current,
          actor,
          'return_to_service',
          events,
        );
        return {
          ...next,
          roomReturned,
          remainingBlockingTicketIds: others.map((row: any) => row.id),
        };
      },
    );
  }
  private listConditions(dto: ListMaintenanceTicketsDto) {
    const conditions = [eq(maintenanceTickets.propertyId, dto.propertyId)];
    for (const field of [
      'roomId',
      'category',
      'priority',
      'status',
      'assigneeId',
      'department',
    ] as const)
      if (dto[field])
        conditions.push(eq(maintenanceTickets[field], dto[field] as any));
    if (dto.overdue)
      conditions.push(
        lt(maintenanceTickets.slaDeadline, new Date()),
        inArray(maintenanceTickets.status, [
          'open',
          'assigned',
          'in_progress',
          'waiting_parts',
        ]),
      );
    return conditions;
  }
  async list(dto: ListMaintenanceTicketsDto, paging?:{page:number;limit:number}) {
    const query=this.db
      .select({
        ticket: maintenanceTickets,
        roomNumber: rooms.number,
        assigneeName: users.name,
      })
      .from(maintenanceTickets)
      .leftJoin(
        rooms,
        and(
          eq(rooms.id, maintenanceTickets.roomId),
          eq(rooms.propertyId, dto.propertyId),
        ),
      )
      .leftJoin(users, eq(users.id, maintenanceTickets.assigneeId))
      .where(and(...this.listConditions(dto)))
      .orderBy(desc(maintenanceTickets.createdAt),desc(maintenanceTickets.id));
    return paging ? query.limit(paging.limit).offset((paging.page-1)*paging.limit) : query;
  }
  async page(dto:ListMaintenanceTicketsDto & {page?:number;limit?:number}) {
    const page=dto.page??1,limit=dto.limit??50;
    if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100) throw new BadRequestException('Укажите корректную страницу и размер от 1 до 100.');
    const [data,[count]]=await Promise.all([this.list(dto,{page,limit}),this.db.select({total:sql<number>`count(*)::int`}).from(maintenanceTickets).where(and(...this.listConditions(dto)))]);
    return {data,total:count.total,page,limit};
  }
  async findById(id: string, propertyId: string) {
    const [row] = await this.db
      .select({
        ticket: maintenanceTickets,
        roomNumber: rooms.number,
        roomStatus: rooms.status,
        assigneeName: users.name,
      })
      .from(maintenanceTickets)
      .leftJoin(
        rooms,
        and(
          eq(rooms.id, maintenanceTickets.roomId),
          eq(rooms.propertyId, propertyId),
        ),
      )
      .leftJoin(users, eq(users.id, maintenanceTickets.assigneeId))
      .where(
        and(
          eq(maintenanceTickets.id, id),
          eq(maintenanceTickets.propertyId, propertyId),
        ),
      );
    if (!row) throw new NotFoundException('Заявка не найдена в этом объекте.');
    const history = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.propertyId, propertyId),
          eq(auditLogs.entityType, 'maintenance_ticket'),
          eq(auditLogs.entityId, id),
          not(like(auditLogs.description, 'Webhook event:%')),
        ),
      )
      .orderBy(desc(auditLogs.occurredAt))
      .limit(100);
    return { ...row, history };
  }
  async requestStatus(propertyId: string, key: string, db: any = this.db) {
    if (typeof key !== 'string' || !key.trim() || key.length > 200)
      throw new BadRequestException('Укажите корректный ключ операции.');
    const [receipt] = await db
      .select({ value: auditLogs.newValue })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.propertyId, propertyId),
          eq(auditLogs.entityType, 'maintenance_request'),
          eq(auditLogs.description, 'maintenance.request:' + key),
        ),
      )
      .limit(1);
    return !receipt
      ? { state: 'unconfirmed' }
      : receipt.value.closed
        ? { state: 'closed' }
        : { state: 'committed', result: receipt.value.response };
  }
  async closeRequest(propertyId: string, key: string, actor?: AuditActor) {
    return this.db.transaction(async (tx: any) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${propertyId + ':maintenance:' + key},0))`,
      );
      const status = await this.requestStatus(propertyId, key, tx);
      if (status.state !== 'unconfirmed') return status;
      const [property] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, propertyId));
      if (!property) throw new NotFoundException('Объект не найден.');
      await tx
        .insert(auditLogs)
        .values({
          propertyId,
          entityType: 'maintenance_request',
          entityId: randomUUID(),
          action: 'create',
          description: 'maintenance.request:' + key,
          newValue: { closed: true },
          ...actorFields(actor),
        });
      return { state: 'closed' };
    });
  }
}
