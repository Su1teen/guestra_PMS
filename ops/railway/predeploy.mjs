import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { deploy, identityFromEnv, attestIntegration } from './deploy-engine.mjs';

if (process.env.GUESTRA_DEPLOY_AUTOMATION_ENABLED !== 'true') {
  console.log('Deployment automation disabled; apply the reviewed Railway bootstrap configuration to enable it.');
} else {
  const postgres = createRequire(new URL('../../packages/database/package.json', import.meta.url))('postgres');
  const identity = identityFromEnv('guestra_pms');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
  const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const query = async (text, args = []) => sql.unsafe(text, args);
  try {
    const [ledger] = await query("SELECT to_regclass('public.schema_migrations') AS name");
    const installed = ledger.name ? await query('SELECT version,filename FROM schema_migrations') : [];
    const root = resolve('packages/database/dist/migrations');
    const migrations = (await readdir(root)).filter(f => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= 22).sort().map(file => {
      const version = Number(file.slice(0, 4));
      const old = installed.find(row => row.version === version);
      if (old && old.filename !== file) throw new Error('MIGRATION_FILENAME_DRIFT');
      return { name: 'core/' + file, file: resolve(root, file), installed: Boolean(old), category: [26,28].includes(version) && !old ? 'manual' : 'safe',
        record: async query => {
          await query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,filename varchar(255) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
          await query('INSERT INTO schema_migrations(version,filename) VALUES($1,$2)', [version, file]);
        } };
    });
    if(installed.some(row=>row.version>=22&&!migrations.some(m=>m.name==='core/'+row.filename)))throw new Error('MIGRATION_SOURCE_MISSING');
    const [optionalLedger] = await query("SELECT to_regclass('public.guestra_integration_migrations') AS name");
    const optional = optionalLedger.name ? await query('SELECT name,digest FROM guestra_integration_migrations') : [];
    for (const file of (await readdir('integration-migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const old = optional.find(row => row.name === file);
      migrations.push({ name: 'integration/' + file, file: resolve('integration-migrations', file), installed: Boolean(old),
        legacyDigest: old?.digest, category: 'integration', record: async (query, checksum) => {
          await query('CREATE TABLE IF NOT EXISTS guestra_integration_migrations(name text PRIMARY KEY,digest text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now())');
          await query('INSERT INTO guestra_integration_migrations(name,digest) VALUES($1,$2)', [file, checksum]);
        } });
    }
    await deploy(query, { identity, migrations, foreignTables: ['app_users', 'workspaces', 'workflow_entity'],
      requiredTables: ['properties', 'reservations', 'folios', 'payments'],
      baselineApproved: process.env.GUESTRA_MIGRATION_BASELINE_APPROVED === 'true',
      integrationApproved: process.env.GUESTRA_INTEGRATION_MIGRATIONS_APPROVED === 'true',
      afterMigrations: async query => {
        const [table] = await query("SELECT to_regclass('public.guestra_integration_deployment') AS name");
        if (table.name) await attestIntegration(query, 'guestra_integration_deployment', identity);
        if (process.env.GUESTRA_INTEGRATION_V2_ENABLED === 'true' && !table.name) throw new Error('MIGRATION_REQUIRED:integration');
        const [credential] = await query("SELECT to_regclass('public.connect_credentials') AS name");
        if (!credential.name) throw new Error('MIGRATION_REQUIRED:connect_credentials');
        const columns=await query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='connect_credentials'");
        if(!columns.some(c=>c.column_name==='scopes'&&c.data_type==='jsonb')||!columns.some(c=>c.column_name==='property_id'&&c.data_type==='uuid'))throw new Error('MIGRATION_REQUIRED:connect_credentials_columns');
        const bootstrap = spawnSync(process.execPath, ['packages/database/dist/bootstrap-connect.js'], { stdio: 'inherit', env: process.env });
        if (bootstrap.error || bootstrap.status !== 0) throw new Error('CREDENTIAL_BOOTSTRAP_FAILED');
      } });
    console.log('DATABASE_READY');
  } catch (error) {
    console.error('Pre-deploy refused:', /^[A-Z_]+(?::[a-zA-Z0-9_./-]+)?$/.test(error.message) ? error.message : 'DATABASE_PREFLIGHT_FAILED', error.code ?? '');
    process.exitCode = 1;
  } finally { await sql.end(); }
}
