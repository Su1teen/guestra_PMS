import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { eq, and, desc, or, isNull, inArray } from 'drizzle-orm';
import {
  serviceRequests,
  rooms,
  reservations,
  reservationGuests,
  users,
  guestPropertyLinks,
  housekeepingTasks,
  maintenanceTickets,
  properties,
  auditLogs,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { WebhookService } from '../webhook/webhook.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { randomUUID } from 'node:crypto';
import {
  type CreateServiceRequestDto,
  type UpdateServiceRequestDto,
  type ListServiceRequestsDto,
  type CreateTaskFromRequestDto,
} from './dto/service-request.dto';

const HK_LINKABLE_TYPES = new Set([
  'maintenance',
  'turndown',
  'deep_clean',
  'checkout',
  'stayover',
  'inspection',
]);

@Injectable()
export class ServiceRequestsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly housekeepingService: HousekeepingService,
    private readonly webhookService: WebhookService,
    private readonly maintenance: MaintenanceService,
    private readonly outbox: DomainEventOutboxService,
  ) {}

  private async verifyRoomOwnership(roomId: string, propertyId: string) {
    const [row] = await this.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId)));
    if (!row) {
      throw new BadRequestException(`room ${roomId} not found in this property`);
    }
  }

  private async verifyReservationOwnership(reservationId: string, propertyId: string) {
    const [row] = await this.db
      .select({ id: reservations.id })
      .from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) {
      throw new BadRequestException(`reservation ${reservationId} not found in this property`);
    }
  }

  private async verifyGuestOwnership(guestId: string, propertyId: string) {
    const [row] = await this.db
      .select({ id: reservations.id })
      .from(reservations)
      .leftJoin(reservationGuests, eq(reservationGuests.reservationId, reservations.id))
      .where(and(
        eq(reservations.propertyId, propertyId),
        or(eq(reservations.guestId, guestId), eq(reservationGuests.guestId, guestId)),
      ))
      .limit(1);
    if (row) return;
    const [serviceOnlyLink] = await this.db.select({ id: guestPropertyLinks.id }).from(guestPropertyLinks)
      .where(and(eq(guestPropertyLinks.guestId, guestId), eq(guestPropertyLinks.propertyId, propertyId)));
    if (!serviceOnlyLink) throw new BadRequestException(`guest ${guestId} not found in this property`);
  }

  private async verifyAssignee(assigneeId: string, propertyId: string) {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(
        eq(users.id, assigneeId),
        or(eq(users.propertyId, propertyId), isNull(users.propertyId)),
        eq(users.status, 'active' as any),
      ));
    if (!row) throw new BadRequestException(`assignee ${assigneeId} is not active at this property`);
  }

  async create(dto: CreateServiceRequestDto) {
    if (dto.roomId) await this.verifyRoomOwnership(dto.roomId, dto.propertyId);
    if (dto.reservationId) await this.verifyReservationOwnership(dto.reservationId, dto.propertyId);
    if (dto.guestId) await this.verifyGuestOwnership(dto.guestId, dto.propertyId);
    if (dto.assigneeId) await this.verifyAssignee(dto.assigneeId, dto.propertyId);

    const [request] = await this.db
      .insert(serviceRequests)
      .values({
        propertyId: dto.propertyId,
        roomId: dto.roomId,
        reservationId: dto.reservationId,
        guestId: dto.guestId,
        type: dto.type,
        category: dto.category,
        department: dto.department,
        priority: dto.priority ?? 0,
        status: dto.assigneeId ? 'assigned' : 'open',
        title: dto.title,
        description: dto.description,
        requestedBy: dto.requestedBy,
        assigneeId: dto.assigneeId,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
        slaDeadline: dto.slaDeadline ? new Date(dto.slaDeadline) : undefined,
        createdBy: dto.requestedBy,
      })
      .returning();

    await this.webhookService.emit(
      'operations.task_created',
      'service_request',
      request.id,
      { requestId: request.id, reservationId: request.reservationId, guestId: request.guestId },
      dto.propertyId,
    );
    return request;
  }

  /** Agent-facing, retry-safe creation. It remains an operational request, never a CRM lead. */
  async createFromAgent(dto: CreateServiceRequestDto & { idempotencyKey: string; integrationContext?: Record<string, unknown> }) {
    const fingerprint = JSON.stringify({ ...dto, idempotencyKey: undefined });
    const [existing] = await this.db.select().from(serviceRequests).where(and(
      eq(serviceRequests.propertyId, dto.propertyId), eq(serviceRequests.idempotencyKey, dto.idempotencyKey),
    ));
    if (existing) {
      if ((existing.integrationContext as any)?.idempotencyFingerprint !== fingerprint) {
        throw new ConflictException('IDEMPOTENCY_CONFLICT');
      }
      return { ...existing, idempotentReplay: true };
    }
    if (dto.roomId) await this.verifyRoomOwnership(dto.roomId, dto.propertyId);
    if (dto.reservationId) await this.verifyReservationOwnership(dto.reservationId, dto.propertyId);
    if (dto.guestId) await this.verifyGuestOwnership(dto.guestId, dto.propertyId);
    const [request] = await this.db.insert(serviceRequests).values({
      propertyId: dto.propertyId, roomId: dto.roomId, reservationId: dto.reservationId, guestId: dto.guestId,
      type: dto.type as any, category: dto.category, department: dto.department, priority: dto.priority ?? 0,
      status: 'open', title: dto.title, description: dto.description, sourceChannel: 'ai_guest_agent',
      idempotencyKey: dto.idempotencyKey, integrationContext: { ...(dto.integrationContext ?? {}), idempotencyFingerprint: fingerprint },
    }).returning();
    await this.webhookService.emit('service_request.created', 'service_request', request.id, {
      serviceRequestId: request.id, guestId: request.guestId, reservationId: request.reservationId,
      status: request.status, integrationContext: dto.integrationContext ?? {},
    }, dto.propertyId);
    return request;
  }

  async list(dto: ListServiceRequestsDto) {
    const conditions = [eq(serviceRequests.propertyId, dto.propertyId)];
    if (dto.type) conditions.push(eq(serviceRequests.type, dto.type as any));
    if (dto.department) conditions.push(eq(serviceRequests.department, dto.department));
    if (dto.priority !== undefined) conditions.push(eq(serviceRequests.priority, dto.priority));
    if (dto.assigneeId) conditions.push(eq(serviceRequests.assigneeId, dto.assigneeId));

    const requests = await this.db
      .select()
      .from(serviceRequests)
      .where(and(...conditions))
      .orderBy(desc(serviceRequests.createdAt));
    const projected = await this.projectOperations(requests, dto.propertyId);
    return dto.status
      ? projected.filter((request: any) => request.status === dto.status)
      : projected;
  }

  async findById(id: string, propertyId: string) {
    const [request] = await this.db
      .select()
      .from(serviceRequests)
      .where(and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, propertyId)));
    if (!request) {
      throw new NotFoundException(`Service request ${id} not found`);
    }
    return (await this.projectOperations([request], propertyId))[0];
  }

  private async projectOperations(requests: any[], propertyId: string) {
    if (!requests.length) return [];
    const hkIds = requests.map((r) => r.linkedTaskId).filter(Boolean),
      maintenanceIds = requests
        .map((r) => r.linkedMaintenanceTicketId)
        .filter(Boolean);
    const [cleaning, repairs, property] = await Promise.all([
      hkIds.length
        ? this.db.select().from(housekeepingTasks)
            .where(
              and(
                eq(housekeepingTasks.propertyId, propertyId),
                inArray(housekeepingTasks.id, hkIds),
              ),
            )
        : [],
      maintenanceIds.length
        ? this.db.select().from(maintenanceTickets)
            .where(
              and(
                eq(maintenanceTickets.propertyId, propertyId),
                inArray(maintenanceTickets.id, maintenanceIds),
              ),
            )
        : [],
      this.db
      .select({ settings: properties.settings })
        .from(properties)
        .where(eq(properties.id, propertyId)),
    ]);
    const hk = new Map(cleaning.map((task: any) => [task.id, task])),
      mt = new Map(repairs.map((ticket: any) => [ticket.id, ticket]));
    return requests.map((request) => {
      const source: any = request.linkedMaintenanceTicketId
        ? mt.get(request.linkedMaintenanceTicketId)
        : hk.get(request.linkedTaskId);
      if (!source)
        return {
          ...request,
          linkedOperation: null,
          ...(request.linkedTaskId || request.linkedMaintenanceTicketId
            ? {
                coordinationWarning:
                  'Связанная задача недоступна; нужна проверка руководителя.',
              }
            : {}),
        };
      const isMaintenance = !!request.linkedMaintenanceTicketId;
      const completed = isMaintenance
        ? ['resolved', 'closed'].includes(source.status)
        : source.status === 'inspected' ||
          (source.status === 'completed' &&
            !(
              property[0]?.settings?.requireInspection &&
              ['checkout', 'deep_clean', 'inspection'].includes(source.type)
            ));
      const status =
        source.status === 'cancelled'
          ? 'cancelled'
          : completed
            ? 'completed'
            : ['in_progress', 'waiting_parts', 'completed'].includes(
                  source.status,
                )
              ? 'in_progress'
              : source.assignedTo || source.assigneeId
                ? 'assigned'
                : 'open';
      return {
        ...request,
        storedStatus: request.status,
        status,
        linkedOperation: {
          kind: isMaintenance ? 'maintenance' : 'housekeeping',
          id: source.id,
          status: source.status,
          href: isMaintenance
            ? `/operations?tab=maintenance&ticketId=${source.id}&propertyId=${propertyId}`
            : `/housekeeping?tab=tasks&taskId=${source.id}&propertyId=${propertyId}`,
        },
      };
    });
  }

  async update(id: string, propertyId: string, dto: UpdateServiceRequestDto) {
    const request = await this.findById(id, propertyId);
    if (
      (request.linkedTaskId || request.linkedMaintenanceTicketId) &&
      [
        'status',
        'assigneeId',
        'roomId',
        'reservationId',
        'guestId',
        'type',
      ].some((key) => Object.prototype.hasOwnProperty.call(dto, key))
    )
      throw new ConflictException(
        'Используйте связанную задачу службы для изменения статуса, назначения и контекста.',
      );

    if (dto.roomId) await this.verifyRoomOwnership(dto.roomId, propertyId);
    if (dto.reservationId) await this.verifyReservationOwnership(dto.reservationId, propertyId);
    if (dto.guestId) await this.verifyGuestOwnership(dto.guestId, propertyId);
    if (dto.assigneeId) await this.verifyAssignee(dto.assigneeId, propertyId);

    const now = new Date();
    const updates: Record<string, unknown> = { ...dto, updatedAt: now };
    if (dto.dueAt) updates['dueAt'] = new Date(dto.dueAt);
    if (dto.slaDeadline) updates['slaDeadline'] = new Date(dto.slaDeadline);
    if (dto.status === 'in_progress' && !request.startedAt) updates['startedAt'] = now;
    if ((dto.status === 'done' || dto.status === 'completed') && !request.completedAt) {
      updates['completedAt'] = now;
    }
    if (dto.assigneeId && !dto.status && request.status === 'open') updates['status'] = 'assigned';

    const [updatedRequest] = await this.db
      .update(serviceRequests)
      .set(updates)
      .where(
        and(
          eq(serviceRequests.id, id),
          eq(serviceRequests.propertyId, propertyId),
          ...([
            'status',
            'assigneeId',
            'roomId',
            'reservationId',
            'guestId',
            'type',
          ].some((key) => Object.prototype.hasOwnProperty.call(dto, key))
            ? [
                isNull(serviceRequests.linkedTaskId),
                isNull(serviceRequests.linkedMaintenanceTicketId),
              ]
            : []),
        ),
      )
      .returning();
    if (!updatedRequest)
      throw new ConflictException(
        'Запрос изменился или уже передан службе. Обновите очередь.',
      );

    await this.webhookService.emit(
      dto.status === 'done' || dto.status === 'completed'
        ? 'operations.task_completed'
        : 'operations.task_updated',
      'service_request',
      id,
      { requestId: id, previousStatus: request.status, status: updatedRequest.status },
      propertyId,
    );
    return updatedRequest;
  }

  async addComment(id: string, propertyId: string, body: string, authorId?: string | null) {
    const request = await this.findById(id, propertyId);
    const comments = Array.isArray(request.comments) ? request.comments : [];
    const comment = {
      id: crypto.randomUUID(),
      body: body.trim(),
      authorId: authorId ?? null,
      createdAt: new Date().toISOString(),
    };
    if (!comment.body) throw new BadRequestException('Comment cannot be blank');
    const [updated] = await this.db.update(serviceRequests)
      .set({ comments: [...comments, comment], updatedAt: new Date() })
      .where(and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, propertyId)))
      .returning();
    await this.webhookService.emit(
      'operations.task_updated',
      'service_request',
      id,
      { requestId: id, action: 'comment_added' },
      propertyId,
    );
    return updated;
  }

  async delete(id: string, propertyId: string) {
    const [request] = await this.db
      .delete(serviceRequests)
      .where(and(
        eq(serviceRequests.id, id),
        eq(serviceRequests.propertyId, propertyId),
        isNull(serviceRequests.linkedTaskId),
        isNull(serviceRequests.linkedMaintenanceTicketId),
      ))
      .returning();
    if (!request) {
      await this.findById(id, propertyId);
      throw new ConflictException('Запрос уже передан службе. Историю связанной работы нельзя удалить.');
    }
    return request;
  }

  async createLinkedTask(
    id: string,
    dto: CreateTaskFromRequestDto,
    actor?: AuditActor,
    grants?: string[],
  ) {
    const eventIds: string[] = [];
    const result = await this.db.transaction(async (tx: any) => {
      const [request] = await tx
        .select()
        .from(serviceRequests)
        .where(
          and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, dto.propertyId)),
        )
        .for('update');
      if (!request)
        throw new NotFoundException('Запрос не найден в этом объекте.');
      const technical = ['maintenance', 'technical_problem'].includes(
        request.type,
      );
      if (
        grants &&
        !grants.includes(
          technical ? 'maintenance.create' : 'housekeeping.manage',
        )
      )
        throw new ForbiddenException(
          'Нет права создания задачи выбранной службы.',
        );
      if (request.linkedTaskId || request.linkedMaintenanceTicketId) {
        const table = request.linkedMaintenanceTicketId
          ? maintenanceTickets
          : housekeepingTasks;
        const [task] = await tx
          .select()
          .from(table)
          .where(
            and(
              eq(table.propertyId, dto.propertyId),
              eq(
                table.id,
                request.linkedMaintenanceTicketId ?? request.linkedTaskId,
              ),
            ),
          );
        if (!task)
          throw new ConflictException(
            'Связанная задача недоступна. Нужна проверка руководителя.',
          );
        if (
          dto.serviceDate &&
          task.serviceDate &&
          new Date(task.serviceDate).toISOString().slice(0, 10) !==
            dto.serviceDate
        )
          throw new ConflictException(
            'Запрос уже передан службе на другую дату.',
          );
        return { request, task, replayed: true };
      }
      if (['done', 'completed', 'cancelled'].includes(request.status))
        throw new ConflictException(
          'Завершённый запрос нельзя передать в работу.',
        );
      let task: any;
      if (technical)
        task = await this.maintenance.create(
          {
            propertyId: dto.propertyId,
            roomId: request.roomId ?? undefined,
            reservationId: request.reservationId ?? undefined,
            guestId: request.guestId ?? undefined,
            category: 'other',
            title: request.title,
            description: request.description?.trim() || request.title,
            priority:
              ['low', 'normal', 'high', 'critical'][request.priority] ??
              'normal',
            slaDeadline: request.slaDeadline?.toISOString(),
          },
          actor,
          { transaction: tx, eventIds },
        );
      else {
        if (!request.roomId)
          throw new BadRequestException('Для задачи уборки нужен номер.');
        if (
          !HK_LINKABLE_TYPES.has(request.type) &&
          !['housekeeping', 'extra_towel', 'extra_blanket'].includes(
            request.type,
          )
        )
          throw new BadRequestException(
            'Этот запрос выполняется в операционной очереди и не относится к уборке или ремонту.',
          );
        const [property] = await tx
          .select({ timezone: properties.timezone })
          .from(properties)
          .where(eq(properties.id, dto.propertyId));
        const date =
          dto.serviceDate ??
          new Intl.DateTimeFormat('sv-SE', {
            timeZone: property?.timezone ?? 'UTC',
          }).format(new Date());
        task = await this.housekeepingService.create(
          {
            propertyId: dto.propertyId,
            roomId: request.roomId,
            type: HK_LINKABLE_TYPES.has(request.type)
              ? request.type
              : 'stayover',
            priority: request.priority,
            serviceDate: date,
            notes: request.description ?? request.title,
          },
          tx,
        );
      }
      const [updated] = await tx
        .update(serviceRequests)
        .set({
          linkedTaskId: technical ? null : task.id,
          linkedMaintenanceTicketId: technical ? task.id : null,
          status: 'in_progress',
          department: technical ? 'maintenance' : 'housekeeping',
          updatedAt: new Date(),
        })
        .where(
          and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, dto.propertyId)),
        )
        .returning();
      await tx
        .insert(auditLogs)
        .values({
          propertyId: dto.propertyId,
          entityType: 'service_request',
          entityId: id,
          action: 'update',
          description: 'operations.linked',
          previousValue: request,
          newValue: updated,
          ...actorFields(actor),
        });
      const eventId = randomUUID();
      await this.outbox.persist(
        tx,
        {
          propertyId: dto.propertyId,
          event: 'service_request.updated',
          entityType: 'service_request',
          entityId: id,
          timestamp: new Date().toISOString(),
          data: {
            serviceRequestId: id,
            linkedTaskId: updated.linkedTaskId,
            linkedMaintenanceTicketId: updated.linkedMaintenanceTicketId,
          },
        },
        eventId,
      );
      eventIds.push(eventId);
      return { request: updated, task, replayed: false };
    });
    for (const eventId of eventIds) {
      try {
        await this.outbox.deliver(dto.propertyId, eventId);
      } catch {
        /* Durable outbox retries after commit. */
      }
    }
    return { ...result, request: await this.findById(id, dto.propertyId) };
  }
}
