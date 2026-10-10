# PMS workspace release 1 — draft implementation

This branch replaces the existing staff UI components in their existing routes. It is not approved for production or a claim that the complete PMS 2.0 scope is finished.

## Existing systems reused

| Area | Existing source retained | Change |
| --- | --- | --- |
| Staff home | Dashboard reports, room summaries, operations attention | One configurable canvas around the existing widgets, plus operational queue widgets |
| Reservations | ReservationService, party service, notes, messaging | One drawer/page workspace replacing the duplicated reservation and Front Desk detail implementations |
| Calendar | Rooms, reservations, iCal, AvailabilityService | A complete bounded calendar API replaces the paginated list used as calendar inventory |
| Guests | GuestService.get360, Guest360Panel, guest_property_links | Independent Quick View; explicit membership covers guests without stays; service schedules remain separate from ledger revenue |
| Front Desk | OperationsService.preArrivals, existing check-in/out workflows | Live readiness indicators and reservation deep links reuse the existing operation rules |
| Notifications | Existing notification table, per-user read receipts, gateway | Hotel events, audience permissions, deduplication and controlled action links |
| Pricing | Canonical room pricing, RatePlanService, TaxService | Each night uses its own stayDate with full-stay LOS context; staff creation validates a fresh accepted quote |
| Integration events | WebhookService.dispatchPersisted, existing delivery consumers | Staff creation commits a durable outbox consequence with its audit record |

## Contracts and storage

- `users.preferences.workspaces[propertyId]` stores `{revision, layout}`. Layout version 2 allows up to eight pages and a bounded widget registry. Server validation rejects arbitrary fields, URLs, SQL and guest records. A user-row lock and expected revision prevent lost updates; report favorites and other properties are preserved.
- `GET/PATCH /v1/admin/me/workspace` require dashboard access and the active property scope. Configured widget properties must also belong to the user's allowed scope. Templates do not grant permissions. Auth-disabled sessions explicitly support local persistence only.
- `GET /v1/reservations/calendar` returns all intersecting active stays, rooms, categories, iCal blocks and availability for at most 31 nights in a read-only repeatable-read transaction. It has no list-page truncation.
- `GET /v1/reservations/calendar-ledger` separately requires `folios.read`; indicators describe posted payments and positive ledger balances, not estimated payment of future unposted nights. No cross-currency monetary aggregation is added.
- `POST /v1/reservations/quote` and `calendar-prices` use canonical pricing. Calendar prices are one-night previews. Accepted multi-night totals are recomputed by the server.
- `POST /v1/reservations/staff-create` locks a property/request namespace, validates guest membership, tariff, party and price, and creates/confirms/optionally assigns within one transaction. The immutable pricing snapshot is accepted through the existing reservation path. Replays return the same stay before repricing; changed request details conflict.
- `0030` adds nullable notification audience/deduplication fields and a unique property/deduplication index. `0031` adds the property-scoped event outbox. Both Drizzle and push-schema definitions are aligned. No migration has been executed against production.
- Staff-created events are persisted with the operation, dispatched after commit, and recovered periodically. Delivery is at least once; consumers use the stable logical event id. This does not convert every legacy operation to durable delivery.
- In-house room moves now lock the stay and both physical rooms, check overlap and update both room statuses in the same transaction. UI drag-to-move remains disabled pending PostgreSQL concurrency verification.

## UI scope implemented

- Multiple named home pages, five presets, initial page, add/remove/order widgets, pointer drag ordering, keyboard ordering, width/height controls, supported property/period/density settings and server save with conflict handling. OCC, ADR, RevPAR, pickup and booking pace now have independent property/period/density settings and read the existing Reports APIs. Existing saved aggregate widgets remain compatible; new management/revenue templates use the independent metrics. Historical ADR/RevPAR cards explicitly describe the existing daily-average report semantics.
- Standalone Guest Quick View from calendar, home arrivals, guest list, search, Front Desk and reservation context. The same Guest 360 content serves the full profile. The drawer is suspended before Quick View opens; closing Quick View restores the selected reservation, tab and drawer scroll without unmounting the calendar.
- Shared contextual reservation drawer and `/reservations/:id` page. Full page exposes overview, accommodation, guests, services, folios, tasks, notes and history tabs. Operational mutations continue to use existing services and Front Desk workflows.
- Calendar 7/14/28-day views, date navigation, category/status/search/accessibility filters, continuous stay bands, room states, canonical tariff previews, ledger indicators and keyboard selection of a free night.
- Russian default locale, safe translated error boundary/toasts/validation messages, translated notification chrome and known legacy system notices, guest/readiness/status labels and help-panel chrome. User-authored text, brands, acronyms and other locale resources are retained.

## Follow-up validation and remaining gates

The Guest 360 HTTP regression was reproduced on real PostgreSQL: selecting all audit columns included the internal BigInt timeline sequence, which Express could not serialize. Guest 360 and reservation audit history now project only their public timeline fields. Service-only clients are included through property-scoped service bookings in guest lookup, search and staff creation eligibility.

The drawer shows guest notes, booking notes, special requests and read-only operational comments immediately. Compact history reads Guest 360 and excludes the selected stay. The full booking page routes check-in, checkout and room move to existing Front Desk forms; confirm/cancel/no-show use existing scoped lifecycle APIs. Drawer editing controls remain on the full workspace.

Inclusive pricing now uses the same ordered, rounded TaxService rules in both directions, including compounding, split components, flat taxes, night caps and guest exemptions. Exact cent decomposition is required; impossible gross values fail closed rather than changing a tax or total. A nightly charge bills one flat night and charges a flat stay fee only on the first night.

A session receipt stores only the request UUID, scoped to actor/property. The new result endpoint takes the existing request advisory lock and returns a committed reservation without repricing. After a browser reload, an unconfirmed result is deliberately not permission to create another request: the receipt remains and new creation is blocked. A terminal recovery/fencing workflow for a request that never committed remains open.

Calendar iCal blocks now have separate category/date rows. Reservation and availability indexes remove repeated whole-range scans in each room/cell. This is not a verified large-hotel virtualization or load result. Pickup now counts bookings cancelled later in its historical baseline and offsets additions cancelled within the same booking window. Readiness no longer treats a historical inspection as making a currently dirty/OOO room ready, or mixes deposit currencies. These indicators do not implement additional deposit or registration policies.

### PASS

- Complete local workspace suite: 2,373 passed cases in 292 files with passes; 53 skipped cases excluded. Later guest membership changes received focused guest/staff and real HTTP checks.
- Workspace build, all package type checks and lint (zero lint errors; existing warnings remain). A missing import exposed by typecheck was restored; a concurrent dependency rebuild caused a separate transient type resolution failure, followed by a passing API check after build.
- Real PostgreSQL 16.15: six Guest 360 HTTP/RBAC/property/service-only cases, nine operation/pricing/pickup/readiness cases, four workspace/notification/migration cases, and six accepted-pricing mutex cases. External delivery ports are doubles in the outbox test.
- Core migration runner and optional booking-request migration runner on the isolated local database. Migrations 0030/0031 were also applied twice to an isolated legacy schema with notification/read-receipt preservation assertions.
- Focused UI tests and a local browser fixture check: immediate notes, expandable history, a single Quick View dialog, restored reservation/filter/date/28-day scale, and guest-list opening without contact fields. Browser fixtures are synthetic and are not production or database evidence.

### NOT VERIFIED / requirements still open

- Actual Keycloak login/JWT verification and persistence across devices; HTTP guard tests inject a test identity but execute real property membership and PostgreSQL RBAC.
- Redis-backed full release smoke and the published-head CI result, until GitHub Actions executes. The workflow now explicitly runs the core PostgreSQL tests before optional-package migrations, then financial mutex checks and the existing release smoke.
  Repository Actions is enabled and the CI workflow is active, but the initial follow-up PR check query returned no workflow runs. This is not a successful CI result; the trigger must be verified on the published revision.
- Live CRM/n8n/channel sandbox delivery, process-kill recovery and the complete legacy event delivery surface. Passing contract tests are not proof of live provider certification.
- Terminal recovery after a reload when the original request never committed.
- Date-scoped planned OOO/OOS, virtualized large-hotel performance and concurrency between room moves and check-in/other moves. Existing OOO/OOS remains blocked until explicit manual return; resolved maintenance does not reopen it automatically.
- Complete accommodation mutation parity (including changes protected by accepted-pricing invariants), service/task authoring from booking context, readiness policy completeness, all viewport/focus paths, all legacy enum/help/export/print translations. Forty visible legacy text instances plus report/payment labels were localized; this does not assert a complete Russian audit.

No production migration or deployment was performed. Keep the follow-up PR draft, finish the outstanding P0/P1 gates, then start P2.
