/**
 * Numbered SQL migration runner for schema changes from 0022 onward.
 *
 * Migrations 0001–0021 are incorporated idempotently by push-schema.ts (legacy
 * baseline). This runner records applied versions in schema_migrations and
 * executes each new .sql file once, inside a transaction.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { pushSchema } from './push-schema.js';

/** Last migration version baked into push-schema.ts (baseline, not re-run). */
export const BASELINE_MIGRATION_VERSION = 21;

/** First version executed by this runner. */
export const FIRST_TRACKED_MIGRATION_VERSION = BASELINE_MIGRATION_VERSION + 1;

const MIGRATION_FILENAME_RE = /^(\d{4})_.+\.sql$/;

export type MigrationFile = {
  version: number;
  filename: string;
  path: string;
};

export function parseMigrationFilename(filename: string): number | null {
  const match = MIGRATION_FILENAME_RE.exec(filename);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

export function resolveMigrationsDirectory(entryDir = dirname(fileURLToPath(import.meta.url))): string {
  return join(entryDir, 'migrations');
}

export async function listTrackedMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const files: MigrationFile[] = [];

  for (const filename of entries) {
    const version = parseMigrationFilename(filename);
    if (version === null || version < FIRST_TRACKED_MIGRATION_VERSION) continue;
    files.push({
      version,
      filename,
      path: join(migrationsDir, filename),
    });
  }

  files.sort((a, b) => a.version - b.version);
  return files;
}

export async function ensureMigrationLedger(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      filename varchar(255) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum varchar(64)`;
}

export async function getAppliedMigrationVersions(sql: postgres.Sql): Promise<Set<number>> {
  await ensureMigrationLedger(sql);
  const rows = await sql<{ version: number }[]>`
    SELECT version FROM schema_migrations ORDER BY version
  `;
  return new Set(rows.map((row) => row.version));
}

export async function runPendingSqlMigrations(
  sql: postgres.Sql,
  migrationsDir: string,
): Promise<string[]> {
  // A dedicated transaction serializes discovery and execution across deploys.
  return sql.begin(async (tx) => {
  const locked = tx as unknown as postgres.Sql;
  await tx`SELECT pg_advisory_xact_lock(hashtext('guestra:pms:core-migrations'))`;
  await ensureMigrationLedger(locked);
  const files = await listTrackedMigrationFiles(migrationsDir);
  if (new Set(files.map(f => f.version)).size !== files.length) throw new Error('Duplicate migration version');
  const installed = await tx<{version: number; filename: string; checksum: string | null}[]>`SELECT version,filename,checksum FROM schema_migrations`;
  for (const file of files) {
    const previous = installed.find(row => row.version === file.version);
    const checksum = createHash('sha256').update(await readFile(file.path, 'utf8')).digest('hex');
    if (previous && (previous.filename !== file.filename || (previous.checksum && previous.checksum !== checksum)))
      throw new Error('Migration checksum or filename drift: ' + file.filename);
    if (previous && !previous.checksum) await tx`UPDATE schema_migrations SET checksum=${checksum} WHERE version=${file.version}`;
  }
  const pending = files.filter(f => !installed.some(row => row.version === f.version));
  const applied: string[] = [];

  for (const migration of pending) {
    const body = await readFile(migration.path, 'utf8');
      await tx.unsafe(body);
      const checksum = createHash('sha256').update(body).digest('hex');
      await tx`
        INSERT INTO schema_migrations (version, filename, checksum)
        VALUES (${migration.version}, ${migration.filename}, ${checksum})
      `;
    applied.push(migration.filename);
    console.log(`Applied migration ${migration.filename}`);
  }

  return applied;
  }) as unknown as Promise<string[]>;
}

export async function listPendingMigrations(
  sql: postgres.Sql,
  migrationsDir: string,
): Promise<MigrationFile[]> {
  const applied = await getAppliedMigrationVersions(sql);
  const files = await listTrackedMigrationFiles(migrationsDir);
  return files.filter((file) => !applied.has(file.version));
}

/**
 * Push legacy baseline schema, then apply tracked SQL migrations (0022+).
 */
export async function runAllMigrations(
  databaseUrl: string,
  options: {
    migrationsDir?: string;
    skipPushSchema?: boolean;
  } = {},
): Promise<void> {
  const postgresModule = await import('postgres');
  const defaultPostgres = postgresModule.default;
  const { postgresOptionsFromEnv } = await import('./postgres-options.js');

  const migrationsDir = options.migrationsDir ?? resolveMigrationsDirectory();

  const sql = defaultPostgres(databaseUrl, postgresOptionsFromEnv());

  try {
    if (!options.skipPushSchema) {
      const [baseline] = await sql`SELECT to_regclass('public.properties') AS name`;
      if (!baseline?.['name']) {
        const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> 'schema_migrations'`;
        if (tables.length) throw new Error('PMS baseline missing on a populated database; automatic schema push refused');
        console.log('Initializing an empty PMS database; existing databases never replay push-schema.');
        await pushSchema(databaseUrl);
      }
    }
    const applied = await runPendingSqlMigrations(sql, migrationsDir);
    if (applied.length === 0) {
      console.log('No pending SQL migrations.');
    } else {
      console.log(`SQL migrations applied: ${applied.join(', ')}`);
    }
  } finally {
    await sql.end();
  }
}
