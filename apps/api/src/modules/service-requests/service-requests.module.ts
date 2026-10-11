import { Module } from '@nestjs/common';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { WebhookModule } from '../webhook/webhook.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [HousekeepingModule, WebhookModule, MaintenanceModule, AuthModule],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
  exports: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
