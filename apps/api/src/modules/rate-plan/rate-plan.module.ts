import { Module } from '@nestjs/common';
import { RatePlanController } from './rate-plan.controller';
import { RatePlanService } from './rate-plan.service';
import { WebhookModule } from '../webhook/webhook.module';
import { ReportsModule } from '../reports/reports.module';
import { TaxModule } from '../tax/tax.module';

@Module({
  imports: [WebhookModule, ReportsModule, TaxModule],
  controllers: [RatePlanController],
  providers: [RatePlanService],
  exports: [RatePlanService],
})
export class RatePlanModule {}
