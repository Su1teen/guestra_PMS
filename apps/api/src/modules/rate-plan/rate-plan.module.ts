import { Module } from '@nestjs/common';
import { RatePlanController } from './rate-plan.controller';
import { RatePlanService } from './rate-plan.service';
import { PriceCalendarController } from './price-calendar.controller';
import { PriceCalendarService } from './price-calendar.service';
import { WebhookModule } from '../webhook/webhook.module';
import { ReportsModule } from '../reports/reports.module';
import { TaxModule } from '../tax/tax.module';

@Module({
  imports: [WebhookModule, ReportsModule, TaxModule],
  controllers: [RatePlanController, PriceCalendarController],
  providers: [RatePlanService, PriceCalendarService],
  exports: [RatePlanService, PriceCalendarService],
})
export class RatePlanModule {}
