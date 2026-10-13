import { Module } from '@nestjs/common';
import { ConnectV2Controller } from './connect-v2.controller';
import { ConnectV2Service } from './connect-v2.service';
import { ConnectV2Guard } from './connect-v2.guard';
import { ConnectSandboxService } from './connect-sandbox.service';
import { ConnectInboxService } from './connect-inbox.service';
import { ConnectInboxController } from './connect-inbox.controller';
import { ServiceOperationsController } from './service-operations.controller';
import { ConnectController } from './connect.controller';
import { ConnectSearchService } from './connect-search.service';
import { ConnectContentService } from './connect-content.service';
import { ConnectBookingService } from './connect-booking.service';
import { ConnectEventsService } from './connect-events.service';
import { ConnectInsightsService } from './connect-insights.service';
import { ConnectCredentialsController } from './connect-credentials.controller';
import { ConnectCredentialsService } from './connect-credentials.service';
import { ReservationModule } from '../reservation/reservation.module';
import { WebhookModule } from '../webhook/webhook.module';
import { AuthModule } from '../auth/auth.module';
import { RatePlanModule } from '../rate-plan/rate-plan.module';
import { PolicyModule } from '../policy/policy.module';
import { TaxModule } from '../tax/tax.module';
import { AccountingModule } from '../accounting/accounting.module';
import { FolioModule } from '../folio/folio.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { ConnectServiceBookingService } from './connect-service-booking.service';

@Module({
  imports: [ReservationModule, WebhookModule, AuthModule, RatePlanModule, PolicyModule, TaxModule, FolioModule, ServiceRequestsModule, AccountingModule],
  controllers: [ConnectController, ConnectCredentialsController, ServiceOperationsController, ConnectV2Controller, ConnectInboxController],
  providers: [
    ConnectV2Service, ConnectV2Guard, ConnectInboxService, ConnectSandboxService,
    ConnectSearchService,
    ConnectContentService,
    ConnectBookingService,
    ConnectEventsService,
    ConnectInsightsService,
    ConnectCredentialsService,
    ConnectServiceBookingService,
  ],
  exports: [ConnectSearchService, ConnectBookingService],
})
export class ConnectModule {}
