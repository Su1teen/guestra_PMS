import { Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReservationDocumentKind } from './reservation-confirmation.service';

interface LinkClaims { p: string; r: string; k: ReservationDocumentKind; e: number }
const DAY = 86_400_000;

/**
 * Guest-facing link to a booking document (proposal / confirmation), for chats where a file cannot be attached.
 * The token is signed (HMAC-SHA256) and expires; it names one reservation of one property and one document kind,
 * and grants nothing else. The rendered document is the same one staff see.
 */
@Injectable()
export class DocumentLinkService {
  constructor(private readonly config: ConfigService) {}

  private secret() {
    const secret = this.config.get<string>('DOCUMENT_LINK_SECRET') || this.config.get<string>('CONNECT_QUOTE_SIGNING_SECRET') || '';
    if (secret.length < 32) throw new ServiceUnavailableException('DOCUMENT_LINK_SECRET_NOT_CONFIGURED');
    return secret;
  }

  /** Base URL the guest opens: explicit public URL, else the Railway public domain, else the request host. */
  publicBase(requestHost?: string) {
    const explicit = this.config.get<string>('PMS_PUBLIC_URL');
    if (explicit) return explicit.replace(/\/$/, '');
    const domain = this.config.get<string>('RAILWAY_PUBLIC_DOMAIN');
    if (domain) return `https://${domain}`;
    if (requestHost && /^[a-z0-9.-]+(:\d+)?$/i.test(requestHost)) return `${/^(localhost|127\.)/.test(requestHost) ? 'http' : 'https'}://${requestHost}`;
    throw new ServiceUnavailableException('PMS_PUBLIC_URL_NOT_CONFIGURED');
  }

  sign(propertyId: string, reservationId: string, kind: ReservationDocumentKind, days = 30, now = Date.now()) {
    const body = Buffer.from(JSON.stringify({ p: propertyId, r: reservationId, k: kind, e: now + days * DAY } satisfies LinkClaims)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret()).update(body).digest('base64url')}`;
  }

  url(propertyId: string, reservationId: string, kind: ReservationDocumentKind, requestHost?: string) {
    return `${this.publicBase(requestHost)}/api/v1/public/documents/${this.sign(propertyId, reservationId, kind)}`;
  }

  /** Same answer (404) for a forged, altered or expired token: nothing to learn from the difference. */
  verify(token: string, now = Date.now()): LinkClaims {
    const [body, signature] = token.split('.');
    if (!body || !signature || token.length > 600) throw new NotFoundException('Document not found');
    const expected = createHmac('sha256', this.secret()).update(body).digest();
    const provided = Buffer.from(signature, 'base64url');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new NotFoundException('Document not found');
    let claims: LinkClaims;
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new NotFoundException('Document not found'); }
    if (!claims?.p || !claims.r || !['proposal', 'confirmation'].includes(claims.k) || !(claims.e > now)) throw new NotFoundException('Document not found');
    return claims;
  }
}
