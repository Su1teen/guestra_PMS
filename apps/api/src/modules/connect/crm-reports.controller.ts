import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { ConnectV2Guard } from './connect-v2.guard';
import { ServiceCapability } from './service-capability.decorator';
import { MoneyReportsService } from '../reports/money-reports.service';
import { ReportsService } from '../reports/reports.service';

/** Money reports for Guestra CRM: the same figures as the PMS screens, read with integration.read. */
@ApiTags('Guestra integration v2') @ApiSecurity('api-key') @Controller('connect/v2/reports') @Public()
@UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
export class CrmReportsController {
  constructor(private readonly reports: MoneyReportsService, private readonly ledger: ReportsService) {}

  @Get('day-by-day') @ServiceCapability('integration.read') @ApiOperation({ summary: 'Money received per day by payment date' })
  dayByDay(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.reports.dayByDay(propertyId, from, to);
  }

  @Get('commission-base') @ServiceCapability('integration.read') @ApiOperation({ summary: 'Accommodation paid per stay for manager commission' })
  commissionBase(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.reports.commissionBase(propertyId, from, to);
  }

  @Get('management') @ServiceCapability('integration.read') @ApiOperation({ summary: 'Management report with plan and previous period' })
  management(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.reports.management(propertyId, from, to);
  }

  @Get('manager') @ServiceCapability('integration.read') @ApiOperation({ summary: "Manager's report: day, month and year to date with last year" })
  manager(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('date') date?: string) {
    return this.ledger.getManagerReport(propertyId, date);
  }

  @Get('outlets') @ServiceCapability('integration.read') @ApiOperation({ summary: 'Revenue of points of sale per department and outlet' })
  outlets(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('from') from: string, @Query('to') to: string) {
    return this.ledger.getOutletRevenue(propertyId, from, to);
  }
}
