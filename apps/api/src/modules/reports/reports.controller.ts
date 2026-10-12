import {
  Controller,
  Get,
  Query,
  ParseUUIDPipe,
  Post, Body,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ReportsService } from './reports.service';
import { ManagementInputsService } from './management-inputs.service';
import { ManagementInputDto, ManagementReportQueryDto, ManagementOperationsQueryDto } from './dto/management-report.dto';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { PortfolioPropertyResolver } from './portfolio-property-resolver';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ReportQueryDto } from './dto/report-query.dto';
import { BusinessDateResponseDto, DailyRevenueResponseDto, FinancialSummaryResponseDto, ManagementSummaryResponseDto,
  RevenuePeriodsResponseDto, RevenueOverviewResponseDto, RevenueTrendResponseDto, ReportRangeDto, PortfolioFinancialResponseDto } from './dto/financial-report.dto';

@ApiTags('reports')
@Controller('reports')
// Financial / occupancy reports are management data. Without this, RolesGuard and
// PermissionsGuard default-allow any authenticated user (e.g. housekeeping) for a
// property they belong to. PermissionsGuard enforces this for every route below.
@RequirePermissions('reports.view')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly portfolioResolver: PortfolioPropertyResolver,
    private readonly configService: ConfigService,
    private readonly managementInputs: ManagementInputsService,
  ) {}

  private authOn(): boolean {
    return this.configService.get<string>('AUTH_ENABLED', 'true') !== 'false';
  }

  @Get('/management-report')
  @RequirePermissions('reports.view','management_dashboard.view')
  @ApiOperation({ summary:'Signed management hierarchy with versioned supplied budgets and expenses' })
  async managementReport(@Query() q: ManagementReportQueryDto) { return this.reportsService.getManagementReport(q.propertyId,q.startDate,q.endDate,q.date); }

  @Get('/management-operations')
  @RequirePermissions('reports.view','management_dashboard.view','folios.read')
  @ApiOperation({ summary:'Property-scoped signed earned operations, 100 rows per page' })
  async managementOperations(@Query() q: ManagementOperationsQueryDto) { return this.reportsService.getManagementOperations(q.propertyId,q.startDate,q.endDate,q.article,Number(q.offset ?? 0)); }

  @Get('/management-inputs')
  @RequirePermissions('reports.view','management_dashboard.view')
  @ApiOperation({ summary:'Immutable management input versions for one property and period' })
  async managementInputHistory(@Query() q: ManagementReportQueryDto) { return this.managementInputs.history(q.propertyId,q.startDate,q.endDate); }

  @Post('/management-inputs')
  @RequirePermissions('reports.view','management_dashboard.view','accounting.manage')
  @ApiOperation({ summary:'Publish a versioned daily budget or confirmed operating expenses without posting to folios' })
  async publishManagementInputs(@Body() body: ManagementInputDto,@AuditActorCtx() actor: AuditActor) { return this.managementInputs.save(body,actor); }

  private parsePropertyIds(raw?: string): string[] | undefined {
    if (!raw) return undefined;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  @Get()
  @ApiOperation({ summary: 'Available reports' })
  async listReports() {
    return {
      reports: [
        'daily-revenue',
        'management-summary',
        'occupancy',
        'financial-summary',
        'trial-balance',
        'occupancy-trend',
        'revenue-trend',
        'revenue-periods',
        'revenue-overview',
        'pickup',
        'booking-pace',
      ],
    };
  }

  @Get('/daily-revenue')
  @ApiOperation({ summary: 'Daily revenue report' })
  @ApiOkResponse({ type: DailyRevenueResponseDto })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'date', required: false })
  async getDailyRevenue(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date?: string,
  ) {
    return this.reportsService.getDailyRevenue(propertyId, date);
  }

  @Get('/business-date')
  @ApiOperation({ summary: 'Authoritative operational business date from completed audit or property timezone' })
  @ApiOkResponse({ type: BusinessDateResponseDto })
  async getBusinessDate(@Query() query: ReportQueryDto) {
    return this.reportsService.getBusinessDate(query.propertyId);
  }

  @Get('/revenue-overview')
  @ApiOperation({ summary: 'Revenue workspace financial overview using shared reporting contracts' })
  @ApiOkResponse({ type: RevenueOverviewResponseDto })
  async getRevenueOverview(@Query() query: ReportQueryDto) {
    return this.reportsService.getRevenueOverview(query.propertyId, query.date);
  }

  @Get('/management-summary')
  @RequirePermissions('management_dashboard.view')
  @ApiOperation({ summary: 'Management dashboard + Daily Revenue Report cockpit' })
  @ApiOkResponse({ type: ManagementSummaryResponseDto })
  async getManagementSummary(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date: string,
  ) { return this.reportsService.getManagementSummary(propertyId, date); }

  @Get('/occupancy')
  @ApiOperation({ summary: 'Occupancy report' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'Business date YYYY-MM-DD. Defaults to operational business date in the property timezone.',
  })
  async getOccupancy(@Query() query: ReportQueryDto) {
    return this.reportsService.getOccupancy(
      query.propertyId,
      query.date,
    );
  }

  @Get('/financial-summary')
  @ApiOperation({ summary: 'Financial summary (Manager\'s Report)' })
  @ApiOkResponse({ type: FinancialSummaryResponseDto })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'date', required: false })
  async getFinancialSummary(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date?: string,
  ) {
    return this.reportsService.getFinancialSummary(propertyId, date);
  }

  @Get('/trial-balance')
  @ApiOperation({ summary: 'Daily trial balance (Deposit / Guest / A/R ledgers)' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'date', required: true })
  async getTrialBalance(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date: string,
  ) {
    return this.reportsService.dailyTrialBalance(propertyId, date);
  }

  @Get('/occupancy-trend')
  @ApiOperation({ summary: 'Occupancy trend report over date range' })
  @ApiOkResponse({ type: RevenueTrendResponseDto })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async getOccupancyTrend(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getOccupancyTrend(propertyId, startDate, endDate);
  }

  @Get('/revenue-trend')
  @ApiOperation({ summary: 'Signed earned revenue and inventory trend (same source as occupancy trend)' })
  @ApiOkResponse({ type: RevenueTrendResponseDto })
  async getRevenueTrend(@Query() query: ReportRangeDto) {
    return this.reportsService.getOccupancyTrend(query.propertyId, query.startDate, query.endDate);
  }

  @Get('/revenue-periods')
  @ApiOperation({ summary: 'Calendar actuals, booking metrics and explicit unavailable forecast/plan/GOP' })
  @ApiOkResponse({ type: RevenuePeriodsResponseDto })
  async getRevenuePeriods(@Query() query: ReportQueryDto) {
    return this.reportsService.getRevenuePeriods(query.propertyId, query.date);
  }

  @Get('/pickup')
  @ApiOperation({ summary: 'Pickup report — room nights gained/lost for a stay date' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'stayDate', required: true, description: 'Stay night to measure pickup for' })
  @ApiQuery({ name: 'from', required: true, description: 'Start of booking window (ISO date)' })
  @ApiQuery({ name: 'to', required: true, description: 'End of booking window (ISO date)' })
  async getPickup(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('stayDate') stayDate: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.reportsService.getPickup(propertyId, stayDate, from, to);
  }

  @Get('/booking-pace')
  @ApiOperation({ summary: 'Booking pace — rooms on books per stay date + daily new bookings' })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  async getBookingPace(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getBookingPace(propertyId, startDate, endDate);
  }

  @Get('/portfolio/financial-summary')
  @ApiOperation({ summary: 'Portfolio financial summary across properties' })
  @ApiOkResponse({ type: PortfolioFinancialResponseDto })
  @ApiQuery({ name: 'date', required: false, description: 'Omit for each property operational business date' })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'propertyIds', required: false, description: 'Comma-separated property UUIDs' })
  async getPortfolioFinancialSummary(
    @Query('date') date: string | undefined,
    @Query('organizationId') organizationId: string | undefined,
    @Query('propertyIds') propertyIdsRaw: string | undefined,
    @CurrentUser() user?: AuthUser,
  ) {
    const propertyIds = await this.portfolioResolver.resolvePropertyIds(
      user,
      this.authOn(),
      organizationId,
      this.parsePropertyIds(propertyIdsRaw),
    );
    return this.reportsService.getPortfolioFinancialSummary(propertyIds, date);
  }

  @Get('/portfolio/occupancy')
  @ApiOperation({ summary: 'Portfolio occupancy across properties' })
  @ApiQuery({ name: 'date', required: false, description: 'Omit for each property operational business date' })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'propertyIds', required: false, description: 'Comma-separated property UUIDs' })
  async getPortfolioOccupancy(
    @Query('date') date: string | undefined,
    @Query('organizationId') organizationId: string | undefined,
    @Query('propertyIds') propertyIdsRaw: string | undefined,
    @CurrentUser() user?: AuthUser,
  ) {
    const propertyIds = await this.portfolioResolver.resolvePropertyIds(
      user,
      this.authOn(),
      organizationId,
      this.parsePropertyIds(propertyIdsRaw),
    );
    return this.reportsService.getPortfolioOccupancy(propertyIds, date);
  }
}
