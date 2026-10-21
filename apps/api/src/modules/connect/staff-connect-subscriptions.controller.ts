import { Controller, Get, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ConnectEventsService } from './connect-events.service';

/** Staff settings use staff guards; the browser never receives a service credential. */
@ApiTags('Staff integration settings')
@Controller('settings/connect/subscriptions')
@Roles('admin')
export class StaffConnectSubscriptionsController {
  constructor(private readonly events: ConnectEventsService) {}
  @Get()
  @RequirePermissions('settings.manage')
  @ApiQuery({ name: 'propertyId', required: true })
  @ApiOperation({ summary: 'List redacted subscriptions through the existing staff settings authorization' })
  list(@Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.events.listSubscriptions(propertyId);
  }
}
