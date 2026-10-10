import { Controller, Get, Patch, Param, Query, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PermissionsService } from '../auth/permissions.service';
import { ALL_PERMISSIONS } from '../auth/permissions.catalog';
import { RequirePermissions } from '../auth/permissions.decorator';
import { StaffNotificationService } from './staff-notification.service';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';

@ApiTags('staff-notifications')
@Controller('staff-notifications')
@RequirePermissions('dashboard.view')
export class StaffNotificationController {
  constructor(private readonly service: StaffNotificationService, private readonly permissions: PermissionsService) {}
  private async audience(user: AuthUser | undefined, propertyId: string) {
    if (!user) return ALL_PERMISSIONS;
    const local = await this.permissions.findLocalUser(user.sub, user.email);
    return local ? this.permissions.getEffectivePermissions(local.id, propertyId) : [];
  }

  @Get()
  @ApiOperation({ summary: 'List staff notifications for current user at a property' })
  @ApiQuery({ name: 'propertyId', required: true })
  async list(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const userId = user?.sub ?? 'anonymous';
    return this.service.listForUser(propertyId, userId, await this.audience(user, propertyId));
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Unread notification count' })
  @ApiQuery({ name: 'propertyId', required: true })
  async unreadCount(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const userId = user?.sub ?? 'anonymous';
    const count = await this.service.unreadCount(propertyId, userId, await this.audience(user, propertyId));
    return { count };
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiQuery({ name: 'propertyId', required: true })
  async markAllRead(
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const userId = user?.sub ?? 'anonymous';
    return this.service.markAllRead(propertyId, userId, await this.audience(user, propertyId));
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiQuery({ name: 'propertyId', required: true })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('propertyId', ParseUUIDPipe) propertyId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const userId = user?.sub ?? 'anonymous';
    return this.service.markRead(id, propertyId, userId, await this.audience(user, propertyId));
  }
}
