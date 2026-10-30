import { Module } from '@nestjs/common';
import { WebhookModule } from '../webhook/webhook.module';
import { TaxModule } from '../tax/tax.module';
import { FolioController } from './folio.controller';
import { FolioService } from './folio.service';
import { FolioRoutingService } from './folio-routing.service';
import { FiscalDocumentService } from './fiscal-document.service';
import { FolioDocumentService } from './folio-document.service';

@Module({
  imports: [WebhookModule, TaxModule],
  controllers: [FolioController],
  providers: [FolioService, FolioRoutingService, FiscalDocumentService, FolioDocumentService],
  exports: [FolioService, FolioRoutingService, FiscalDocumentService, FolioDocumentService],
})
export class FolioModule {}
