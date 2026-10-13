# Integration test evidence

Verified locally on 14 October 2026. Production databases, credentials, seeds and real customer operations were not used. Studio source was inspected read-only.

## Results

| Check | Actual result |
|---|---|
| CRM full suite | 29 files, 245 passed tests |
| PMS complete workspace suite and published-count synchronizer | 329 files with passes, 2,575 passed tests; skipped cases excluded |
| Live PMS PostgreSQL v2 suite | 7 passed, including real CRM/PMS HTTP with two independent databases |
| CRM/PMS type checking | Passed |
| CRM/PMS lint | Zero errors; existing warning-level checks remain |
| CRM/PMS builds | Passed; PMS shared/database/booking-requests/API/booking/Dashboard built |
| Optional SQL installation | Applied and repeated on each isolated DB; checksum/attestation setup helpers passed twice |
| Browser CRM | Six loaded workspaces in each account, database rows from real local PostgreSQL, mock makes zero /api/crm requests, database → mock switch isolated, zero page exceptions |
| Browser PMS | Enabled Inbox with explicit HTTP contract fixtures: list, transcript, operational/financial context, takeover response and CRM unavailable; built default-OFF mode verified; zero page exceptions |

The headless browser used installed Chrome. CRM browser tests used actual CRM API and its isolated PostgreSQL. PMS UI tests deliberately supplied HTTP contract fixtures: they do not prove a live Keycloak session or external CRM/n8n production connectivity. PMS staff permissions and CRM attestation/outage behavior were separately checked by unit tests; business integration used actual local Nest/Express HTTP boundaries and real PostgreSQL transactions.

## Test boundaries and invariants

- Scoped returning identities; same phone with distinct channel/property identities never auto-merges.
- Mock sessions cannot write through service integration endpoints.
- Staff notes stay in CRM for staff but never enter the guest transcript, changes feed or AI context.
- Outbound prepare is pending; only explicit transport acknowledgement changes delivery. Delivery/media edits and tombstones have new cursor positions without changing old message IDs.
- Delivered proposal plus a later guest confirmation, exact payload/expiry/current AI ownership are required for critical commands.
- Simultaneous first bookings create exactly one PMS guest/link/reservation. Accepted canonical rate/tax price is preserved; changed/expired quotes are rejected.
- Lost PMS response recovers via the original remote receipt; no duplicate operation/charge or CRM operational/financial clone.
- PMS service booking posts one actual charge. Operational guest requests are owned and idempotent.
- Amend/cancel exercise accepted pricing, revisions, inventory, local folio/policy settlement and rollback on injected failure.
- PMS signed events update CRM projections using authoritative read-back; stale event delivery cannot revert the current state. Commercial stage/lifecycle history is recorded once per state transition.
- Handoff is sticky; a late AI proposal/action is denied. Financial changes do not resume AI.
- Media checks cover MIME/size/origin/workspace/ownership/readiness, signed token tampering and expiry.
- Sandbox setup validates all 14 real journey states through both APIs. IDs differ across systems, repeated setup returns the same refs, changed input conflicts, retired fixtures are unavailable and production setup is denied.
- Confirming a simulated payment changes only explicitly labelled fixture metadata; the actual payments ledger remains byte-for-byte unchanged.
- Reports tolerate a confirmed Request with no observed stage timestamp and omit it from average duration instead of inventing a time.

## Reproduction

CRM: install locked dependencies, then run npm run typecheck, npm run lint, npm test, npm run build.

PMS: install frozen pnpm dependencies; build workspace packages; run pnpm typecheck, pnpm lint, pnpm build. With an explicitly isolated test PostgreSQL and the existing test prerequisites, run the repository's scripts/sync-test-count.mjs (Windows requires npm_execpath to point to pnpm's Node entry). The published count reflects all workspace packages containing tests.

For live v2 tests, use a loopback PMS database ending in _integration_test, apply existing baseline migrations and the opt-in setup helper. Set PMS_LIVE_PG=1 and run apps/api/src/modules/connect/connect-v2.postgres.spec.ts with Vitest from apps/api. For the actual two-repository HTTP case also set GUESTRA_CROSS_REPO=1, CRM_TEST_ROOT to the matching CRM checkout and CRM_TEST_DATABASE_URL to a different loopback CRM database ending in _integration_test. Apply CRM's existing baseline/bootstrap only on this explicitly isolated test DB. The fixture refuses production/non-loopback targets.

CI retains PMS's complete suite and PG16/PG18 release smoke, adds a separate isolated v2 PostgreSQL job, and introduces CRM CI for typecheck/lint/tests/build. The created PR checks and final delivery report provide the remote CI/merge evidence.

## External activation work

No real n8n workflow ran. No external agent/LLM conversation, Keycloak staff login, signed storage scanner, payment gateway, PBX, Railway production integration activation or production optional migration is claimed here. Those require authorized sandbox/production credentials, reviewed independent schema rollout, compatible Studio/n8n adapters and final live tests described in CROSS_DATABASE_CONTRACT.md.

Both repositories retain default-OFF gates and optional migrations outside normal startup. Existing accounts/seed definitions and production credentials are preserved.
