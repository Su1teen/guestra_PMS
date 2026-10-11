import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsUUID, Matches } from 'class-validator';

export class ReportRangeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() propertyId!: string;
  @ApiProperty({ example: '2027-05-01' }) @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @ApiProperty({ example: '2027-05-31' }) @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate!: string;
}

export class RevenueCategoriesDto {
  @ApiProperty() room!: number;
  @ApiProperty({ description: 'Separately posted tax, excluded from earned revenue' }) tax!: number;
  @ApiProperty() foodBeverage!: number;
  @ApiProperty({ description: 'All other charge types, excluding room, tax and food_beverage' }) other!: number;
  @ApiProperty({ description: 'Posted charges including tax; not an earned-revenue KPI' }) total!: number;
  @ApiProperty({ description: 'Room + foodBeverage + other, excluding separately posted tax' }) earned!: number;
}

export class ActualRevenueDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Null when no postings and no completed audit; never a forecast' }) value!: number | null;
  @ApiProperty({ enum: ['COMPLETE', 'PARTIAL', 'NO_POSTINGS'] }) status!: string;
  @ApiProperty() source!: string;
  @ApiProperty() closedDays!: number;
  @ApiProperty() expectedDays!: number;
}

export class CashSummaryDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) byMethod!: Record<string, number>;
  @ApiProperty({ description: 'Net tenders including non-cash city-ledger transfers (legacy payment total)' }) ledgerNet!: number;
  @ApiProperty({ description: 'Positive captured/settled cash tenders; includes deposits' }) received!: number;
  @ApiProperty({ description: 'Absolute negative captured payment children; cash corrections/refunds, not revenue reversals' }) refunds!: number;
  @ApiProperty({ description: 'Received minus refunds, excluding city-ledger transfers' }) net!: number;
  @ApiProperty() arTransfers!: number;
}

export class DailyRevenueResponseDto {
  @ApiProperty() date!: string;
  @ApiProperty({ format: 'uuid' }) propertyId!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: RevenueCategoriesDto, description: 'Legacy non-reversal subtotal, including signed amendment corrections and tax' }) revenue!: RevenueCategoriesDto;
  @ApiProperty({ type: RevenueCategoriesDto, description: 'Signed originals + corrections + reversals, by category' }) netRevenueByCategory!: RevenueCategoriesDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) revenueByType!: Record<string, number>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' }, description: 'Legacy net payment tenders by method plus total; includes A/R transfers' }) payments!: Record<string, number>;
  @ApiProperty({ description: 'Negative of signed reversal sum; revenue.total - adjustments = netRevenue' }) adjustments!: number;
  @ApiProperty({ description: 'Legacy signed posted total including tax; use netEarnedRevenue for KPI actuals' }) netRevenue!: number;
  @ApiProperty() netEarnedRevenue!: number;
  @ApiProperty() separatelyPostedTax!: number;
  @ApiProperty({ type: ActualRevenueDto }) actual!: ActualRevenueDto;
  @ApiProperty({ type: CashSummaryDto }) cash!: CashSummaryDto;
}

export class FinancialKpisDto {
  @ApiProperty({ description: 'Net room revenue / occupied room nights; legacy zero if no rooms sold' }) adr!: number;
  @ApiProperty({ description: 'Net room revenue / available rooms; legacy zero if no inventory' }) revpar!: number;
  @ApiProperty({ type: Number, nullable: true }) trevpar!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Occupied room nights / available inventory; null if denominator absent' }) occ!: number | null;
  @ApiProperty({ description: 'Legacy OCC alias; zero if denominator absent' }) occupancyRate!: number;
  @ApiProperty({ description: 'Net earned room + F&B + ancillary revenue, excluding separately posted tax' }) totalRevenue!: number;
  @ApiProperty() roomRevenue!: number;
  @ApiProperty() foodBeverageRevenue!: number;
  @ApiProperty() ancillaryRevenue!: number;
  @ApiProperty() separatelyPostedTax!: number;
  @ApiProperty() roomsSold!: number;
  @ApiProperty() availableRooms!: number;
  @ApiProperty({ type: 'object', description: 'Explicit missing-denominator statuses for legacy numeric aliases' }) ratioStatus!: Record<string, string>;
}

export class OutstandingBalancesDto {
  @ApiProperty() totalFoliosOpen!: number;
  @ApiProperty({ description: 'Positive open-folio balances only, not offset by unrelated guest credits' }) totalBalanceDue!: number;
  @ApiProperty({ description: 'Negative open-folio credit balances separately' }) creditBalances!: number;
  @ApiProperty({ description: 'Positive balances in open A/R ledgers, separately from guest folios' }) accountsReceivableDue!: number;
  @ApiProperty() accountsReceivableCredits!: number;
  @ApiProperty({ enum: ['CURRENT_SNAPSHOT'] }) asOf!: string;
}

export class DepositsSummaryDto {
  @ApiProperty({ description: 'Current held deposit liability; never earned revenue' }) held!: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) byStatus!: Record<string, number>;
  @ApiProperty({ enum: ['CURRENT_SNAPSHOT'] }) asOf!: string;
}

export class FinancialSummaryResponseDto {
  @ApiProperty() date!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty({ type: FinancialKpisDto }) kpis!: FinancialKpisDto;
  @ApiProperty({ type: ActualRevenueDto }) actual!: ActualRevenueDto;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) revenueByType!: Record<string, number>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) paymentsByMethod!: Record<string, number>;
  @ApiProperty({ type: CashSummaryDto }) cash!: CashSummaryDto;
  @ApiProperty({ type: DepositsSummaryDto }) deposits!: DepositsSummaryDto;
  @ApiProperty({ type: OutstandingBalancesDto }) outstandingBalances!: OutstandingBalancesDto;
  @ApiProperty({ type: 'object', description: 'Most recent audit at or before the requested business date' }) auditStatus!: Record<string, unknown>;
}

export class UnavailableMetricDto {
  @ApiProperty({ type: Number, nullable: true }) value!: null;
  @ApiProperty({ enum: ['INSUFFICIENT_HISTORY', 'UNAVAILABLE'] }) status!: string;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) source?: string | null;
}

export class RevenuePeriodsResponseDto {
  @ApiProperty() date!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty({ type: 'object', description: 'mtd/ytd/ly (same date last year)/lytd: start, end, actual value/status/coverage, revenueByCategory. Leap day clamps to Feb 28.' }) periods!: Record<string, unknown>;
  @ApiProperty({ type: 'object', description: 'Arrival minus creation local date, days, nullable value and sampleSize' }) bookingWindow!: Record<string, unknown>;
  @ApiProperty({ type: 'object', description: 'Departure minus arrival, nights, nullable value and sampleSize' }) averageLengthOfStay!: Record<string, unknown>;
  @ApiProperty({ type: 'object', description: 'Forward reservation quotes, full-stay gross amounts; not revenue, not forecast' }) onBooksQuotedAmount!: Record<string, unknown>;
  @ApiProperty({ type: UnavailableMetricDto }) forecast!: UnavailableMetricDto;
  @ApiProperty({ type: UnavailableMetricDto }) planToDate!: UnavailableMetricDto;
  @ApiProperty({ type: UnavailableMetricDto }) gop!: UnavailableMetricDto;
}

export class ManagementSummaryResponseDto extends RevenuePeriodsResponseDto {
  @ApiProperty({ type: FinancialSummaryResponseDto }) financial!: FinancialSummaryResponseDto;
  @ApiProperty({ type: 'object', description: 'Daily shared KPIs and operational activity; money uses net earned revenue' }) today!: Record<string, unknown>;
  @ApiProperty({ type: 'object', description: 'Daily Revenue Report (not a ratio); same KPIs plus pickup/pace/channelMix/MTD/comparisons. forecastRevenue is nullable and never a quote.' }) drr!: Record<string, unknown>;
}

export class RevenueTrendResponseDto {
  @ApiProperty({ type: 'object' }) period!: { start: string; end: string };
  @ApiProperty() currencyCode!: string;
  @ApiProperty({ type: ActualRevenueDto }) actual!: ActualRevenueDto;
  @ApiProperty({ type: 'array', items: { type: 'object' }, description: 'Per business-date signed revenue categories, OOO/OOS inventory, sold rooms, OCC/ADR/RevPAR/TRevPAR. revenue alias is room revenue.' }) daily!: unknown[];
  @ApiProperty({ type: 'object', description: 'Weighted period ratios. netEarnedRevenue is total earned; totalRevenue is legacy room-only alias.' }) summary!: Record<string, unknown>;
}
