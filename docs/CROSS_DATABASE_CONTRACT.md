# Guestra cross-database contract v2

Status: implemented APIs and isolated contract tests. Real n8n/AI execution, payment-provider validation and production activation are external follow-up work.

## Ownership and boundaries

| Independent PostgreSQL | Authoritative data |
|---|---|
| CRM | Customers (legacy local table `guests`), scoped identities, conversations, messages, Requests (`leads`), Offers, commercial projections |
| PMS | Guests, inventory, reservations/stays, services, operational requests, folios, charges, payments and operational events |
| Studio | Virtual Clients, Test Sessions, Agent Configurations, Prompt Versions, Annotations and Execution References |

CRM's legacy operational tables remain for its independent existing account workflows. The enabled integration writes PMS operational records through its API and writes only CRM commercial records, mappings and projections locally. No shared schema, foreign database query, foreign-data wrapper, distributed transaction or production DB credential is given to Studio/n8n. Each server connects only to its own database.

A Studio client ID, CRM Customer ID and PMS Guest UUID are different identifiers. Phone/email similarity never establishes a mapping. CRM external identities include property and channel; PMS uses its existing property-scoped `integration_links` for the explicit CRM customer origin. CRM's mapping is accepted only after an owned PMS API read-back. Changing an existing mapping fails instead of silently reassigning another guest.

Property mappings pin both tenant IDs, both property IDs and the environment. Capabilities verify the remote contract version, property, tenant, deployment attestation and environment. A local `guestra_integration_deployment` marker must agree with the server environment. Missing schema/configuration fails closed. A scalar property is mandatory in every scoped request; array/wildcard property access is denied.

## Defaults and compatibility

All new operational integration, sandbox setup and PMS Inbox flags default OFF. Optional integration SQL is outside the standard migration journal and is never applied by application startup or the Railway release command.

CRM mock mode keeps its complete in-memory account and performs no business integration/DB writes. A logged-in mock session cannot use integration endpoints even with a supplied service key. Database mode uses real CRM rows, polls for committed updates and discards responses belonging to an earlier account/mode. Existing demo fixtures and login credentials are preserved.

When integration is OFF, existing Telegram and v1 operational flows remain available. When ON, legacy operational agent paths return `PMS_V2_REQUIRED`; v1 inbound, context, commercial requests, transcript, handoff and transport-result callbacks remain compatible. Never enable v2 before its consumers have migrated. Guest transcript/context excludes internal notes. Financial updates cannot resume an AI conversation owned by a human.

## Critical operation protocol

1. Persist CRM guest input using channel/property/external user/message IDs. Returning identity resolution uses the scoped identity, not the phone.
2. Obtain PMS availability and a canonical quote. The signed quote binds customer, property, category, rate plan, dates, occupancy, exact tax-inclusive/exclusive price and expiry.
3. Persist the outbound proposal with exact action payload and a pending delivery state. HTTP success from prepare is not delivery.
4. Transport must send once using its stable key, then acknowledge the real result. A later inbound guest confirmation must reference the delivered proposal in the same conversation; proposal expiry, payload hash and current ownership are checked.
5. CRM claims the confirmed action and persists a pending operation in one local transaction. Its payload/fingerprint/key are immutable.
6. The worker checks PMS operation receipts before retrying a write. PMS applies the domain mutation, receipt and outbox in one local transaction, with property/inventory locks and uniqueness checks.
7. CRM reads the owned entity back from PMS and updates mappings/projections/commercial lifecycle in its own transaction before marking the operation completed.

A timeout after PMS commit leaves a recoverable pending CRM operation. Repeat with the original idempotency key and identical payload. Do not create a new key for transport retries. Reusing a key for a different payload is a conflict. Quote/revision/ownership conflicts are rejected without pretending the booking succeeded. Reservation cancellation includes policy settlement locally; amendments include inventory, accepted price and folio changes atomically. Service cancellation reports reversal/refund review consequences and never claims a refund just from a status change.

One commercial Request maps to one verified PMS reservation. A pending booking must finish or recover before another booking attempt for that Request. A different booking requires a new Request; completed or cancelled mappings are never reassigned. Accepted PMS prices update CRM commercial totals without creating local operational or financial records.

PMS entity snapshots read identity, row, event revision and financial facts in a local repeatable-read transaction. PMS ledger math uses the existing canonical net-payment predicate, including negative captured refund children and supported legacy parent statuses. Prepaid/virtual-card flags do not create captured payment facts. Payment link capability is currently false: production links need a real provider adapter. Simulated fixture payments are explicitly labelled and never enter the payment ledger.

CRM integral KZT Offer columns reject fractional/non-KZT accepted prices with `CRM_MONEY_PRECISION_UNSUPPORTED`. They do not round an accepted PMS quote. Supporting those currencies needs a separately reviewed commercial-money migration.

## Durable event protocol

Envelope `schemaVersion: guestra-domain-event-v1`, `sourceSystem: guestra_pms`, eventId UUID, eventType, propertyId UUID, tenantId, entityType, entityId UUID, optional guestId, positive revision, occurredAt, and optional sanitized CRM integrationContext (sourceSystem/customerId/requestId/offerId/conversationId/operationId). No message text, staff notes, secrets, signed links or provider tokens enter the event.

PMS reuses `domain_event_outbox`. Opt-in database triggers capture reservation, service, operational request, folio/charge and payment lifecycle changes, including changes through existing PMS staff APIs. Property counters serialize at transaction commit order. CRM has its own immutable outbox with scoped commit sequence for customer/conversation/commercial/guest-message changes. Delivery metadata can change; committed business envelopes cannot.

Delivery is at least once. CRM first persists event ID plus envelope fingerprint in its local inbox. Identical replay is harmless; changed payload for an existing ID is rejected. Applying an event means authoritative PMS read-back, not trusting a stale event payload. Projections only move to a higher revision. Unknown mappings/unavailable PMS leave a pending receipt. Out-of-order events cannot revert a cancellation or human ownership.

CRM recovery runs every 15 seconds when enabled: pending commands, pending inbox receipts and the PMS event feed. Feed cursor advances only after all returned envelopes have durable local receipts. A backlog follows paginated `nextCursor`/`hasMore`. Manual reconcile retries due local operations/receipts and reports actual completed/rejected/applied counts. Persistent network failures retain their receipts with bounded backoff; they do not disappear. Existing PMS webhook delivery retry/dead-letter mechanisms are retained. After a delivery exhausts retries, repair connectivity/credentials and replay the same event or use the durable feed. Investigate repeatedly pending CRM receipts and rejected commands rather than issuing replacement keys.

CRM consumer acknowledgement is monotonic and scoped by principal/property. Guest message changes have a separate commit sequence and include delivery changes, attachment processing changes and tombstones; use this instead of treating mutable sentAt as an immutable cursor.

## Authentication and transport

CRM service callers use `x-crm-api-key`, whose SHA-256 digest matches a configured principal: id, keyHash, environment, propertyIds, scopes, optional workspaceIds and revoked flag. Required agent/tool and business scopes are checked independently. V2 does not accept an unscoped legacy secret. Rate limit is 120 requests/minute per process/principal; deploy shared edge limits for multiple replicas.

PMS callers use `x-api-key` and an existing property-scoped connect credential with exact capabilities and `environment:<name>`. V2 business writes additionally require a CRM-only HMAC secret. Sign:
`timestamp + "." + HTTP_METHOD + "." + URL.pathname + "." + JSON.stringify(body)`
with SHA-256; send lowercase hex `x-guestra-command-signature` and epoch-second `x-guestra-command-time`. Window is five minutes. CRM retains the signing secret server-side; Studio/n8n never receive it.

PMS events use `x-guestra-timestamp` and hex `x-guestra-signature` over timestamp + "." + exact raw JSON body. CRM verifies before persistence. The dedicated PMS webhook additionally resolves the verified property/tenant mapping. Do not reuse command/event/media/outbound secrets. HTTPS is mandatory except explicit loopback test URLs; redirects and credential-bearing URLs are rejected; outbound timeout is ten seconds. Never log keys or signed media/payment URLs.

Rotation: create a new scoped principal/credential, deploy consumers with the new key, verify capabilities/read-back, then revoke the old principal/credential. Maintain separate production/sandbox keys and allow only the properties/tools a caller needs. Staff Inbox never exposes these keys to a browser.

## Media and observability

Inbound attachment metadata preserves an external file reference. A trusted media adapter must scan/store the binary and attest a clean reference for the exact workspace/customer/conversation/property. Supported MIME types, 20 MiB limit, allowlisted HTTPS origin and a maximum five-minute remote reference lifetime are enforced. Only ready + clean owned references are eligible for outbound messages. CRM issues a signed no-store read capability lasting at most 60 seconds and rechecks ownership/expiry on retrieval. An unavailable/expired/processing asset stays unavailable; metadata alone is not playable media. Binary scanning/storage and PBX transport remain external adapters.

Sanitized inspector records HTTP acceptance, deliveryStatus/operationStatus when returned, durations, safe error codes and stable correlation/execution/prompt/deployment/message/operation refs. HTTP acceptance alone is not a business completion or delivery receipt. Hidden reasoning, raw guest/staff payloads, secrets and provider tokens are excluded.

## Studio / n8n readiness

Current Studio `server/integrations.ts` sends simulator inbound to the CRM v1 endpoint with `x-crm-api-key` and reads the v1 guest transcript. Those shapes remain compatible. Studio currently owns its own virtual IDs and retains separate CRM refs; the new PMS guest mapping must come from verified API evidence, never equal-ID inference. Studio source is deliberately unchanged.

Required future workflow:
- Configure separate sandbox service keys and exact property/tenant/environment mapping; verify both capabilities.
- Choose one inbound owner per attempt (Studio gateway or n8n), retain stable attempt/message/idempotency/correlation IDs, and persist external execution references in Studio only.
- Use CRM commercial request APIs and the v2 PMS-backed search/Offer API. Use v2 context and message changes; drain pages and reconcile delivery/media changes.
- Prepare a proposal, deliver through the actual simulator/channel transport, acknowledge the real delivery result, then submit the guest-confirmed v2 action.
- Treat pending operations as pending, poll the scoped receipt until completed/rejected and display the read-back result.
- Configure signed PMS webhook plus feed catch-up, transport acknowledgements and trusted media scanning/reference callbacks.
- Use sandbox fixture setup/read-back APIs for journey scenarios, label simulated payment outcomes and retire fixtures.
- Run real n8n + Studio + CRM + PMS tests with authorized sandbox credentials before enabling production. Contract-test orchestration is not a real AI execution.

## Isolated fixtures

Privileged `sandbox.setup` works only with setup flag ON, test/sandbox server environment, matching DB attestation and explicitly registered dedicated property/tenant. PMS registration pins the category, rate plan and service. CRM staff must exist in that test organization. Registration is operator-owned; neither Studio nor n8n writes registration SQL.

Stages: new_contact, returning_customer, enquire, tentative, definite, pending_payment, confirmed_reservation, pre_arrival, in_house, service_only, due_out, post_stay, cancelled, human_handoff. APIs create real isolated CRM/PMS records with distinct IDs, verify PMS snapshots and return references. Same key/payload replays; altered payload conflicts. A service-only setup can recover a partially completed local/remote operation. Expiry is 24 hours; PMS sweeps expired fixtures every minute, releasing only their inventory while retaining audit/receipts/financial history. Explicit retire closes its CRM dialogue and releases its PMS fixture resources. Expired/retired keys cannot be reused.

Payment simulation returns `source: simulated, ledgerEffect: false, providerVerified: false`; it cannot turn a PMS reservation/payment into a provider-verified paid record.

## Migration, activation and recovery

1. Keep integration flags OFF. Back up each database independently; review its optional SQL against its current schema and expected local lock/index cost.
2. On new isolated loopback databases whose names end in `_integration_test` or `_sandbox`, apply the repository's existing baseline migrations, then run `node scripts/setup-integration-test.mjs` with explicit DATABASE_URL and INTEGRATION_ENVIRONMENT=test/sandbox.
3. The helper rejects production/non-loopback targets, keeps an installation checksum ledger and creates environment attestation. A second invocation verifies the same migration. Never rewrite an installed SQL version.
4. Production migration is a separately reviewed manual DBA operation while flags stay OFF: apply only this repository's optional SQL in a local transaction, record checksum/install version and insert its production deployment marker. Do not run the automated helper against Railway. Existing journals/seeds are unchanged.
5. Register approved mappings/credentials/media origins; sandbox properties only in isolated test databases. Verify independent database backups and scoped read-only capabilities.
6. Activate PMS v2, then CRM integration and separately the authenticated PMS Inbox after compatible consumers are deployed. Verify read-back and event catch-up before allowing new guest operations.

Rollback: turn new flags OFF first and restore the prior application version if required. Retain additive tables, outbox, immutable receipts and mappings; do not delete live guests/messages/reservations/folios/payments. Export pending/rejected receipts for audit. Restore connectivity or deploy a compatible fixed consumer and resume using original keys. Disabling a mode does not undo a PMS operation already committed; recover it from its PMS receipt/read-back. Do not automatically drop triggers/tables or restore one database behind the other's commit history. Forward schema repair gets a new reviewed migration version.

## Staff two-way sync (front desk ↔ CRM)

The agent contract above is guest-scoped. Front-desk work needs both systems to show the same stays, so a separate staff mirror runs over the same credentials, signatures and event feed:

- **PMS → CRM.** Every reservation, folio/charge, payment and service-booking event is resolved by `GET connect/v2/sync/resolve/:type/:id` to a full staff snapshot and mirrored into CRM reservations, stays, units, folio lines, payments and service bookings. A PMS-native guest becomes a new CRM customer (contacts never merge people) and `POST sync/links` records it in PMS `integration_links`.
- **CRM → PMS.** Stays, folio lines and payments created in CRM are applied by `POST sync/apply` exactly once (`crm:fline:` / `crm:payment:` source keys, `crm:reservation:` booking idempotency). The category is matched by name and capacity; an unmatched category is rejected (`CATEGORY_NOT_MAPPED`) rather than guessed, and `GUESTRA_SYNC_CATEGORY_MAP` (PMS, JSON `{ "CRM name": "PMS room type code" }`) can map it explicitly. The stay status only moves forward; PMS check-in rules (room assignment, signed registration card) still apply and a refusal is kept in CRM `guestra_staff_sync_failures`.
- **Money.** A stay is billed in CRM as one accommodation line with the accepted PMS total; PMS room-night charges, their taxes and deposit moves are not mirrored line by line, and CRM never sends accommodation as a PMS charge. Other charges and payments are mirrored in both directions, never echoed back.
- **Switch-on.** CRM `GUESTRA_STAFF_SYNC_ENABLED=true` and `GUESTRA_STAFF_SYNC_SINCE=<ISO instant>`: only CRM records and PMS events from that instant are synced. State lives in CRM `guestra_staff_sync` (integration migration 0002). A failed mirror keeps its event receipt pending with backoff.
