import { describe, it, expect, vi } from 'vitest';
import { charges, payments, properties, rooms, reservations, roomInventoryBlocks, auditRuns, folios, depositLedgerEntries } from '@telivityhaip/database';
import { ReportsService } from './reports.service';
import { priorYearDate, ratio, reportDate, reportDates } from './reporting-policy';

const DATE = '2027-05-01';
const PROP = 'a0000001-0000-4000-a000-000000000001';
const roomFixtures = (count: number) => Array.from({ length: count }, (_, i) => ({ id: String(i), status: 'guest_ready' }));
const charge = (type: string, total: string, isReversal = false) => ({ type, total, isReversal, currencyCode: 'KZT', count: 1 });

/** Table-aware query double; PostgreSQL tests cover predicates and real financial invariants. */
function fixture(options: Record<string, any> = {}) {
  const data = new Map<any, any[]>([
    [properties, [{ id: PROP, currencyCode: 'KZT', timezone: 'Asia/Almaty', totalRooms: 999 }]],
    [charges, options.charges ?? []], [payments, options.payments ?? []],
    [rooms, options.rooms ?? roomFixtures(50)], [roomInventoryBlocks, options.blocks ?? []],
    [folios, options.balances ?? []], [depositLedgerEntries, options.deposits ?? []],
  ]);
  const db: any = {
    transaction: vi.fn(async (read: any) => read(db)),
    select: vi.fn((projection: any) => ({
      from: (table: any) => {
        let result: any[];
        if (table === auditRuns) result = projection?.count ? [{ count: options.closedDays ?? 0 }] : options.audits ?? [];
        else if (table === reservations) result = projection?.date ? [] : projection?.count ? [{ count: options.sold ?? 0 }] : options.stays ?? [];
        else result = data.get(table) ?? options.pace ?? [];
        const chain: any = { then: (resolve: any) => Promise.resolve(result).then(resolve) };
        for (const method of ['where', 'groupBy', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) chain[method] = () => chain;
        return chain;
      },
    })),
  };
  return { service: new ReportsService(db), db };
}

describe('ReportsService shared foundation', () => {
  it('resolves omitted daily / financial / portfolio dates from the same completed audit boundary', async () => {
    const { service } = fixture({ audits: [{ businessDate: '2027-04-30' }] });
    expect(await service.getBusinessDate(PROP)).toMatchObject({ date: DATE, timezone: 'Asia/Almaty', currencyCode: 'KZT' });
    expect((await service.getDailyRevenue(PROP)).date).toBe(DATE);
    expect((await service.getFinancialSummary(PROP)).date).toBe(DATE);
    expect((await service.getPortfolioFinancialSummary([PROP])).byProperty[0]?.date).toBe(DATE);
  });
  it('resolves property-local midnight without using the browser timezone', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-04-30T20:30:00Z'));
    try { expect((await fixture().service.getBusinessDate(PROP)).date).toBe(DATE); } finally { vi.useRealTimers(); }
  });
  it('preserves nullable portfolio Actual and ratios, with confirmed zero and partial coverage distinct', async () => {
    const missing = await fixture().service.getPortfolioFinancialSummary([PROP], DATE);
    expect(missing.actual).toMatchObject({ value: null, status: 'NO_POSTINGS', missingProperties: 1 });
    expect(missing.kpis).toMatchObject({ totalRevenue: null, adr: null, revpar: null });
    const complete = await fixture({ closedDays: 1 }).service.getPortfolioFinancialSummary([PROP], DATE);
    expect(complete.actual).toMatchObject({ value: 0, status: 'COMPLETE', missingProperties: 0 });
    const { service } = fixture(); const original = await service.getFinancialSummary(PROP, DATE);
    (service as any).inSnapshot = true;
    vi.spyOn(service, 'getFinancialSummary').mockImplementation(async (id) => id === PROP ? { ...original, actual: { ...original.actual, value: 115, status: 'COMPLETE' as const }, kpis: { ...original.kpis, roomRevenue: 75 } } : original);
    const partial = await service.getPortfolioFinancialSummary([PROP, 'another'], DATE);
    expect(partial.actual).toMatchObject({ value: 115, status: 'PARTIAL', propertiesWithActual: 1, missingProperties: 1 });
  });
  it('sums signed charges by type without treating separately posted tax as earned revenue', async () => {
    const { service } = fixture({ charges: [charge('room', '3000'), charge('tax', '300'), charge('food_beverage', '500'), charge('room', '-50', true)] });
    const r = await service.getDailyRevenue(PROP, DATE);
    expect(r.revenue.total).toBe(3800);
    expect(r.adjustments).toBe(50);
    expect(r.netRevenue).toBe(3750);
    expect(r.netEarnedRevenue).toBe(3450);
    expect(r.netRevenueByCategory.room).toBe(2950);
  });

  it('nets a fully reversed signed accepted-pricing group to zero revenue', async () => {
    const { service } = fixture({ charges: [charge('room', '80'), charge('room', '-80', true)] });
    const r = await service.getDailyRevenue(PROP, DATE);
    expect(r.revenue.room).toBe(80);
    expect(r.adjustments).toBe(80);
    expect(r.netEarnedRevenue).toBe(0);
  });

  it('sums payment methods while separating refunds and non-cash A/R transfers', async () => {
    const { service } = fixture({ payments: [
      { method: 'credit_card', total: '750', received: '1000', refunded: '250', currencyCode: 'KZT' },
      { method: 'cash', total: '200', received: '200', refunded: '0', currencyCode: 'KZT' },
      { method: 'city_ledger', total: '500', received: '500', refunded: '0', currencyCode: 'KZT' },
    ] });
    const r = await service.getDailyRevenue(PROP, DATE);
    expect(r.payments.total).toBe(1450);
    expect(r.cash).toMatchObject({ received: 1200, refunds: 250, net: 950, arTransfers: 500 });
    expect(r.netEarnedRevenue).toBe(0);
  });

  it('uses physical inventory rather than configured property totals for occupancy', async () => {
    const { service } = fixture({ sold: 20, rooms: roomFixtures(40) });
    const r = await service.getOccupancy(PROP, DATE);
    expect(r.totalRooms).toBe(40);
    expect(r.occupiedRooms).toBe(20);
    expect(r.occupancyRate).toBe(0.5);
  });

  it('excludes OOO/OOS and avoids double subtraction of status and date block', async () => {
    const rows = roomFixtures(5);
    rows[0]!.status = 'out_of_order';
    rows[1]!.status = 'out_of_service';
    const { service } = fixture({ rooms: rows, sold: 1, blocks: [
      { roomId: '0', kind: 'OOO', startDate: DATE, status: 'active' },
      { roomId: '2', kind: 'OOS', startDate: DATE, status: 'active' },
    ] });
    const r = await service.getOccupancy(PROP, DATE);
    expect(r).toMatchObject({ totalRooms: 5, outOfOrder: 1, outOfService: 2, availableRooms: 2, occupancyRate: 0.5 });
  });

  it('ignores sticky occupied room statuses when no stay covers the report night', async () => {
    const { service } = fixture({ rooms: [{ id: '1', status: 'occupied' }] });
    expect((await service.getOccupancy(PROP, DATE)).occupiedRooms).toBe(0);
  });

  it('calculates ADR using signed room revenue, excluding taxes and services', async () => {
    const { service } = fixture({ sold: 20, charges: [charge('room', '3200'), charge('room', '-200', true), charge('tax', '500'), charge('spa', '100')] });
    const r = await service.getFinancialSummary(PROP, DATE);
    expect(r.kpis).toMatchObject({ adr: 150, totalRevenue: 3100, roomRevenue: 3000, separatelyPostedTax: 500 });
  });

  it('calculates RevPAR directly from room revenue / available inventory', async () => {
    const { service } = fixture({ sold: 30, charges: [charge('room', '6000'), charge('spa', '1000')] });
    const r = await service.getFinancialSummary(PROP, DATE);
    expect(r.kpis).toMatchObject({ adr: 200, revpar: 120, trevpar: 140, occupancyRate: 0.6 });
  });

  it('preserves zero legacy ratio aliases while exposing missing denominators', async () => {
    const { service } = fixture({ rooms: [] });
    const r = await service.getFinancialSummary(PROP, DATE);
    expect(r.kpis.adr).toBe(0);
    expect(r.kpis.revpar).toBe(0);
    expect(r.kpis.occ).toBeNull();
    expect(r.kpis.trevpar).toBeNull();
    expect(r.kpis.ratioStatus.adr).toBe('NO_ROOMS_SOLD');
  });

  it('keeps empty legacy revenue numbers but does not claim a confirmed zero actual', async () => {
    const { service } = fixture();
    const r = await service.getDailyRevenue(PROP, DATE);
    expect(r.netRevenue).toBe(0);
    expect(r.actual).toMatchObject({ value: null, status: 'NO_POSTINGS' });
  });

  it('returns signed daily room and total-earned trend breakdowns', async () => {
    const { service } = fixture({ charges: [
      { ...charge('room', '3000'), date: DATE }, { ...charge('spa', '100'), date: DATE },
    ], stays: [{ arrivalDate: DATE, departureDate: '2027-05-03' }] });
    const r = await service.getOccupancyTrend(PROP, DATE, '2027-05-02');
    expect(r.daily).toHaveLength(2);
    expect(r.daily[0]).toMatchObject({ revenue: 3000, totalRevenue: 3100, roomsSold: 1 });
    expect(r.summary).toMatchObject({ totalRevenue: 3000, netEarnedRevenue: 3100, totalRoomNights: 2 });
  });

  it('uses weighted period ratios, not the mean of daily ADRs', async () => {
    const { service } = fixture({ rooms: roomFixtures(10), charges: [
      { ...charge('room', '100'), date: DATE }, { ...charge('room', '900'), date: '2027-05-02' },
    ], stays: [{ arrivalDate: DATE, departureDate: '2027-05-03' },
      { arrivalDate: '2027-05-02', departureDate: '2027-05-03' }] });
    const r = await service.getOccupancyTrend(PROP, DATE, '2027-05-02');
    expect(r.summary.avgAdr).toBe(333.33);
    expect(r.summary.avgRevpar).toBe(50);
    expect(r.summary.avgOccupancy).toBe(0.15);
  });

  it('reports pickup and explicitly flags unavailable historical amendment reconstruction', async () => {
    const { service } = fixture();
    const r = await service.getPickup(PROP, DATE, '2027-04-01', DATE);
    expect(r.pickup.roomNights).toBe(0);
    expect(r.historicalAmendmentsReconstructed).toBe(false);
  });

  it('returns booking pace rows and daily new bookings', async () => {
    const { service } = fixture({ pace: [{ date: DATE, count: 42 }] });
    const r = await service.getBookingPace(PROP, DATE, DATE);
    expect(r.daily[0]).toEqual({ date: DATE, roomsOnBooks: 42, newBookings: 0 });
    expect(r.summary.avgRoomsOnBooks).toBe(42);
  });

  it('defaults missing new bookings to zero without using them as revenue', async () => {
    const { service } = fixture({ pace: [{ date: DATE, count: 30 }] });
    const r = await service.getBookingPace(PROP, DATE, DATE);
    expect(r.summary.totalNewBookings).toBe(0);
    expect(r.daily[0]!.roomsOnBooks).toBe(30);
  });

  it('fails explicitly on an unconverted ledger currency', async () => {
    const { service } = fixture({ charges: [{ ...charge('room', '100'), currencyCode: 'USD' }] });
    await expect(service.getDailyRevenue(PROP, DATE)).rejects.toMatchObject({ status: 400 });
  });

  it('reads a daily report in a read-only repeatable-read snapshot', async () => {
    const { service, db } = fixture();
    await service.getDailyRevenue(PROP, DATE);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read', readOnly: true });
  });

  it('separates positive outstanding balances, guest credits and held deposits', async () => {
    const { service } = fixture({ balances: [{ count: 3, totalBalance: '450', credits: '-100', currencyCode: 'KZT' }],
      deposits: [{ status: 'held', total: '200', currencyCode: 'KZT' }] });
    const r = await service.getFinancialSummary(PROP, DATE);
    expect(r.outstandingBalances).toMatchObject({ totalBalanceDue: 450, creditBalances: -100 });
    expect(r.deposits.held).toBe(200);
    expect(r.kpis.totalRevenue).toBe(0);
  });
});

describe('Reporting calendar and numeric policy', () => {
  it('rejects malformed or impossible business dates', () => {
    for (const date of ['2027-02-30', '2027-2-1', '2027-01-01T00:00Z', 'bad']) expect(() => reportDate(date)).toThrow();
  });
  it('bounds ordered report ranges without dropping leap days', () => {
    expect(reportDates('2028-02-28', '2028-03-01')).toHaveLength(3);
    expect(() => reportDates('2027-05-02', DATE)).toThrow();
    expect(() => reportDates('2025-01-01', '2027-01-01')).toThrow();
  });
  it('clamps a LY leap date instead of rolling into March', () => {
    expect(priorYearDate('2028-02-29')).toBe('2027-02-28');
  });
  it('calculates currency ratios with decimal arithmetic and absent denominator as null', () => {
    expect(ratio(100, 3)).toBe(33.33);
    expect(ratio(10, 0)).toBeNull();
  });
});
