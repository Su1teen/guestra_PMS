import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import { auditRuns, charges, properties } from '@telivityhaip/database';
import { ReportsService } from './reports.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')('Revenue overview shared PostgreSQL snapshot', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 4 });
  const db = drizzle(client);
  const service = new ReportsService(db);
  const propertyId = randomUUID();
  const foreignPropertyId = randomUUID();
  const ids = [propertyId, foreignPropertyId];
  const date = '2027-05-01';

  async function clear() {
    await db.delete(charges).where(inArray(charges.propertyId, ids));
    await db.delete(auditRuns).where(inArray(auditRuns.propertyId, ids));
  }

  beforeAll(async () => {
    await db.insert(properties).values([
      { id: propertyId, name: 'Revenue overview', code: propertyId.slice(0, 16),
        countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: 0 },
      { id: foreignPropertyId, name: 'Foreign overview', code: foreignPropertyId.slice(0, 16),
        countryCode: 'US', timezone: 'America/Los_Angeles', currencyCode: 'USD', totalRooms: 0 },
    ]);
  });
  beforeEach(async () => { vi.restoreAllMocks(); await clear(); });
  afterAll(async () => {
    vi.restoreAllMocks();
    await clear();
    await db.delete(properties).where(inArray(properties.id, ids));
    await client.end();
  });

  it('composes signed financial and period actuals in one property-isolated read snapshot', async () => {
    const common = { propertyId, description: 'Overview fixture', currencyCode: 'KZT',
      serviceDate: new Date(`${date}T00:00:00Z`) };
    await db.insert(charges).values([
      { ...common, type: 'room', amount: '100' },
      { ...common, type: 'tax', amount: '10' },
      { ...common, type: 'food_beverage', amount: '30' },
      { ...common, type: 'food_beverage', amount: '-5', isReversal: true },
      { ...common, propertyId: foreignPropertyId, currencyCode: 'USD', type: 'room', amount: '900' },
    ]);
    const transaction = vi.spyOn(db, 'transaction');
    const overview = await service.getRevenueOverview(propertyId, date);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: 'repeatable read', readOnly: true });
    expect(overview).toMatchObject({ propertyId, date, currencyCode: 'KZT',
      financial: { date, kpis: { roomRevenue: 100, foodBeverageRevenue: 25,
        totalRevenue: 125, separatelyPostedTax: 10 }, actual: { value: 125 } },
      periods: { mtd: { value: 125 } },
    });
    expect(overview.financial).toEqual(await service.getFinancialSummary(propertyId, date));
    expect(overview.periods).toEqual((await service.getRevenuePeriods(propertyId, date)).periods);
    const foreign = await service.getRevenueOverview(foreignPropertyId, date);
    expect(foreign).toMatchObject({ currencyCode: 'USD', financial: { actual: { value: 900 } } });
  });

  it('uses the completed-audit operational date and keeps missing actuals nullable', async () => {
    await db.insert(auditRuns).values({ propertyId, businessDate: '2027-04-30', status: 'completed' });
    const overview = await service.getRevenueOverview(propertyId);
    expect(overview.date).toBe(date);
    expect(overview.financial.date).toBe(date);
    expect(overview.financial.actual).toMatchObject({ value: null, status: 'NO_POSTINGS' });
    expect(overview.periods.mtd.end).toBe(date);
    expect(overview.periods.mtd.value).toBeNull();
  });
});
