import { Module } from '@nestjs/common';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';
import { HousekeepingModule } from '../housekeeping/housekeeping.module';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  imports: [HousekeepingModule, WebhookModule],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
  exports: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
