import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import { properties, guests, roomTypes, ratePlans, rooms, bookings, reservations, folios, charges, payments,
  depositLedgerEntries, auditLogs, domainEventOutbox } from '@telivityhaip/database';
import { ReportsService } from './reports.service';
import { FolioService } from '../folio/folio.service';
import { DepositService } from '../accounting/deposit.service';
import { DepositSettlementService } from '../accounting/deposit-settlement.service';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')('Real-service deposit and accepted-charge provenance', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 8 }), db = drizzle(client);
  const ids = { a: randomUUID(), b: randomUUID(), guest: randomUUID(), type: randomUUID(), rate: randomUUID(), room: randomUUID(), booking: randomUUID(), reservation: randomUUID(), folio: randomUUID(), foreign: randomUUID() };
  const actor = { userId: randomUUID(), userEmail: 'tester@example.test' };
  const date = '2027-05-01', now = new Date(date + 'T12:00:00Z');
  const webhooks = { emit: vi.fn(), dispatchPersisted: vi.fn() };
  const folioService = new FolioService(db, webhooks as any, { calculateTaxes: async () => [] } as any);
  const outbox = new DomainEventOutboxService(db, webhooks as any);
  const deposits = new DepositService(db, outbox, folioService);
  const settlement = new DepositSettlementService(db, deposits, folioService, outbox);
  const reports = new ReportsService(db);
  const scoped = (table: any) => db.select().from(table).where(eq(table.propertyId, ids.a));
  const earned = async () => (await reports.getDailyRevenue(ids.a, date)).actual.value;
  const deposit = async (amount = '20.00', isRefundable = false) => deposits.recordDeposit({ propertyId: ids.a, reservationId: ids.reservation, amount, currencyCode: 'KZT', isRefundable }, actor);
  const evaluation = { withinFreeWindow: false, penaltyAmount: '20.00', depositAction: 'forfeit' as const, policyDescription: 'Existing policy', policyId: 'policy', policyCode: 'TEST', penaltyType: 'first_night' };
  async function clear() {
    for (const table of [depositLedgerEntries, payments, charges, auditLogs, domainEventOutbox, folios, reservations, bookings]) await db.delete(table).where(inArray(table.propertyId, [ids.a, ids.b]));
  }
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
    await db.insert(properties).values([{ id: ids.a, name: 'Deposit A', code: ids.a.slice(0, 16), countryCode: 'KZ', currencyCode: 'KZT', timezone: 'Asia/Almaty', totalRooms: 1 }, { id: ids.b, name: 'Deposit B', code: ids.b.slice(0, 16), countryCode: 'US', currencyCode: 'USD', timezone: 'UTC', totalRooms: 0 }]);
    await db.insert(guests).values({ id: ids.guest, firstName: 'Deposit', lastName: 'Test' });
    await db.insert(roomTypes).values({ id: ids.type, propertyId: ids.a, name: 'Standard', code: 'STD', maxOccupancy: 2, defaultOccupancy: 1 });
    await db.insert(ratePlans).values({ id: ids.rate, propertyId: ids.a, roomTypeId: ids.type, name: 'BAR', code: 'BAR', type: 'bar', baseAmount: '100', currencyCode: 'KZT' });
    await db.insert(rooms).values({ id: ids.room, propertyId: ids.a, roomTypeId: ids.type, number: '101' });
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); await clear();
    await db.insert(bookings).values({ id: ids.booking, propertyId: ids.a, guestId: ids.guest, source: 'direct', confirmationNumber: randomUUID() });
    await db.insert(reservations).values({ id: ids.reservation, propertyId: ids.a, bookingId: ids.booking, guestId: ids.guest, roomTypeId: ids.type, ratePlanId: ids.rate, roomId: ids.room,
      arrivalDate: date, departureDate: '2027-05-02', nights: 1, status: 'checked_in', totalAmount: '80', currencyCode: 'KZT' });
    await db.insert(folios).values([{ id: ids.folio, propertyId: ids.a, reservationId: ids.reservation, guestId: ids.guest, type: 'guest', folioNumber: 'A', currencyCode: 'KZT' }, { id: ids.foreign, propertyId: ids.b, guestId: ids.guest, folioNumber: 'B', currencyCode: 'USD' }]);
  });
  afterAll(async () => {
    await clear(); await db.delete(rooms).where(eq(rooms.propertyId, ids.a)); await db.delete(ratePlans).where(eq(ratePlans.propertyId, ids.a)); await db.delete(roomTypes).where(eq(roomTypes.propertyId, ids.a));
    await db.delete(guests).where(eq(guests.id, ids.guest)); await db.delete(properties).where(inArray(properties.id, [ids.a, ids.b])); await client.end(); vi.useRealTimers();
  });
  const roomCharge = (adjustment?: { amount: string; reason: string }) => folioService.postChargeFromSnapshot(ids.folio, { propertyId: ids.a, type: 'room', description: 'Accepted room night', amount: '100.00', currencyCode: 'KZT', serviceDate: now.toISOString() }, '0', adjustment, `accepted-pricing:reservation:${ids.reservation}:night:${date}`);
  it('applies a real 40 deposit as a liability credit without reducing earned room100', async () => {
    await roomCharge(); const entry = await deposit('40');
    await Promise.all([deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor), deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor)]);
    expect(await earned()).toBe(100);
    expect((await folioService.findById(ids.folio, ids.a)).balance).toBe('60.00');
    const audit = (await scoped(auditLogs)).find(row => row.entityId === entry.id && (row.newValue as any)?.status === 'applied');
    expect(audit).toMatchObject({ userId: actor.userId, userEmail: actor.userEmail });
    expect((await scoped(domainEventOutbox)).filter(row => (row.payload as any).event === 'deposit.applied')).toHaveLength(1);
    await deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor);
    expect((await scoped(charges)).filter(row => row.revenueRole === 'deposit_credit')).toHaveLength(1);
    const trend = await reports.getOccupancyTrend(ids.a, date, date);
    expect(trend.daily[0]).toMatchObject({ roomRevenue: 100, totalRevenue: 100, ancillaryRevenue: 0 });
  });
  it('recognizes a real forfeited20 exactly once, even across concurrent identical retries', async () => {
    const entry = await deposit();
    await Promise.all([deposits.forfeitDeposit(entry.id, ids.a, actor), deposits.forfeitDeposit(entry.id, ids.a, actor)]);
    expect(await earned()).toBe(20);
    expect((await scoped(charges)).filter(row => row.amount === '20.00')).toHaveLength(1);
  });
  it('uses cancellation fee provenance to avoid double recognition and repeated penalty posting', async () => {
    const entry = await deposit();
    const params = { reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation };
    await settlement.settleFromEvaluation(params);
    await settlement.settleFromEvaluation(params);
    expect(await earned()).toBe(20);
    expect((await scoped(charges)).filter(row => row.type === 'fee' && row.amount === '20.00')).toHaveLength(1);
    expect((await deposits.findById(entry.id, ids.a)).status).toBe('forfeited');
  });
  it('does not recognize a refund as earned revenue', async () => {
    await roomCharge(); const entry = await deposit('20', true);
    await Promise.all([deposits.refundDeposit(entry.id, ids.a, actor), deposits.refundDeposit(entry.id, ids.a, actor)]);
    expect(await earned()).toBe(100); expect(await scoped(charges)).toHaveLength(1);
    expect((await scoped(domainEventOutbox)).filter(row => (row.payload as any).event === 'deposit.refunded')).toHaveLength(1);
  });
  it('allocates accepted child room discount and its signed reversal to room KPIs', async () => {
    const posted = await roomCharge({ amount: '-20', reason: 'Custom accepted discount' });
    const financial = await reports.getFinancialSummary(ids.a, date);
    expect(financial.kpis).toMatchObject({ roomRevenue: 80, totalRevenue: 80, ancillaryRevenue: 0, adr: 80, revpar: 80 });
    expect((await reports.getOccupancyTrend(ids.a, date, date)).daily[0]).toMatchObject({ roomRevenue: 80, totalRevenue: 80, ancillaryRevenue: 0, adr: 80, revpar: 80 });
    await folioService.reverseCharge(ids.folio, posted.id, ids.a);
    expect(await earned()).toBe(0);
  });
  it('rejects foreign-property folios and rolls back state/postings/audit when durable outbox persistence fails', async () => {
    const entry = await deposit('40'); await roomCharge();
    await expect(deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.foreign }, actor)).rejects.toThrow();
    const before = { charges: (await scoped(charges)).length, audits: (await scoped(auditLogs)).length, events: (await scoped(domainEventOutbox)).length };
    vi.spyOn(outbox, 'persist').mockRejectedValueOnce(new Error('outbox fail'));
    await expect(deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor)).rejects.toThrow('outbox fail');
    expect((await deposits.findById(entry.id, ids.a)).status).toBe('held'); expect((await scoped(charges)).length).toBe(before.charges);
    expect((await scoped(auditLogs)).length).toBe(before.audits); expect((await scoped(domainEventOutbox)).length).toBe(before.events);
  });
  it('serializes independent deposits and no-show settlement retries, offsetting policy fees only once', async () => {
    const first = await deposit('15'), second = await deposit('15');
    const params = { reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation, actor,
      penaltyDescription: 'No-show penalty', additionalFeeAmount: '5', additionalFeeDescription: 'No-show fee' };
    await Promise.all([settlement.settleFromEvaluation(params), settlement.settleFromEvaluation(params)]);
    expect(await earned()).toBe(30);
    const rows = await scoped(charges);
    expect(rows.filter(row => row.sourceKey?.startsWith('settlement:'))).toHaveLength(2);
    expect(rows.filter(row => row.revenueRole === 'deposit_credit').reduce((sum, row) => sum + Number(row.amount), 0)).toBe(-25);
    expect((await deposits.findById(first.id, ids.a)).status).toBe('forfeited');
    expect((await deposits.findById(second.id, ids.a)).status).toBe('forfeited');
  });
  it('does not offset a reversed policy fee or mix conflicting terminal transitions', async () => {
    await settlement.settleFromEvaluation({ reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation });
    const fee = (await scoped(charges)).find(row => row.type === 'fee')!;
    await folioService.reverseCharge(ids.folio, fee.id, ids.a);
    const entry = await deposit('20', true);
    await deposits.forfeitDeposit(entry.id, ids.a, actor);
    expect(await earned()).toBe(20);
    await expect(deposits.refundDeposit(entry.id, ids.a, actor)).rejects.toThrow();
    expect((await scoped(charges)).filter(row => row.revenueRole === 'deposit_credit')).toHaveLength(0);
  });
  it('keeps manual child correction reversals in the room category via scoped original provenance', async () => {
    const base = await folioService.postCharge(ids.folio, { propertyId: ids.a, type: 'room', description: 'Manual room', amount: '100', currencyCode: 'KZT', serviceDate: now.toISOString(), skipTaxCalculation: true });
    const [child] = await db.insert(charges).values({ propertyId: ids.a, folioId: ids.folio, parentChargeId: base.id, type: 'adjustment', description: 'Room correction', amount: '-20', currencyCode: 'KZT', serviceDate: now }).returning();
    expect((await reports.getFinancialSummary(ids.a, date)).kpis.roomRevenue).toBe(80);
    await folioService.reverseCharge(ids.folio, child!.id, ids.a);
    expect((await reports.getFinancialSummary(ids.a, date)).kpis).toMatchObject({ roomRevenue: 100, ancillaryRevenue: 0, totalRevenue: 100 });
  });
  it('does not inherit a room category from a foreign-property parent', async () => {
    const [foreign] = await db.insert(charges).values({ propertyId: ids.b, folioId: ids.foreign, type: 'room', description: 'Foreign room', amount: '100', currencyCode: 'USD', serviceDate: now }).returning();
    await db.insert(charges).values({ propertyId: ids.a, folioId: ids.folio, parentChargeId: foreign!.id, type: 'adjustment', description: 'Foreign parent correction', amount: '-20', currencyCode: 'KZT', serviceDate: now });
    expect((await reports.getFinancialSummary(ids.a, date)).kpis).toMatchObject({ roomRevenue: 0, ancillaryRevenue: -20, totalRevenue: -20 });
  });
  it('rolls back policy fees and forfeiture together if any durable financial event fails', async () => {
    const entry = await deposit();
    const before = { audits: (await scoped(auditLogs)).length, events: (await scoped(domainEventOutbox)).length };
    const persist = outbox.persist.bind(outbox);
    vi.spyOn(outbox, 'persist').mockImplementation(async (tx, event, key) => {
      if (event.event === 'deposit.forfeited') throw new Error('forfeiture event failure');
      return persist(tx, event, key);
    });
    await expect(settlement.settleFromEvaluation({ reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation, actor })).rejects.toThrow('forfeiture event failure');
    expect(await scoped(charges)).toHaveLength(0);
    expect((await deposits.findById(entry.id, ids.a)).status).toBe('held');
    expect((await scoped(auditLogs)).length).toBe(before.audits); expect((await scoped(domainEventOutbox)).length).toBe(before.events);
  });
  it('makes newly created settlement folios and tax children part of the audited durable transaction', async () => {
    await deposit(); await db.delete(folios).where(and(eq(folios.id, ids.folio), eq(folios.propertyId, ids.a)));
    const taxableFolio = new FolioService(db, webhooks as any, { calculateTaxes: async () => [{ name: 'VAT', amount: '2.00', rate: '0.1', code: 'VAT' }] } as any);
    await new DepositSettlementService(db, deposits, taxableFolio, outbox).settleFromEvaluation({ reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation, actor });
    expect(await earned()).toBe(20);
    const tax = (await scoped(charges)).find(row => row.type === 'tax')!;
    expect((await scoped(auditLogs)).find(row => row.entityId === tax.id && row.userId === actor.userId)).toBeDefined();
    const events = await scoped(domainEventOutbox);
    expect(events.filter(row => (row.payload as any).event === 'folio.created')).toHaveLength(1);
    expect(events.filter(row => (row.payload as any).event === 'folio.charge_posted')).toHaveLength(3);
  });
  it('excludes signed deposit credit reversals from earned actual and rejects received-event failure atomically', async () => {
    await roomCharge(); const entry = await deposit('40');
    await deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor);
    const credit = (await scoped(charges)).find(row => row.revenueRole === 'deposit_credit')!;
    await folioService.reverseCharge(ids.folio, credit.id, ids.a);
    expect(await earned()).toBe(100); expect((await folioService.findById(ids.folio, ids.a)).balance).toBe('100.00');
    const before = { deposits: (await scoped(depositLedgerEntries)).length, audits: (await scoped(auditLogs)).length, events: (await scoped(domainEventOutbox)).length };
    vi.spyOn(outbox, 'persist').mockRejectedValueOnce(new Error('received event failure'));
    await expect(deposit()).rejects.toThrow('received event failure');
    expect((await scoped(depositLedgerEntries)).length).toBe(before.deposits);
    expect((await scoped(auditLogs)).length).toBe(before.audits); expect((await scoped(domainEventOutbox)).length).toBe(before.events);
  });
  it('rejects closed penalty folios without duplicate income and serializes apply against settlement', async () => {
    await roomCharge();
    await settlement.settleFromEvaluation({ reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation });
    const entry = await deposit();
    await db.update(folios).set({ status: 'closed' }).where(and(eq(folios.id, ids.folio), eq(folios.propertyId, ids.a)));
    await expect(deposits.forfeitDeposit(entry.id, ids.a, actor)).rejects.toThrow('Open guest folio');
    expect((await deposits.findById(entry.id, ids.a)).status).toBe('held'); expect(await earned()).toBe(120);
    await db.update(folios).set({ status: 'open' }).where(and(eq(folios.id, ids.folio), eq(folios.propertyId, ids.a)));
    await Promise.allSettled([deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor),
      settlement.settleFromEvaluation({ reservationId: ids.reservation, propertyId: ids.a, currencyCode: 'KZT', evaluation, actor })]);
    expect((await deposits.findById(entry.id, ids.a)).status).toMatch(/^(applied|forfeited)$/);
    expect((await scoped(charges)).filter(row => row.revenueRole === 'deposit_credit')).toHaveLength(1);
    expect(await earned()).toBe(120);
  });
  it('serializes independent unlinked deposits on a shared folio before computing its balance', async () => {
    await roomCharge();
    const entries = await Promise.all(['40', '30'].map(amount => deposits.recordDeposit({ propertyId: ids.a, amount, currencyCode: 'KZT' }, actor)));
    await Promise.all(entries.map(entry => deposits.applyDeposit(entry.id, { propertyId: ids.a, folioId: ids.folio }, actor)));
    expect(await earned()).toBe(100);
    expect((await folioService.findById(ids.folio, ids.a)).balance).toBe('30.00');
    expect((await scoped(charges)).filter(row => row.revenueRole === 'deposit_credit')).toHaveLength(2);
  });
});
