import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { DocumentLinkService } from './document-link.service';
import { ReservationConfirmationService } from './reservation-confirmation.service';

/** Guest opens a booking document from a chat link. Signed, expiring, read-only, not indexed. */
@ApiExcludeController() @Public() @Controller('public/documents')
export class PublicDocumentController {
  constructor(private readonly links: DocumentLinkService, private readonly confirmation: ReservationConfirmationService) {}

  @Get(':token')
  async open(@Param('token') token: string, @Res() res: Response) {
    const claims = this.links.verify(token);
    const html = await this.confirmation.html(claims.r, claims.p, claims.k);
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; script-src 'unsafe-inline'; frame-ancestors 'none'" });
    res.send(html);
  }
}
