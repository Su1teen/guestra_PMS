import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import { properties, guests, rooms, roomTypes, ratePlans, bookings, reservations,
  charges, payments, folios, depositLedgerEntries, auditRuns, roomInventoryBlocks,
  arLedgers, arTransactions } from '@telivityhaip/database';
import { ReportsService } from './reports.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')('Shared financial contracts on PostgreSQL', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 8 });
  const db = drizzle(client);
  const service = new ReportsService(db);
  const a = randomUUID(), b = randomUUID(), guest = randomUUID();
  const type = randomUUID(), rate = randomUUID(), room = randomUUID(), spare = randomUUID();
  const folio = randomUUID(), foreignFolio = randomUUID();
  const date = '2027-05-01';
  const currencies = { [a]: 'KZT', [b]: 'USD' };

  async function clear() {
    for (const table of [depositLedgerEntries, payments, charges, arTransactions, arLedgers,
      folios, roomInventoryBlocks, auditRuns, reservations, bookings]) {
      await db.delete(table).where(inArray(table.propertyId, [a, b]));
    }
  }

  beforeAll(async () => {
    await db.insert(properties).values([
      { id: a, name: 'Financial A', code: a.slice(0, 16), countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: 999 },
      { id: b, name: 'Financial B', code: b.slice(0, 16), countryCode: 'US', timezone: 'America/Los_Angeles', currencyCode: 'USD', totalRooms: 0 },
    ]);
    await db.insert(guests).values({ id: guest, firstName: 'Test', lastName: 'Finance' });
    await db.insert(roomTypes).values({ id: type, propertyId: a, name: 'Standard', code: 'STD', maxOccupancy: 2, defaultOccupancy: 1 });
    await db.insert(ratePlans).values({ id: rate, propertyId: a, roomTypeId: type, name: 'Accepted', code: 'BAR', type: 'bar', baseAmount: '100', currencyCode: 'KZT' });
    await db.insert(rooms).values([
      { id: room, propertyId: a, roomTypeId: type, number: '101' },
      { id: spare, propertyId: a, roomTypeId: type, number: '102' },
    ]);
  });
  beforeEach(async () => {
    await clear();
    await db.update(properties).set({ timezone: 'Asia/Almaty' }).where(eq(properties.id, a));
    await db.update(rooms).set({ status: 'vacant_clean' }).where(eq(rooms.propertyId, a));
    await db.insert(folios).values([
      { id: folio, propertyId: a, guestId: guest, folioNumber: 'A', currencyCode: 'KZT', balance: '150' },
      { id: foreignFolio, propertyId: b, guestId: guest, folioNumber: 'B', currencyCode: 'USD', balance: '900' },
    ]);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await clear();
    await db.delete(rooms).where(eq(rooms.propertyId, a));
    await db.delete(ratePlans).where(eq(ratePlans.propertyId, a));
    await db.delete(roomTypes).where(eq(roomTypes.propertyId, a));
    await db.delete(guests).where(eq(guests.id, guest));
    await db.delete(properties).where(inArray(properties.id, [a, b]));
    await client.end();
  });

  async function post(amount: string, extra: Partial<typeof charges.$inferInsert> = {}) {
    const [row] = await db.insert(charges).values({ propertyId: a, folioId: folio,
      type: 'room', description: 'Signed fixture', amount, currencyCode: 'KZT',
      serviceDate: new Date(`${date}T00:00:00Z`), ...extra }).returning();
    return row!;
  }
  async function pay(amount: string, extra: Partial<typeof payments.$inferInsert> = {}) {
    const [row] = await db.insert(payments).values({ propertyId: a, folioId: folio,
      method: 'cash', status: 'captured', amount, currencyCode: 'KZT',
      processedAt: new Date(`${date}T12:00:00Z`), ...extra }).returning();
    return row!;
  }
  async function stay(extra: Partial<typeof reservations.$inferInsert> = {}) {
    const [booking] = await db.insert(bookings).values({ propertyId: a, guestId: guest,
      source: 'direct', confirmationNumber: randomUUID() }).returning();
    const [row] = await db.insert(reservations).values({ propertyId: a, bookingId: booking!.id,
      guestId: guest, roomTypeId: type, ratePlanId: rate, roomId: room,
      arrivalDate: date, departureDate: '2027-05-03', nights: 2, status: 'checked_in',
      totalAmount: '9999', currencyCode: 'KZT', createdAt: new Date('2027-04-20T12:00:00Z'), ...extra }).returning();
    return row!;
  }

  it('reconciles signed amendments, reversals, service-only and tax across every reporting consumer', async () => {
    await stay();
    const original = await post('100');
    await post('-20', { adjustsChargeId: original.id });
    await post('-10', { isReversal: true, originalChargeId: original.id });
    await post('10', { type: 'tax', parentChargeId: original.id });
    await post('-1', { type: 'tax', isReversal: true });
    await post('30', { type: 'food_beverage', folioId: null });
    await post('-5', { type: 'food_beverage', folioId: null, isReversal: true });
    await post('20', { type: 'spa', folioId: null });
    const daily = await service.getDailyRevenue(a, date);
    const financial = await service.getFinancialSummary(a, date);
    const management = await service.getManagementSummary(a, date);
    const trend = await service.getOccupancyTrend(a, date, date);
    expect(daily.netRevenueByCategory).toEqual({ room: 70, tax: 9, foodBeverage: 25, other: 20, total: 124, earned: 115 });
    expect(daily.revenue.total - daily.adjustments).toBe(daily.netRevenue);
    expect(financial.kpis).toMatchObject({ totalRevenue: 115, roomRevenue: 70, foodBeverageRevenue: 25,
      ancillaryRevenue: 20, separatelyPostedTax: 9, adr: 70, revpar: 35, trevpar: 57.5, occ: 0.5 });
    expect(management.today.revenue).toBe(115);
    expect(management.drr).toMatchObject({ revenue: 115, mtdRevenue: 115, forecastRevenue: null });
    expect(management.periods.ytd?.value).toBe(115);
    expect(trend.daily[0]).toMatchObject({ roomRevenue: 70, totalRevenue: 115, separatelyPostedTax: 9 });
    expect(trend.actual.value).toBe(daily.actual.value);
  });

  it('separates refunds and non-cash A/R transfers without reversing earned revenue', async () => {
    await post('100');
    await post('10', { type: 'tax' });
    const parent = await pay('100', { status: 'partially_refunded', method: 'credit_card' });
    await pay('-25', { originalPaymentId: parent.id, method: 'credit_card' });
    await pay('50', { status: 'failed' });
    await pay('20', { status: 'authorized' });
    await pay('30', { method: 'city_ledger' });
    const r = await service.getDailyRevenue(a, date);
    expect(r.cash).toMatchObject({ ledgerNet: 105, received: 100, refunds: 25, net: 75, arTransfers: 30 });
    expect(r.netEarnedRevenue).toBe(100);
    expect(r.separatelyPostedTax).toBe(10);
  });

  it('does not count held/applied/refunded/forfeited deposit rows a second time as revenue', async () => {
    const payment = await pay('100');
    await db.insert(depositLedgerEntries).values([
      { propertyId: a, amount: '100', currencyCode: 'KZT', paymentId: payment.id, status: 'held' },
      { propertyId: a, amount: '30', currencyCode: 'KZT', status: 'applied' },
      { propertyId: a, amount: '20', currencyCode: 'KZT', status: 'refunded' },
      { propertyId: a, amount: '10', currencyCode: 'KZT', status: 'forfeited' },
    ]);
    const r = await service.getFinancialSummary(a, date);
    expect(r.deposits).toMatchObject({ held: 100, byStatus: { held: 100, applied: 30, refunded: 20, forfeited: 10 } });
    expect(r.actual).toMatchObject({ value: null, status: 'NO_POSTINGS' });
    expect(r.cash.received).toBe(100);
  });

  it('keeps guest credit balances and A/R distinct from positive open folio balances', async () => {
    await db.insert(folios).values({ propertyId: a, guestId: guest, folioNumber: 'Credit', currencyCode: 'KZT', balance: '-80' });
    await db.insert(arLedgers).values({ propertyId: a, name: 'Corporate', currencyCode: 'KZT', balance: '250' });
    const r = await service.getFinancialSummary(a, date);
    expect(r.outstandingBalances).toMatchObject({ totalBalanceDue: 150, creditBalances: -80, accountsReceivableDue: 250, asOf: 'CURRENT_SNAPSHOT' });
    expect(r.kpis.totalRevenue).toBe(0);
  });

  it('isolates all property ledgers and buckets portfolios by currency without FX assumptions', async () => {
    await post('10');
    await post('500', { propertyId: b, folioId: foreignFolio, currencyCode: 'USD' });
    await pay('700', { propertyId: b, folioId: foreignFolio, currencyCode: 'USD' });
    await db.insert(depositLedgerEntries).values({ propertyId: b, amount: '400', currencyCode: 'USD' });
    const single = await service.getFinancialSummary(a, date);
    expect(single.kpis.totalRevenue).toBe(10);
    expect(single.cash.net).toBe(0);
    expect(single.deposits.held).toBe(0);
    expect(single.outstandingBalances.totalBalanceDue).toBe(150);
    const portfolio = await service.getPortfolioFinancialSummary([a, b, a], date);
    expect(portfolio.propertyCount).toBe(2);
    expect(portfolio.currencyStatus).toBe('MIXED_CURRENCIES');
    expect(portfolio.kpis).toMatchObject({ totalRevenue: null, roomRevenue: null, adr: null, revpar: null, trevpar: null });
    expect(portfolio.byCurrency).toEqual(expect.arrayContaining([
      expect.objectContaining({ currencyCode: 'KZT', totalRevenue: 10 }),
      expect.objectContaining({ currencyCode: 'USD', totalRevenue: 500 }),
    ]));
  });

  it.each(['charges', 'cash', 'folios', 'deposits'] as const)('rejects foreign currency in a single-property %s source', async source => {
    if (source === 'charges') await post('1', { currencyCode: 'USD' });
    if (source === 'cash') await pay('1', { currencyCode: 'USD' });
    if (source === 'folios') await db.update(folios).set({ currencyCode: 'USD' }).where(eq(folios.id, folio));
    if (source === 'deposits') await db.insert(depositLedgerEntries).values({ propertyId: a, amount: '1', currencyCode: 'USD' });
    await expect(service.getFinancialSummary(a, date)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('CURRENCY_MISMATCH') });
  });

  it('uses property-local payment/check-in/booking timestamps but preserves explicit night-audit service dates', async () => {
    await db.update(properties).set({ timezone: 'America/Los_Angeles' }).where(eq(properties.id, a));
    const timestamp = new Date('2027-05-02T04:00:00Z'); // May 1 locally
    await post('100');
    await pay('100', { processedAt: timestamp });
    await stay({ checkedInAt: timestamp, createdAt: timestamp });
    const financial = await service.getFinancialSummary(a, date);
    expect(financial.kpis.roomRevenue).toBe(100);
    expect(financial.cash.net).toBe(100);
    expect((await service.getDailyRevenue(a, '2027-05-02')).cash.net).toBe(0);
    expect((await service.getOccupancy(a, date)).arrivals).toBe(1);
    expect((await service.getBookingPace(a, date, date)).daily[0]!.newBookings).toBe(1);
    expect((await service.getPickup(a, date, date, date)).pickup.roomNights).toBe(1);
    expect((await service.getDailyRevenue(a, '2027-04-30')).netEarnedRevenue).toBe(0);
  });

  it('uses the next completed night-audit business date and marks a closed empty day as confirmed zero', async () => {
    await db.insert(auditRuns).values({ propertyId: a, businessDate: date, status: 'completed' });
    expect((await service.getOccupancy(a)).date).toBe('2027-05-02');
    const r = await service.getDailyRevenue(a, date);
    expect(r.actual).toMatchObject({ value: 0, status: 'COMPLETE', expectedDays: 1, closedDays: 1 });
  });

  it('keeps quotes and synthetic-demand absence out of actuals/forecast and missing LY history out of zero comparisons', async () => {
    await stay({ status: 'confirmed', arrivalDate: '2027-05-03', departureDate: '2027-05-05', totalAmount: '9999' });
    const r = await service.getManagementSummary(a, date);
    expect(r.financial.actual.value).toBeNull();
    expect(r.onBooksQuotedAmount).toMatchObject({ value: 9999, isEarnedRevenue: false });
    expect(r.forecast).toMatchObject({ value: null, status: 'INSUFFICIENT_HISTORY' });
    expect(r.planToDate).toMatchObject({ value: null, status: 'UNAVAILABLE' });
    expect(r.gop).toMatchObject({ value: null, status: 'UNAVAILABLE' });
    expect(r.periods.lytd?.value).toBeNull();
    expect(r.drr.comparisons.previousDay.revenue).toMatchObject({ value: null, absolute: null, percent: null, status: 'NO_POSTINGS' });
    expect(r.drr.forecastRevenue).toBeNull();
  });

  it('uses real MTD/YTD/LY/LYTD calendar cutoffs and signed prior-year postings', async () => {
    await post('40', { serviceDate: new Date('2027-01-01T00:00:00Z') });
    await post('100');
    await post('50', { serviceDate: new Date('2026-05-01T00:00:00Z') });
    await post('-10', { serviceDate: new Date('2026-05-01T00:00:00Z'), isReversal: true });
    await post('20', { serviceDate: new Date('2026-01-01T00:00:00Z') });
    const r = await service.getRevenuePeriods(a, date);
    expect(r.periods.mtd?.value).toBe(100);
    expect(r.periods.ytd?.value).toBe(140);
    expect(r.periods.ly?.value).toBe(40);
    expect(r.periods.lytd?.value).toBe(60);
    expect(r.periods.ytd?.status).toBe('PARTIAL');
  });

  it('does not report a false revenue decline when the current day has no postings', async () => {
    await post('100');
    const r = await service.getManagementSummary(a, '2027-05-02');
    expect(r.financial.actual.value).toBeNull();
    expect(r.drr.comparisons.previousDay.revenue).toMatchObject({ value: 100, absolute: null, percent: null, status: 'CURRENT_NO_POSTINGS' });
  });

  it('uses local deposit dates and explicit completeness for the existing trial balance', async () => {
    await db.update(properties).set({ timezone: 'America/Los_Angeles' }).where(eq(properties.id, a));
    await db.insert(depositLedgerEntries).values({ propertyId: a, amount: '100', currencyCode: 'KZT', receivedAt: new Date('2027-05-02T04:00:00Z') });
    const r = await service.dailyTrialBalance(a, date);
    expect(r.ledgers.deposit).toMatchObject({ opening: '0.00', netActivity: '100.00', closing: '100.00' });
    expect(r.completeness.guest).toBe('CURRENT_SNAPSHOT_ONLY');
    const next = await service.dailyTrialBalance(a, '2027-05-02');
    expect(next.ledgers.deposit).toMatchObject({ opening: '100.00', netActivity: '0.00', closing: '100.00' });
  });

  it('accounts for planned, overdue-active and explicitly released OOO/OOS blocks by night', async () => {
    const [block] = await db.insert(roomInventoryBlocks).values({ propertyId: a, roomId: spare,
      startDate: '2027-05-02', endDate: '2027-05-03', kind: 'OOS', reason: 'Planned' }).returning();
    expect((await service.getOccupancy(a, date)).availableRooms).toBe(2);
    expect((await service.getOccupancy(a, '2027-05-04'))).toMatchObject({ availableRooms: 1, outOfService: 1 });
    await db.update(roomInventoryBlocks).set({ status: 'released', releasedAt: new Date('2027-05-03T20:00:00Z') }).where(eq(roomInventoryBlocks.id, block!.id));
    const trend = await service.getOccupancyTrend(a, date, '2027-05-04');
    expect(trend.daily.map(day => day.availableRooms)).toEqual([2, 1, 1, 2]);
    await db.update(rooms).set({ status: 'out_of_order' }).where(eq(rooms.id, spare));
    expect((await service.getOccupancy(a, '2027-05-04'))).toMatchObject({ availableRooms: 1, outOfOrder: 1, outOfService: 0 });
  });

  it('counts historical checked-out nights, excluding departures, cancelled and merely quoted stays', async () => {
    await stay({ status: 'checked_out' });
    await stay({ status: 'confirmed' });
    await stay({ status: 'cancelled', cancelledAt: new Date(`${date}T12:00:00Z`) });
    expect((await service.getOccupancy(a, date)).occupiedRooms).toBe(1);
    expect((await service.getOccupancy(a, '2027-05-03')).occupiedRooms).toBe(0);
    expect((await service.getOccupancyTrend(a, date, '2027-05-03')).daily.map(day => day.roomsSold)).toEqual([1, 1, 0]);
  });

  it('defines booking window and ALOS from non-cancelled arrival samples', async () => {
    await stay();
    await stay({ status: 'cancelled', nights: 10, departureDate: '2027-05-11' });
    const r = await service.getRevenuePeriods(a, date);
    expect(r.bookingWindow).toMatchObject({ value: 11, sampleSize: 1, unit: 'days' });
    expect(r.averageLengthOfStay).toMatchObject({ value: 2, sampleSize: 1, unit: 'nights' });
  });

  it('keeps concurrent committed postings outside an already-open read snapshot', async () => {
    await post('100');
    const prototype = ReportsService.prototype as any;
    const cash = prototype.cash;
    const intercept = vi.spyOn(prototype, 'cash').mockImplementationOnce(async function (this: ReportsService, ...args: any[]) {
      await post('1');
      return cash.apply(this, args);
    });
    try {
      expect((await service.getDailyRevenue(a, date)).netEarnedRevenue).toBe(100);
    } finally { intercept.mockRestore(); }
    expect((await service.getDailyRevenue(a, date)).netEarnedRevenue).toBe(101);
  });
});
