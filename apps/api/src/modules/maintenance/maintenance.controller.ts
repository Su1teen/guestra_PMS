import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { RequirePermissions } from '../auth/permissions.decorator';
import {
  CreateMaintenanceTicketDto,
  ListMaintenanceTicketsDto,
  MaintenanceAttachmentDto,
  MaintenanceCommentDto,
  ReturnToServiceDto,
  UpdateMaintenanceTicketDto,
} from './dto/maintenance.dto';
import { MaintenanceService } from './maintenance.service';

@ApiTags('maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly service: MaintenanceService) {}

  @Get()
  @RequirePermissions('maintenance.view')
  @ApiOperation({ summary: 'List maintenance tickets with SLA filters' })
  list(@Query() dto: ListMaintenanceTicketsDto) { return this.service.list(dto); }

  @Get(':id')
  @RequirePermissions('maintenance.view')
  @ApiQuery({ name: 'propertyId', required: true })
  get(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.service.findById(id, propertyId);
  }

  @Post()
  @RequirePermissions('maintenance.create')
  create(@Body() dto: CreateMaintenanceTicketDto, @AuditActorCtx() actor: AuditActor) {
    return this.service.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions('maintenance.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: UpdateMaintenanceTicketDto,
    @AuditActorCtx() actor: AuditActor,
  ) { return this.service.update(id, propertyId, dto, actor); }

  @Post(':id/comments')
  @RequirePermissions('maintenance.update')
  comment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaintenanceCommentDto, @AuditActorCtx() actor: AuditActor) {
    return this.service.addComment(id, dto.propertyId, dto.body, actor);
  }

  @Post(':id/attachments')
  @RequirePermissions('maintenance.update')
  attachment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MaintenanceAttachmentDto, @AuditActorCtx() actor: AuditActor) {
    const { propertyId, ...attachment } = dto;
    return this.service.addAttachment(id, propertyId, attachment, actor);
  }

  @Post(':id/return-to-service')
  @RequirePermissions('maintenance.close')
  returnToService(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnToServiceDto, @AuditActorCtx() actor: AuditActor) {
    return this.service.confirmReturnToService(id, dto.propertyId, dto.note, actor);
  }
}
