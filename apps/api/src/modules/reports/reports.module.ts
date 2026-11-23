import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PortfolioPropertyResolver } from './portfolio-property-resolver';
import { ManagementInputsService } from './management-inputs.service';
import { MoneyReportsService } from './money-reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, PortfolioPropertyResolver, ManagementInputsService, MoneyReportsService],
  exports: [ReportsService, PortfolioPropertyResolver, MoneyReportsService],
})
export class ReportsModule {}
