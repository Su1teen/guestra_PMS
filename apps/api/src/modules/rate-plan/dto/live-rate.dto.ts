import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsUUID, IsInt, Min, IsOptional, IsEnum, Matches, ValidateNested, IsDateString } from 'class-validator';
import { PricingMutationDto } from './pricing-mutation.dto';
import { UpdateRatePlanDto } from './update-rate-plan.dto';
import { UpdateRateRestrictionDto } from './update-rate-restriction.dto';
import { ActualRevenueDto, FinancialKpisDto, UnavailableMetricDto } from '../../reports/dto/financial-report.dto';
import { LosAdjustmentDto, OccupancyBandDto } from './rate-adjustment.dto';

export class LiveCalendarQueryDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @ApiProperty() @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() roomTypeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() ratePlanId?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) nights?: number;
}

export class LiveRateChangeDto extends PricingMutationDto {
  @ApiProperty() @IsUUID() propertyId!: string;
  @ApiProperty() @IsUUID() ratePlanId!: string;
  @ApiProperty({ enum: ['plan', 'restriction_create', 'restriction_update', 'restriction_delete'] })
  @IsEnum(['plan', 'restriction_create', 'restriction_update', 'restriction_delete']) kind!: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() restrictionId?: string;
  @ApiPropertyOptional({ type: UpdateRatePlanDto }) @IsOptional() @ValidateNested() @Type(() => UpdateRatePlanDto) plan?: UpdateRatePlanDto;
  @ApiPropertyOptional({ type: UpdateRateRestrictionDto }) @IsOptional() @ValidateNested() @Type(() => UpdateRateRestrictionDto) restriction?: UpdateRateRestrictionDto;
  @ApiProperty({ description: 'Inclusive preview window, maximum 93 days.' })
  @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @ApiProperty() @IsDateString() @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate!: string;
  @ApiPropertyOptional({ description: 'Preview stateToken, required when submitting a proposal.' })
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) stateToken?: string;
}

export class LiveRateDecisionDto extends PricingMutationDto {}

export class CanonicalRateOverrideDto {
  @ApiProperty() restrictionId!: string;
  @ApiProperty({ type: Number, nullable: true }) amount!: number | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class CanonicalRateDto {
  @ApiProperty() effectiveRate!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() baseRate!: number;
  @ApiPropertyOptional() nights?: number;
  @ApiPropertyOptional({ description: 'Property-wide authoritative on-books occupancy, percentage points; absent when inventory unavailable.' }) occupancyPct?: number;
  @ApiProperty({ type: LosAdjustmentDto, nullable: true }) losAdjustment!: LosAdjustmentDto | null;
  @ApiProperty({ type: OccupancyBandDto, nullable: true }) occupancyAdjustment!: OccupancyBandDto | null;
  @ApiProperty({ type: CanonicalRateOverrideDto, nullable: true }) override!: CanonicalRateOverrideDto | null;
  @ApiProperty() isTaxInclusive!: boolean;
}

export class CanonicalNightDto {
  @ApiProperty() date!: string;
  @ApiProperty() rate!: string;
  @ApiProperty() tax!: string;
}

export class CanonicalQuoteDto {
  @ApiProperty() currency!: string;
  @ApiProperty({ type: [CanonicalNightDto] }) lineItems!: CanonicalNightDto[];
  @ApiProperty() roomTotal!: string;
  @ApiProperty() taxTotal!: string;
  @ApiProperty() totalAmount!: string;
}

export class LiveRestrictionRecordDto {
  @ApiProperty({ description: 'UUID for persisted row; preview for an uncommitted new restriction.' }) id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() ratePlanId!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) minLos?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) maxLos?: number | null;
  @ApiPropertyOptional() closedToArrival?: boolean;
  @ApiPropertyOptional() closedToDeparture?: boolean;
  @ApiPropertyOptional() isClosed?: boolean;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Persisted decimal string; draft may carry DTO number.' }) rateOverride?: string | number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) overrideReason?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) overrideBy?: string | null;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'number' }, nullable: true }) dayOfWeekOverrides?: Record<string, number> | null;
  @ApiPropertyOptional() revision?: number;
  @ApiPropertyOptional() createdAt?: string;
  @ApiPropertyOptional() updatedAt?: string;
  @ApiPropertyOptional({ description: 'Updated parent-plan revision on mutation responses only.' }) planRevision?: number;
  @ApiPropertyOptional() deleted?: boolean;
}

export class PricingSalesStateDto {
  @ApiProperty() sellable!: boolean;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class LivePreviewDayDto {
  @ApiProperty() date!: string;
  @ApiProperty({ type: CanonicalRateDto }) before!: CanonicalRateDto;
  @ApiProperty({ type: CanonicalRateDto }) after!: CanonicalRateDto;
  @ApiProperty({ type: CanonicalQuoteDto }) beforeQuote!: CanonicalQuoteDto;
  @ApiProperty({ type: CanonicalQuoteDto }) afterQuote!: CanonicalQuoteDto;
  @ApiProperty({ type: PricingSalesStateDto }) beforeSales!: PricingSalesStateDto;
  @ApiProperty({ type: PricingSalesStateDto }) afterSales!: PricingSalesStateDto;
  @ApiProperty({ type: [LiveRestrictionRecordDto] }) beforeRestrictions!: LiveRestrictionRecordDto[];
  @ApiProperty({ type: [LiveRestrictionRecordDto] }) afterRestrictions!: LiveRestrictionRecordDto[];
}

export class PickupCountDto { @ApiProperty() roomNights!: number; }
export class PickupPeriodDto { @ApiProperty() from!: string; @ApiProperty() to!: string; }
export class PacePeriodDto { @ApiProperty() start!: string; @ApiProperty() end!: string; }
export class BookingPaceDayDto { @ApiProperty() date!: string; @ApiProperty() roomsOnBooks!: number; @ApiProperty() newBookings!: number; }
export class BookingPaceSummaryDto { @ApiProperty() avgRoomsOnBooks!: number; @ApiProperty() totalNewBookings!: number; }
export class LiveBookingPaceDto {
  @ApiProperty({ type: PacePeriodDto }) period!: PacePeriodDto;
  @ApiProperty({ type: [BookingPaceDayDto] }) daily!: BookingPaceDayDto[];
  @ApiProperty({ type: BookingPaceSummaryDto }) summary!: BookingPaceSummaryDto;
  @ApiProperty({ enum: [false] }) historicalAmendmentsReconstructed!: boolean;
}

export class LiveSignalDayDto {
  @ApiProperty() date!: string;
  @ApiProperty() totalRooms!: number;
  @ApiProperty() outOfOrder!: number;
  @ApiProperty() outOfService!: number;
  @ApiProperty() availableRooms!: number;
  @ApiProperty({ enum: ['active_rooms_and_inventory_blocks'] }) inventorySource!: string;
  @ApiProperty({ enum: ['CURRENT_ROOM_ROSTER_WITH_DATED_BLOCKS'] }) inventoryHistoryStatus!: string;
  @ApiProperty() roomsOnBooks!: number;
  @ApiProperty({ type: Number, nullable: true, description: '0..1 fraction, may exceed 1 for oversell; null without inventory.' }) onBooksOccupancy!: number | null;
  @ApiProperty() realisedRooms!: number;
  @ApiProperty({ type: Number, nullable: true }) realisedOccupancy!: number | null;
  @ApiProperty({ type: PickupCountDto }) pickup!: PickupCountDto;
  @ApiProperty({ type: PickupPeriodDto }) pickupPeriod!: PickupPeriodDto;
  @ApiProperty({ type: PickupCountDto }) pickupBaseline!: PickupCountDto;
  @ApiProperty({ enum: ['reservation_created_and_cancelled_timestamps'] }) pickupSource!: string;
  @ApiProperty({ enum: [false] }) historicalAmendmentsReconstructed!: boolean;
}

export class LiveRevenueSignalsDto {
  @ApiProperty() propertyId!: string;
  @ApiProperty({ type: String, nullable: true }) roomTypeId!: string | null;
  @ApiProperty() currencyCode!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() operationalDate!: string;
  @ApiProperty() startDate!: string;
  @ApiProperty() endDate!: string;
  @ApiProperty({ enum: ['ReportsService'] }) source!: string;
  @ApiProperty({ enum: [false] }) synthetic!: boolean;
  @ApiProperty({ enum: ['property_operational_date'] }) kpiScope!: string;
  @ApiProperty({ type: FinancialKpisDto }) kpis!: FinancialKpisDto;
  @ApiProperty({ type: ActualRevenueDto }) actual!: ActualRevenueDto;
  @ApiProperty({ type: [LiveSignalDayDto] }) daily!: LiveSignalDayDto[];
  @ApiProperty({ type: LiveBookingPaceDto }) pace!: LiveBookingPaceDto;
  @ApiProperty({ type: UnavailableMetricDto }) forecast!: UnavailableMetricDto;
}

export class LiveRateRecommendationDto {
  @ApiProperty({ enum: ['RULE_BASED'] }) status!: string;
  @ApiProperty() value!: number;
  @ApiProperty({ enum: ['RatePlanService'] }) source!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: [true] }) requiresHumanReview!: boolean;
}

export class LiveCalendarRateDto {
  @ApiProperty() date!: string;
  @ApiProperty() ratePlanId!: string;
  @ApiProperty() roomTypeId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() code!: string;
  @ApiProperty() planRevision!: number;
  @ApiProperty() currencyCode!: string;
  @ApiProperty({ type: CanonicalRateDto }) price!: CanonicalRateDto;
  @ApiProperty({ type: CanonicalQuoteDto }) quote!: CanonicalQuoteDto;
  @ApiProperty({ enum: [false] }) isEarnedRevenue!: boolean;
  @ApiProperty() sellable!: boolean;
  @ApiProperty({ type: String, nullable: true }) restrictionReason!: string | null;
  @ApiProperty({ type: [LiveRestrictionRecordDto] }) restrictions!: LiveRestrictionRecordDto[];
  @ApiProperty({ type: LiveRateRecommendationDto }) recommendation!: LiveRateRecommendationDto;
  @ApiProperty({ type: UnavailableMetricDto }) forecast!: UnavailableMetricDto;
}

export class PricingMutationResponseDto {
  @ApiProperty({ description: 'Plan, restriction, or proposal record; immutable original on retry.' }) record!: Record<string, unknown>;
  @ApiProperty() replayed!: boolean;
}

export class LiveRatePreviewDto {
  @ApiProperty({ enum: ['LIVE_PREVIEW'] }) mode!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() ratePlanId!: string;
  @ApiProperty() planRevision!: number;
  @ApiProperty() stateToken!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty() approvalRequired!: boolean;
  @ApiProperty({ type: [LivePreviewDayDto] }) days!: LivePreviewDayDto[];
  @ApiProperty() acceptedPricesChanged!: boolean;
  @ApiProperty({ enum: [false] }) isEarnedRevenue!: boolean;
}

export class LiveCalendarResponseDto {
  @ApiProperty({ enum: ['LIVE'] }) mode!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty({ type: LiveRevenueSignalsDto }) signals!: LiveRevenueSignalsDto;
  @ApiProperty({ type: [LiveCalendarRateDto] }) rates!: LiveCalendarRateDto[];
}

export class RateChangeRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() propertyId!: string;
  @ApiProperty() ratePlanId!: string;
  @ApiProperty({ enum: ['pending','approved','applied','rejected'] }) status!: string;
  @ApiProperty() revision!: number;
  @ApiProperty() expectedPlanRevision!: number;
  @ApiProperty() stateToken!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true }) requestedBy!: string | null;
  @ApiProperty({ nullable: true }) approvedBy!: string | null;
  @ApiProperty({ nullable: true }) decisionReason!: string | null;
  @ApiProperty() change!: Record<string, unknown>;
  @ApiProperty({ type: LiveRatePreviewDto }) preview!: LiveRatePreviewDto;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PricingRequestStateDto {
  @ApiProperty({ enum: ['unconfirmed', 'running', 'committed', 'closed'] }) state!: string;
  @ApiPropertyOptional({ type: 'object', description: 'Present only for committed requests; immutable original mutation record.' }) record?: Record<string, unknown>;
}
