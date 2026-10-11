import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { eq, and, sql, inArray, lte, or } from 'drizzle-orm';
import { rooms, housekeepingTasks, maintenanceTickets } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { WebhookService } from '../webhook/webhook.service';

type RoomStatus =
  | 'vacant_clean'
  | 'vacant_dirty'
  | 'clean'
  | 'inspected'
  | 'guest_ready'
  | 'occupied'
  | 'out_of_order'
  | 'out_of_service';

export type RoomReadiness = { roomId: string; status: string; ready: boolean; operational: boolean; reasons: Array<{ code: string; label: string; entityIds?: string[] }> };

const VALID_TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  // KB 5.2 chain: vacant_clean → vacant_dirty is the documented "clean room
  // found dirty" path — the desk must be able to send a room back to HK.
  vacant_clean: ['occupied', 'vacant_dirty', 'out_of_order', 'out_of_service'],
  vacant_dirty: ['clean', 'out_of_order'],
  clean: ['inspected', 'vacant_clean', 'out_of_order'],
  inspected: ['guest_ready', 'out_of_order'],
  guest_ready: ['occupied', 'out_of_order'],
  occupied: ['vacant_dirty'],
  out_of_order: ['vacant_dirty'],
  out_of_service: ['vacant_dirty'],
};

@Injectable()
export class RoomStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly webhookService: WebhookService,
  ) {}

  async transitionStatus(
    roomId: string,
    propertyId: string,
    newStatus: RoomStatus,
    note?: string,
    tx?: any,
  ) {
    const room = await this.findRoom(roomId, propertyId, tx);
    const currentStatus = room.status as RoomStatus;
    const allowed = VALID_TRANSITIONS[currentStatus] ?? [];

    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Cannot transition room from '${currentStatus}' to '${newStatus}'. Valid transitions: ${allowed.join(', ') || 'none'}`,
      );
    }

    const updates: Record<string, unknown> = {
      status: newStatus,
      updatedAt: new Date(),
    };
    if (note !== undefined) {
      updates['maintenanceNotes'] = note;
    }

    const [updated] = await (tx ?? this.db)
      .update(rooms)
      .set(updates)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId), eq(rooms.status, currentStatus)))
      .returning();
    if (!updated) throw new BadRequestException('Room status changed concurrently');

    if (!tx) await this.webhookService.emit(
      'room.status_changed',
      'room',
      updated.id,
      { previousStatus: currentStatus, newStatus, roomNumber: room.number },
      propertyId,
    );

    return updated;
  }

  async markOccupied(roomId: string, propertyId: string, tx?: any) {
    return this.transitionStatus(roomId, propertyId, 'occupied', undefined, tx);
  }

  async markVacantDirty(roomId: string, propertyId: string, tx?: any) {
    return this.transitionStatus(roomId, propertyId, 'vacant_dirty', undefined, tx);
  }

  async markOutOfOrder(roomId: string, propertyId: string, notes: string) {
    return this.transitionStatus(roomId, propertyId, 'out_of_order', notes);
  }

  async markBackInService(roomId: string, propertyId: string) {
    const room = await this.findRoom(roomId, propertyId);
    const currentStatus = room.status as RoomStatus;
    if (currentStatus !== 'out_of_order' && currentStatus !== 'out_of_service') {
      throw new BadRequestException(
        `Room is not out of order or out of service (current: ${currentStatus})`,
      );
    }
    return this.transitionStatus(roomId, propertyId, 'vacant_dirty');
  }

  async lockRoom(roomId: string, propertyId: string, tx: any) {
    const [room] = await tx.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId))).for('update');
    if (!room) throw new NotFoundException('Номер не найден в этом объекте');
    return room;
  }

  /** One projection of existing room, cleaning and repair state; it does not create a second readiness ledger. */
  async operationalReadiness(propertyId: string, serviceDate: string, db: any = this.db): Promise<RoomReadiness[]> {
    const [inventory, cleaning, repairs] = await Promise.all([
      db.select({ id: rooms.id, status: rooms.status, isActive: rooms.isActive }).from(rooms).where(eq(rooms.propertyId, propertyId)),
      db.select({ id: housekeepingTasks.id, roomId: housekeepingTasks.roomId, status: housekeepingTasks.status }).from(housekeepingTasks).where(and(
        eq(housekeepingTasks.propertyId, propertyId), lte(housekeepingTasks.serviceDate, new Date(serviceDate + 'T23:59:59.999Z')),
        inArray(housekeepingTasks.type, ['checkout','deep_clean','inspection','maintenance']), inArray(housekeepingTasks.status, ['pending','assigned','in_progress','completed']),
      )),
      db.select({ id: maintenanceTickets.id, roomId: maintenanceTickets.roomId }).from(maintenanceTickets).where(and(eq(maintenanceTickets.propertyId, propertyId), or(
        eq(maintenanceTickets.returnToServiceRequired, true), and(eq(maintenanceTickets.blocksInventory, true), inArray(maintenanceTickets.status, ['open','assigned','in_progress','waiting_parts'])),
      ))),
    ]);
    const cleaningByRoom = new Map<string,any[]>(); const repairsByRoom = new Map<string,any[]>();
    for (const row of cleaning) cleaningByRoom.set(row.roomId, [...(cleaningByRoom.get(row.roomId) ?? []), row]);
    for (const row of repairs) if (row.roomId) repairsByRoom.set(row.roomId, [...(repairsByRoom.get(row.roomId) ?? []), row]);
    return inventory.map((room: any) => {
      const tasks = cleaningByRoom.get(room.id) ?? []; const tickets = repairsByRoom.get(room.id) ?? [];
      const reasons: Array<{ code: string; label: string; entityIds?: string[] }> = [];
      if (!room.isActive) reasons.push({ code: 'inactive', label: 'Номер выключен' });
      if (['out_of_order','out_of_service'].includes(room.status)) reasons.push({ code: 'inventory_blocked', label: 'Номер выведен из эксплуатации' });
      if (tickets.length) reasons.push({ code: 'maintenance', label: 'Ремонт или возврат в эксплуатацию не подтверждён', entityIds: tickets.map(t => t.id) });
      if (room.status === 'vacant_dirty') reasons.push({ code: 'dirty', label: 'Номер грязный' });
      if (['clean','inspected'].includes(room.status) || tasks.some(t => t.status === 'completed')) reasons.push({ code: 'inspection', label: 'Не завершена инспекция', entityIds: tasks.filter(t => t.status === 'completed').map(t => t.id) });
      if (tasks.some(t => t.status !== 'completed')) reasons.push({ code: 'blocking_task', label: 'Есть незавершённая блокирующая задача', entityIds: tasks.filter(t => t.status !== 'completed').map(t => t.id) });
      if (room.status === 'occupied') reasons.push({ code: 'occupied', label: 'Номер занят' });
      return { roomId: room.id, status: room.status, ready: ['vacant_clean','guest_ready'].includes(room.status) && reasons.length === 0, reasons,
        operational: room.isActive && !['out_of_order','out_of_service'].includes(room.status) && tickets.length === 0 };
    });
  }

  async getRoomStatus(roomId: string, propertyId: string, tx?: any) {
    const room = await this.findRoom(roomId, propertyId, tx);
    return { id: room.id, number: room.number, status: room.status };
  }

  async getRoomsByStatus(propertyId: string, status: string) {
    return this.db
      .select()
      .from(rooms)
      .where(
        and(
          eq(rooms.propertyId, propertyId),
          eq(rooms.status, status as RoomStatus),
          eq(rooms.isActive, true),
        ),
      );
  }

  async getPropertyRoomSummary(propertyId: string) {
    const result = await this.db
      .select({
        status: rooms.status,
        count: sql<number>`count(*)::int`,
      })
      .from(rooms)
      .where(and(eq(rooms.propertyId, propertyId), eq(rooms.isActive, true)))
      .groupBy(rooms.status);

    return result;
  }

  private async findRoom(roomId: string, propertyId: string, tx?: any) {
    const [room] = await (tx ?? this.db)
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId)));
    if (!room) {
      throw new NotFoundException(`Room ${roomId} not found`);
    }
    return room;
  }
}
