import { Module } from '@nestjs/common';
import { RoomModule } from '../room/room.module';
import { WebhookModule } from '../webhook/webhook.module';
import { AuthModule } from '../auth/auth.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [RoomModule, WebhookModule, AuthModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
