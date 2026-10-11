import { Module } from '@nestjs/common';
import { HousekeepingController } from './housekeeping.controller';
import { HousekeepingService } from './housekeeping.service';
import { RoomModule } from '../room/room.module';
import { WebhookModule } from '../webhook/webhook.module';
import { AuthModule } from '../auth/auth.module';
import { StaffShiftService } from './staff-shift.service';

@Module({
  imports: [RoomModule, WebhookModule, AuthModule],
  controllers: [HousekeepingController],
  providers: [HousekeepingService, StaffShiftService],
  exports: [HousekeepingService, StaffShiftService],
})
export class HousekeepingModule {}
