import { Inject, Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { auditLogs, guests, reservations } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import type { AuthUser } from '../auth/current-user.decorator';
import { CrmInboxClient } from '../guest-inbox/crm-inbox.client';
import { ReservationConfirmationService, type ReservationDocumentKind } from '../reservation/reservation-confirmation.service';
import { DocumentLinkService } from '../reservation/document-link.service';
import { ConnectInboxService } from './connect-inbox.service';

export interface ChatDocumentInput {
  kind?: ReservationDocumentKind;
  /** ai: into the guest's AI conversation; manual: a new staff chat with the prepared text. */
  mode: 'ai' | 'manual';
  channel?: string;
  text?: string;
  idempotencyKey?: string;
}

/** Prepared message; the hotel may edit it before sending. Same wording as the CRM template. */
export function chatDocumentText(input: { kind: ReservationDocumentKind; confirmationNumber: string; hotel: string; guestName: string; url: string; language: string }) {
  const en = input.language === 'en';
  const what = input.kind === 'proposal'
    ? (en ? `Here is the proposal for your booking no. ${input.confirmationNumber} at ${input.hotel}` : `Направляем предложение по бронированию № ${input.confirmationNumber} в ${input.hotel}`)
    : (en ? `Here is the confirmation of your booking no. ${input.confirmationNumber} at ${input.hotel}` : `Направляем подтверждение бронирования № ${input.confirmationNumber} в ${input.hotel}`);
  return en
    ? `Hello, ${input.guestName}! ${what}.\nPlease check the dates, guests and prices: ${input.url}\nIf everything is correct, reply "Yes". If something needs changing, just tell us what.`
    : `Здравствуйте, ${input.guestName}! ${what}.\nПожалуйста, проверьте даты, гостей и стоимость: ${input.url}\nЕсли всё верно, ответьте «Да». Если что-то нужно изменить, напишите, что именно.`;
}

/**
 * Booking documents in guest chats. The document is a signed link to the same proposal / confirmation staff see;
 * the CRM sends it into the chat (AI conversation or a new staff chat) and records the guest's answer, which comes
 * back to PMS as `detailsConfirmedAt` on every room of the booking.
 */
@Injectable()
export class ReservationChatService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly crm: CrmInboxClient, private readonly inbox: ConnectInboxService,
    private readonly confirmation: ReservationConfirmationService, private readonly links: DocumentLinkService) {}

  private ensureEnabled() { if (!this.crm.configured()) throw new ServiceUnavailableException('INBOX_DISABLED'); }

  /** The prepared text and link, so staff can read / edit it before sending. */
  async preview(reservationId: string, propertyId: string, kind: ReservationDocumentKind | undefined, user: AuthUser | undefined, host?: string) {
    this.ensureEnabled();
    await this.inbox.authorize(propertyId, user);
    const doc = await this.confirmation.build(reservationId, propertyId, kind);
    const url = this.links.url(propertyId, reservationId, doc.kind, host);
    return { kind: doc.kind, url, guest: doc.guest, text: chatDocumentText({ kind: doc.kind, confirmationNumber: doc.confirmationNumber,
      hotel: doc.property.name, guestName: doc.guest.name, url, language: doc.property.language }) };
  }

  async send(reservationId: string, propertyId: string, input: ChatDocumentInput, user: AuthUser | undefined, host?: string) {
    this.ensureEnabled();
    const staff = await this.inbox.authorize(propertyId, user);
    const doc = await this.confirmation.build(reservationId, propertyId, input.kind);
    const [row] = await this.db.select({ guestId: reservations.guestId, bookingId: reservations.bookingId }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    // guests are cross-property rows; the reservation lookup above scoped access to this property.
    const [guest] = await this.db.select().from(guests).where(eq(guests.id, row.guestId));
    const url = this.links.url(propertyId, reservationId, doc.kind, host);
    const text = input.text?.trim() || chatDocumentText({ kind: doc.kind, confirmationNumber: doc.confirmationNumber, hotel: doc.property.name,
      guestName: doc.guest.name, url, language: doc.property.language });
    if (input.text && !input.text.includes(url) && !input.text.includes('/public/documents/')) throw new BadRequestException('The message must keep the document link');
    const channel = input.mode === 'manual' ? input.channel ?? 'simulator' : input.channel;
    const delivery = channel === 'email' || channel === 'sms'
      ? await this.inbox.deliverDirect(propertyId, channel, (channel === 'email' ? guest.email : guest.phone) ?? '', text,
        `${doc.kind === 'proposal' ? 'Предложение по бронированию' : 'Подтверждение бронирования'} ${doc.confirmationNumber} — ${doc.property.name}`)
      : undefined;
    const mapping = await this.crm.verified(propertyId);
    const result = await this.crm.call(mapping, 'v2/document-confirmations', 'POST', {
      guest: this.inbox.guestPayload(guest), pmsReservationId: reservationId, confirmationNumber: doc.confirmationNumber, kind: doc.kind,
      documentUrl: url, mode: input.mode, ...(channel ? { channel } : {}), text, idempotencyKey: input.idempotencyKey ?? randomUUID(),
      ...(delivery ? { delivery } : {}), staffReference: 'pms:' + staff.id, staffName: staff.name.slice(0, 120) });
    const delivered = result['delivered'] === true;
    const now = new Date();
    if (delivered) {
      await this.db.update(reservations).set({ ...(doc.kind === 'proposal' ? { proposalSentAt: now } : { confirmationSentAt: now }), updatedAt: now })
        .where(and(eq(reservations.propertyId, propertyId), inArray(reservations.id, doc.rooms.map((r) => r.reservationId))));
    }
    await this.db.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: reservationId, action: 'document_sent_to_chat',
      userId: null, description: `${doc.kind === 'proposal' ? 'Предложение' : 'Подтверждение'} отправлено в чат (${input.mode === 'ai' ? 'ИИ' : 'вручную'}, ${String(result['channel'] ?? channel ?? '')})`,
      newValue: { mode: input.mode, channel: result['channel'] ?? channel ?? null, conversationId: result['conversationId'] ?? null, delivered,
        staff: 'pms:' + staff.id } });
    return result;
  }

  async status(reservationId: string, propertyId: string, user: AuthUser | undefined) {
    const [row] = await this.db.select({ detailsConfirmedAt: reservations.detailsConfirmedAt, detailsConfirmedBy: reservations.detailsConfirmedBy })
      .from(reservations).where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new BadRequestException('Reservation not found');
    if (!this.crm.configured()) return { enabled: false, ...row, confirmations: [] };
    await this.inbox.authorize(propertyId, user);
    const mapping = await this.crm.verified(propertyId);
    const remote = await this.crm.call(mapping, 'v2/document-confirmations', 'GET', undefined, { pmsReservationId: reservationId });
    return { enabled: true, ...row, confirmations: remote['confirmations'] ?? [] };
  }

  async resolve(reservationId: string, propertyId: string, confirmationId: string, outcome: 'confirmed' | 'declined', user: AuthUser | undefined) {
    this.ensureEnabled();
    const staff = await this.inbox.authorize(propertyId, user);
    const [row] = await this.db.select({ id: reservations.id }).from(reservations).where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new BadRequestException('Reservation not found');
    const mapping = await this.crm.verified(propertyId);
    return this.crm.call(mapping, `v2/document-confirmations/${encodeURIComponent(confirmationId)}/resolve`, 'POST',
      { outcome, pmsReservationId: reservationId, staffReference: 'pms:' + staff.id, staffName: staff.name.slice(0, 120) });
  }
}
