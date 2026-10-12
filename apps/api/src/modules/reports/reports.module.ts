import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PortfolioPropertyResolver } from './portfolio-property-resolver';
import { ManagementInputsService } from './management-inputs.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, PortfolioPropertyResolver, ManagementInputsService],
  exports: [ReportsService, PortfolioPropertyResolver],
})
export class ReportsModule {}
