# Shared financial reporting contracts (M2)

`ReportsService` is the single reporting source for Revenue, Dashboard, Management
Summary and DRR consumers. No price calculation, accepted-price rewrite, AI demand
runtime or independent BI ledger is introduced. These endpoints are read-only;
canonical financial writes and their audit trails stay in the existing domains.

## Sources and invariant

The earned-revenue source is **signed `charges.amount`**, grouped by property,
business date, charge type and currency. Include originals, signed amendment
corrections and signed reversal rows exactly once. Do not negate a negative
reversal again. Do not join reservations, bookings, folios or service sales to
compute revenue: such joins duplicate service-only charges or omit non-stay sales.

| Category | Source |
| --- | --- |
| Room Revenue | Net signed charges with `type = room` |
| F&B Revenue | Net signed charges with `type = food_beverage` |
| Ancillary Revenue | All remaining types except `room`, `food_beverage`, `tax`; includes minibar, spa, packages, fees and adjustments |
| Separately posted tax | Net signed `type = tax` rows, including tax reversals |
| Total earned revenue | Room + F&B + Ancillary, **excluding separately posted tax** |
| Posted total | Earned revenue + separately posted tax; legacy `netRevenue` |

`taxAmount` is provenance, not another posting to add or subtract. Accepted pricing
is recognized only when the existing financial domains post its charges (including
separately posted tax). Live changes to `RatePlanService` do not reprice these
actuals. Cancellations/no-shows earn only posted fees or retained-deposit charges,
not the cancelled reservation quote. A refund is a cash movement, not automatically
a charge reversal. Revenue decreases when its canonical signed correction is posted.

Amounts are aggregated with PostgreSQL numeric/Decimal arithmetic. Reporting ratios
are rounded to two places (OCC to four); APIs retain numeric values and an ISO currency
code. Presentation formatting belongs to the consuming UI.

## Dates, operational day and inventory

- Explicit dates are valid `YYYY-MM-DD` business-date labels, not timestamps.
  Ranges are inclusive, ordered, and limited to 367 calendar dates.
- Charges retain the PMS/night-audit convention: `serviceDate` encodes a business
  date in UTC. Extract its UTC date, regardless of DB/session timezone. Do **not**
  convert midnight business-date labels into the previous day in a western timezone.
- Actual event timestamps (`processedAt`, `checkedInAt`, `checkedOutAt`,
  `cancelledAt`, deposit timestamps, reservation `createdAt`) are converted to
  `properties.timezone` before selecting/grouping calendar dates.
- Where an API allows an omitted date, resolve the next business date after the
  latest completed night audit; with no completed audit, use property-local today.
  Payments do not have a persisted business-date label, so their reporting calendar
  is explicitly their processed timestamp in the property timezone.
- Active physical rooms are the inventory denominator, not configured
  `properties.totalRooms`. OOO and OOS are distinct and both exclude sales.
- Reuse `activeInventoryBlockConditions`: an active block starts on `startDate`
  and remains unavailable until explicit release, **even after expected `endDate`**.
  The existing policy does not treat expected return as permission to sell.
- Released blocks cover historical dates from start until the property-local
  release day (exclusive). Current OOO/OOS room status is also excluded. Block/status
  overlap counts a physical room only once; OOO takes precedence over OOS.
- Occupied/sold room nights: checked-in/stayover/due-out/checked-out reservations
  with `arrivalDate <= date < departureDate`. Confirmed/assigned/pending quotes,
  cancellations and no-shows are not occupied actual room nights. Completed stays
  still count on their historical nights. Arrivals/departures use actual local
  check-in/check-out timestamps; cancellations use local cancellation timestamps.
- `inventoryHistoryStatus = CURRENT_ROOM_ROSTER_WITH_DATED_BLOCKS`: the schema has
  dated inventory blocks but no versioned physical-room roster/status snapshots.
  Historical denominators therefore use the current active roster/status plus dated
  block history. Do not claim fully reconstructed historical inventory or OTB
  amendments when the underlying history is absent.

Every multi-query financial report runs in one read-only PostgreSQL **repeatable-read**
transaction. Management/portfolio nested reports reuse that snapshot. A concurrent
posting is visible to the next report, not halfway through the current one.

## KPI methodology

| KPI | Calculation and source | Missing/qualification |
| --- | --- | --- |
| OCC | Occupied room nights / sellable room nights from the above inventory and reservation sources | `kpis.occ = null` if no inventory; legacy `occupancyRate = 0` |
| ADR | Net Room Revenue / occupied room nights | Legacy `adr = 0` without sold nights; `ratioStatus.adr = NO_ROOMS_SOLD` |
| RevPAR | Net Room Revenue / sellable room nights | Legacy `revpar = 0` without inventory; `ratioStatus.revpar = NO_AVAILABLE_INVENTORY` |
| TRevPAR | Total earned revenue / sellable room nights | `null` without inventory |
| Room / F&B / Ancillary / Total Revenue | Signed charge categories defined above | Use `actual.status` and `actual.value`, not a bare legacy zero |
| Pickup | Room nights covering one stay date: OTB at the end of the booking window minus OTB before the start; additions by creation timestamp and losses by cancellation timestamp | Source timestamps are local; later cancellation still belongs to the earlier baseline; historical date/room amendments are not reconstructed (`historicalAmendmentsReconstructed = false`) |
| Booking Pace | Current non-cancelled/non-no-show reservations covering each stay date; daily new reservations by local creation timestamp | Current OTB, not historical as-of snapshots; new bookings count creation events even when later cancelled; never money |
| Booking Window | Mean arrival date minus property-local creation date for non-cancelled/non-no-show reservations arriving on the requested date | Unit days; `value = null` and sampleSize 0 without arrivals; late entry can be negative |
| ALOS | Mean departure minus arrival dates for that same arrival sample | Unit nights; `value = null` without samples |
| DRR | Daily Revenue Report cockpit composed from Financial Summary, Occupancy, Pickup/Pace and calendar periods | DRR is a report, not a percentage or a second financial model |
| MTD | Signed earned charges from first calendar day of requested month through requested date | Completeness includes every date in the range |
| YTD | Signed earned charges from January 1 through requested date | Same completeness rule |
| LY | Same calendar date in previous year | February 29 clamps to February 28 in a non-leap year |
| LYTD | January 1 of previous year through the LY comparison date | Same signed sources/cutoff, not full prior-year revenue |
| Actual | Posted earned revenue with night-audit coverage, independent of quotes or forecast | COMPLETE / PARTIAL / NO_POSTINGS below |
| Forecast | Separate validated non-synthetic commercial forecast | No such reporting source currently exists: null / INSUFFICIENT_HISTORY; no synthetic fallback or quote-based forecast |
| Plan to Date | Approved budget accrued through requested date | No approved budget source exists: null / UNAVAILABLE; do not substitute actuals |
| GOP | Total earned revenue less confirmed operating expenses | No confirmed expense ledger exists: null / UNAVAILABLE; do not treat cash paid out as audited operating expenses |
| Outstanding balances | Positive balances of open folios; negative credits separately; positive/negative open A/R balances separately | CURRENT_SNAPSHOT, not historical balances or revenue; unrelated credits never offset a guest's debt |
| Deposits | `deposit_ledger_entries`, grouped by held/applied/refunded/forfeited status | CURRENT_SNAPSHOT liability/lifecycle totals; recognition only contributes to revenue via canonical charges; underlying cash already counted in payments |

Trend/portfolio ratios are **weighted**: divide total revenue by total sold/sellable
room nights. Do not average daily/property ratios. Occupancy is not clamped to 100%;
an inconsistent inventory/stay dataset must remain visible, not be silently hidden.

### Missing data is not zero

`actual = { value, status, source: 'charges.serviceDate', closedDays, expectedDays }`.

- `COMPLETE`: every date has a completed night audit; a closed empty day is confirmed 0.
- `PARTIAL`: postings exist, but not all dates are audit-closed. Value is observed posted
  revenue, not a claim that future/missing days are zero.
- `NO_POSTINGS`: no charge rows and incomplete audit coverage. Value is **null**,
  not confirmed 0. A full reversal still has postings and legitimately nets to 0.

Legacy numeric revenue fields stay 0 for empty aggregations for existing clients.
New UI consumers must gate them on `actual`. LY and previous-day/week comparisons
return null baseline/delta/percent for NO_POSTINGS; a genuine zero baseline also has
null percentage, rather than division by zero. Forecast/plan/GOP have independent
status contracts and must not be folded into actual totals.
If the baseline exists but the current day has NO_POSTINGS, keep the known baseline
value but return null deltas/percentage with CURRENT_NO_POSTINGS; do not invent a decline.

## Cash and balance separation

Use existing `reportPaymentSumWhere(propertyId)` rather than a second payment model:
captured/settled parent tenders, legacy refunded/partially-refunded parents, and
captured negative refund/correction children. Failed/pending/authorized/voided
payments are not cash. `cash.refunds` is the absolute amount of included negative
children (including payment corrections), not the tax or revenue-reversal total.

- `cash.received`: positive included tenders excluding `city_ledger`.
- `cash.refunds`: absolute negative included tenders excluding `city_ledger`.
- `cash.net`: received - refunds.
- `cash.arTransfers`: net `city_ledger` tenders (non-cash).
- `cash.ledgerNet`: all included payment methods, including A/R transfers.
- `cash.byMethod` / legacy `payments` are net tenders; deposits already included here
  must not be added again. Revenue and cash can differ legitimately.

Financial Summary exposes open-folio debt/credits and open-A/R debt/credits separately.
Do not add all folio, deposit, payment, quote and A/R fields to produce “revenue”.
Trial Balance preserves existing ledger/export fields, uses local timestamp dates,
currency checks and snapshot reads, and adds `completeness`: deposit is
DATE_RECONSTRUCTED, guest CURRENT_SNAPSHOT_ONLY, A/R CURRENT_SNAPSHOT_WITH_DAILY_ACTIVITY.
Legacy guest opening/activity zero placeholders are not confirmed historical balances.
Deposit reconstruction also depends on existing `recognizedAt`; it does not invent a
refund timestamp missing from that schema. Do not use this best-effort trial balance
as the source of earned-revenue actuals.

## API surface for next stages

All paths are under `/api/v1/reports`. Existing property routes require UUID
`propertyId` and `reports.view`. Management Summary retains the existing explicit
`management_dashboard.view` permission. Global property guards and portfolio resolver
enforce granted property access; every underlying property-scoped query is filtered.
No migrations or writes are needed for these reports.

| GET | Query | Consumer contract |
| --- | --- | --- |
| `/daily-revenue` | propertyId, date required | `date/propertyId/currencyCode/timezone`, `netRevenueByCategory`, `netEarnedRevenue`, `separatelyPostedTax`, `actual`, `cash`, compatibility fields |
| `/financial-summary` | propertyId, date required | `kpis`, `actual`, `cash`, `deposits`, `outstandingBalances`, `revenueByType`, `paymentsByMethod`, `auditStatus` |
| `/management-summary` | propertyId; optional date | `financial`, `today`, `drr`, all revenue-period fields below; DRR revenue equals financial.kpis.totalRevenue |
| `/revenue-periods` | propertyId; optional date | `periods.mtd/ytd/ly/lytd`, each `{start,end,value,status,source,closedDays,expectedDays,revenueByCategory}`; `bookingWindow`, `averageLengthOfStay`, `onBooksQuotedAmount`, `forecast`, `planToDate`, `gop` |
| `/occupancy` | propertyId; optional date | Physical/available/occupied rooms, OOO/OOS counts, operational arrivals/departures/cancellations, OCC, inventory source/history status |
| `/occupancy-trend` and `/revenue-trend` | propertyId, startDate, endDate | Same service/result: `{period,currencyCode,daily,actual,summary}`; daily signed categories + inventory + KPIs; weighted summary |
| `/pickup` | propertyId, stayDate, from, to | `{stayDate,period,baseline,current,pickup,daily,source,historicalAmendmentsReconstructed}`; from/to accept dates or timestamps normalized to property-local dates |
| `/booking-pace` | propertyId, startDate, endDate | `{period,daily:[{date,roomsOnBooks,newBookings}],summary}` |
| `/trial-balance` | propertyId, date | Existing string ledger amounts, plus currencyCode/timezone/completeness |
| `/portfolio/financial-summary` | date; optional organizationId/propertyIds | Granted, deduplicated properties only; per-currency totals plus individual properties |

### Important compatibility fields

- Daily `revenue` is the **non-reversal** subtotal (signed amendments included);
  `adjustments = -signed reversal sum`. Thus `revenue.total - adjustments = netRevenue`.
- Daily `netRevenue` remains **tax-inclusive posted net**. Use `netEarnedRevenue`
  for BI. `revenueByType` now represents the signed net by type.
- Financial `kpis.totalRevenue` and Management `today.revenue` / `drr.revenue` are
  **earned net excluding separately posted tax**. This deliberately fixes quote/tax
  pollution; do not compare them to legacy Daily `netRevenue` without removing tax.
- Trend daily `revenue` and summary `totalRevenue` remain **room-only** legacy aliases.
  New daily `totalRevenue` and summary `netEarnedRevenue` are all earned categories.
- `onBooksQuotedAmount = {value,reservations,source:'reservations.totalAmount',
  isEarnedRevenue:false}` aggregates full-stay quoted gross amounts for forward
  pending/confirmed/assigned arrivals. This is explicitly **not a forecast** or
  posted revenue. `drr.forecastRevenue` is null, not a quoted amount.
- The existing accounting CSV journal remains a compatibility gross/tax/adjustment
  journal (`Net Revenue` includes tax). New Management/Excel presentation should use
  signed category net and earned totals, not relabel the legacy tax-inclusive line.

### Example reconciled actual

100 room -20 signed amendment -10 room reversal +30 F&B -5 F&B reversal +20 spa
+10 tax -1 tax reversal produces:

```json
{
  "currencyCode": "KZT",
  "netRevenueByCategory": {
    "room": 70, "foodBeverage": 25, "other": 20,
    "tax": 9, "earned": 115, "total": 124
  },
  "netEarnedRevenue": 115,
  "separatelyPostedTax": 9,
  "netRevenue": 124
}
```

With one occupied room and two available rooms, ADR 70, RevPAR 35, TRevPAR 57.50,
OCC 0.5. Every Financial/Management/DRR/trend/period actual derives from those same
115 earned units. A reservation quote of 9,999 does not change any of them.

## Currency safety

Single-property reports reject inconsistent source currencies with HTTP 400
`CURRENCY_MISMATCH`; they never assume implicit FX rates. This includes charge,
payment, deposit, open folio and A/R balance sources where consumed.

Portfolio financial responses contain `currencyStatus`, nullable `currencyCode`,
`byCurrency` and `byProperty`. With MIXED_CURRENCIES, combined `totalRevenue`,
`roomRevenue`, `adr`, `revpar`, `trevpar` are **null**; inventory/OCC can aggregate.
Each currency bucket has its own earned/room totals and weighted ratios. Never
display a currency-less combined monetary KPI or replace null with 0. All monetary
values remain in original currency; no FX service or rate is implied.

## Verification

The financial regression suites are normal Vitest unit/contract tests and
opt-in local PostgreSQL fixtures (no external services or production data):

```bash
DATABASE_URL=postgresql://haip:haip@localhost:5432/haip_test PMS_LIVE_PG=1 \
  pnpm --filter @telivityhaip/api exec vitest run src/modules/reports \
  src/modules/accounting-export/accounting-export.service.spec.ts --maxWorkers=1 --minWorkers=1
```

Live tests cover full/partial signed reversals and amendment provenance, service-only
charges, tax/cash/refunds, liabilities/credits/A/R, property and currency isolation,
local timestamp boundaries vs UTC business labels, night-audit closed zero vs missing
history, periods, quote/forecast/actual separation, inventory blocks and releases,
historical departure-exclusive occupancy, booking metrics, and concurrent snapshots.
The CI core PostgreSQL release-smoke job runs both financial suites too. No browser
or UI changes are part of M2; later stages own presentation and browser verification.
