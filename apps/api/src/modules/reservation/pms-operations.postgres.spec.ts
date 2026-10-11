import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import { properties, guests, guestPropertyLinks, roomTypes, rooms, ratePlans, reservations, reservationGuests,
  bookings, folios, auditLogs, domainEventOutbox, taxProfiles, taxRules, depositLedgerEntries, staffRequestFences } from '@telivityhaip/database';
import { OperationsService } from '../operations/operations.service';
import { ReportsService } from '../reports/reports.service';
import { ReservationCalendarService } from './reservation-calendar.service';
import { AvailabilityService } from './availability.service';
import { ReservationService } from './reservation.service';
import { StaffReservationService } from './staff-reservation.service';
import { RatePlanService } from '../rate-plan/rate-plan.service';
import { TaxService } from '../tax/tax.service';
import { FolioService } from '../folio/folio.service';
import { RoomStatusService } from '../room/room-status.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { GuestService } from '../guest/guest.service';

// Real SQL, locks, transactions, pricing and folios. Only external delivery is a port double.
describe.runIf(process.env.PMS_LIVE_PG === '1')('PMS operations against PostgreSQL', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 8 });
  const db = drizzle(client);
  const ids = { property: randomUUID(), guest: randomUUID(), type: randomUUID(), rate: randomUUID(), room: randomUUID(), target: randomUUID(), third: randomUUID(), tax: randomUUID() };
  const webhooks = { emit: vi.fn(), dispatchPersisted: vi.fn() };
  const taxes = new TaxService(db);
  const rates = new RatePlanService(db, webhooks as any);
  const outbox = new DomainEventOutboxService(db, webhooks as any);
  const reservationService = new ReservationService(db, new AvailabilityService(db), new FolioService(db, webhooks as any, taxes),
    new RoomStatusService(db, webhooks as any), {} as any, webhooks as any, {} as any, {} as any, {} as any, rates, outbox);
  const staff = new StaffReservationService(db, reservationService, rates, taxes, outbox);
  const input = { propertyId: ids.property, guestId: ids.guest, roomTypeId: ids.type, ratePlanId: ids.rate,
    checkIn: '2027-05-01', checkOut: '2027-05-03', expectedTotal: '200.00', currencyCode: 'KZT', adults: 1, roomId: ids.room };
  const create = (changes = {}) => staff.create({ ...input, requestId: randomUUID(), ...changes });

  async function clearStays() {
    await db.delete(staffRequestFences).where(eq(staffRequestFences.propertyId, ids.property));
    await db.delete(depositLedgerEntries).where(eq(depositLedgerEntries.propertyId, ids.property));
    await db.delete(domainEventOutbox).where(eq(domainEventOutbox.propertyId, ids.property));
    await db.delete(auditLogs).where(eq(auditLogs.propertyId, ids.property));
    await db.delete(folios).where(eq(folios.propertyId, ids.property));
    await db.delete(reservationGuests).where(eq(reservationGuests.propertyId, ids.property));
    await db.delete(reservations).where(eq(reservations.propertyId, ids.property));
    await db.delete(bookings).where(eq(bookings.propertyId, ids.property));
  }
  beforeAll(async () => {
    await db.insert(properties).values({ id: ids.property, name: 'PMS transaction test', code: 'TX-' + ids.property.slice(0, 8), countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: 1 });
    await db.insert(guests).values({ id: ids.guest, firstName: 'Тест', lastName: 'Транзакции' });
    await db.insert(guestPropertyLinks).values({ propertyId: ids.property, guestId: ids.guest, source: 'pms' });
    await db.insert(roomTypes).values({ id: ids.type, propertyId: ids.property, name: 'Стандарт', code: 'STD', maxOccupancy: 2, defaultOccupancy: 1 });
    await db.insert(ratePlans).values({ id: ids.rate, propertyId: ids.property, roomTypeId: ids.type, name: 'Тест', code: 'TX', type: 'bar', baseAmount: '100.00', currencyCode: 'KZT' });
    await db.insert(rooms).values([{ id: ids.room, propertyId: ids.property, roomTypeId: ids.type, number: '101', status: 'vacant_clean' },
      { id: ids.target, propertyId: ids.property, roomTypeId: ids.type, number: '102', status: 'vacant_clean', isActive: false },
      { id: ids.third, propertyId: ids.property, roomTypeId: ids.type, number: '103', status: 'vacant_clean', isActive: false }]);
    await db.insert(taxProfiles).values({ id: ids.tax, propertyId: ids.property, name: 'Test rules', jurisdictionCode: 'TEST', effectiveFrom: '2027-01-01', isActive: false });
  });
  beforeEach(async () => {
    await clearStays();
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax));
    await db.update(taxProfiles).set({ isActive: false }).where(eq(taxProfiles.id, ids.tax));
    await db.update(ratePlans).set({ isTaxInclusive: false, baseAmount: '100.00' }).where(eq(ratePlans.id, ids.rate));
    await db.update(rooms).set({ status: 'vacant_clean', isActive: true }).where(eq(rooms.id, ids.room));
    await db.update(rooms).set({ status: 'vacant_clean', isActive: false }).where(eq(rooms.id, ids.target));
    await db.update(rooms).set({ status: 'vacant_clean', isActive: false }).where(eq(rooms.id, ids.third));
    vi.clearAllMocks();
    webhooks.dispatchPersisted.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await clearStays();
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax));
    await db.delete(taxProfiles).where(eq(taxProfiles.id, ids.tax));
    await db.delete(rooms).where(inArray(rooms.id, [ids.room, ids.target, ids.third]));
    await db.delete(ratePlans).where(eq(ratePlans.id, ids.rate));
    await db.delete(roomTypes).where(eq(roomTypes.id, ids.type));
    await db.delete(guestPropertyLinks).where(eq(guestPropertyLinks.guestId, ids.guest));
    await db.delete(guests).where(eq(guests.id, ids.guest));
    await db.delete(properties).where(eq(properties.id, ids.property));
    await client.end();
  });

  it('allows exactly one concurrent purchase of the last room, without orphan booking/folio/outbox', async () => {
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const table of [bookings, reservations, folios, domainEventOutbox]) {
      expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(1);
    }
  });
  it('excludes OOO/OOS physical inventory from sale even with an overbooking allowance', async () => {
    await db.update(properties).set({ overbookingPercentage: 100 }).where(eq(properties.id, ids.property));
    try {
      for (const status of ['out_of_order', 'out_of_service'] as const) {
        await db.update(rooms).set({ status }).where(eq(rooms.id, ids.room));
        const availability = await new AvailabilityService(db).searchAvailability(ids.property, input.checkIn, input.checkOut, ids.type);
        expect(availability.every(night => night.available === 0 && night.overbookingBuffer === 0)).toBe(true);
        await expect(create({ roomId: undefined })).rejects.toThrow();
      }
      expect(await db.select().from(bookings).where(eq(bookings.propertyId, ids.property))).toHaveLength(0);
    } finally { await db.update(properties).set({ overbookingPercentage: 0 }).where(eq(properties.id, ids.property)); }
  });
  it('serializes concurrent retries and returns the same immutable snapshot', async () => {
    const requestId = randomUUID();
    const results = await Promise.all([create({ requestId }), create({ requestId })]);
    expect(results[0].id).toBe(results[1].id);
    expect(await staff.result(ids.property, requestId)).toMatchObject({ state: 'committed', reservationId: results[0].id });
    expect(await staff.result(randomUUID(), requestId)).toEqual({ state: 'unconfirmed' });
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(results[0].acceptedPricingSnapshot).toMatchObject({ grandTotal: '200.00', roomTotal: '200.00', taxTotal: '0.00' });
    await db.update(ratePlans).set({ baseAmount: '150.00' }).where(eq(ratePlans.id, ids.rate));
    expect(await create({ requestId })).toMatchObject({ id: results[0].id, totalAmount: '200.00', replayed: true });
    await expect(create({ requestId, adults: 2 })).rejects.toMatchObject({ response: { code: 'REQUEST_CHANGED' } });
  });
  it('rolls back creation, roster, folio and event when physical assignment fails', async () => {
    await expect(create({ roomId: ids.target })).rejects.toThrow();
    for (const table of [bookings, reservations, reservationGuests, folios, auditLogs, domainEventOutbox]) {
      expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    }
  });
  it('closes a request that never arrived and rejects a delayed POST without creating any stay', async () => {
    const requestId = randomUUID();
    expect(await staff.result(ids.property, requestId)).toEqual({ state: 'unconfirmed' });
    expect(await staff.result(ids.property, requestId, true)).toEqual({ state: 'closed' });
    expect(await staff.result(ids.property, requestId, true)).toEqual({ state: 'closed' });
    await expect(create({ requestId })).rejects.toMatchObject({ response: { code: 'REQUEST_CLOSED' } });
    for (const table of [bookings, reservations, folios, domainEventOutbox])
      expect(await db.select().from(table).where(eq(table.propertyId, ids.property))).toHaveLength(0);
    expect(await staff.result(randomUUID(), requestId)).toEqual({ state: 'unconfirmed' });
    expect(await create()).toMatchObject({ replayed: false });
  });
  it('serializes closing against creation: either a saved stay or a permanently fenced token', async () => {
    const requestId = randomUUID();
    const [creation, closing] = await Promise.allSettled([create({ requestId }), staff.result(ids.property, requestId, true)]);
    expect(closing.status).toBe('fulfilled');
    if (creation.status === 'fulfilled') {
      expect((closing as PromiseFulfilledResult<any>).value).toMatchObject({ state: 'committed', reservationId: creation.value.id });
      expect(await create({ requestId })).toMatchObject({ id: creation.value.id, replayed: true });
    } else {
      expect((closing as PromiseFulfilledResult<any>).value).toEqual({ state: 'closed' });
      await expect(create({ requestId })).rejects.toMatchObject({ response: { code: 'REQUEST_CLOSED' } });
    }
    expect(await db.select().from(reservations).where(eq(reservations.propertyId, ids.property))).toHaveLength(creation.status === 'fulfilled' ? 1 : 0);
  });
  it('prevents two independent stays assigning the same physical room', async () => {
    await db.update(rooms).set({ isActive: true }).where(eq(rooms.id, ids.target));
    const a = await create({ roomId: undefined });
    const b = await create({ roomId: undefined });
    const results = await Promise.allSettled([
      reservationService.assignRoom(a.id, ids.property, { roomId: ids.room }),
      reservationService.assignRoom(b.id, ids.property, { roomId: ids.room }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('moves an in-house stay and both room statuses atomically and rejects foreign property reads', async () => {
    await db.update(rooms).set({ isActive: true }).where(eq(rooms.id, ids.target));
    const stay = await create();
    await db.update(reservations).set({ status: 'checked_in' }).where(eq(reservations.id, stay.id));
    await db.update(rooms).set({ status: 'occupied' }).where(eq(rooms.id, ids.room));
    await reservationService.moveRoom(stay.id, ids.property, { roomId: ids.target });
    expect((await db.select().from(rooms).where(eq(rooms.id, ids.room)))[0]?.status).toBe('vacant_dirty');
    expect((await db.select().from(rooms).where(eq(rooms.id, ids.target)))[0]?.status).toBe('occupied');
    await expect(reservationService.moveRoom(stay.id, randomUUID(), { roomId: ids.room })).rejects.toThrow('Reservation not found');
  });
  it('allows only one concurrent check-in and commits its room and folio together', async () => {
    const stay = await create();
    const results = await Promise.allSettled([reservationService.checkIn(stay.id, ids.property, { registrationSigned: true }), reservationService.checkIn(stay.id, ids.property, { registrationSigned: true })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.select().from(reservations).where(eq(reservations.id, stay.id)))[0]?.status).toBe('checked_in');
    expect((await db.select().from(rooms).where(eq(rooms.id, ids.room)))[0]?.status).toBe('occupied');
    expect(await db.select().from(folios).where(eq(folios.reservationId, stay.id))).toHaveLength(1);
  });
  it('rejects checking into an assigned room that became OOO without changing the stay', async () => {
    const stay = await create();
    await db.update(rooms).set({ status: 'out_of_order' }).where(eq(rooms.id, ids.room));
    await expect(reservationService.checkIn(stay.id, ids.property)).rejects.toThrow();
    expect((await db.select().from(reservations).where(eq(reservations.id, stay.id)))[0]?.status).toBe('assigned');
    expect((await db.select().from(rooms).where(eq(rooms.id, ids.room)))[0]?.status).toBe('out_of_order');
  });
  it('serializes two independent check-ins requesting the same ready room', async () => {
    await db.update(rooms).set({ isActive: true }).where(inArray(rooms.id, [ids.target, ids.third]));
    const a = await create();
    const b = await create({ roomId: ids.third });
    const results = await Promise.allSettled([a, b].map(stay => reservationService.checkIn(stay.id, ids.property,
      { roomId: ids.target, registrationSigned: true })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rows = await db.select().from(reservations).where(eq(reservations.propertyId, ids.property));
    expect(rows.filter(r => r.status === 'checked_in' && r.roomId === ids.target)).toHaveLength(1);
    expect(rows.filter(r => r.status === 'assigned')).toHaveLength(1);
  });
  it('serializes competing in-house moves and preserves the losing stay and room', async () => {
    await db.update(rooms).set({ isActive: true }).where(inArray(rooms.id, [ids.target, ids.third]));
    const a = await create();
    const b = await create({ roomId: ids.third });
    await reservationService.checkIn(a.id, ids.property, { registrationSigned: true });
    await reservationService.checkIn(b.id, ids.property, { registrationSigned: true });
    const results = await Promise.allSettled([a, b].map(stay => reservationService.moveRoom(stay.id, ids.property, { roomId: ids.target })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const stays = await db.select().from(reservations).where(eq(reservations.propertyId, ids.property));
    expect(stays.filter(r => r.roomId === ids.target)).toHaveLength(1);
    const roomRows = await db.select().from(rooms).where(eq(rooms.propertyId, ids.property));
    expect(roomRows.filter(r => r.status === 'occupied')).toHaveLength(2);
    expect(roomRows.filter(r => r.status === 'vacant_dirty')).toHaveLength(1);
    expect(stays.every(r => r.totalAmount === '200.00' && r.acceptedPricingSnapshot?.grandTotal === '200.00')).toBe(true);
  });
  it('rolls back room occupancy and check-in when folio creation fails', async () => {
    const stay = await create();
    const failure = vi.spyOn((reservationService as any).folioService, 'createAutoFolio').mockRejectedValueOnce(new Error('folio unavailable'));
    try { await expect(reservationService.checkIn(stay.id, ids.property, { registrationSigned: true })).rejects.toThrow('folio unavailable'); }
    finally { failure.mockRestore(); }
    expect((await db.select().from(reservations).where(eq(reservations.id, stay.id)))[0]?.status).toBe('assigned');
    expect((await db.select().from(rooms).where(eq(rooms.id, ids.room)))[0]?.status).toBe('vacant_clean');
  });
  it('retains a committed event after a delivery failure and recovers once per logical event', async () => {
    webhooks.dispatchPersisted.mockRejectedValueOnce(new Error('Delivery unavailable'));
    const stay = await create();
    const [pending] = await db.select().from(domainEventOutbox).where(eq(domainEventOutbox.propertyId, ids.property));
    expect(pending?.deliveredAt).toBeNull();
    expect(pending?.attempts).toBe(1);
    await db.update(domainEventOutbox).set({ availableAt: new Date(0) }).where(eq(domainEventOutbox.id, pending!.id));
    await outbox.recover();
    await outbox.recover();
    expect(webhooks.dispatchPersisted).toHaveBeenCalledTimes(2);
    expect((await db.select().from(reservations).where(eq(reservations.id, stay.id)))[0]?.status).toBe('assigned');
    expect((await db.select().from(domainEventOutbox).where(eq(domainEventOutbox.id, pending!.id)))[0]?.deliveredAt).not.toBeNull();
  });
  it('decomposes a gross tariff, including compounding, and preserves net + taxes = accepted total', async () => {
    await db.update(taxProfiles).set({ isActive: true }).where(eq(taxProfiles.id, ids.tax));
    await db.insert(taxRules).values([
      { taxProfileId: ids.tax, name: 'Base', code: 'BASE', type: 'percentage', rate: '10', effectiveFrom: '2027-01-01', sortOrder: 1 },
      { taxProfileId: ids.tax, name: 'Compound', code: 'COMP', type: 'percentage', rate: '5', isCompounding: true, effectiveFrom: '2027-01-01', sortOrder: 2 },
    ]);
    await db.update(ratePlans).set({ isTaxInclusive: true, baseAmount: '115.50' }).where(eq(ratePlans.id, ids.rate));
    const stay = await create({ expectedTotal: '231.00' });
    expect(stay.acceptedPricingSnapshot).toMatchObject({ grandTotal: '231.00', roomTotal: '200.00', taxTotal: '31.00',
      nights: [{ date: '2027-05-01', roomAmount: '100.00', taxAmount: '15.50' }, { date: '2027-05-02', roomAmount: '100.00', taxAmount: '15.50' }] });
    expect((await new GuestService(db).get360(ids.guest, ids.property)).stays).toHaveLength(1);
  });
  it('does not mark OOO rooms or a foreign-currency deposit as ready', async () => {
    const stay = await create();
    await db.update(rooms).set({ status: 'out_of_order' }).where(eq(rooms.id, ids.room));
    await db.insert(depositLedgerEntries).values({ propertyId: ids.property, reservationId: stay.id, amount: '100.00', currencyCode: 'USD' });
    const rows = await new OperationsService(db).preArrivals(ids.property, input.checkIn, input.checkIn);
    expect(rows[0]?.checks).toMatchObject({ housekeepingReady: false, roomOperational: false, depositReceived: false, depositAmount: 0 });
  });
  it('counts a later cancellation in pickup baseline, and offsets additions cancelled in the same window', async () => {
    const stay = await create();
    await db.update(reservations).set({ status: 'cancelled', createdAt: new Date('2027-04-01T10:00:00Z'), cancelledAt: new Date('2027-04-20T10:00:00Z') }).where(eq(reservations.id, stay.id));
    const reports = new ReportsService(db);
    const lost = await reports.getPickup(ids.property, input.checkIn, '2027-04-10', '2027-04-25');
    expect(lost.baseline.roomNights).toBe(1); expect(lost.current.roomNights).toBe(0); expect(lost.pickup.roomNights).toBe(-1);
    await db.update(reservations).set({ createdAt: new Date('2027-04-15T10:00:00Z') }).where(eq(reservations.id, stay.id));
    const offset = await reports.getPickup(ids.property, input.checkIn, '2027-04-10', '2027-04-25');
    expect(offset.pickup.roomNights).toBe(0);
    expect(offset.daily.reduce((sum, day) => sum + day.netPickup, 0)).toBe(0);
  });
  it('retains committed check-in events when webhook delivery fails and retries with stable identities', async () => {
    const stay = await create();
    webhooks.dispatchPersisted.mockRejectedValue(new Error('temporary delivery failure'));
    try {
      const result = await reservationService.checkIn(stay.id, ids.property, { registrationSigned: true, skipDepositAuth: true });
      expect(result.reservation.status).toBe('checked_in');
      const events = await db.select().from(domainEventOutbox).where(eq(domainEventOutbox.propertyId, ids.property));
      const checkedIn = events.find(row => row.payload.event === 'reservation.checked_in');
      const occupied = events.find(row => row.payload.event === 'room.status_changed');
      expect(checkedIn).toBeDefined(); expect(occupied).toBeDefined();
      expect(checkedIn!.deliveredAt).toBeNull();
      expect(occupied!.payload.data.roomNumber).toBeDefined();
      webhooks.dispatchPersisted.mockResolvedValue(undefined);
      await outbox.deliver(ids.property, checkedIn!.logicalEventId);
      const [delivered] = await db.select().from(domainEventOutbox).where(eq(domainEventOutbox.id, checkedIn!.id));
      expect(delivered.deliveredAt).not.toBeNull();
      expect(delivered.logicalEventId).toBe(checkedIn!.logicalEventId);
    } finally { webhooks.dispatchPersisted.mockResolvedValue(undefined); }
  });

  it('returns a complete 31-night calendar for 300 rooms and 900 stays without list pagination', async () => {
    const extraRooms = Array.from({ length: 300 }, (_, index) => ({ id: randomUUID(), propertyId: ids.property, roomTypeId: ids.type, number: String(1000 + index), status: 'vacant_clean' as const }));
    await db.insert(rooms).values(extraRooms);
    const bookingRows = Array.from({ length: 900 }, () => ({ id: randomUUID(), propertyId: ids.property, guestId: ids.guest, confirmationNumber: 'CAL-' + randomUUID(), source: 'direct' as const }));
    try {
      await db.insert(bookings).values(bookingRows);
      await db.insert(reservations).values(bookingRows.map((booking, index) => {
        const period = Math.floor(index / 300);
        const arrival = ['2027-05-01', '2027-05-11', '2027-05-21'][period];
        const departure = ['2027-05-11', '2027-05-21', '2027-05-31'][period];
        return { propertyId: ids.property, bookingId: booking.id, guestId: ids.guest, roomTypeId: ids.type,
          roomId: extraRooms[index % 300].id, ratePlanId: ids.rate, arrivalDate: arrival, departureDate: departure,
          nights: 10, totalAmount: '1000.00', currencyCode: 'KZT', status: 'assigned' as const };
      }));
      const started = performance.now();
      const result = await new ReservationCalendarService(db, new AvailabilityService(db)).range({ propertyId: ids.property, checkIn: '2027-05-01', checkOut: '2027-06-01' });
      console.info('Calendar PostgreSQL sample: 300 rooms / 900 stays / 31 nights, ' + Math.round(performance.now() - started) + ' ms');
      expect(result.complete).toBe(true);
      expect(result.rooms).toHaveLength(301);
      expect(result.reservations).toHaveLength(900);
      expect(result.availability).toHaveLength(31);
      expect(new Set(result.reservations.map((row: any) => row.id)).size).toBe(900);
      await expect(new ReservationCalendarService(db, new AvailabilityService(db)).range({ propertyId: ids.property, checkIn: '2027-05-01', checkOut: '2027-06-02' })).rejects.toThrow();
    } finally {
      await clearStays();
      await db.delete(rooms).where(inArray(rooms.id, extraRooms.map(room => room.id)));
    }
  });

});
