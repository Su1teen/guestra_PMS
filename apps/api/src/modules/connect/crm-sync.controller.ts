import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { ConnectScopeGuard } from '../auth/connect-scope.guard';
import { ConnectV2Guard } from './connect-v2.guard';
import { ServiceCapability } from './service-capability.decorator';
import { CrmSyncService } from './crm-sync.service';
import { CrmSyncApplyDto, CrmSyncLinkDto } from './dto/crm-sync.dto';

const ENTITY_TYPES = ['reservation', 'folio', 'payment', 'service_booking'];

/** Staff two-way mirror with Guestra CRM. Reads use integration.read, writes the signed integration.write command. */
@ApiTags('Guestra integration v2') @ApiSecurity('api-key') @Controller('connect/v2/sync') @Public()
@UseGuards(ApiKeyGuard, ConnectScopeGuard, ConnectV2Guard)
export class CrmSyncController {
  constructor(private readonly sync: CrmSyncService) {}

  @Get('reservations/:id') @ServiceCapability('integration.read') @ApiOperation({ summary: 'Staff snapshot of a stay: guest, category, room, folio ledger, services' })
  reservation(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.sync.snapshot(propertyId, id);
  }

  @Get('resolve/:type/:id') @ServiceCapability('integration.read') @ApiOperation({ summary: 'Resolve a domain event entity to its stay snapshot' })
  resolve(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Param('type') type: string, @Param('id', ParseUUIDPipe) id: string) {
    if (!ENTITY_TYPES.includes(type)) throw new BadRequestException('UNSUPPORTED_ENTITY');
    return this.sync.resolve(propertyId, type, id);
  }

  @Post('apply') @ServiceCapability('integration.write') @ApiOperation({ summary: 'Apply a CRM stay with its charges, payments and status exactly once' })
  apply(@Body() dto: CrmSyncApplyDto) { return this.sync.apply(dto); }

  @Post('links') @ServiceCapability('integration.write') @ApiOperation({ summary: 'Record the CRM customer / reservation created for a mirrored PMS stay' })
  link(@Body() dto: CrmSyncLinkDto) { return this.sync.linkGuest(dto); }
}
