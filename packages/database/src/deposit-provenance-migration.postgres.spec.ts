import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgTable, uuid, varchar, numeric, timestamp, boolean } from 'drizzle-orm/pg-core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { properties, guests, roomTypes, bookings, reservations, folios, charges, depositLedgerEntries, auditLogs } from './schema/index.js';
import { listTrackedMigrationFiles, resolveMigrationsDirectory, runAllMigrations } from './migration-runner.js';

// Only test infrastructure creates/drops a fresh database; financial fixtures use Drizzle.
describe.runIf(process.env['PMS_LIVE_PG'] === '1')('0040 historical provenance attribution', () => {
  const name = `haip_deposit_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env['DATABASE_URL'] ?? 'postgresql://haip:haip@localhost:5432/haip_test');
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1 });
  url.pathname = `/${name}`;
  const testUrl = url.toString();
  let client: ReturnType<typeof postgres>, staging: string;
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Historical regression must use local test PostgreSQL');
    await admin.unsafe(`CREATE DATABASE ${name}`);
    staging = await mkdtemp(join(tmpdir(), 'haip-before-0040-'));
    for (const file of await listTrackedMigrationFiles(resolveMigrationsDirectory())) {
      if (file.version < 40) await copyFile(file.path, join(staging, file.filename));
    }
    await runAllMigrations(testUrl, { migrationsDir: staging });
    client = postgres(testUrl, { max: 1 });
  }, 120000);
  afterAll(async () => {
    if (client) await client.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
    if (staging) await rm(staging, { recursive: true });
  });

  it('attributes only unique canonical legacy credits/reversals/fees, audits changes, and leaves ambiguity/old forfeiture untouched', async () => {
    const db = drizzle(client), p = randomUUID(), guest = randomUUID(), type = randomUUID(), rate = randomUUID(), booking = randomUUID();
    const resA = randomUUID(), resB = randomUUID(), folioA = randomUUID(), folioB = randomUUID();
    const date = new Date('2027-05-01T12:00:00Z');
    await db.insert(properties).values({ id: p, name: 'Migration test', code: p.slice(0, 16), countryCode: 'KZ', currencyCode: 'KZT', timezone: 'UTC', totalRooms: 1 });
    await db.insert(guests).values({ id: guest, firstName: 'Migration', lastName: 'Test' });
    await db.insert(roomTypes).values({ id: type, propertyId: p, name: 'Standard', code: 'STD', maxOccupancy: 2, defaultOccupancy: 1 });
    // Pre-0040 database: insert only columns that existed then (later migrations add rate plan columns).
    await client`INSERT INTO rate_plans (id, property_id, room_type_id, name, code, type, base_amount, currency_code)
      VALUES (${rate}, ${p}, ${type}, 'BAR', 'BAR', 'bar', '100', 'KZT')`;
    await db.insert(bookings).values({ id: booking, propertyId: p, guestId: guest, source: 'direct', confirmationNumber: randomUUID() });
    for (const id of [resA, resB]) await db.insert(reservations).values({ id, propertyId: p, bookingId: booking, guestId: guest, roomTypeId: type, ratePlanId: rate,
      arrivalDate: '2027-05-01', departureDate: '2027-05-02', nights: 1, status: 'cancelled', cancelledAt: date, updatedAt: date, totalAmount: '100', currencyCode: 'KZT' });
    await db.insert(folios).values([{ id: folioA, propertyId: p, reservationId: resA, guestId: guest, folioNumber: 'A', currencyCode: 'KZT' },
      { id: folioB, propertyId: p, reservationId: resB, guestId: guest, folioNumber: 'B', currencyCode: 'KZT' }]);
    const base = { propertyId: p, currencyCode: 'KZT', recognizedAt: date, isRefundable: false };
    await db.insert(depositLedgerEntries).values([{ ...base, reservationId: resA, amount: '40', status: 'applied' },
      { ...base, reservationId: resB, amount: '10', status: 'applied' }, { ...base, reservationId: resB, amount: '10', status: 'applied' },
      { ...base, reservationId: resA, amount: '15', status: 'forfeited' }]);
    const taggedDepositId = randomUUID();
    await db.insert(depositLedgerEntries).values({ ...base, id: taggedDepositId, reservationId: resA, amount: '55', status: 'applied' });
    await db.insert(depositLedgerEntries).values({ ...base, reservationId: resA, amount: '45', status: 'applied' });
    // Deliberately declare the pre-0040 charge shape, which has no revenue_role column.
    const legacy = pgTable('charges', { id: uuid('id').primaryKey().defaultRandom(), propertyId: uuid('property_id'), folioId: uuid('folio_id'), type: varchar('type'),
      description: varchar('description'), amount: numeric('amount'), currencyCode: varchar('currency_code'), serviceDate: timestamp('service_date', { withTimezone: true }),
      originalChargeId: uuid('original_charge_id'), parentChargeId: uuid('parent_charge_id'), isReversal: boolean('is_reversal'), sourceKey: varchar('source_key') });
    const applied = randomUUID(), reversed = randomUUID(), ambiguous = randomUUID(), unmatched = randomUUID(), fee = randomUUID();
    const conflict = randomUUID(), roomParent = randomUUID(), roomChild = randomUUID(), foreignReversal = randomUUID();
    const charge = { propertyId: p, folioId: folioA, currencyCode: 'KZT', serviceDate: date, isReversal: false };
    await db.insert(legacy).values([{ ...charge, id: applied, type: 'adjustment', description: 'Deposit applied', amount: '-40' },
      { ...charge, id: reversed, type: 'adjustment', description: 'Reversal', amount: '40', originalChargeId: applied, isReversal: true },
      { ...charge, id: ambiguous, folioId: folioB, type: 'adjustment', description: 'Deposit applied', amount: '-10' },
      { ...charge, id: unmatched, type: 'adjustment', description: 'Deposit applied', amount: '-7' },
      { ...charge, id: fee, type: 'fee', description: 'Cancellation penalty', amount: '20' },
      { ...charge, folioId: folioB, type: 'fee', description: 'Cancellation penalty', amount: '10' },
      { ...charge, folioId: folioB, type: 'fee', description: 'Cancellation penalty', amount: '10' }]);
    await db.insert(legacy).values([{ ...charge, type: 'adjustment', description: 'Deposit applied', amount: '-55', sourceKey: `deposit:${taggedDepositId}:apply` },
      { ...charge, id: conflict, type: 'adjustment', description: 'Deposit applied', amount: '-55' },
      { ...charge, id: roomParent, type: 'room', description: 'Room', amount: '100' },
      { ...charge, id: roomChild, type: 'adjustment', description: 'Deposit applied', amount: '-45', parentChargeId: roomParent },
      { ...charge, id: foreignReversal, type: 'adjustment', description: 'Reversal', currencyCode: 'USD', amount: '40', originalChargeId: applied, isReversal: true }]);
    await runAllMigrations(testUrl, { skipPushSchema: true });
    const rows = await db.select().from(charges).where(eq(charges.propertyId, p));
    expect(rows).toHaveLength(12);
    for (const id of [conflict, roomChild, foreignReversal]) expect(rows.find(row => row.id === id)).toMatchObject({ revenueRole: 'earned', sourceKey: null });
    expect(rows.find(row => row.id === applied)).toMatchObject({ revenueRole: 'deposit_credit' });
    expect(rows.find(row => row.id === reversed)).toMatchObject({ revenueRole: 'deposit_credit' });
    expect(rows.find(row => row.id === ambiguous)).toMatchObject({ revenueRole: 'earned', sourceKey: null });
    expect(rows.find(row => row.id === unmatched)).toMatchObject({ revenueRole: 'earned', sourceKey: null });
    expect(rows.find(row => row.id === fee)?.sourceKey).toBe(`settlement:${resA}:policy`);
    expect(rows.filter(row => row.folioId === folioB && row.type === 'fee').every(row => row.sourceKey == null)).toBe(true);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.propertyId, p))).toHaveLength(3);
    expect(await db.select().from(depositLedgerEntries).where(and(eq(depositLedgerEntries.propertyId, p), eq(depositLedgerEntries.status, 'forfeited')))).toHaveLength(1);
  }, 120000);
});
