import { Module, forwardRef } from '@nestjs/common';
import { FolioModule } from '../folio/folio.module';
import { ReservationModule } from '../reservation/reservation.module';
import { WebhookModule } from '../webhook/webhook.module';
import { QutPayWebhookController, RemotePaymentController } from './remote-payment.controller';
import { RemotePaymentScheduler } from './remote-payment.scheduler';
import { RemotePaymentService } from './remote-payment.service';

/** Remote prepayment: invoices in the guest's Kaspi app, recorded as folio payments when paid. */
@Module({
  imports: [forwardRef(() => FolioModule), ReservationModule, WebhookModule],
  controllers: [RemotePaymentController, QutPayWebhookController],
  providers: [RemotePaymentService, RemotePaymentScheduler],
  exports: [RemotePaymentService],
})
export class RemotePaymentModule {}
