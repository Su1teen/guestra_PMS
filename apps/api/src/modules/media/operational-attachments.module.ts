import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { MediaModule } from './media.module';
import { OperationalAttachmentsController } from './operational-attachments.controller';
import { OperationalAttachmentsService } from './operational-attachments.service';
@Module({
  imports: [MediaModule, AuthModule, HousekeepingModule, MaintenanceModule],
  controllers: [OperationalAttachmentsController],
  providers: [OperationalAttachmentsService],
})
export class OperationalAttachmentsModule {}
