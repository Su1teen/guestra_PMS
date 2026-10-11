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
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ServiceRequestsService } from './service-requests.service';
import {
  CreateServiceRequestDto,
  UpdateServiceRequestDto,
  ListServiceRequestsDto,
  CreateTaskFromRequestDto,
  AddServiceRequestCommentDto,
} from './dto/service-request.dto';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { ConfigService } from '@nestjs/config';
import { PermissionsService } from '../auth/permissions.service';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';

@ApiTags('service-requests')
@Controller('service-requests')
export class ServiceRequestsController {
  constructor(
    private readonly serviceRequestsService: ServiceRequestsService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @RequirePermissions('ops.manage')
  @ApiOperation({ summary: 'Create a service request' })
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateServiceRequestDto) {
    return this.serviceRequestsService.create(dto);
  }

  @Get()
  @RequirePermissions('ops.read')
  @ApiOperation({ summary: 'List service requests' })
  list(@Query() dto: ListServiceRequestsDto) {
    return this.serviceRequestsService.list(dto);
  }

  @Get(':id')
  @RequirePermissions('ops.read')
  @ApiOperation({ summary: 'Get service request by ID' })
  @ApiQuery({ name: 'propertyId', type: String, required: true })
  getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.serviceRequestsService.findById(id, propertyId);
  }

  @Patch(':id')
  @RequirePermissions('ops.manage')
  @ApiOperation({ summary: 'Update service request' })
  @ApiQuery({ name: 'propertyId', type: String, required: true })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: UpdateServiceRequestDto,
  ) {
    return this.serviceRequestsService.update(id, propertyId, dto);
  }

  @Post(':id/comments')
  @RequirePermissions('ops.manage')
  @ApiOperation({ summary: 'Add an operational task comment' })
  addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddServiceRequestCommentDto,
    @AuditActorCtx() actor: AuditActor,
  ) {
    return this.serviceRequestsService.addComment(id, dto.propertyId, dto.body, actor.userId);
  }

  @Post(':id/create-task')
  @RequirePermissions('ops.manage')
  @ApiOperation({ summary: 'Create a linked housekeeping task from a service request' })
  async createTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTaskFromRequestDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    let localActor = { ...actor, userId: null as string | null };
    let grants: string[] | undefined;
    if (this.config.get('AUTH_ENABLED', 'true') !== 'false') {
      const local =
        user && (await this.permissions.findLocalUser(user.sub, user.email));
      if (!local || local.status !== 'active')
        throw new ForbiddenException('Нет активной учётной записи.');
      grants = await this.permissions.getEffectivePermissions(
        local.id,
        dto.propertyId,
      );
      localActor = { ...actor, userId: local.id };
    }
    return this.serviceRequestsService.createLinkedTask(
      id,
      dto,
      localActor,
      grants,
    );
  }

  @Delete(':id')
  @RequirePermissions('ops.manage')
  @ApiOperation({ summary: 'Delete service request' })
  @ApiQuery({ name: 'propertyId', type: String, required: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.serviceRequestsService.delete(id, propertyId);
  }
}
