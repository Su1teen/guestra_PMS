# Live rate management backend contract (M2)

## Replacement map and boundaries

- Simulation remains read-only and separate. No agent/autopilot/channel configuration is changed.
- Existing `RatePlanService` owns the calendar, preview and rate-change workflow, not a parallel pricing engine.
- Existing `ReportsService` owns real occupancy, pickup, pace and financial KPIs. Existing ledger and operational business-date conventions are unchanged.
- Existing `calculateCanonicalRoomPricing` owns every calendar/preview quote. New date overrides also flow through `calculateDerivedRate`, so new bookings and quotes consume the same rates.
- Existing `withAcceptedPricingLock` remains authoritative for accepted-price operations. Live pricing never updates reservations, accepted snapshots, folios or previously posted charges.

## Endpoints and permissions

All paths below are under `/api/v1/rate-plans`. All listed permission keys are required together, in addition to JWT/property membership. Existing demo `AUTH_ENABLED=false` behavior remains; it is not production authorization.

| Method/path | Scope/input DTO | Required permissions | HTTP/result |
| --- | --- | --- | --- |
| GET `/live-calendar` | Query `LiveCalendarQueryDto` | `rateplans.read`, `reports.view` | 200 `LiveCalendarResponseDto` |
| POST `/live-preview` | Body `LiveRateChangeDto` | `rateplans.manage` | 201 `LiveRatePreviewDto`; no write |
| POST `/rate-changes` | Body `LiveRateChangeDto`, matching preview token required | `rateplans.manage` | 201 `PricingMutationResponseDto<RateChangeRecordDto>` |
| GET `/approval-queue` | Required UUID query `propertyId` | `rateplans.read` | 200 `RateChangeRecordDto[]`, pending/approved only |
| GET `/rate-changes` | Required UUID query `propertyId` | `rateplans.read` | 200 `RateChangeRecordDto[]`, includes terminal history |
| POST `/rate-changes/:changeId/approve` | UUID change ID; required query `propertyId`; `LiveRateDecisionDto` body | `rateplans.manage`, `revenue.manage` | 201 mutation response of proposal |
| POST `/rate-changes/:changeId/apply` | Same | `rateplans.manage` | 201 mutation response of proposal |
| POST `/rate-changes/:changeId/reject` | Same | `rateplans.manage`, `revenue.manage` | 201 mutation response of proposal |
| GET `/requests/:requestId` | UUID request ID; required query `propertyId` | `rateplans.manage` | 200 `PricingRequestStateDto` |
| POST `/requests/:requestId/close` | Same; no body | `rateplans.manage` | 201 `PricingRequestStateDto` |
| GET `/pricing-history` | Required query `propertyId` | `rateplans.read` | 200 actor audit records, without duplicate webhook audit rows |

The body-scoped preview/submission routes reject a different query `propertyId`. The same protection applies to existing create routes. Every ID lookup includes the caller's property ID; no scope is inferred from a foreign entity.

Queue and proposal history return the latest 200 rows, newest first. Pricing audit history returns the latest 200 actor audit rows.

### Guarded legacy routes (intentional contract upgrade)

These routes remain available but cannot bypass approval policy, revision checks, audit, durable events or retry fences:

| Method/path | DTO | HTTP/result |
| --- | --- | --- |
| POST `/` | `CreateRatePlanDto`; property in body or matching UUID query alias | 201 mutation response of rate-plan row |
| PATCH `/:id` | Required query `propertyId`; `GuardedUpdateRatePlanDto` | 200 mutation response of rate-plan row |
| POST `/:id/restrictions` | `CreateRateRestrictionDto`, required body `propertyId` | 201 mutation response of restriction row |
| PATCH `/:id/restrictions/:restrictionId` | Required query `propertyId`; `GuardedUpdateRateRestrictionDto` | 200 mutation response of restriction row |
| DELETE `/:id/restrictions/:restrictionId` | Required query `propertyId`; required `PricingMutationDto` JSON body | 200 mutation response of deleted restriction row |

All legacy mutations require `rateplans.manage`. Existing read/list/effective-rate/restriction endpoints still require `rateplans.read`. Existing effective-rate result now includes date override and tax-mode explanation. Existing active rate-plan rows include `revision`.

## Request types

```ts
type PricingMutationDto = {
  requestId: string; // UUID: fresh per financial action, retained for identical retry
  expectedRevision: number; // integer >= 0
  reason: string; // nonblank, <= 1000 characters
};
type LiveCalendarQueryDto = {
  propertyId: string; startDate: string; endDate: string;
  roomTypeId?: string; ratePlanId?: string; nights?: number; // integer >= 1, default 1
};
type LiveRateChangeDto = PricingMutationDto & {
  propertyId: string; ratePlanId: string;
  kind: 'plan' | 'restriction_create' | 'restriction_update' | 'restriction_delete';
  restrictionId?: string; plan?: UpdateRatePlanDto; restriction?: UpdateRateRestrictionDto;
  startDate: string; endDate: string; stateToken?: string; // 64 lowercase hex characters
};
type LiveRateDecisionDto = PricingMutationDto;
```

All IDs are UUIDs; all date windows use valid `YYYY-MM-DD` dates and inclusive endpoints. Calendar/preview max 93 days. Calendar `nights` max 366; quote checkout is exclusive. HTTP query stays are transformed from strings to numbers.

`expectedRevision` is the **plan revision**, not restriction revision, for previews, submissions and every legacy restriction mutation. Create-plan uses 0. Existing plans start at 1. Any restriction create/update/delete increments the parent plan revision; a restriction update also increments its own revision. Queue decisions instead use the **proposal revision** (pending starts at 1, approval increments to 2, application/rejection increments again).

`plan` accepts the existing update-plan fields: name/code/description/type/baseAmount/currencyCode/parentRatePlanId/derivedAdjustmentType/derivedAdjustmentValue/isTaxInclusive/mealPlan/validFrom/validTo/channelCodes/cancellationPolicyId/groupProfileId/sortOrder/losAdjustments/occupancyBands/isActive. It does not accept roomTypeId, propertyId, IDs, server revisions or nested request guards. Create-plan additionally requires roomTypeId, name, code, type, baseAmount and currencyCode. Supported types remain bar/derived/negotiated/package/promotional.

`restriction` accepts startDate/endDate/minLos/maxLos/closedToArrival/closedToDeparture/isClosed/rateOverride/overrideReason/dayOfWeekOverrides. Creation requires both dates; update merges omitted fields with the current row; deletion accepts only restrictionId (no patch). Dates and LOS bounds are validated together. A monetary override must have a business reason. DTO rateOverride is a number (up to two decimal places) or null to clear. Day-of-week keys are lowercase English weekdays; values are signed two-decimal amount adjustments. Overlapping monetary override windows are rejected rather than relying on nondeterministic precedence.

Plan changes are **global plan configuration changes**, not confined to the preview window. Date-specific changes must use restrictions. Preview windows explain representative one-night stays; calendar `nights` can show whole-stay LOS and tax effects. Currency must match the property; parents/FKs must belong to that property; derived chains must be acyclic. No synthetic forecast produces an applied rate.

## Response types

Swagger defines concrete `CanonicalRateDto`, `CanonicalQuoteDto`, `LivePreviewDayDto`, `LiveSignalDayDto`, `LiveBookingPaceDto`, `LiveRevenueSignalsDto`, `LiveRateRecommendationDto`, `LiveCalendarRateDto` and the top-level DTOs. It reuses existing `FinancialKpisDto`, `ActualRevenueDto`, `UnavailableMetricDto`, LOS and occupancy-rule DTOs.

```ts
type MutationResponse<T> = { record: T; replayed: boolean };
type CanonicalRate = {
  effectiveRate: number; currency: string; baseRate: number; nights?: number;
  occupancyPct?: number; // property-wide on-books percentage, not realised OCC
  losAdjustment: { minNights: number; adjustmentType: 'percentage'|'fixed'; adjustmentValue: number } | null;
  occupancyAdjustment: { occupancyPctMin: number; occupancyPctMax: number; adjustmentType: 'percentage'|'fixed'; adjustmentValue: number } | null;
  override: { restrictionId: string; amount: number|null; reason: string|null } | null;
  isTaxInclusive: boolean;
};
type CanonicalQuote = {
  currency: string; lineItems: { date: string; rate: string; tax: string }[];
  roomTotal: string; taxTotal: string; totalAmount: string;
};
type PreviewDay = {
  date: string; before: CanonicalRate; after: CanonicalRate;
  beforeQuote: CanonicalQuote; afterQuote: CanonicalQuote;
  beforeSales: { sellable: boolean; reason: string|null };
  afterSales: { sellable: boolean; reason: string|null };
  beforeRestrictions: RestrictionRecord[]; afterRestrictions: RestrictionRecord[];
};
type LivePreview = {
  mode: 'LIVE_PREVIEW'; propertyId: string; ratePlanId: string; planRevision: number;
  stateToken: string; currencyCode: string; approvalRequired: boolean; days: PreviewDay[];
  acceptedPricesChanged: false; isEarnedRevenue: false;
};
type RateChangeRecord = {
  id: string; propertyId: string; ratePlanId: string;
  status: 'pending'|'approved'|'applied'|'rejected'; revision: number; expectedPlanRevision: number;
  stateToken: string; reason: string; requestedBy: string|null; approvedBy: string|null;
  decisionReason: string|null; change: LiveRateChangeDto; preview: LivePreview;
  createdAt: string; updatedAt: string; // ISO timestamps
};
type RequestState = {
  state: 'unconfirmed'|'running'|'committed'|'closed';
  record?: RatePlanRecord | RestrictionRecord | RateChangeRecord; // only committed
};
type SignalDay = {
  date: string; totalRooms: number; outOfOrder: number; outOfService: number; availableRooms: number;
  inventorySource: 'active_rooms_and_inventory_blocks';
  inventoryHistoryStatus: 'CURRENT_ROOM_ROSTER_WITH_DATED_BLOCKS';
  roomsOnBooks: number; onBooksOccupancy: number|null;
  realisedRooms: number; realisedOccupancy: number|null;
  pickup: { roomNights: number }; pickupPeriod: { from: string; to: string };
  pickupBaseline: { roomNights: number }; pickupSource: 'reservation_created_and_cancelled_timestamps';
  historicalAmendmentsReconstructed: false;
};
type RevenueSignals = {
  propertyId: string; roomTypeId: string|null; currencyCode: string; timezone: string;
  operationalDate: string; startDate: string; endDate: string; source: 'ReportsService'; synthetic: false;
  kpiScope: 'property_operational_date'; kpis: FinancialKpisDto; actual: ActualRevenueDto;
  daily: SignalDay[];
  pace: { period: { start: string; end: string };
    daily: { date: string; roomsOnBooks: number; newBookings: number }[];
    summary: { avgRoomsOnBooks: number; totalNewBookings: number }; historicalAmendmentsReconstructed: false };
  forecast: { status: 'INSUFFICIENT_HISTORY'; value: null; source: null; reason: string };
};
type CalendarRate = {
  date: string; ratePlanId: string; roomTypeId: string; name: string; code: string;
  planRevision: number; currencyCode: string; price: CanonicalRate; quote: CanonicalQuote;
  isEarnedRevenue: false; sellable: boolean; restrictionReason: string|null; restrictions: RestrictionRecord[];
  recommendation: { status: 'RULE_BASED'; value: number; source: 'RatePlanService'; reason: string; requiresHumanReview: true };
  forecast: RevenueSignals['forecast'];
};
type LiveCalendar = { mode: 'LIVE'; propertyId: string; signals: RevenueSignals; rates: CalendarRate[] };
```

`RatePlanRecord` is the existing Drizzle ratePlans row: IDs/property/category, name/code/description/type, decimal-string baseAmount and derivedAdjustmentValue, currencyCode, parent and policy/group IDs, tax/meal flags, validity/active/channel/rule configuration, sortOrder, revision and ISO timestamps. Nullable schema fields remain null. `RestrictionRecord` is the existing rateRestrictions row: id/propertyId/ratePlanId, startDate/endDate, nullable minLos/maxLos, three closure flags, nullable decimal-string rateOverride/overrideReason/overrideBy/dayOfWeekOverrides, revision and timestamps. Mutation restriction records additionally return `planRevision`; deletion additionally returns `deleted: true`. Draft new restrictions use id `preview`, DTO numeric override values, and omit unpersisted metadata/default fields.

Money in canonical quotes and persisted rows is decimal text. Effective-rule rates and report KPI values are numbers. OCC in signals is a fraction (may exceed 1 for overbooking); canonical occupancyPct is percentage points. Do not use rate-array order to identify a category/plan: key by date+ratePlanId.

### Source and completeness methodology

- On-books occupancy = non-cancelled/non-no-show reservation room nights / authoritative available inventory. Includes pending/confirmed/assigned and historical consumed statuses; it is not realised revenue.
- Realised occupancy uses checked_in/stayover/due_out/checked_out reservation nights. Available rooms exclude active OOO/OOS through the existing inventory policy; history uses the current active room roster/status plus dated blocks, not reconstructed historical roster.
- Pickup = current minus baseline room nights covering each stay date, using property-local reservation creation/cancellation timestamps over operationalDate minus six days through operationalDate. Reservation amendments are not historically reconstructed.
- Pace.daily roomsOnBooks follows stay dates; newBookings follows property-local creation dates in the requested window. The summary averages on-books room nights and sums created bookings; it is not a full LY pace curve.
- Category filters scope commercial/inventory signals; financial `kpis` and `actual` remain property-wide at the operational date, explicitly labelled `kpiScope`. Financial method/source definitions are in `financial-reporting.md`; reservation quotes never become earned revenue.
- Missing inventory produces null OCC and no occupancy price adjustment, not a fabricated zero-demand observation. Financial absence is indicated by `actual.status=NO_POSTINGS` and `actual.value=null`; display completeness, not legacy KPI aliases as confirmed zero.
- Recommendations expose the existing configured canonical rules/overrides and human-review requirement. They are not statistically validated optimal prices. Forecast always returns INSUFFICIENT_HISTORY/value null without authoritative non-synthetic commercial history.

## Workflow, approval, concurrency and recovery

1. Load scoped live calendar/rate-plan revision.
2. POST a guarded change to live-preview. It creates no audit, event, fence or proposal and never changes live rates.
3. Confirm before/after rates, taxes, sellability and restrictions; submit the same change with returned stateToken. Preview/submit can use the same requestId; preview does not consume it.
4. `properties.settings.pricingApprovalRequired=true` requires an independent identified approver. Requester self-approval and anonymous/demo approval are rejected; legacy direct mutation routes return APPROVAL_REQUIRED. Default false preserves direct authorized edits and allows applying a pending proposal without an approval step.
5. Approve/apply/reject each uses a fresh requestId and current proposal revision. Apply revalidates both the canonical state token and plan revision, updates the canonical plan/restriction, transitions the proposal and writes audit+durable events atomically. Rejection writes history only. Terminal proposals cannot be reapplied or rejected under a fresh request.
6. On network ambiguity, GET the actor-owned request. Committed returns the immutable original record; replaying the identical body returns that same record with replayed=true. It does not reevaluate a stale revision after successful commit. Unconfirmed requests can be terminally closed; closing a committed request returns its result and cannot cancel a completed change.

All writes run in one PostgreSQL transaction: property-scoped request fence, state, revision, actor audit and DomainEventOutboxService persistence. A failed event/audit rolls back everything; delivery failure does not roll back committed state and the existing outbox worker retries it. No webhook emit is relied upon for financial durability.

Lock order is property row (FOR NO KEY UPDATE, compatible with booking FK key-share locks), fence, proposal when applicable, then canonical rate-plan rows. All pricing writers serialize by property, preventing crossing derived-chain mutations; canonical accepted-price pricing keeps its existing rate-plan/accepted-reservation locks. State tokens also include parent-chain/restriction state, before/after canonical amounts/taxes/sales state and approval policy. Concurrent rate writers at the same revision have one winner and stale losers.

Expected errors: 400 DTO/date/LOS/money/currency/cycle/FK validation or MUTATION_GUARD_REQUIRED; 401 invalid/missing JWT; 403 missing permissions/property membership/request actor/independent approval; 404 scoped entity absent; 409 STALE_PRICING, REQUEST_CHANGED, REQUEST_CLOSED, APPROVAL_REQUIRED, OVERLAPPING_RATE_OVERRIDE or invalid proposal transition. Refresh/re-preview and use a new key after a confirmed stale/conflict; retain the original key only for an identical ambiguous retry.

Migration `0038_live_rate_management.sql` adds plan/restriction revisions, proposal records and request fences. It contains no reservation/snapshot/ledger rewrite. Apply through the existing migration runner; this milestone was validated only on local test PostgreSQL, not production.
