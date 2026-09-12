import { Module } from '@nestjs/common';
import { RoomModule } from '../room/room.module';
import { WebhookModule } from '../webhook/webhook.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [RoomModule, WebhookModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
