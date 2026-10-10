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

- Multiple named home pages, five presets, initial page, add/remove/order widgets, pointer drag ordering, keyboard ordering, width/height controls, supported property/period/density settings and server save with conflict handling. Coarse report widgets retain their fixed current-property/day contract.
- Standalone Guest Quick View from calendar, home arrivals, guest list, search, Front Desk and reservation context. The same Guest 360 content serves the full profile. Drawer closes before Quick View opens.
- Shared contextual reservation drawer and `/reservations/:id` page. Full page exposes overview, accommodation, guests, services, folios, tasks, notes and history tabs. Operational mutations continue to use existing services and Front Desk workflows.
- Calendar 7/14/28-day views, date navigation, category/status/search/accessibility filters, continuous stay bands, room states, canonical tariff previews, ledger indicators and keyboard selection of a free night.
- Russian default locale, safe translated error boundary/toasts/validation messages, translated notification chrome and known legacy system notices, guest/readiness/status labels and help-panel chrome. User-authored text, brands, acronyms and other locale resources are retained.

## Release gates still open

- Run migrations and real PostgreSQL contention/rollback tests for staff creation, move-room, workspace revisions, notification deduplication and outbox recovery. Unit tests and synthetic browser fixtures are not substitutes.
- Verify release smoke, CRM/n8n/channel contracts and all GitHub Actions on the published head.
- Tax-inclusive staff tariffs currently fail closed because the existing canonical engine lacks verified gross-to-net decomposition for every tax rule. Complete that work before enabling them in the new creation flow.
- Finish full-page accommodation actions and parity checks across all existing reservation actions; avoid nested operation modals in the drawer. Verify staff creation recovery across browser reloads, not only retries within the current dialog.
- Complete calendar pooled-iCal presentation, date-scoped OOO/OOS restrictions and large-hotel performance/virtualization checks. Do not enable reservation drag mutations before backend concurrency tests pass.
- Complete the remaining Russian audit across every legacy page, backend-generated help text, exports/print forms and system enum fallbacks.
- Complete readiness policy checks (deposit rules, guest data, operational tasks), workflow permissions and operational closure scenarios end to end.
- Verify authenticated persistence and role differences per property in a real test environment. Synthetic browser fixtures exercise layout/navigation only.

## Validation

The complete local workspace run passed 2,350 test cases in 286 files containing passed tests. Skipped cases are excluded from published totals. Workspace build/typecheck/lint passed; lint retains warnings. The final UI string and guest eligibility changes were followed by focused validation. Two additional real-PostgreSQL scenarios were added to the existing release smoke job for concurrent staff request replay and rollback on failed physical-room assignment; their execution is NOT VERIFIED locally.

Validation evidence and final counts are recorded in the accompanying implementation report. The first full run exposed failures already present at the base commit; these were reproduced in an isolated base snapshot. Test fixtures were corrected for explicit business dates, real future service dates and current API/transaction shapes without weakening amount or replay assertions. The Connect booking response also restores the expected roomNumber field.

Keep this PR draft until the open gates are closed. Do not merge or deploy automatically. Apply additive migrations through the existing migration runner only in a verified test/staging environment before promotion.
