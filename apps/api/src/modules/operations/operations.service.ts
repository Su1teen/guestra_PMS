import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import {
  depositLedgerEntries,
  guests,
  housekeepingTasks,
  maintenanceTickets,
  properties,
  ratePlans,
  reservationServices,
  reservations,
  rooms,
  roomTypes,
  serviceRequests,
  services,
  users,
} from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';

type AttentionItem = {
  id: string;
  type: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  title: string;
  description: string;
  entityType: string;
  entityId: string;
  href: string;
  dueAt?: string | null;
  assignee?: string | null;
};

@Injectable()
export class OperationsService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  async assignees(propertyId: string) {
    return this.db.select({ id: users.id, name: users.name, email: users.email })
      .from(users).where(and(
        eq(users.status, 'active' as any),
        sql`(${users.propertyId} = ${propertyId} or ${users.propertyId} is null)`,
      )).orderBy(asc(users.name));
  }

  async preArrivals(propertyId: string, startDate: string, endDate: string) {
    const rows = await this.db.select({
      reservation: reservations,
      guest: guests,
      roomNumber: rooms.number,
      roomStatus: rooms.status,
      roomType: roomTypes.name,
      ratePlan: ratePlans.name,
      propertyName: properties.name,
      checkInTime: properties.checkInTime,
    }).from(reservations)
      .innerJoin(guests, eq(guests.id, reservations.guestId))
      .innerJoin(properties, eq(properties.id, reservations.propertyId))
      .leftJoin(rooms, and(eq(rooms.id, reservations.roomId), eq(rooms.propertyId, propertyId)))
      .leftJoin(roomTypes, and(eq(roomTypes.id, reservations.roomTypeId), eq(roomTypes.propertyId, propertyId)))
      .leftJoin(ratePlans, and(eq(ratePlans.id, reservations.ratePlanId), eq(ratePlans.propertyId, propertyId)))
      .where(and(
        eq(reservations.propertyId, propertyId),
        inArray(reservations.status, ['pending', 'confirmed', 'assigned'] as any),
        sql`${reservations.arrivalDate} >= ${startDate}`,
        sql`${reservations.arrivalDate} <= ${endDate}`,
      )).orderBy(asc(reservations.arrivalDate));

    return Promise.all(rows.map(async (row: any) => {
      const reservationId = row.reservation.id;
      const [depositRows, hkRows, extraRows, taskRows] = await Promise.all([
        this.db.select({
          status: depositLedgerEntries.status,
          amount: depositLedgerEntries.amount,
          currencyCode: depositLedgerEntries.currencyCode,
        }).from(depositLedgerEntries).where(and(
          eq(depositLedgerEntries.propertyId, propertyId),
          eq(depositLedgerEntries.reservationId, reservationId),
          inArray(depositLedgerEntries.status, ['held', 'applied'] as any),
        )),
        row.reservation.roomId
          ? this.db.select().from(housekeepingTasks).where(and(
              eq(housekeepingTasks.propertyId, propertyId),
              eq(housekeepingTasks.roomId, row.reservation.roomId),
              sql`${housekeepingTasks.serviceDate}::date <= ${row.reservation.arrivalDate}`,
            )).orderBy(sql`${housekeepingTasks.serviceDate} desc`).limit(1)
          : Promise.resolve([]),
        this.db.select({
          id: reservationServices.id,
          name: services.name,
          status: reservationServices.status,
          quantity: reservationServices.quantity,
        }).from(reservationServices)
          .innerJoin(services, and(
            eq(services.id, reservationServices.serviceId),
            eq(services.propertyId, propertyId),
          )).where(and(
            eq(reservationServices.propertyId, propertyId),
            eq(reservationServices.reservationId, reservationId),
            inArray(reservationServices.status, ['confirmed', 'posted'] as any),
          )),
        this.db.select().from(serviceRequests).where(and(
          eq(serviceRequests.propertyId, propertyId),
          eq(serviceRequests.reservationId, reservationId),
          inArray(serviceRequests.status, ['open', 'assigned', 'in_progress'] as any),
        )),
      ]);

      const depositAmount = depositRows.reduce((sum: number, d: any) => sum + Number(d.amount), 0);
      const latestHk = hkRows[0];
      const guestComplete = Boolean(
        row.guest.firstName && row.guest.lastName && (row.guest.email || row.guest.phone),
      );
      const roomOperational = !['out_of_order', 'out_of_service'].includes(row.roomStatus ?? '');
      const housekeepingReady = ['guest_ready', 'inspected', 'vacant_clean'].includes(row.roomStatus ?? '')
        || latestHk?.status === 'inspected';

      return {
        reservationId,
        guestId: row.guest.id,
        guestName: `${row.guest.firstName} ${row.guest.lastName}`,
        vipLevel: row.guest.vipLevel,
        propertyName: row.propertyName,
        arrivalDate: row.reservation.arrivalDate,
        arrivalTime: row.reservation.actualArrivalTime ?? row.checkInTime,
        roomId: row.reservation.roomId,
        roomNumber: row.roomNumber,
        roomStatus: row.roomStatus,
        roomType: row.roomType,
        ratePlan: row.ratePlan,
        currencyCode: row.reservation.currencyCode,
        notes: row.reservation.specialRequests,
        checks: {
          roomAssigned: Boolean(row.reservation.roomId),
          roomOperational,
          housekeepingReady,
          depositReceived: depositAmount > 0,
          depositAmount,
          guestInformationComplete: guestComplete,
          hasSpecialRequests: Boolean(row.reservation.specialRequests),
          extrasBooked: extraRows.length > 0,
          operationalTasksComplete: taskRows.length === 0,
        },
        extras: extraRows,
        operationalTasks: taskRows,
        actions: {
          reservation: `/reservations/${reservationId}`,
          guest: `/guests/${row.guest.id}`,
        },
      };
    }));
  }

  async attention(propertyId: string, date: string) {
    const [arrivals, requests, maintenance, overdueHk] = await Promise.all([
      this.preArrivals(propertyId, date, date),
      this.db.select({ request: serviceRequests, assigneeName: users.name })
        .from(serviceRequests).leftJoin(users, eq(users.id, serviceRequests.assigneeId))
        .where(and(
          eq(serviceRequests.propertyId, propertyId),
          inArray(serviceRequests.status, ['open', 'assigned', 'in_progress'] as any),
        )),
      this.db.select({ ticket: maintenanceTickets, roomNumber: rooms.number, assigneeName: users.name })
        .from(maintenanceTickets)
        .leftJoin(rooms, and(eq(rooms.id, maintenanceTickets.roomId), eq(rooms.propertyId, propertyId)))
        .leftJoin(users, eq(users.id, maintenanceTickets.assigneeId))
        .where(and(
          eq(maintenanceTickets.propertyId, propertyId),
          inArray(maintenanceTickets.status, ['open', 'assigned', 'in_progress', 'waiting_parts'] as any),
        )),
      this.db.select({ task: housekeepingTasks, roomNumber: rooms.number })
        .from(housekeepingTasks)
        .innerJoin(rooms, and(eq(rooms.id, housekeepingTasks.roomId), eq(rooms.propertyId, propertyId)))
        .where(and(
          eq(housekeepingTasks.propertyId, propertyId),
          lt(housekeepingTasks.serviceDate, new Date(`${date}T00:00:00.000Z`)),
          inArray(housekeepingTasks.status, ['pending', 'assigned', 'in_progress'] as any),
        )),
    ]);

    const items: AttentionItem[] = [];
    for (const arrival of arrivals as any[]) {
      if (!arrival.checks.roomAssigned) items.push({
        id: `arrival-unassigned-${arrival.reservationId}`,
        type: 'arrival_unassigned', priority: 'high',
        title: arrival.guestName,
        description: 'Arrival today without an assigned room',
        entityType: 'reservation', entityId: arrival.reservationId,
        href: arrival.actions.reservation,
      });
      else if (!arrival.checks.roomOperational || !arrival.checks.housekeepingReady) items.push({
        id: `arrival-room-${arrival.reservationId}`,
        type: 'arrival_room_not_ready', priority: 'critical',
        title: `${arrival.guestName} · ${arrival.roomNumber}`,
        description: `Arrival today; room status: ${arrival.roomStatus}`,
        entityType: 'reservation', entityId: arrival.reservationId,
        href: arrival.actions.reservation,
      });
      if (!arrival.checks.depositReceived) items.push({
        id: `arrival-deposit-${arrival.reservationId}`,
        type: 'deposit_missing', priority: 'normal',
        title: arrival.guestName,
        description: 'Arrival without a recorded deposit',
        entityType: 'reservation', entityId: arrival.reservationId,
        href: `/accounting?reservationId=${arrival.reservationId}`,
      });
    }
    for (const row of requests as any[]) {
      const r = row.request;
      const overdue = r.slaDeadline && new Date(r.slaDeadline) < new Date();
      if (overdue || r.priority >= 2 || !r.assigneeId) items.push({
        id: r.id, type: 'operational_task',
        priority: overdue || r.priority >= 3 ? 'critical' : r.priority >= 2 ? 'high' : 'normal',
        title: r.title, description: r.description ?? r.type,
        entityType: 'service_request', entityId: r.id,
        href: `/operations?tab=tasks&taskId=${r.id}`,
        dueAt: r.slaDeadline, assignee: row.assigneeName,
      });
    }
    for (const row of maintenance as any[]) {
      const t = row.ticket;
      const overdue = t.slaDeadline && new Date(t.slaDeadline) < new Date();
      if (overdue || t.priority === 'critical' || t.priority === 'high' || !t.assigneeId) items.push({
        id: t.id, type: 'maintenance',
        priority: overdue || t.priority === 'critical' ? 'critical' : t.priority,
        title: `${row.roomNumber ? `${row.roomNumber} · ` : ''}${t.title}`,
        description: t.description,
        entityType: 'maintenance_ticket', entityId: t.id,
        href: `/operations?tab=maintenance&ticketId=${t.id}`,
        dueAt: t.slaDeadline, assignee: row.assigneeName,
      });
    }
    for (const row of overdueHk as any[]) items.push({
      id: row.task.id, type: 'housekeeping_overdue', priority: 'high',
      title: `Room ${row.roomNumber}`, description: 'Housekeeping task is overdue',
      entityType: 'housekeeping_task', entityId: row.task.id,
      href: `/housekeeping?taskId=${row.task.id}`,
      dueAt: row.task.serviceDate,
    });

    const rank = { critical: 0, high: 1, normal: 2, low: 3 };
    items.sort((a, b) => rank[a.priority] - rank[b.priority]);
    return { date, total: items.length, items };
  }
}
