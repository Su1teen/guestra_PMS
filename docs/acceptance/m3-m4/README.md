# M3 / M4 — implementation and acceptance evidence

Base: `0dbc7f80893a0846dd3d419f2bd822620b3d4092`. Changes are confined to Management reporting, the existing Workspace Builder, and their contracts/tests. No production deployment, seed or database change is part of this delivery.

## Management

The business route `/reports/management` now renders PMS data through the existing ReportsService and Financial Foundation. The old developer demo remains a separate named export for its existing tests; there is no demo switch on the business route. Properties come from PropertyContext, without a fixed hotel list.

The hierarchy retains the existing visual composition, sticky first column, property/direction/article rows, and currency-separated totals. Columns distinguish full-period plan/attainment/remaining from plan-to-date/variance and full LY from LYTD. Revenue uses signed service-date charges; taxes and deposit credits are excluded. Cash, refunds, deposits, receivables and earned revenue remain separate.

Management reads execute in the existing repeatable-read snapshot. The DRR slice, occupancy, ADR, RevPAR, pickup, pace and period comparisons reuse existing report methods. Source operations are property-scoped, require `folios.read`, and are paged in batches of 100.

Budget and operating-expense documents are explicitly supplied daily entries. Publishing creates immutable revisions under a property-row lock and writes the existing audit trail in the same transaction. Stale revisions return 409. Writing additionally requires `accounting.manage`. These documents never create folio charges, payments, payroll or automatic allocations.

An explicitly published budget covers its declared period; omitted days/articles mean zero planned amounts, as explained in the editor. Expense omissions are unavailable until coverage is explicitly confirmed. A closed day without postings is confirmed zero; an unclosed day without postings remains unavailable. Operating result is available only with complete earned-revenue and confirmed expense coverage. Forecast remains `INSUFFICIENT_HISTORY`: no unsupported model or invented numbers were introduced.

Excel exports the exact loaded response snapshot: hierarchy, currency totals, period comparisons, daily revenue/expenses, DRR slice, source completeness and input revisions. Export does not refetch or recompute another business model.

## Workspace

The existing WorkspaceCanvas/WorkspaceSettings/Dashboard were replaced in place. Layout v3 uses canonical 12-column coordinates and bounded row dimensions, pointer drag/resize handles, collision resolution, keyboard controls, undo, role reset and a drawer inspector. Container measurement projects to 12/8/4 columns without overwriting saved positions when the sidebar or viewport changes.

Legacy v2 pages, IDs, order, settings and start page are preserved during a read-only conversion. The original server preference changes only on explicit Save. Existing per-user/per-property preferences and revision conflicts are retained; no parallel persistence service was added. Corrupt geometry can be recovered locally and must be reviewed before replacing the original server version.

All five role templates remain available. Compact OCC, ADR, RevPAR, earned Revenue, DRR, pickup/pace and Financial Summary reuse reporting APIs. Housekeeping, Maintenance, Guest Requests and Services reuse their operational queues. Fixed-period widgets do not offer ineffective period choices. Existing actions and links remain in their domain screens.

## Migration

`0041_management_inputs.sql` adds one property-scoped table and a revision uniqueness index. Drizzle mirrors its kind, revision, JSON-array, period and coverage checks. There is no backfill or modification of financial/guest/booking tables. Fresh migration and a repeat invocation were verified against the isolated local PostgreSQL database; the repeat found no pending migrations.

## Acceptance matrix

| Requirement | Implemented | Verified locally | External gate |
|---|---|---|---|
| Signed hierarchy, classifications, reversals, service-only revenue, tax/deposit separation | Yes | Real PostgreSQL financial suite | Same suite included in CI smoke matrix |
| LY/LYTD, explicit plans, uncapped attainment, separate variance, nullable sources | Yes | PostgreSQL and UI/Excel tests | CI |
| Versioned expenses, confirmed coverage, safe operating result | Yes | PostgreSQL, audit rollback and concurrent publication | CI |
| Property isolation/RBAC and source operations | Yes | Real HTTP API with synthetic guarded identity | Real Keycloak session remains external |
| API / UI / Excel reconciliation | Yes | Local HTTP + browser download + workbook values | — |
| Drag, resize, collisions, keyboard, bounds, responsive projection | Yes | Unit tests and browser acceptance | CI unit tests |
| Five templates, inspector, multiple pages, reload | Yes | Shared contracts and browser acceptance | — |
| Cross-session preferences and conflict handling | Yes | PostgreSQL tests against existing UsersService | Authenticated devices remain external |
| Build / typecheck / lint / all workspace tests | Yes | Local commands; 2571 passing tests, 328 files | Required final-head GitHub CI |
| PostgreSQL / Redis release smoke | Extended | PostgreSQL locally; Redis not available locally | Required PG16/Redis7 and PG18/Redis8.2 CI jobs |

The synthetic browser fixture contains a long hotel name, two currencies, service-only charges, large signed KZT values, a supplied daily budget and expenses. Browser authentication is disabled only in the local test API; browser persistence therefore verifies the documented local-demo path. Server persistence and authorization are independently tested with PostgreSQL and HTTP guards, not represented as a real Keycloak check.

Local financial acceptance: 52/52 tests across six PostgreSQL suites. The final management/preference changes were additionally checked with 11/11 tests. Full workspace counts exclude skipped PostgreSQL/Redis suites. Typecheck and lint succeeded; pre-existing lint warnings are retained.

GitHub CI must finish successfully on the final PR head before this delivery is accepted. Local results do not imply CI success. Final run URLs, conclusions and SHA are supplied with the final delivery report and PR description once the actual run has completed.

## Screenshots

All screenshots use synthetic local data. The two before images were built from the exact base commit, not a stale cached build.

- [Dashboard before, 1440px](dashboard-before-1440.png)
- [Dashboard after, 1440px](dashboard-after-1440.png)
- [Dashboard after, 390px](dashboard-after-390.png)
- [Dashboard with collapsed sidebar](dashboard-collapsed-1440.png)
- [Management before, 1440px](management-before-1440.png)
- [Management after, 1440px](management-after-1440.png)
- [Management after, 390px](management-after-390.png)
- Remaining screenshots cover 768 / 1366 / 1920px.
- `browser-results.json` records the bounded acceptance scenarios, HTTP failures and browser errors.
- `management-acceptance.xlsx` is the reconciled synthetic download.

No new packages, paid services, AI runtime, channel functionality or E–G implementation were introduced. Existing accepted pricing, folio/payment workflows, housekeeping, maintenance, audit/outbox and M1/M2 APIs are preserved.
