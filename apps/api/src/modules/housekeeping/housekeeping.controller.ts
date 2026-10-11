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
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/permissions.decorator';
import { HousekeepingService } from './housekeeping.service';
import { RoomService } from '../room/room.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { ListTasksDto } from './dto/list-tasks.dto';
import { AssignTaskDto } from './dto/assign-task.dto';
import { AutoAssignDto } from './dto/auto-assign.dto';
import { CompleteTaskDto } from './dto/complete-task.dto';
import { InspectTaskDto } from './dto/inspect-task.dto';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { PermissionsService } from '../auth/permissions.service';
import { ConfigService } from '@nestjs/config';
import { StaffShiftService } from './staff-shift.service';
import { StaffShiftDto, StaffShiftRequestDto, StaffShiftTemplateDto, ApplyShiftTemplateDto } from './dto/staff-shift.dto';
import { AuditActorCtx, type AuditActor } from '../../common/audit/audit-actor';
import { isUUID } from 'class-validator';

@ApiTags('housekeeping')
@Controller('housekeeping')
export class HousekeepingController {
  constructor(
    private readonly housekeepingService: HousekeepingService,
    private readonly roomService: RoomService,
    private readonly permissions: PermissionsService,
    private readonly config: ConfigService,
    private readonly shifts: StaffShiftService,
  ) {}

  private async executor(
    propertyId: string,
    user?: AuthUser,
    requireExecution = true,
  ) {
    if (this.config.get('AUTH_ENABLED', 'true') === 'false')
      return { id: null, manager: true };
    const local =
      user && (await this.permissions.findLocalUser(user.sub, user.email));
    if (!local || local.status !== 'active')
      throw new ForbiddenException('Нет активной учётной записи сотрудника.');
    const keys = await this.permissions.getEffectivePermissions(
      local.id,
      propertyId,
    );
    if (
      requireExecution &&
      !keys.includes('housekeeping.manage') &&
      !keys.includes('housekeeping.execute')
    )
      throw new ForbiddenException('Нет права выполнения задач уборки.');
    return { id: local.id, manager: keys.includes('housekeeping.manage') };
  }
  private async ownedTask(id: string, propertyId: string, user?: AuthUser) {
    const worker = await this.executor(propertyId, user);
    const task = await this.housekeepingService.findById(id, propertyId);
    if (!worker.manager && task.assignedTo !== worker.id)
      throw new ForbiddenException('Задача назначена другому сотруднику.');
    return worker;
  }
  @Get('/identity')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({
    summary: 'Resolve the local staff identity in the current property',
  })
  async identity(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    const worker = await this.executor(propertyId, user, false);
    return { staffId: worker.id, canManage: worker.manager };
  }
  @Get('/staff')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({
    summary: 'Property-scoped housekeeping staff without admin account details',
  })
  staff(@Query('propertyId', ParseUUIDPipe) propertyId: string) {
    return this.shifts.staff(propertyId);
  }
  @Get('/staff-availability')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({
    summary: 'Confirmed shift coverage and actual outstanding task load',
  })
  staffAvailability(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('serviceDate') date: string,
  ) {
    return this.shifts.availability(propertyId, date);
  }
  @Get('/shift-templates')
  @RequirePermissions('housekeeping.manage')
  templates(@Query('propertyId',ParseUUIDPipe) propertyId:string) { return this.shifts.templates(propertyId); }
  @Post('/shift-templates')
  @RequirePermissions('housekeeping.manage')
  async createTemplate(@Body() dto:StaffShiftTemplateDto,@AuditActorCtx() actor:AuditActor,@CurrentUser() user?:AuthUser) {
    const worker=await this.executor(dto.propertyId,user);return this.shifts.saveTemplate(dto,undefined,{...actor,userId:worker.id});
  }
  @Patch('/shift-templates/:id')
  @RequirePermissions('housekeeping.manage')
  async updateTemplate(@Param('id',ParseUUIDPipe) id:string,@Body() dto:StaffShiftTemplateDto,@AuditActorCtx() actor:AuditActor,@CurrentUser() user?:AuthUser) {
    const worker=await this.executor(dto.propertyId,user);return this.shifts.saveTemplate(dto,id,{...actor,userId:worker.id});
  }
  @Post('/shift-templates/:id/preview')
  @RequirePermissions('housekeeping.manage')
  previewTemplate(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ApplyShiftTemplateDto) {return this.shifts.previewTemplate(id,dto);}
  @Post('/shift-templates/:id/apply')
  @RequirePermissions('housekeeping.manage')
  async applyTemplate(@Param('id',ParseUUIDPipe) id:string,@Body() dto:ApplyShiftTemplateDto,@AuditActorCtx() actor:AuditActor,@CurrentUser() user?:AuthUser) {
    const worker=await this.executor(dto.propertyId,user);return this.shifts.applyTemplate(id,dto,{...actor,userId:worker.id});
  }
  @Get('/shifts')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Read explicit staff shifts, bounded to 35 days' })
  async shiftCalendar(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('startAt') start: string,
    @Query('endAt') end: string,
    @CurrentUser() user?: AuthUser,
    @Query('userId') staffId?: string,
  ) {
    if (staffId && !isUUID(staffId))
      throw new BadRequestException('Укажите корректного сотрудника.');
    const worker = await this.executor(propertyId, user, false);
    return this.shifts.list(
      propertyId,
      start,
      end,
      worker.manager ? staffId : worker.id!,
    );
  }
  @Post('/shifts')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Create an explicit retry-safe staff shift' })
  async createShift(
    @Body() dto: StaffShiftDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    const worker = await this.executor(dto.propertyId, user);
    return this.shifts.save(dto, undefined, { ...actor, userId: worker.id });
  }
  @Get('/shifts/:id/history')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({
    summary: 'Property and staff scoped shift history, without request tokens',
  })
  async shiftHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user?: AuthUser,
  ) {
    const worker = await this.executor(propertyId, user, false);
    return this.shifts.history(
      propertyId,
      id,
      worker.manager ? undefined : worker.id!,
    );
  }
  @Get('/shift-request')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({
    summary: 'Read the original accepted shift operation after response loss',
  })
  shiftRequest(@Query() dto: StaffShiftRequestDto) {
    return this.shifts.requestStatus(dto.propertyId, dto.idempotencyKey);
  }
  @Post('/shift-request/close')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({
    summary: 'Fence an unaccepted shift request against late delivery',
  })
  closeShiftRequest(
    @Body() dto: StaffShiftRequestDto,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    return this.shifts.closeRequest(dto.propertyId, dto.idempotencyKey, actor);
  }
  @Patch('/shifts/:id')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({
    summary: 'Revise or cancel a shift with optimistic concurrency',
  })
  async updateShift(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StaffShiftDto,
    @AuditActorCtx() actor: AuditActor,
    @CurrentUser() user?: AuthUser,
  ) {
    const worker = await this.executor(dto.propertyId, user);
    return this.shifts.save(dto, id, { ...actor, userId: worker.id });
  }
  @Get('/tasks/mine')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({
    summary:
      'Assigned tasks resolved from the authenticated local staff identity',
  })
  async mine(@Query() dto: ListTasksDto, @CurrentUser() user?: AuthUser) {
    const worker = await this.executor(dto.propertyId, user, false);
    return worker.id
      ? this.housekeepingService.list({ ...dto, assignedTo: worker.id })
      : { data: [], total: 0, page: dto.page, limit: dto.limit };
  }

  @Get('/dashboard')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Get housekeeping dashboard' })
  @ApiQuery({ name: 'propertyId', type: String })
  @ApiQuery({
    name: 'serviceDate',
    type: String,
    required: false,
    description:
      'Service date (YYYY-MM-DD); defaults to today in property timezone',
  })
  getDashboard(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('serviceDate') serviceDate?: string,
  ) {
    return this.housekeepingService.getDashboard(propertyId, serviceDate);
  }

  @Get('/ops-forecast')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({
    summary: 'Expected checkout vs stayover task counts for a service date',
  })
  @ApiQuery({ name: 'propertyId', type: String })
  @ApiQuery({
    name: 'date',
    type: String,
    description: 'Service date (YYYY-MM-DD)',
  })
  getOpsForecast(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('date') date: string,
  ) {
    return this.housekeepingService.getOpsForecast(propertyId, date);
  }

  @Get('/analytics')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Get housekeeping analytics' })
  @ApiQuery({ name: 'propertyId', type: String })
  @ApiQuery({
    name: 'startDate',
    type: String,
    required: false,
    description:
      'Period start (YYYY-MM-DD); defaults to 30 days before endDate',
  })
  @ApiQuery({
    name: 'endDate',
    type: String,
    required: false,
    description:
      'Period end (YYYY-MM-DD); defaults to today in property timezone',
  })
  getAnalytics(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.housekeepingService.getAnalytics(
      propertyId,
      startDate,
      endDate,
    );
  }

  @Post('/generate-stayover-tasks')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Generate stayover tasks for occupied rooms' })
  generateStayoverTasks(
    @Body() body: { propertyId: string; serviceDate: string },
  ) {
    return this.housekeepingService.generateStayoverTasks(
      body.propertyId,
      body.serviceDate,
    );
  }

  @Post('/auto-assign')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Auto-assign pending tasks to housekeepers' })
  autoAssign(@Body() dto: AutoAssignDto, @AuditActorCtx() actor?: AuditActor) {
    return this.housekeepingService.autoAssign(dto, actor);
  }

  @Post('/tasks')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Create housekeeping task' })
  @HttpCode(HttpStatus.CREATED)
  async createTask(@Body() dto: CreateTaskDto) {
    // roomId is client-supplied — verify it belongs to the request's property (throws
    // NotFound otherwise) so a caller can't attach a task to another tenant's room.
    await this.roomService.findRoomById(dto.roomId, dto.propertyId);
    return this.housekeepingService.create(dto);
  }

  @Get('/tasks')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'List housekeeping tasks' })
  listTasks(@Query() dto: ListTasksDto) {
    return this.housekeepingService.list(dto);
  }

  @Get('/tasks/:id')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Get housekeeping task by ID' })
  @ApiQuery({ name: 'propertyId', type: String })
  getTaskById(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.housekeepingService.findById(id, propertyId);
  }

  @Patch('/tasks/:id/assign')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Assign task to housekeeper' })
  @ApiQuery({ name: 'propertyId', type: String })
  assignTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: AssignTaskDto,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    return this.housekeepingService.assign(id, propertyId, dto, actor);
  }

  @Patch('/tasks/:id/start')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Start assigned task' })
  @ApiQuery({ name: 'propertyId', type: String })
  async startTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user?: AuthUser,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    const worker = await this.ownedTask(id, propertyId, user);
    return this.housekeepingService.startTask(
      id,
      propertyId,
      worker.manager ? undefined : worker.id!,
      { ...actor, userId: worker.id },
    );
  }

  @Patch('/tasks/:id/unassign')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Unassign task' })
  @ApiQuery({ name: 'propertyId', type: String })
  unassignTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.housekeepingService.unassign(id, propertyId);
  }

  @Patch('/tasks/:id/complete')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Complete housekeeping task' })
  @ApiQuery({ name: 'propertyId', type: String })
  async completeTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: CompleteTaskDto,
    @CurrentUser() user?: AuthUser,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    const worker = await this.ownedTask(id, propertyId, user);
    return this.housekeepingService.completeTask(
      id,
      propertyId,
      dto,
      { ...actor, userId: worker.id },
      worker.manager ? undefined : worker.id!,
    );
  }

  @Patch('/tasks/:id/inspect')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Inspect completed task' })
  @ApiQuery({ name: 'propertyId', type: String })
  async inspectTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: InspectTaskDto,
    @CurrentUser() user?: AuthUser,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    const worker = await this.executor(propertyId, user);
    return this.housekeepingService.inspectTask(
      id,
      propertyId,
      { ...dto, inspectedBy: worker.id ?? dto.inspectedBy },
      { ...actor, userId: worker.id },
    );
  }

  @Patch('/tasks/:id/skip')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Skip housekeeping task' })
  @ApiQuery({ name: 'propertyId', type: String })
  skipTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() body: { reason?: string },
  ) {
    return this.housekeepingService.skipTask(id, propertyId, body.reason);
  }

  @Patch('/tasks/:id')
  @RequirePermissions('housekeeping.read')
  @ApiOperation({ summary: 'Update housekeeping task' })
  @ApiQuery({ name: 'propertyId', type: String })
  async updateTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @Body() dto: UpdateTaskDto,
    @CurrentUser() user?: AuthUser,
    @AuditActorCtx() actor?: AuditActor,
  ) {
    const worker = await this.ownedTask(id, propertyId, user);
    if (!worker.manager && dto.priority !== undefined)
      throw new ForbiddenException('Приоритет меняет руководитель смены.');
    return this.housekeepingService.update(
      id,
      propertyId,
      dto,
      worker.manager ? undefined : worker.id!,
      { ...actor, userId: worker.id },
    );
  }

  @Delete('/tasks/:id')
  @RequirePermissions('housekeeping.manage')
  @ApiOperation({ summary: 'Delete housekeeping task' })
  @ApiQuery({ name: 'propertyId', type: String })
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
  ) {
    return this.housekeepingService.delete(id, propertyId);
  }
}
