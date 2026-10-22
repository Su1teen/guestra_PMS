# Isolated Railway sandbox for CRM, PMS and Studio

The sandbox is a separate Railway environment (`sandbox`) in the same project. It has its own
databases, Redis and three services, so production data, credentials and flags are never shared.
`INTEGRATION_ENVIRONMENT=sandbox` plus a `sandbox` database attestation are what the fixture
endpoints require; a production deployment can never run them.

## Layout

| Service | Role | Notes |
|---|---|---|
| `Postgres-*` (3) | PMS, CRM and Studio databases | Enable a TCP Proxy (port 5432) on each **database** service only to run the one-off schema init |
| `Redis` | PMS cache/queue | `REDIS_URL=${{Redis.REDIS_URL}}` |
| `sandbox-pms`, `sandbox-crm`, `sandbox-studio` | Applications deployed from `main` | `DATABASE_URL` uses reference variables to the matching database |

## Order of operations

1. Generate the env with `pnpm integrations:generate-config` using `"environment": "sandbox"`, new
   stable `databaseDeploymentIds` and a fresh sandbox PMS property UUID. Never reuse production IDs.
2. Create the schemas before the first deploy (the pre-deploy refuses an empty database):
   PMS `node packages/database/dist/run-migrations.js`; CRM `db:migrate` then `db:bootstrap`;
   Studio `scripts/bootstrap.ts`. Run from Linux/LF checkouts or normalise line endings first,
   otherwise Drizzle stores CRLF-based hashes and the CRM pre-deploy reports
   `LEGACY_MIGRATION_CHECKSUM_DRIFT`.
3. Seed the dedicated sandbox property in PMS (organisation-less property, room type, rooms, rate
   plan, tax rule, service) and in CRM (property under the existing organisation).
4. Apply the generated env, plus for the sandbox only: `GUESTRA_INTEGRATION_MIGRATIONS_APPROVED`,
   `GUESTRA_INTEGRATION_V2_ENABLED` / `CRM_PMS_INTEGRATION_ENABLED`, `GUESTRA_REGISTRY_ENABLED`,
   `GUESTRA_SANDBOX_SETUP_ENABLED` and `GUESTRA_BUSINESS_WRITES_ENABLED` set to `true`; add the
   `sandbox.setup` scope to the CRM service credential and a sandbox-only operator principal;
   Studio gets `STUDIO_SANDBOX=true`, `STUDIO_ENVIRONMENT=sandbox` and `SANDBOX_ALLOWED_HOSTS`.
5. Deploy PMS, CRM, Studio. Register the property in `guestra_sandbox_properties` of PMS and CRM
   after the integration migrations created that table. Run the Studio pre-deploy if its
   migration 003 and attestation are missing.
6. Verify: CRM readiness, PMS diagnostics, Studio `/api/integrations` and a fixture round trip
   (`POST /api/integrations/agent/v2/sandbox/fixtures`).

Production keeps `GUESTRA_BUSINESS_WRITES_ENABLED=false` until the sandbox end-to-end run,
including the real n8n workflow, has passed.
