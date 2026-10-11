# Navigation and runtime recovery

The navigation catalog lives in `apps/dashboard/src/lib/navigation.ts`. Sidebar visibility and direct-route UI access use the same permission keys; server permission/property guards remain authoritative. Existing URLs are preserved. Housekeeping and its shifts tab, reports and daily revenue, settings and user administration have one active destination each. The internal agent console is reached through `/revenue?section=agents` in Advanced tools; its services and existing operator controls are retained, and no automatic agent mode is enabled.

Desktop menu collapse stores a cosmetic preference and releases 168px of content width. Responsive layout uses the actual remaining content area. Advanced tools starts closed, persists its state and opens an active direct destination. Collapsed icons keep accessible names and titles. The mobile overlay traps focus, supports Escape and restores scrolling; visual mobile acceptance is outside this milestone.

Cross-section links preserve the active `propertyId` and only the target's intended filters. PropertyContext treats URL scope as authoritative for browser history, does not replace an explicit selection when bootstrap completes, and updates the default API scope before new view effects. Property changes remount page-local drafts/results. Cached queries stay separately scoped; Reports and the Revenue summary consume cancellation signals. Property-specific UI grants are cleared before paint and content waits for the new permission query.

## Confirmed failure modes

1. The previous common ErrorBoundary retained a render error after React Router changed the URL. The regression failed against the previous implementation and passed with route/property-aware reset. Layout and navigation remain mounted outside the section boundary.
2. A existing seeded night-audit decision stores `recommendation.anomalies` as the numeric count `1`; current agent decisions store detailed arrays. NightAudit called `slice` on that number after HTTP 200. It now preserves the legacy count, labels unavailable detail and safely renders detailed current decisions. Invalid history response shapes become query errors instead of render failures.
3. The already-mounted Reports page did not observe a newly linked report selector. The daily-revenue and financial-summary links now select the intended report without a reload.

These reproductions do not prove the cause of every historical production failure.

## Recovery contract

Render failures and request failures use separate messages. A route or property change resets a failed section. Retry explicitly remounts its failed import; React.lazy's cached rejection is invalidated for that retry. A detected import/chunk failure additionally offers an explicit app-version reload. No route change or failure automatically reloads the document, and no automatic import retry loop is installed.

API 401/403/404 and other 4xx errors are not retried by React Query. Transient failures get at most one automatic retry. Forbidden responses display restricted access instead of a network failure. Cancelled requests do not create error toasts. Concurrent 401 responses share one token refresh, allow one safe read retry and initiate at most one login through that recovery coordinator. Business writes are never replayed by this interceptor: their existing domain recovery remains authoritative. Technical diagnostics emitted by the new handlers contain only bounded failure categories and HTTP status, without exception messages, URLs, identifiers or request bodies. Real Keycloak verification remains a separate gate.

## Validation and continuation

Regression coverage includes route/import/manual retry, permission errors, property history/bootstrap races, draft isolation, advanced menu persistence, collapsed controls, current-item uniqueness, cancellation and bounded authentication recovery. Local browser smoke uses synthetic PostgreSQL data and a local API; it performs business reads only. It covers 21 repeated route transitions, report selectors, 1366/1440/1920px width release, HTTP 403/500 recovery and isolation of a failed lazy chunk. Full workspace CI remains the acceptance checkpoint for the final commit.

No API, schema or migration changes are part of this milestone. Canonical pricing, accepted prices, folios, audit/outbox, services, housekeeping/maintenance and integration contracts are preserved.

Next milestones retain the existing RatePlan/Restrictions and canonical pricing, ReportsService/financial ledger, Management hierarchy/Excel and server-persisted workspace layout. Financial reconciliation, live pricing preview/approval/history, real Management/DRR/budget/LYTD sources and responsive dashboard drag/resize are remaining work. Navigation consolidation does not certify the existing KPI methodology, synthetic forecast or demo Management model. No P2-E/F/G or Channel Manager implementation is included.
