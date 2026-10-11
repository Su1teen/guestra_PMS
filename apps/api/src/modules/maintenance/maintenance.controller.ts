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
import {
  InventoryBlockDto,
  InventoryReturnDto,
} from './dto/inventory-block.dto';

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
  list(@Query() dto: ListMaintenanceTicketsDto) {
    return this.service.list(dto);
  }

  @Get('page')
  @RequirePermissions('maintenance.view')
  page(@Query() dto: MaintenancePageDto) {
    return this.service.page(dto);
  }

  @Get('inventory-blocks')
  @RequirePermissions('maintenance.view', 'rooms.read')
  @ApiOperation({
    summary:
      'Read active planned room blocks; expected end never releases inventory',
  })
  inventoryBlocks(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('roomId', new ParseUUIDPipe({ optional: true })) roomId?: string,
  ) {
    return this.service.inventoryBlocks(propertyId, roomId);
  }
  @Post('inventory-blocks/preview')
  @RequirePermissions('maintenance.view', 'rooms.write')
  @ApiOperation({
    summary:
      'Preview conflicts and canonical capacity without reserving inventory',
  })
  previewInventoryBlock(
    @Body() dto: InventoryBlockDto,
    @Query('blockId', new ParseUUIDPipe({ optional: true })) blockId?: string,
  ) {
    return this.service.previewInventoryBlock(dto, blockId);
  }
  @Post('inventory-blocks')
  @RequirePermissions('maintenance.create', 'rooms.write')
  @ApiOperation({
    summary:
      'Create a planned OOO/OOS block atomically without changing physical room status',
  })
  async createInventoryBlock(
    @Body() dto: InventoryBlockDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.saveInventoryBlock(
      dto,
      undefined,
      await this.actor(dto.propertyId, user, actor, true),
    );
  }
  @Patch('inventory-blocks/:id')
  @RequirePermissions('maintenance.update', 'rooms.write')
  @ApiOperation({
    summary: 'Revise an active planned block with revision and idempotency',
  })
  async updateInventoryBlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InventoryBlockDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.saveInventoryBlock(
      dto,
      id,
      await this.actor(dto.propertyId, user, actor, true),
    );
  }
  @Post('inventory-blocks/:id/return-to-service')
  @RequirePermissions('maintenance.close', 'rooms.write')
  @ApiOperation({
    summary:
      'Explicit early or overdue return after repair, cleaning and inspection checks',
  })
  async returnInventoryBlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InventoryReturnDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.service.returnInventoryBlock(
      id,
      dto,
      await this.actor(dto.propertyId, user, actor, true),
    );
  }
  @Get('inventory-blocks/:id')
  @RequirePermissions('maintenance.view', 'rooms.read')
  @ApiOperation({
    summary:
      'Read a scoped planned block and its public audit history, including released blocks',
  })
  inventoryBlockDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.service.inventoryBlockDetail(id, propertyId);
  }
  @Get(':id')
  @RequirePermissions('maintenance.view')
  @ApiQuery({ name: 'propertyId', required: true })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
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
