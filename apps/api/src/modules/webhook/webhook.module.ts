import { DomainEventOutboxService } from './domain-event-outbox.service';
import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Module({
  providers: [WebhookService, WebhookDeliveryService, DomainEventOutboxService],
  exports: [WebhookService, WebhookDeliveryService, DomainEventOutboxService],
})
export class WebhookModule {}
