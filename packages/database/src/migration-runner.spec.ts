/**
 * PostgreSQL integration tests for the numbered SQL migration runner (0022+).
 *
 * Uses ephemeral databases when Postgres is reachable (haip_test pattern).
 */
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { postgresOptionsFromEnv } from './postgres-options.js';
import { pushSchema } from './push-schema.js';
import {
  FIRST_TRACKED_MIGRATION_VERSION,
  getAppliedMigrationVersions,
  listPendingMigrations,
  resolveMigrationsDirectory,
  runAllMigrations,
  runPendingSqlMigrations,
} from './migration-runner.js';

const DEFAULT_DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://haip:haip@localhost:5432/haip_test';

const ADMIN_DATABASE_URL = DEFAULT_DATABASE_URL.replace(/\/[^/]+$/, '/postgres');

const MIGRATIONS_DIR = resolveMigrationsDirectory(
  dirname(fileURLToPath(import.meta.url)),
);

async function postgresReachable(url: string): Promise<boolean> {
  const client = postgres(url, { ...postgresOptionsFromEnv(), max: 1 });
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

async function withEphemeralDatabase(run: (databaseUrl: string) => Promise<void>): Promise<void> {
  const dbName = `haip_mig_${randomBytes(6).toString('hex')}`;
  const admin = postgres(ADMIN_DATABASE_URL, { ...postgresOptionsFromEnv(), max: 1 });
  const databaseUrl = DEFAULT_DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`);

  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  try {
    await run(databaseUrl);
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  }
}

async function columnExists(sql: postgres.Sql, column: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'webhook_deliveries'
        AND column_name = ${column}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function uniqueIndexExists(sql: postgres.Sql, indexName: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function seedWebhookDedupFixtures(sql: postgres.Sql) {
  const propertyId = 'f3500001-0000-4000-a000-000000000001';
  const subscriptionId = 'f3500002-0000-4000-a000-000000000002';
  const logicalEventId = 'f3500003-0000-4000-a000-000000000003';

  await sql`
    INSERT INTO properties (
      id, name, code, country_code, timezone, currency_code, total_rooms
    ) VALUES (
      ${propertyId},
      'Migration test property',
      ${`M350${randomBytes(2).toString('hex').toUpperCase()}`},
      'US',
      'America/New_York',
      'USD',
      10
    )
  `;

  await sql`
    INSERT INTO agent_webhook_subscriptions (
      id, property_id, subscriber_id, callback_url, events
    ) VALUES (
      ${subscriptionId},
      ${propertyId},
      'migration-test-subscriber',
      'https://example.com/webhooks',
      ${JSON.stringify(['reservation.created'])}
    )
  `;

  return { propertyId, subscriptionId, logicalEventId };
}

const postgresReady = await postgresReachable(DEFAULT_DATABASE_URL);

describe.skipIf(!postgresReady)('migration runner (PostgreSQL)', () => {
  beforeAll(async () => {
    if (!postgresReady) return;
    const canCreateDb = await postgresReachable(ADMIN_DATABASE_URL);
    if (!canCreateDb) {
      throw new Error('Postgres admin connection required for ephemeral migration tests');
    }
  });

  it('applies 0022 on a fresh database', async () => {
    await withEphemeralDatabase(async (databaseUrl) => {
      await runAllMigrations(databaseUrl, { migrationsDir: MIGRATIONS_DIR });

      const sql = postgres(databaseUrl, postgresOptionsFromEnv());
      try {
        expect(await columnExists(sql, 'logical_event_id')).toBe(true);
        expect(await uniqueIndexExists(
          sql,
          'webhook_deliveries_property_subscription_logical_event_unique',
        )).toBe(true);
        // The fresh release path must install the database-level overlap fence,
        // not only the ORM table shape. Live operation tests exercise this lock.
        expect(await sql`SELECT contype FROM pg_constraint WHERE conrelid = 'staff_shifts'::regclass AND conname = 'staff_shifts_user_interval_excl'`).toEqual([{contype:'x'}]);

        const applied = await getAppliedMigrationVersions(sql);
        expect(applied.has(FIRST_TRACKED_MIGRATION_VERSION)).toBe(true);
      } finally {
        await sql.end();
      }
    });
  });

  it('enforces booking keys per property and backfills only missing demo guestInfo', async () => {
    await withEphemeralDatabase(async (databaseUrl) => {
      await pushSchema(databaseUrl);
      const sql = postgres(databaseUrl, postgresOptionsFromEnv());
      try {
        const demoId = 'a0000001-0000-4000-a000-000000000001';
        const otherId = 'f3600001-0000-4000-a000-000000000001';
        await sql`
          INSERT INTO properties (id, name, code, country_code, timezone, currency_code, total_rooms, settings)
          VALUES
            (${demoId}, 'Demo', 'LES', 'KZ', 'Asia/Almaty', 'KZT', 10, ${sql.json({ taxRate: 0.13 })}::jsonb),
            (${otherId}, 'Other', 'OTHER', 'KZ', 'Asia/Almaty', 'KZT', 10, ${sql.json({ taxRate: 0.2 })}::jsonb)
        `;
        await sql`
          INSERT INTO tax_profiles (id, property_id, name, jurisdiction_code, is_active, effective_from)
          VALUES
            ('a5000001-0000-4000-a000-000000000001', ${demoId}, 'Stale demo profile', 'US-FL-MIAMI-BEACH', true, '2024-01-01'),
            ('f3600002-0000-4000-a000-000000000002', ${otherId}, 'Production profile', 'KZ', true, '2024-01-01')
        `;
        await runAllMigrations(databaseUrl, { migrationsDir: MIGRATIONS_DIR });

        const [demo] = await sql<{ settings: { taxRate: number; guestInfo: { pets: string; wifi: string } } }[]>`
          SELECT settings FROM properties WHERE id = ${demoId}
        `;
        const [other] = await sql<{ settings: { taxRate: number; guestInfo?: unknown } }[]>`
          SELECT settings FROM properties WHERE id = ${otherId}
        `;
        expect(demo?.settings.taxRate).toBe(0.13);
        expect(demo?.settings.guestInfo.pets).toContain('питомц');
        expect(demo?.settings.guestInfo.wifi).toContain('Wi-Fi');
        expect(other?.settings).toEqual({ taxRate: 0.2 });
        const profiles = await sql<{ propertyId: string; isActive: boolean }[]>`
          SELECT property_id AS "propertyId", is_active AS "isActive"
          FROM tax_profiles
          WHERE property_id IN (${demoId}, ${otherId})
          ORDER BY property_id
        `;
        expect(profiles.find((profile) => profile.propertyId === demoId)?.isActive).toBe(false);
        expect(profiles.find((profile) => profile.propertyId === otherId)?.isActive).toBe(true);

        const [guest] = await sql<{ id: string }[]>`
          INSERT INTO guests (first_name, last_name) VALUES ('Demo', 'Guest') RETURNING id
        `;
        const insertBooking = (propertyId: string, confirmationNumber: string, idempotencyKey: string | null) => sql`
          INSERT INTO bookings (property_id, guest_id, confirmation_number, source, idempotency_key)
          VALUES (${propertyId}, ${guest!.id}, ${confirmationNumber}, 'direct', ${idempotencyKey})
        `;
        await insertBooking(demoId, 'DEMO-1', 'message-1');
        await expect(insertBooking(demoId, 'DEMO-2', 'message-1'))
          .rejects.toMatchObject({ code: '23505' });
        await insertBooking(otherId, 'OTHER-1', 'message-1');
        await insertBooking(demoId, 'DEMO-3', null);
        await insertBooking(demoId, 'DEMO-4', null);

        await sql`
          INSERT INTO booking_engine_idempotency (property_id, idempotency_key, response)
          VALUES (${demoId}, 'message-1', '{"reservationId":"demo"}'::jsonb)
        `;
        await expect(sql`
          INSERT INTO booking_engine_idempotency (property_id, idempotency_key)
          VALUES (${demoId}, 'message-1')
        `).rejects.toMatchObject({ code: '23505' });
        await sql`
          INSERT INTO booking_engine_idempotency (property_id, idempotency_key)
          VALUES (${otherId}, 'message-1')
        `;
      } finally {
        await sql.end();
      }
    });
  });

  it('upgrades an existing pre-0022 database (push-schema baseline only)', async () => {
    await withEphemeralDatabase(async (databaseUrl) => {
      await pushSchema(databaseUrl);

      const sql = postgres(databaseUrl, postgresOptionsFromEnv());
      try {
        expect(await columnExists(sql, 'logical_event_id')).toBe(false);
        expect(await getAppliedMigrationVersions(sql).then((v) => v.size)).toBe(0);

        const pendingBefore = await listPendingMigrations(sql, MIGRATIONS_DIR);
        expect(pendingBefore.some((m) => m.version === FIRST_TRACKED_MIGRATION_VERSION)).toBe(true);

        await runPendingSqlMigrations(sql, MIGRATIONS_DIR);

        expect(await columnExists(sql, 'logical_event_id')).toBe(true);
        expect(await uniqueIndexExists(
          sql,
          'webhook_deliveries_property_subscription_logical_event_unique',
        )).toBe(true);
      } finally {
        await sql.end();
      }
    });
  });

  it('upgrades populated 0034 operations without losing comments, attachments, links or room state', async () => {
    // The fixture is created from the repository baseline, never copied from a user database.
    const baseline = await mkdtemp(join(tmpdir(), 'haip-b2-baseline-'));
    try {
      for (const name of await readdir(MIGRATIONS_DIR)) {
        if (/^00(?:2[2-9]|3[0-4])_.*\.sql$/.test(name)) {
          await cp(join(MIGRATIONS_DIR, name), join(baseline, name));
        }
      }
      await withEphemeralDatabase(async (databaseUrl) => {
        await runAllMigrations(databaseUrl, { migrationsDir: baseline });
        const sql = postgres(databaseUrl, postgresOptionsFromEnv());
        const propertyId = 'b2000001-0000-4000-a000-000000000001';
        try {
          await sql`INSERT INTO properties (id,name,code,country_code,timezone,currency_code,total_rooms,settings)
            VALUES (${propertyId},'Synthetic upgrade','B2UP','KZ','Asia/Almaty','KZT',1,'{"custom":"preserve"}'::jsonb)`;
          const [type] = await sql`INSERT INTO room_types (property_id,code,name,max_occupancy,default_occupancy)
            VALUES (${propertyId},'B2','Synthetic',2,2) RETURNING id`;
          const [room] = await sql`INSERT INTO rooms (property_id,room_type_id,number,status)
            VALUES (${propertyId},${type!['id']},'1','out_of_order') RETURNING id`;
          const comments = [{ id: 'legacy-note', body: 'Сохранить заметку', createdAt: '2026-10-01T00:00:00Z' }];
          const attachments = [{ url: 'https://example.invalid/legacy-photo.jpg', name: 'Legacy reference' }];
          const [ticket] = await sql`INSERT INTO maintenance_tickets (property_id,room_id,category,title,description,blocks_inventory,return_to_service_required,comments,attachments)
            VALUES (${propertyId},${room!['id']},'plumbing','Synthetic repair','Fixture',true,true,${sql.json(comments)},${sql.json(attachments)}) RETURNING id`;
          const [task] = await sql`INSERT INTO housekeeping_tasks (property_id,room_id,type,service_date,attachments)
            VALUES (${propertyId},${room!['id']},'checkout','2026-10-01',${sql.json(attachments)}) RETURNING id`;
          const [request] = await sql`INSERT INTO service_requests (property_id,room_id,type,title,linked_task_id)
            VALUES (${propertyId},${room!['id']},'checkout','Synthetic request',${task!['id']}) RETURNING id`;
          const [staffUser] = await sql`INSERT INTO users(email,name,status) VALUES ('synthetic-shift@example.invalid','Fixture','active') RETURNING id`;
          const [legacyShift] = await sql`INSERT INTO staff_shifts(property_id,user_id,start_at,end_at,status,notes,idempotency_key,request_fingerprint)
            VALUES (${propertyId},${staffUser!['id']},'2027-01-01T09:00Z','2027-01-01T18:00Z','confirmed','Preserve','legacy-shift-key','original') RETURNING id`;
          await runAllMigrations(databaseUrl, { migrationsDir: MIGRATIONS_DIR });
          expect(await sql`SELECT kind,absence_type,status,notes,idempotency_key,request_fingerprint FROM staff_shifts WHERE id=${legacyShift!['id']}`)
            .toEqual([{kind:'shift',absence_type:null,status:'confirmed',notes:'Preserve',idempotency_key:'legacy-shift-key',request_fingerprint:'original'}]);
          expect(await sql`SELECT * FROM staff_shift_templates WHERE property_id=${propertyId}`).toEqual([]);
          expect(await sql`SELECT revision,comments,attachments,blocks_inventory,return_to_service_required FROM maintenance_tickets WHERE id=${ticket!['id']}`)
            .toEqual([{ revision: 1, comments, attachments, blocks_inventory: true, return_to_service_required: true }]);
          expect(await sql`SELECT attachments FROM housekeeping_tasks WHERE id=${task!['id']}`).toEqual([{ attachments }]);
          expect(await sql`SELECT linked_task_id,linked_maintenance_ticket_id FROM service_requests WHERE id=${request!['id']}`)
            .toEqual([{ linked_task_id: task!['id'], linked_maintenance_ticket_id: null }]);
          expect(await sql`SELECT status FROM rooms WHERE id=${room!['id']}`).toEqual([{ status: 'out_of_order' }]);
          expect(await sql`SELECT settings FROM properties WHERE id=${propertyId}`).toEqual([{ settings: { custom: 'preserve' } }]);
          expect(await sql`SELECT * FROM room_inventory_blocks WHERE property_id=${propertyId}`).toEqual([]);
          expect(await runPendingSqlMigrations(sql, MIGRATIONS_DIR)).toEqual([]);
        } finally { await sql.end(); }
      });
    } finally { await rm(baseline, { recursive: true, force: true }); }
  });

  it('skips already-applied migrations when run twice (ledger idempotency)', async () => {
    await withEphemeralDatabase(async (databaseUrl) => {
      await runAllMigrations(databaseUrl, { migrationsDir: MIGRATIONS_DIR });

      const sql = postgres(databaseUrl, postgresOptionsFromEnv());
      try {
        const firstApplied = await getAppliedMigrationVersions(sql);
        expect(firstApplied.has(FIRST_TRACKED_MIGRATION_VERSION)).toBe(true);

        const secondPass = await runPendingSqlMigrations(sql, MIGRATIONS_DIR);
        expect(secondPass).toEqual([]);

        const appliedAfter = await getAppliedMigrationVersions(sql);
        expect(appliedAfter.size).toBe(firstApplied.size);
      } finally {
        await sql.end();
      }
    });
  });
  it('upgrades JSON null demo settings without touching another tenant and retains terminal request fences', async () => {
    await withEphemeralDatabase(async databaseUrl => {
      await pushSchema(databaseUrl);
      const sql = postgres(databaseUrl, postgresOptionsFromEnv());
      const demoId = 'a0000001-0000-4000-a000-000000000001';
      const otherId = 'f3600001-0000-4000-a000-000000000001';
      const requestId = 'f3600002-0000-4000-a000-000000000002';
      try {
        await sql`INSERT INTO properties (id, name, code, country_code, timezone, currency_code, total_rooms, settings) VALUES
          (${demoId}, 'Demo', 'LES', 'KZ', 'Asia/Almaty', 'KZT', 1, 'null'::jsonb),
          (${otherId}, 'Other', 'OTHER', 'KZ', 'Asia/Almaty', 'KZT', 1, '{"custom":"retain"}'::jsonb)`;
        await sql`INSERT INTO staff_request_fences (property_id, request_id) VALUES (${otherId}, ${requestId})`;
        await runAllMigrations(databaseUrl, { migrationsDir: MIGRATIONS_DIR });
        const [demo] = await sql`SELECT settings FROM properties WHERE id = ${demoId}`;
        expect(demo!['settings'].guestInfo.wifi).toContain('Wi-Fi');
        expect(demo!['settings'].earlyCheckInFee).toBe(22500);
        expect(await runPendingSqlMigrations(sql, MIGRATIONS_DIR)).toEqual([]);
        const [other] = await sql`SELECT settings FROM properties WHERE id = ${otherId}`;
        expect(other!['settings']).toEqual({ custom: 'retain' });
        expect(await sql`SELECT request_id FROM staff_request_fences WHERE property_id = ${otherId}`).toHaveLength(1);
      } finally { await sql.end(); }
    });
  });

  it('rejects duplicate (property_id, subscription_id, logical_event_id) rows', async () => {
    await withEphemeralDatabase(async (databaseUrl) => {
      await runAllMigrations(databaseUrl, { migrationsDir: MIGRATIONS_DIR });

      const sql = postgres(databaseUrl, postgresOptionsFromEnv());
      try {
        const { propertyId, subscriptionId, logicalEventId } = await seedWebhookDedupFixtures(sql);
        const payload = JSON.stringify({ eventType: 'reservation.created' });

        await sql`
          INSERT INTO webhook_deliveries (
            property_id, subscription_id, logical_event_id, event_type, payload
          ) VALUES (
            ${propertyId},
            ${subscriptionId},
            ${logicalEventId},
            'reservation.created',
            ${payload}::jsonb
          )
        `;

        await expect(sql`
          INSERT INTO webhook_deliveries (
            property_id, subscription_id, logical_event_id, event_type, payload
          ) VALUES (
            ${propertyId},
            ${subscriptionId},
            ${logicalEventId},
            'reservation.created',
            ${payload}::jsonb
          )
        `).rejects.toMatchObject({ code: '23505' });
      } finally {
        await sql.end();
      }
    });
  });
});

describe('migration runner (unit)', () => {
  it('resolves migrations adjacent to the compiled entry directory', () => {
    const dir = resolveMigrationsDirectory(join(dirname(fileURLToPath(import.meta.url))));
    expect(dir.endsWith(`${join('src', 'migrations')}`) || dir.endsWith(`${join('dist', 'migrations')}`)).toBe(true);
  });
});
