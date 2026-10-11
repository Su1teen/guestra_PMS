import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ConnectServiceBookingService } from './connect-service-booking.service';
import { ServiceBlockDto, ServiceChangeDto, ServiceStatusDto, ServiceMutationDto, ServiceResourceDto, StaffServiceAvailabilityDto, StaffServiceBookDto } from './dto/service-operations.dto';

@ApiTags('Service operations')
@Controller('services')
export class ServiceOperationsController {
  constructor(private readonly service: ConnectServiceBookingService) {}
  @Get('calendar') @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Read the complete bounded service/resource calendar' })
  @ApiQuery({ name: 'propertyId', required: true })
  calendar(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('startAt') startAt: string, @Query('endAt') endAt: string) { return this.service.calendar(propertyId, startAt, endAt); }
  @Post('availability') @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Check authoritative service availability and price' })
  availability(@Body() dto: StaffServiceAvailabilityDto) { return this.service.availability(dto, undefined, dto.resourceId); }
  @Post('bookings') @RequirePermissions('services.read', 'reservations.write')
  @ApiOperation({ summary: 'Create a confirmed, retry-safe service booking using the existing scheduling domain' })
  book(@Body() dto: StaffServiceBookDto) { return this.service.book(dto, 'front_desk', dto.resourceId); }
  @Get('booking-request') @RequirePermissions('services.read', 'reservations.write')
  @ApiOperation({ summary: 'Recover an accepted booking after an uncertain network response' })
  @ApiQuery({ name: 'propertyId', required: true }) @ApiQuery({ name: 'idempotencyKey', required: true })
  async recover(@Query('propertyId', ParseUUIDPipe) propertyId: string, @Query('idempotencyKey') key: string) {
    const { folio: _privateFolio, idempotencyKey: _privateKey, ...booking } = await this.service.recover(propertyId, key);
    return booking;
  }
  @Get('bookings/:id') @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Read booking, accepted price and actual financial review state' })
  async get(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    const { folio: _privateFolio, idempotencyKey: _privateKey, ...booking } = await this.service.get(id, propertyId);
    return booking;
  }
  @Get('bookings/:id/history') @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Read the property-scoped existing booking audit timeline' })
  history(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) { return this.service.history(id, propertyId); }
  @Patch('bookings/:id') @RequirePermissions('services.read', 'reservations.write')
  @ApiOperation({ summary: 'Move time/resource/participants without rewriting the accepted price' })
  change(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceChangeDto) { return this.service.change(id, dto); }
  @Post('bookings/:id/preview') @RequirePermissions('services.read')
  @ApiOperation({ summary: 'Preview resource conflicts and preserved accepted price for a move' })
  preview(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceChangeDto) { return this.service.previewChange(id, dto); }
  @Post('bookings/:id/cancel') @RequirePermissions('services.read', 'reservations.write')
  @ApiOperation({ summary: 'Cancel and release capacity; financial adjustments use the manual folio workflow' })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceStatusDto) { return this.service.transition(id, dto, 'cancelled'); }
  @Post('bookings/:id/complete') @RequirePermissions('services.read', 'reservations.write')
  @ApiOperation({ summary: 'Record provision of the service; this does not create or confirm a payment' })
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceStatusDto) { return this.service.transition(id, dto, 'completed'); }
  @Post('resources') @RequirePermissions('services.manage')
  @ApiOperation({ summary: 'Create an operational resource with capacity, working windows and buffers' })
  createResource(@Body() dto: ServiceResourceDto) { return this.service.createResource(dto); }
  @Post('resource-blocks') @RequirePermissions('services.manage')
  @ApiOperation({ summary: 'Block a free resource interval without invalidating accepted bookings' })
  block(@Body() dto: ServiceBlockDto) { return this.service.createBlock(dto); }
  @Post('resource-blocks/:id/remove') @RequirePermissions('services.manage')
  @ApiOperation({ summary: 'Remove a scoped resource block with a durable mutation receipt' })
  removeBlock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceMutationDto) { return this.service.removeBlock(id, dto); }
}
