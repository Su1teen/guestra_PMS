import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { RequirePermissions } from '../auth/permissions.decorator';
import {
  CreateMaintenanceTicketDto,
  ListMaintenanceTicketsDto,
  MaintenancePageDto,
  MaintenanceCommentDto,
  MaintenanceRequestDto,
  ReturnToServiceDto,
  UpdateMaintenanceTicketDto,
} from './dto/maintenance.dto';
import { MaintenanceService } from './maintenance.service';
import { PermissionsService } from '../auth/permissions.service';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';

@ApiTags('maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    private readonly service: MaintenanceService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
  ) {}
  private async actor(
    propertyId: string,
    user: AuthUser | undefined,
    actor: AuditActor | undefined,
    inventoryChange = false,
  ) {
    if (this.config.get('AUTH_ENABLED', 'true') === 'false')
      return { ...actor, userId: null };
    const local =
      user && (await this.permissions.findLocalUser(user.sub, user.email));
    if (!local || local.status !== 'active')
      throw new ForbiddenException('Нет активной учётной записи сотрудника.');
    if (
      inventoryChange &&
      !(
        await this.permissions.getEffectivePermissions(local.id, propertyId)
      ).includes('rooms.write')
    )
      throw new ForbiddenException('Нет права изменения доступности номера.');
    return { ...actor, userId: local.id };
  }
  @Get('request')
  @RequirePermissions('maintenance.view')
  @ApiOperation({
    summary: 'Recover the original accepted maintenance operation',
  })
  requestStatus(@Query() dto: MaintenanceRequestDto) {
    return this.service.requestStatus(dto.propertyId, dto.idempotencyKey);
  }
  @Post('request/close')
  @RequirePermissions('maintenance.view')
  @ApiOperation({
    summary: 'Fence an unaccepted maintenance request against late delivery',
  })
  async closeRequest(
    @Body() dto: MaintenanceRequestDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    const localActor = await this.actor(dto.propertyId, user, actor);
    if (this.config.get('AUTH_ENABLED', 'true') !== 'false') {
      const keys = await this.permissions.getEffectivePermissions(
        localActor.userId!,
        dto.propertyId,
      );
      if (
        !['maintenance.create', 'maintenance.update', 'maintenance.close'].some(
          (key) => keys.includes(key),
        )
      )
        throw new ForbiddenException(
          'Нет права закрытия незавершённого запроса.',
        );
    }
    return this.service.closeRequest(
      dto.propertyId,
      dto.idempotencyKey,
      localActor,
    );
  }

  @Get()
  @RequirePermissions('maintenance.view')
  @ApiOperation({ summary: 'List maintenance tickets with SLA filters' })
  list(@Query() dto: ListMaintenanceTicketsDto) { return this.service.list(dto); }

  @Get('page')
  @RequirePermissions('maintenance.view')
  page(@Query() dto:MaintenancePageDto) { return this.service.page(dto); }

  @Get(':id')
  @RequirePermissions('maintenance.view')
  @ApiQuery({ name: 'propertyId', required: true })
  get(@Param('id', ParseUUIDPipe) id: string, @Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.service.findById(id, propertyId);
  }

  @Post()
  @RequirePermissions('maintenance.create')
  async create(
    @Body() dto: CreateMaintenanceTicketDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.create(
      dto,
      await this.actor(
        dto.propertyId,
        user,
        actor,
        dto.blocksInventory === true,
      ),
    );
  }

  @Patch(':id')
  @RequirePermissions('maintenance.update')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: UpdateMaintenanceTicketDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.update(
      id,
      propertyId,
      dto,
      await this.actor(
        propertyId,
        user,
        actor,
        dto.blocksInventory !== undefined,
      ),
    );
  }

  @Post(':id/comments')
  @RequirePermissions('maintenance.update')
  async comment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MaintenanceCommentDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.addComment(
      id,
      dto.propertyId,
      dto.body,
      await this.actor(dto.propertyId, user, actor),
      {
        idempotencyKey: dto.idempotencyKey,
        expectedRevision: dto.expectedRevision,
      },
    );
  }

  @Post(':id/return-to-service')
  @RequirePermissions('maintenance.close')
  async returnToService(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnToServiceDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.confirmReturnToService(
      id,
      dto.propertyId,
      dto.note,
      await this.actor(dto.propertyId, user, actor, true),
      {
        idempotencyKey: dto.idempotencyKey,
        expectedRevision: dto.expectedRevision,
      },
    );
  }
}
