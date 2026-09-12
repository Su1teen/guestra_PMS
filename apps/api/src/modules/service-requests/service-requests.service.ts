import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { eq, and, desc, or, isNull } from 'drizzle-orm';
import { serviceRequests, rooms, reservations, reservationGuests, users } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { HousekeepingService } from '../housekeeping/housekeeping.service';
import { WebhookService } from '../webhook/webhook.service';
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
    if (!row) throw new BadRequestException(`guest ${guestId} not found in this property`);
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

  async list(dto: ListServiceRequestsDto) {
    const conditions = [eq(serviceRequests.propertyId, dto.propertyId)];
    if (dto.status) conditions.push(eq(serviceRequests.status, dto.status as any));
    if (dto.type) conditions.push(eq(serviceRequests.type, dto.type as any));
    if (dto.department) conditions.push(eq(serviceRequests.department, dto.department));
    if (dto.priority !== undefined) conditions.push(eq(serviceRequests.priority, dto.priority));
    if (dto.assigneeId) conditions.push(eq(serviceRequests.assigneeId, dto.assigneeId));

    return this.db
      .select()
      .from(serviceRequests)
      .where(and(...conditions))
      .orderBy(desc(serviceRequests.createdAt));
  }

  async findById(id: string, propertyId: string) {
    const [request] = await this.db
      .select()
      .from(serviceRequests)
      .where(and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, propertyId)));
    if (!request) {
      throw new NotFoundException(`Service request ${id} not found`);
    }
    return request;
  }

  async update(id: string, propertyId: string, dto: UpdateServiceRequestDto) {
    const request = await this.findById(id, propertyId);

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
      .where(and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, propertyId)))
      .returning();

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
      .where(and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, propertyId)))
      .returning();
    if (!request) {
      throw new NotFoundException(`Service request ${id} not found`);
    }
    return request;
  }

  async createLinkedTask(id: string, dto: CreateTaskFromRequestDto) {
    const request = await this.findById(id, dto.propertyId);

    if (request.linkedTaskId) {
      throw new ConflictException('Service request already has a linked housekeeping task');
    }
    if (!request.roomId) {
      throw new BadRequestException('Service request must have a room to create a housekeeping task');
    }

    const taskType = HK_LINKABLE_TYPES.has(request.type)
      ? request.type
      : 'maintenance';

    const serviceDate =
      dto.serviceDate ?? new Date().toISOString().slice(0, 10);

    const task = await this.housekeepingService.create({
      propertyId: dto.propertyId,
      roomId: request.roomId,
      type: taskType,
      priority: request.priority,
      serviceDate,
      notes: request.description ?? request.title,
    });

    const [updated] = await this.db
      .update(serviceRequests)
      .set({
        linkedTaskId: task.id,
        status: 'in_progress',
        updatedAt: new Date(),
      })
      .where(
        and(eq(serviceRequests.id, id), eq(serviceRequests.propertyId, dto.propertyId)),
      )
      .returning();

    return { request: updated, task };
  }
}
