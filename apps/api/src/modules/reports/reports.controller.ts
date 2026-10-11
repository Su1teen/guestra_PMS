import {
  Controller,
  Get,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ReportsService } from './reports.service';
import { PortfolioPropertyResolver } from './portfolio-property-resolver';
import { RequirePermissions } from '../auth/permissions.decorator';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { ReportQueryDto } from './dto/report-query.dto';
import { DailyRevenueResponseDto, FinancialSummaryResponseDto, ManagementSummaryResponseDto,
  RevenuePeriodsResponseDto, RevenueTrendResponseDto, ReportRangeDto } from './dto/financial-report.dto';

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
  ) {}

  private authOn(): boolean {
    return this.configService.get<string>('AUTH_ENABLED', 'true') !== 'false';
  }

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
        'pickup',
        'booking-pace',
      ],
    };
  }

  @Get('/daily-revenue')
  @ApiOperation({ summary: 'Daily revenue report' })
  @ApiOkResponse({ type: DailyRevenueResponseDto })
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiQuery({ name: 'date', required: true })
  async getDailyRevenue(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date: string,
  ) {
    return this.reportsService.getDailyRevenue(propertyId, date);
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
  @ApiQuery({ name: 'date', required: true })
  async getFinancialSummary(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date: string,
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
  @ApiQuery({ name: 'date', required: true })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'propertyIds', required: false, description: 'Comma-separated property UUIDs' })
  async getPortfolioFinancialSummary(
    @Query('date') date: string,
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
  @ApiQuery({ name: 'date', required: true })
  @ApiQuery({ name: 'organizationId', required: false })
  @ApiQuery({ name: 'propertyIds', required: false, description: 'Comma-separated property UUIDs' })
  async getPortfolioOccupancy(
    @Query('date') date: string,
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
