import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import { properties, guests, guestPropertyLinks, roomTypes, rooms, ratePlans, reservations, reservationGuests,
  bookings, folios, auditLogs, domainEventOutbox, taxProfiles, taxRules, depositLedgerEntries } from '@telivityhaip/database';
import { OperationsService } from '../operations/operations.service';
import { ReportsService } from '../reports/reports.service';
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
  const ids = { property: randomUUID(), guest: randomUUID(), type: randomUUID(), rate: randomUUID(), room: randomUUID(), target: randomUUID(), tax: randomUUID() };
  const webhooks = { emit: vi.fn(), dispatchPersisted: vi.fn() };
  const taxes = new TaxService(db);
  const rates = new RatePlanService(db, webhooks as any);
  const outbox = new DomainEventOutboxService(db, webhooks as any);
  const reservationService = new ReservationService(db, new AvailabilityService(db), new FolioService(db, webhooks as any, taxes),
    new RoomStatusService(db, webhooks as any), {} as any, webhooks as any, {} as any, {} as any, {} as any, rates);
  const staff = new StaffReservationService(db, reservationService, rates, taxes, outbox);
  const input = { propertyId: ids.property, guestId: ids.guest, roomTypeId: ids.type, ratePlanId: ids.rate,
    checkIn: '2027-05-01', checkOut: '2027-05-03', expectedTotal: '200.00', currencyCode: 'KZT', adults: 1, roomId: ids.room };
  const create = (changes = {}) => staff.create({ ...input, requestId: randomUUID(), ...changes });

  async function clearStays() {
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
      { id: ids.target, propertyId: ids.property, roomTypeId: ids.type, number: '102', status: 'vacant_clean', isActive: false }]);
    await db.insert(taxProfiles).values({ id: ids.tax, propertyId: ids.property, name: 'Test rules', jurisdictionCode: 'TEST', effectiveFrom: '2027-01-01', isActive: false });
  });
  beforeEach(async () => {
    await clearStays();
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax));
    await db.update(taxProfiles).set({ isActive: false }).where(eq(taxProfiles.id, ids.tax));
    await db.update(ratePlans).set({ isTaxInclusive: false, baseAmount: '100.00' }).where(eq(ratePlans.id, ids.rate));
    await db.update(rooms).set({ status: 'vacant_clean', isActive: true }).where(eq(rooms.id, ids.room));
    await db.update(rooms).set({ status: 'vacant_clean', isActive: false }).where(eq(rooms.id, ids.target));
    vi.clearAllMocks();
    webhooks.dispatchPersisted.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await clearStays();
    await db.delete(taxRules).where(eq(taxRules.taxProfileId, ids.tax));
    await db.delete(taxProfiles).where(eq(taxProfiles.id, ids.tax));
    await db.delete(rooms).where(inArray(rooms.id, [ids.room, ids.target]));
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
});
