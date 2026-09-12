import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  auditLogs,
  guests,
  maintenanceTickets,
  reservationGuests,
  reservations,
  rooms,
  users,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { RoomStatusService } from '../room/room-status.service';
import { WebhookService } from '../webhook/webhook.service';
import type {
  CreateMaintenanceTicketDto,
  ListMaintenanceTicketsDto,
  UpdateMaintenanceTicketDto,
} from './dto/maintenance.dto';

@Injectable()
export class MaintenanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly roomStatus: RoomStatusService,
    private readonly webhook: WebhookService,
  ) {}

  private async roomAtProperty(roomId: string, propertyId: string) {
    const [room] = await this.db.select().from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId)));
    if (!room) throw new BadRequestException(`room ${roomId} not found in this property`);
    return room;
  }

  private async verifyReservation(reservationId: string, propertyId: string) {
    const [row] = await this.db.select({ id: reservations.id }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new BadRequestException(`reservation ${reservationId} not found in this property`);
  }

  private async verifyGuest(guestId: string, propertyId: string) {
    const [row] = await this.db.select({ id: guests.id }).from(guests)
      .leftJoin(reservations, eq(reservations.guestId, guests.id))
      .leftJoin(reservationGuests, eq(reservationGuests.guestId, guests.id))
      .where(and(
        eq(guests.id, guestId),
        or(eq(reservations.propertyId, propertyId), eq(reservationGuests.propertyId, propertyId)),
      )).limit(1);
    if (!row) throw new BadRequestException(`guest ${guestId} not found in this property`);
  }

  private async verifyAssignee(userId: string, propertyId: string) {
    const [row] = await this.db.select({ id: users.id }).from(users).where(and(
      eq(users.id, userId),
      eq(users.status, 'active' as any),
      or(eq(users.propertyId, propertyId), isNull(users.propertyId)),
    ));
    if (!row) throw new BadRequestException(`assignee ${userId} is not active at this property`);
  }

  async create(dto: CreateMaintenanceTicketDto, actor?: AuditActor) {
    const room = dto.roomId ? await this.roomAtProperty(dto.roomId, dto.propertyId) : null;
    if (dto.reservationId) await this.verifyReservation(dto.reservationId, dto.propertyId);
    if (dto.guestId) await this.verifyGuest(dto.guestId, dto.propertyId);
    if (dto.assigneeId) await this.verifyAssignee(dto.assigneeId, dto.propertyId);
    if (dto.blocksInventory && !dto.roomId) {
      throw new BadRequestException('blocksInventory requires a room');
    }
    if (dto.blocksInventory && room?.status === 'occupied') {
      throw new ConflictException('An occupied room cannot be marked out of order until the guest is safely moved');
    }

    const [ticket] = await this.db.insert(maintenanceTickets).values({
      propertyId: dto.propertyId,
      roomId: dto.roomId,
      reservationId: dto.reservationId,
      guestId: dto.guestId,
      category: dto.category,
      title: dto.title,
      description: dto.description,
      priority: dto.priority ?? 'normal',
      status: dto.assigneeId ? 'assigned' : 'open',
      department: dto.department ?? 'maintenance',
      assigneeId: dto.assigneeId,
      reportedBy: actor?.userId ?? null,
      slaDeadline: dto.slaDeadline ? new Date(dto.slaDeadline) : null,
      blocksInventory: dto.blocksInventory ?? false,
      returnToServiceRequired: dto.blocksInventory ?? false,
    }).returning();

    if (dto.blocksInventory && dto.roomId && room?.status !== 'out_of_order') {
      await this.roomStatus.markOutOfOrder(dto.roomId, dto.propertyId, `Maintenance: ${dto.title}`);
    }
    await this.writeAudit(ticket, null, actor, 'create');
    await this.webhook.emit('maintenance.created', 'maintenance_ticket', ticket.id, {
      ticketId: ticket.id, roomId: ticket.roomId, status: ticket.status,
    }, dto.propertyId);
    return ticket;
  }

  async list(dto: ListMaintenanceTicketsDto) {
    const conditions = [eq(maintenanceTickets.propertyId, dto.propertyId)];
    if (dto.roomId) conditions.push(eq(maintenanceTickets.roomId, dto.roomId));
    if (dto.category) conditions.push(eq(maintenanceTickets.category, dto.category as any));
    if (dto.priority) conditions.push(eq(maintenanceTickets.priority, dto.priority as any));
    if (dto.status) conditions.push(eq(maintenanceTickets.status, dto.status as any));
    if (dto.assigneeId) conditions.push(eq(maintenanceTickets.assigneeId, dto.assigneeId));
    if (dto.overdue) {
      conditions.push(lt(maintenanceTickets.slaDeadline, new Date()));
      conditions.push(or(
        isNull(maintenanceTickets.completedAt),
        eq(maintenanceTickets.status, 'open' as any),
        eq(maintenanceTickets.status, 'assigned' as any),
        eq(maintenanceTickets.status, 'in_progress' as any),
        eq(maintenanceTickets.status, 'waiting_parts' as any),
      )!);
    }
    return this.db.select({
      ticket: maintenanceTickets,
      roomNumber: rooms.number,
      assigneeName: users.name,
    }).from(maintenanceTickets)
      .leftJoin(rooms, and(eq(rooms.id, maintenanceTickets.roomId), eq(rooms.propertyId, dto.propertyId)))
      .leftJoin(users, eq(users.id, maintenanceTickets.assigneeId))
      .where(and(...conditions)).orderBy(desc(maintenanceTickets.createdAt));
  }

  async findById(id: string, propertyId: string) {
    const [row] = await this.db.select({
      ticket: maintenanceTickets,
      roomNumber: rooms.number,
      roomStatus: rooms.status,
      assigneeName: users.name,
    }).from(maintenanceTickets)
      .leftJoin(rooms, and(eq(rooms.id, maintenanceTickets.roomId), eq(rooms.propertyId, propertyId)))
      .leftJoin(users, eq(users.id, maintenanceTickets.assigneeId))
      .where(and(eq(maintenanceTickets.id, id), eq(maintenanceTickets.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Maintenance ticket ${id} not found`);
    const history = await this.db.select().from(auditLogs).where(and(
      eq(auditLogs.propertyId, propertyId),
      eq(auditLogs.entityType, 'maintenance_ticket'),
      eq(auditLogs.entityId, id),
    )).orderBy(desc(auditLogs.occurredAt)).limit(100);
    return { ...row, history };
  }

  async update(id: string, propertyId: string, dto: UpdateMaintenanceTicketDto, actor?: AuditActor) {
    const { ticket: current } = await this.findById(id, propertyId);
    if (dto.assigneeId) await this.verifyAssignee(dto.assigneeId, propertyId);
    if (dto.blocksInventory === true && !current.roomId) {
      throw new BadRequestException('blocksInventory requires a room');
    }
    if ((dto.status === 'resolved' || dto.status === 'closed') && !dto.resolution && !current.resolution) {
      throw new BadRequestException('A resolution is required before resolving a maintenance ticket');
    }
    // Keep the ticket and room in one consistent state when an OOO transition is rejected.
    let roomToBlock: any = null;
    if (dto.blocksInventory === true && current.roomId) {
      roomToBlock = await this.roomAtProperty(current.roomId, propertyId);
      if (roomToBlock.status === 'occupied') {
        throw new ConflictException('Move the guest before blocking this room');
      }
    }
    const now = new Date();
    const values: Record<string, unknown> = { ...dto, updatedAt: now };
    if (dto.slaDeadline) values['slaDeadline'] = new Date(dto.slaDeadline);
    if (dto.assigneeId && !dto.status && current.status === 'open') values['status'] = 'assigned';
    if (dto.status === 'in_progress' && !current.startedAt) values['startedAt'] = now;
    if (dto.status === 'resolved' || dto.status === 'closed') {
      values['completedAt'] = now;
      values['returnToServiceRequired'] = current.blocksInventory || dto.blocksInventory === true;
    }
    if (dto.blocksInventory === true) values['returnToServiceRequired'] = true;

    const [updated] = await this.db.update(maintenanceTickets).set(values)
      .where(and(eq(maintenanceTickets.id, id), eq(maintenanceTickets.propertyId, propertyId)))
      .returning();
    if (dto.blocksInventory === true && current.roomId) {
      if (roomToBlock.status !== 'out_of_order') {
        await this.roomStatus.markOutOfOrder(current.roomId, propertyId, `Maintenance: ${updated.title}`);
      }
    }
    await this.writeAudit(updated, current, actor, 'update');
    const event = dto.status === 'resolved' || dto.status === 'closed'
      ? 'maintenance.completed'
      : 'maintenance.updated';
    await this.webhook.emit(event, 'maintenance_ticket', id, {
      ticketId: id, roomId: updated.roomId, previousStatus: current.status, status: updated.status,
    }, propertyId);
    return updated;
  }

  async addComment(id: string, propertyId: string, body: string, actor?: AuditActor) {
    const { ticket } = await this.findById(id, propertyId);
    const trimmed = body.trim();
    if (!trimmed) throw new BadRequestException('Comment cannot be blank');
    const comment = { id: randomUUID(), body: trimmed, authorId: actor?.userId ?? null, createdAt: new Date().toISOString() };
    const [updated] = await this.db.update(maintenanceTickets)
      .set({ comments: [...(ticket.comments ?? []), comment], updatedAt: new Date() })
      .where(and(eq(maintenanceTickets.id, id), eq(maintenanceTickets.propertyId, propertyId))).returning();
    await this.writeAudit(updated, ticket, actor, 'comment');
    await this.webhook.emit('maintenance.updated', 'maintenance_ticket', id, { ticketId: id, action: 'comment_added' }, propertyId);
    return updated;
  }

  async addAttachment(id: string, propertyId: string, attachment: { url: string; name?: string; contentType?: string }, actor?: AuditActor) {
    const { ticket } = await this.findById(id, propertyId);
    const [updated] = await this.db.update(maintenanceTickets)
      .set({ attachments: [...(ticket.attachments ?? []), attachment], updatedAt: new Date() })
      .where(and(eq(maintenanceTickets.id, id), eq(maintenanceTickets.propertyId, propertyId))).returning();
    await this.writeAudit(updated, ticket, actor, 'attachment');
    await this.webhook.emit('maintenance.updated', 'maintenance_ticket', id, { ticketId: id, action: 'attachment_added' }, propertyId);
    return updated;
  }

  async confirmReturnToService(id: string, propertyId: string, note: string | undefined, actor?: AuditActor) {
    const { ticket } = await this.findById(id, propertyId);
    if (!ticket.roomId || !ticket.returnToServiceRequired) {
      throw new BadRequestException('This ticket has no room awaiting return to service');
    }
    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      throw new ConflictException('Resolve the maintenance ticket before returning the room to service');
    }
    await this.roomStatus.markBackInService(ticket.roomId, propertyId);
    const [updated] = await this.db.update(maintenanceTickets).set({
      returnToServiceRequired: false,
      status: 'closed',
      updatedAt: new Date(),
      resolution: note ? `${ticket.resolution ?? ''}\n${note}`.trim() : ticket.resolution,
    }).where(and(eq(maintenanceTickets.id, id), eq(maintenanceTickets.propertyId, propertyId))).returning();
    await this.writeAudit(updated, ticket, actor, 'return_to_service');
    await this.webhook.emit('maintenance.updated', 'maintenance_ticket', id, {
      ticketId: id, roomId: ticket.roomId, action: 'returned_to_service', roomStatus: 'vacant_dirty',
    }, propertyId);
    return updated;
  }

  private async writeAudit(next: any, previous: any, actor: AuditActor | undefined, action: string) {
    await this.db.insert(auditLogs).values({
      propertyId: next.propertyId,
      action,
      entityType: 'maintenance_ticket',
      entityId: next.id,
      previousValue: previous,
      newValue: next,
      description: action,
      ...actorFields(actor),
    });
  }
}
