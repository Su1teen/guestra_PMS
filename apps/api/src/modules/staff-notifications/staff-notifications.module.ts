import { AuthModule } from '../auth/auth.module';
import { Module } from '@nestjs/common';
import { StaffNotificationController } from './staff-notification.controller';
import { StaffNotificationService } from './staff-notification.service';
import { StaffNotificationListener } from './staff-notification.listener';
import { WebhookModule } from '../webhook/webhook.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [WebhookModule, EventsModule, AuthModule],
  controllers: [StaffNotificationController],
  providers: [StaffNotificationService, StaffNotificationListener],
  exports: [StaffNotificationService],
})
export class StaffNotificationsModule {}
