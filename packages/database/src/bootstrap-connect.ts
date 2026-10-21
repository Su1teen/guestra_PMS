import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, or } from 'drizzle-orm';
import { auditLogs, connectCredentials, properties, integrationLinks } from './schema/index.js';
import { postgresOptionsFromEnv } from './postgres-options.js';

export interface BootstrapCredential {
  id: string;
  propertyId: string;
  label: string;
  key: string;
  environment: string;
  scopes: string[];
  revoked?: boolean;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed = new Set(['integration.read', 'integration.write', 'events.read', 'services.read', 'services.write', 'sandbox.setup']);
export function parseBootstrapCredentials(raw: string, environment: string): BootstrapCredential[] {
  if (!['test', 'sandbox', 'production'].includes(environment)) throw new Error('INVALID_ENVIRONMENT');
  let records: unknown;
  try { records = JSON.parse(raw); } catch { throw new Error('INVALID_CONNECT_CREDENTIALS_JSON'); }
  if (!Array.isArray(records) || records.length > 100) throw new Error('INVALID_CONNECT_CREDENTIALS');
  const ids = new Set(), hashes = new Set();
  for (const record of records) {
    if (!record || !uuid.test(record.id) || !uuid.test(record.propertyId)
      || typeof record.label !== 'string' || !record.label.trim() || record.label.length > 200
      || typeof record.key !== 'string' || record.key.length < 32 || record.key.length > 256
      || record.environment !== environment || !Array.isArray(record.scopes) || !record.scopes.length
      || record.scopes.some((s: unknown) => typeof s !== 'string' || !allowed.has(s))
      || new Set(record.scopes).size !== record.scopes.length
      || (record.revoked !== undefined && typeof record.revoked !== 'boolean')
      || (environment === 'production' && record.scopes.includes('sandbox.setup'))) {
      throw new Error('INVALID_CONNECT_CREDENTIAL_RECORD');
    }
    const hash = createHash('sha256').update(record.key).digest('hex');
    if (ids.has(record.id) || hashes.has(hash)) throw new Error('DUPLICATE_CONNECT_CREDENTIAL');
    ids.add(record.id); hashes.add(hash);
  }
  return records as BootstrapCredential[];
}

/** Explicit CLI/pre-deploy operation; keys are never returned or logged. */
export async function bootstrapConnect(db: any, records: BootstrapCredential[]) {
  await db.transaction(async (tx: any) => {
    for (const record of records) {
      const [property] = await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, record.propertyId));
      if (!property) throw new Error('BOOTSTRAP_PROPERTY_NOT_FOUND');
      const keyHash = createHash('sha256').update(record.key).digest('hex');
      const scopes = [...record.scopes, 'pms:scoped:v1', 'environment:' + record.environment].sort();
      // A conflicting key must not be reassigned, including across properties.
      const matches = await tx.select().from(connectCredentials).where(or(eq(connectCredentials.id, record.id), eq(connectCredentials.keyHash, keyHash)));
      const existing = matches[0];
      if (existing && (matches.length !== 1 || existing.id !== record.id || existing.propertyId !== record.propertyId
        || existing.keyHash !== keyHash || existing.label !== record.label
        || JSON.stringify([...existing.scopes].sort()) !== JSON.stringify(scopes))) throw new Error('BOOTSTRAP_CREDENTIAL_CONFLICT');
      if (existing && (existing.revokedAt || !existing.isActive) && !record.revoked) throw new Error('BOOTSTRAP_CREDENTIAL_REVOKED');
      if (existing && (!record.revoked || existing.revokedAt)) continue;
      if (!existing && record.revoked) throw new Error('BOOTSTRAP_REVOCATION_NOT_FOUND');
      if (existing) {
        await tx.update(connectCredentials).set({ isActive: false, revokedAt: new Date() })
          .where(and(eq(connectCredentials.id, record.id), eq(connectCredentials.propertyId, record.propertyId)));
      } else {
        await tx.insert(connectCredentials).values({ id: record.id, propertyId: record.propertyId, label: record.label, keyHash, scopes });
      }
      await tx.insert(auditLogs).values({ propertyId: record.propertyId, entityId: record.id,
        entityType: 'connect_credential', action: existing ? 'revoke' : 'create',
        description: 'Declarative integration credential bootstrap',
        newValue: { label: record.label, scopes, revoked: Boolean(record.revoked) } });
    }
  });
}
export async function bootstrapPropertyMappings(db: any, mappings: any[], environment: string, confirmed: boolean) {
  if (!Array.isArray(mappings) || (mappings.length && !confirmed)) throw new Error('PROPERTY_MAPPING_CONFIRMATION_REQUIRED');
  await db.transaction(async (tx: any) => {
    for (const mapping of mappings) {
      if (!mapping || !uuid.test(mapping.pmsPropertyId) || !mapping.crmPropertyId || !mapping.crmTenantId || mapping.environment !== environment)
        throw new Error('INVALID_PROPERTY_MAPPING');
      const [property] = await tx.select().from(properties).where(eq(properties.id, mapping.pmsPropertyId));
      if (!property || (property.organizationId ?? property.id) !== mapping.pmsTenantId) throw new Error('TENANT_MISMATCH');
      const existing = await tx.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, mapping.pmsPropertyId),
        eq(integrationLinks.sourceSystem, 'guestra_crm'), eq(integrationLinks.localEntityType, 'property'), eq(integrationLinks.localEntityId, mapping.pmsPropertyId)));
      const old = existing[0];
      const keys = ['crmPropertyId', 'crmTenantId', 'pmsPropertyId', 'pmsTenantId', 'environment'];
      if (old && (existing.length !== 1 || old.externalEntityId !== mapping.crmPropertyId || keys.some(k => old.metadata?.[k] !== mapping[k])))
        throw new Error('PROPERTY_MAPPING_CONFLICT');
      if (!old) {
        const [row] = await tx.insert(integrationLinks).values({ propertyId: mapping.pmsPropertyId, sourceSystem: 'guestra_crm',
          externalEntityType: 'property', externalEntityId: mapping.crmPropertyId, localEntityType: 'property',
          localEntityId: mapping.pmsPropertyId, metadata: mapping }).returning({ id: integrationLinks.id });
        await tx.insert(auditLogs).values({ propertyId: mapping.pmsPropertyId, entityType: 'integration_mapping', entityId: row.id,
          action: 'create', description: 'Operator-confirmed property integration binding', newValue: mapping });
      }
    }
  });
}
async function main() {
  if (process.env['CONNECT_CREDENTIAL_BOOTSTRAP_ENABLED'] !== 'true') return;
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL_REQUIRED');
  const records = parseBootstrapCredentials(process.env['CONNECT_CREDENTIALS_BOOTSTRAP'] ?? '[]', process.env['INTEGRATION_ENVIRONMENT'] ?? 'production');
  const client = postgres(process.env['DATABASE_URL'], postgresOptionsFromEnv());
  try {
    const db = drizzle(client);
    await bootstrapConnect(db, records);
    if (process.env['GUESTRA_REGISTRY_ENABLED'] === 'true') await bootstrapPropertyMappings(db,
      JSON.parse(process.env['CRM_PROPERTY_MAPPINGS'] ?? '[]'), process.env['INTEGRATION_ENVIRONMENT'] ?? 'production',
      process.env['GUESTRA_PROPERTY_MAPPING_CONFIRMED'] === 'true');
  }
  finally { await client.end(); }
  console.log('Connect credential bootstrap verified');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Connect bootstrap refused; verify property, immutable credential bindings, scopes and revocation state'); process.exitCode = 1; });
}
