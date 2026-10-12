import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { charges, properties } from '@telivityhaip/database';
import { ReportsService } from './reports.service';

describe.runIf(process.env.PMS_LIVE_PG === '1')('Revenue signed ledger reconciliation on PostgreSQL', () => {
  const client = postgres(process.env.DATABASE_URL!, { max: 2 });
  const db = drizzle(client);
  const propertyId = randomUUID();
  const date = '2027-05-01';
  const service = new ReportsService(db);

  beforeAll(async () => {
    await db.insert(properties).values({ id: propertyId, name: 'Revenue test', code: propertyId.slice(0, 16),
      countryCode: 'KZ', timezone: 'Asia/Almaty', currencyCode: 'KZT', totalRooms: 2 });
  });
  beforeEach(async () => { await db.delete(charges).where(eq(charges.propertyId, propertyId)); });
  afterAll(async () => {
    await db.delete(charges).where(eq(charges.propertyId, propertyId));
    await db.delete(properties).where(eq(properties.id, propertyId));
    await client.end();
  });

  async function post(amount: string, isReversal = false, type: 'room' | 'tax' | 'food_beverage' | 'spa' = 'room') {
    await db.insert(charges).values({ propertyId, type, description: 'Signed ledger fixture', amount,
      currencyCode: 'KZT', serviceDate: new Date(`${date}T00:00:00Z`), isReversal });
  }

  it('nets signed accepted-price corrections and their reversals to zero', async () => {
    await post('100.00');
    await post('-20.00');
    await post('-100.00', true);
    await post('20.00', true);
    expect((await service.getDailyRevenue(propertyId, date)).netRevenue).toBe(0);
  });

  it('deducts a partial reversal instead of adding it to earned revenue', async () => {
    await post('100.00');
    await post('-25.00', true);
    expect((await service.getDailyRevenue(propertyId, date)).netRevenue).toBe(75);
  });

  it('includes service-only charges and separately posted taxes exactly once', async () => {
    await post('30.00', false, 'food_beverage');
    await post('20.00', false, 'spa');
    await post('5.00', false, 'tax');
    await post('-5.00', true, 'food_beverage');
    expect((await service.getDailyRevenue(propertyId, date)).netRevenue).toBe(50);
  });
});
