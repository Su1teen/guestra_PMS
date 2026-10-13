# PMS integration API v2

Base: `/api/v1/connect/v2`. Header `x-api-key`; existing property-scoped credential plus exact capability and `environment:<name>`. Enabled mode and local DB attestation are mandatory. Business writes need the private CRM command signature. See [shared contract](CROSS_DATABASE_CONTRACT.md).

| Method/path | Capability / purpose |
|---|---|
| GET /capabilities | integration.read; contract/environment/property/tenant/feature attestation |
| POST /search | integration.read; inventory and canonical rates |
| POST /quote | integration.read; signed price for property/customer/dates/category/rate/occupancy |
| POST /book | integration.write; acceptedQuote + idempotencyKey + CRM integrationContext |
| POST /reservations/:id/amend | integration.write; customerId/key/expectedUpdatedAt/acceptedQuote |
| POST /reservations/:id/cancel | integration.write; customerId/key/expectedUpdatedAt/reason; atomic policy settlement |
| GET /services | integration.read; live bookable catalog |
| POST /services/availability | integration.read; exact resource/calendar/price availability |
| POST /services/book | integration.write; expectedTotal, stable key and verified CRM origin |
| POST /services/:id/reschedule | integration.write; customerId/key/expectedRevision/new time |
| POST /services/:id/cancel | integration.write; customerId/key/expectedRevision; financial consequences |
| POST /guest-requests | integration.write; operational request with verified CRM customer origin |
| GET /entities/:type/:id | integration.read; propertyId/customerId-owned authoritative snapshot |
| GET /operations/:key | integration.read; propertyId/customerId-owned committed receipt + snapshot |
| GET /events | events.read; propertyId/after/limit, nextCursor/hasMore |
| POST /sandbox/fixtures | sandbox.setup; dedicated-property setup |
| GET /sandbox/fixtures/:key | sandbox.setup; propertyId/customerId read-back |
| POST /sandbox/fixtures/:key/retire | sandbox.setup; isolated fixture inventory release |
| POST /sandbox/fixtures/:key/simulate-payment | sandbox.setup; labelled simulation only |

Entity types: reservation, service_booking, service_request, folio, payment. Safe snapshots omit private accepted-quote fingerprints, staff notes and provider tokens. Folio receivedAmount is actual PMS net ledger evidence; simulated fixtures cannot alter it. Current paymentLinks capability is false.

DTOs and Swagger operations are in apps/api/src/modules/connect/dto/connect-v2.dto.ts and connect-v2.controller.ts. Retire/simulate fixture calls use the fixture DTO fields; CRM forwards the stored fixture identifiers rather than accepting arbitrary guest IDs.

Authenticated Dashboard Inbox: GET `/api/v1/guest-inbox`, GET `/api/v1/guest-inbox/:id`, POST `/api/v1/guest-inbox/:id/takeover`, each with propertyId. A real local staff identity and communications.manage are mandatory even in a demo configuration. Reservations/services/operational requests/finance are returned only with their respective effective grants. PMS fetches guest messages from CRM and does not copy them into its operational database. CRM unavailable yields an explicit unavailable state. Read windows are bounded; CRM remains the full guest transcript owner.

Flags GUESTRA_INTEGRATION_V2_ENABLED, GUESTRA_INBOX_ENABLED, VITE_GUESTRA_INBOX_ENABLED and GUESTRA_SANDBOX_SETUP_ENABLED default OFF. Inbox UI and backend flags are separate build/runtime settings. Environment template: .env.integration.example.
