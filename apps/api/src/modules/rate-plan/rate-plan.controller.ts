import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { RatePlanService } from './rate-plan.service';
import { CreateRatePlanDto } from './dto/create-rate-plan.dto';
import { GuardedUpdateRatePlanDto } from './dto/update-rate-plan.dto';
import { CreateRateRestrictionDto } from './dto/create-rate-restriction.dto';
import { GuardedUpdateRateRestrictionDto } from './dto/update-rate-restriction.dto';
import { EffectiveRateQueryDto } from './dto/effective-rate-query.dto';
import { resolvePropertyId } from '../../common/property-id';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { PricingMutationDto } from './dto/pricing-mutation.dto';
import { LiveCalendarQueryDto, LiveCalendarResponseDto, LiveRateChangeDto, LiveRatePreviewDto, LiveRateDecisionDto, PricingMutationResponseDto, RateChangeRecordDto, PricingRequestStateDto } from './dto/live-rate.dto';

@ApiTags('rate-plans')
@Controller('rate-plans')
export class RatePlanController {
  constructor(private readonly ratePlanService: RatePlanService) {}

  @Get('live-calendar')
  @RequirePermissions('rateplans.read', 'reports.view')
  @ApiOperation({ summary: 'Canonical live rate calendar and real commercial signals; never synthetic actuals' })
  @ApiResponse({ status: 200, type: LiveCalendarResponseDto })
  liveCalendar(@Query() query: LiveCalendarQueryDto) { return this.ratePlanService.liveCalendar(query); }

  @Post('live-preview')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Read-only canonical before/after live rate preview (no prices applied)' })
  @ApiResponse({ status: 201, type: LiveRatePreviewDto })
  previewLiveChange(@Body() dto: LiveRateChangeDto, @Query('propertyId', new ParseUUIDPipe({ optional: true })) propertyId?: string) {
    if (propertyId && propertyId !== dto.propertyId) throw new BadRequestException('Body/query propertyId mismatch');
    return this.ratePlanService.previewLiveChange(dto);
  }

  @Post('rate-changes')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Submit validated live preview to approval queue' })
  @ApiResponse({ status: 201, type: PricingMutationResponseDto })
  submitLiveChange(@Body() dto: LiveRateChangeDto, @AuditActorCtx() actor: AuditActor,
    @Query('propertyId', new ParseUUIDPipe({ optional: true })) propertyId?: string) {
    if (propertyId && propertyId !== dto.propertyId) throw new BadRequestException('Body/query propertyId mismatch');
    return this.ratePlanService.submitLiveChange(dto, actor);
  }

  @Get('approval-queue')
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Pending and approved pricing changes for this property' })
  @ApiResponse({ status: 200, type: [RateChangeRecordDto] })
  approvalQueue(@Query('propertyId', ParseUUIDPipe) propertyId: string) { return this.ratePlanService.approvalQueue(propertyId); }

  @Get('rate-changes')
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Pricing proposal and decision history for this property' })
  @ApiResponse({ status: 200, type: [RateChangeRecordDto] })
  rateChangeHistory(@Query('propertyId', ParseUUIDPipe) propertyId: string) { return this.ratePlanService.changeHistory(propertyId); }

  @Post('rate-changes/:changeId/approve')
  @RequirePermissions('rateplans.manage', 'revenue.manage')
  @ApiOperation({ summary: 'Approve an unchanged live pricing proposal' })
  @ApiResponse({ status: 201, type: PricingMutationResponseDto })
  approveLiveChange(@Param('changeId', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: LiveRateDecisionDto, @AuditActorCtx() actor: AuditActor) { return this.ratePlanService.decideLiveChange(id, propertyId, 'approve', dto, actor); }

  @Post('rate-changes/:changeId/apply')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Apply eligible unchanged proposal to canonical rates; preserve accepted pricing' })
  @ApiResponse({ status: 201, type: PricingMutationResponseDto })
  applyLiveChange(@Param('changeId', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: LiveRateDecisionDto, @AuditActorCtx() actor: AuditActor) { return this.ratePlanService.decideLiveChange(id, propertyId, 'apply', dto, actor); }

  @Post('rate-changes/:changeId/reject')
  @RequirePermissions('rateplans.manage', 'revenue.manage')
  @ApiOperation({ summary: 'Reject pending or approved proposal without changing live rates' })
  @ApiResponse({ status: 201, type: PricingMutationResponseDto })
  rejectLiveChange(@Param('changeId', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: LiveRateDecisionDto, @AuditActorCtx() actor: AuditActor) { return this.ratePlanService.decideLiveChange(id, propertyId, 'reject', dto, actor); }

  @Get('requests/:requestId')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Recover immutable result for an actor-owned pricing request' })
  @ApiResponse({ status: 200, type: PricingRequestStateDto })
  requestResult(@Param('requestId', ParseUUIDPipe) requestId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @AuditActorCtx() actor: AuditActor) { return this.ratePlanService.recoverRequest(propertyId, requestId, actor); }

  @Post('requests/:requestId/close')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Terminally fence an abandoned request; never cancel an already committed change' })
  @ApiResponse({ status: 201, type: PricingRequestStateDto })
  closeRequest(@Param('requestId', ParseUUIDPipe) requestId: string, @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @AuditActorCtx() actor: AuditActor) { return this.ratePlanService.recoverRequest(propertyId, requestId, actor, true); }

  @Get()
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Get all rate plans for a property' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiResponse({ status: 200, description: 'List of rate plans' })
  getAllRatePlans(@Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.ratePlanService.findAll(propertyId);
  }

  @Get('pricing-history')
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Get manual pricing override audit history' })
  pricingHistory(@Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.ratePlanService.pricingHistory(propertyId);
  }

  @Post()
  @RequirePermissions('rateplans.manage')
  @ApiOperation({
    summary: 'Create new rate plan',
    description:
      'propertyId may be sent in the JSON body (preferred) or as ?propertyId= when omitted from the body. If both are sent they must match.',
  })
  @ApiQuery({
    name: 'propertyId',
    required: false,
    description: 'Alias when body omits propertyId',
  })
  @ApiResponse({ status: 201, type: PricingMutationResponseDto })
  createRatePlan(
    @Body() dto: CreateRatePlanDto,
    @Query('propertyId', new ParseUUIDPipe({ optional: true })) queryPropertyId?: string,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    dto.propertyId = resolvePropertyId({ body: dto.propertyId, query: queryPropertyId });
    return this.ratePlanService.create(dto as CreateRatePlanDto & { propertyId: string }, actor);
  }

  @Get(':id')
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Get rate plan by ID' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiResponse({ status: 200, description: 'Rate plan found' })
  @ApiResponse({ status: 404, description: 'Rate plan not found' })
  getRatePlanById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.ratePlanService.findById(id, propertyId);
  }

  @Get(':id/effective-rate')
  @RequirePermissions('rateplans.read')
  @ApiOperation({
    summary: 'Calculate effective rate (derived chain + LOS + occupancy adjustments)',
  })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'nights', required: false, description: 'Length of stay in nights' })
  @ApiQuery({ name: 'checkIn', required: false, description: 'Arrival date (ISO)' })
  @ApiQuery({ name: 'checkOut', required: false, description: 'Departure date (ISO)' })
  @ApiQuery({ name: 'stayDate', required: false, description: 'Stay night for occupancy lookup' })
  @ApiResponse({ status: 200, description: 'Effective rate calculated' })
  getEffectiveRate(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query() context: EffectiveRateQueryDto,
  ) {
    return this.ratePlanService.calculateDerivedRate(id, propertyId, context);
  }

  @Patch(':id')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Update rate plan' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiResponse({ status: 200, type: PricingMutationResponseDto })
  @ApiResponse({ status: 404, description: 'Rate plan not found' })
  updateRatePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: GuardedUpdateRatePlanDto,
    @AuditActorCtx() actor: AuditActor,
  ) {
    return this.ratePlanService.update(id, propertyId, dto, actor);
  }

  // --- Restrictions sub-resource ---

  @Get(':id/restrictions')
  @RequirePermissions('rateplans.read')
  @ApiOperation({ summary: 'Get restrictions for a rate plan' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiResponse({ status: 200, description: 'List of restrictions' })
  getRestrictions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.ratePlanService.findRestrictions(id, propertyId);
  }

  @Post(':id/restrictions')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Create restriction for a rate plan' })
  @ApiResponse({ status: 201, type: PricingMutationResponseDto })
  createRestriction(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRateRestrictionDto,
    @AuditActorCtx() actor: AuditActor,
    @Query('propertyId', new ParseUUIDPipe({ optional: true })) propertyId?: string,
  ) {
    if (propertyId && propertyId !== dto.propertyId) throw new BadRequestException('Body/query propertyId mismatch');
    return this.ratePlanService.createRestriction(id, dto.propertyId, dto, actor);
  }

  @Patch(':id/restrictions/:restrictionId')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Update a rate restriction' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiResponse({ status: 200, type: PricingMutationResponseDto })
  @ApiResponse({ status: 404, description: 'Restriction not found' })
  updateRestriction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('restrictionId', ParseUUIDPipe) restrictionId: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: GuardedUpdateRateRestrictionDto,
    @AuditActorCtx() actor: AuditActor,
  ) {
    return this.ratePlanService.updateRestriction(restrictionId, propertyId, dto, actor, id);
  }

  @Delete(':id/restrictions/:restrictionId')
  @RequirePermissions('rateplans.manage')
  @ApiOperation({ summary: 'Delete a rate restriction' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiResponse({ status: 200, type: PricingMutationResponseDto })
  @ApiResponse({ status: 404, description: 'Restriction not found' })
  deleteRestriction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('restrictionId', ParseUUIDPipe) restrictionId: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: PricingMutationDto,
    @AuditActorCtx() actor: AuditActor,
  ) {
    return this.ratePlanService.deleteRestriction(restrictionId, propertyId, dto, actor, id);
  }
}
