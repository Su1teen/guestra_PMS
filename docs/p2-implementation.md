# P2 implementation map

Base: main `264b20e9a250e4c413473dc6d51db910d49db366`. Functional completion and external release verification are tracked separately. No production changes are authorized.

| Existing component | Responsibility | Missing behavior | Extend/replace | Compatibility risks | Verification |
|---|---|---|---|---|---|
| AncillaryService / services / reservation_services | Catalog, packages, stay extras and posting | Scheduling settings and explicit tax mode | Extend catalog; keep package posting separate | Accepted package prices must remain immutable | Catalog/financial regression |
| ConnectServiceBookingService / service_bookings / allocations | Service-only and linked bookings, folio creation | Staff workspace, lifecycle, working hours/blocks, safe concurrent retries | Extend this single scheduling path; staff and Connect share it | Legacy fingerprints, events, CRM links, currency and accepted charges | Real PostgreSQL concurrency/ledger/HTTP guards |
| FolioService / TaxService | Charges, reversals, payments, taxes | Accepted service pricing and visible cancellation financial state | Reuse existing posting/reversal APIs | Cancellation is not a refund or payment confirmation | Ledger equality, no duplicate charges |
| Housekeeping / Maintenance / Operations / ServiceRequests | Tasks, checklists, inspection, room readiness, guest requests | Mobile execution, assignments/SLA, planned OOO/OOS | Extend existing routes/workflows | Manual return-to-service retained | State/concurrency and mobile smoke |
| RatePlanService / Revenue / DynamicPricing | Canonical pricing, restrictions, simulation | Unified approval and explained recommendations | Existing pricing path; remove misleading synthetic facts | No rewriting accepted stay prices | Pricing/approval/audit tests |
| ReportsService / ManagementReport | Financial and occupancy APIs; management demo UI | Real management facts, classifications, portfolio drill-down | Replace demo data in existing screen | Business dates, revenue vs payments, currency groups | Reconcile actual charges/folios |
| GuestService.get360 / LoyaltyService | Property-safe guest history and existing loyalty ledger | Service journey, pending/available points, double-spend protection | Extend existing identity/ledger | No arbitrary cross-legal-entity conversion | SQL locks, scope, replay |
| Connect / integration_links / outbox | External operational API, identity mapping, delivery | Read-after-write, lifecycle tools, least-privilege scopes, examples | Backward-compatible v1 extension | Existing event names and CRM mapping retained | Contract/HMAC/retry/isolation |
| PropertyContext / RBAC / portfolio reports | Property selection and network access | Consistent network operations and scoped comparisons | Extend current context/reporting | Different currencies never blindly summed | Role/property access matrix |

Order: A services → B operations → C revenue → D management BI → E guest/loyalty → F cross-module n8n verification → G multi-property completion. APIs are developed with each module, not postponed to F. Channel development and an embedded conversational AI runtime are excluded.

Confirmed service policy: no penalties/no-show; refunds use the existing manual financial workflow; tax mode must be explicitly configured per service. Historical pricing is preserved. Missing expense/budget/provider data is shown as unavailable, never fabricated.

P2-A starts with locks, durable events, accepted service pricing and resource scheduling, then one shared staff calendar/booking interface. Services remain outside the room calendar. New storage records only missing schedule blocks and mutation receipts, not another catalog, task system or accounting ledger.
