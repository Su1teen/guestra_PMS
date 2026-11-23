import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { ConnectV2Guard } from './connect-v2.guard';
import { ServiceCapability } from './service-capability.decorator';
import { PriceCalendarService } from '../rate-plan/price-calendar.service';

/** Price calendar for Guestra CRM and the guest agent: the same nightly prices PMS sells at, with the reasons. */
@ApiTags('Guestra integration v2') @ApiSecurity('api-key') @Controller('connect/v2/price-calendar') @Public()
@UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
export class CrmPriceCalendarController {
  constructor(private readonly calendar: PriceCalendarService) {}

  @Get() @ServiceCapability('integration.read') @ApiOperation({ summary: 'Final nightly price per room type and plan, with why' })
  get(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('from') from: string, @Query('to') to: string,
    @Query('roomTypeId', new ParseUUIDPipe({ optional: true })) roomTypeId?: string) {
    return this.calendar.publicCalendar(propertyId, from, to, roomTypeId);
  }
}
