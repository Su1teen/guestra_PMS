import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq } from 'drizzle-orm';
import { folios, guests, reservations } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import type { WebhookPayload } from '../webhook/webhook.service';
import { CrmInboxClient } from './crm-inbox.client';

/**
 * Every email / SMS PMS sends to a guest (confirmations, proposals, reminders, folios, staff messages) is
 * recorded in the guest's email / SMS chat in the CRM, so the inbox shows the whole correspondence next to
 * messenger chats. Best effort: the message itself is already sent; a CRM outage only loses the copy.
 */
@Injectable()
export class GuestChannelLogListener {
  private readonly logger = new Logger(GuestChannelLogListener.name);
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly crm: CrmInboxClient) {}

  @OnEvent('reservation.message_sent')
  async onMessageSent(payload: WebhookPayload) {
    const data = (payload?.data ?? {}) as Record<string, unknown>;
    const channel = data['channel'];
    if (!payload?.propertyId || (channel !== 'email' && channel !== 'sms') || !this.crm.configured()) return;
    if (data['isMarketing'] === true) return; // marketing has its own tools; the inbox holds service correspondence
    try {
      const guest = await this.guestFor(payload.propertyId, payload.entityType, payload.entityId);
      if (!guest) return;
      const mapping = await this.crm.mapping(payload.propertyId);
      const subject = typeof data['subject'] === 'string' ? data['subject'] : undefined;
      const body = typeof data['text'] === 'string' && data['text'].trim() ? data['text'] : subject ?? String(data['kind'] ?? 'Сообщение');
      const text = channel === 'email' && subject && !body.startsWith(subject) ? `${subject}\n\n${body}` : body;
      await this.crm.call(mapping, 'v2/inbox/messages/external', 'POST', {
        guest: { pmsGuestId: guest.id, firstName: guest.firstName, lastName: guest.lastName, email: guest.email ?? null, phone: guest.phone ?? null },
        channel, text: text.slice(0, 20000), kind: typeof data['kind'] === 'string' ? data['kind'] : 'pms_message',
        idempotencyKey: `${payload.entityType}:${payload.entityId}:${payload.timestamp}:${channel}`.slice(0, 160),
        delivery: { sent: data['sent'] === true, ...(subject ? { subject } : {}), ...(data['sent'] === true ? {} : { error: 'not_sent' }) },
      });
    } catch (error) {
      this.logger.warn(`Guest ${channel} not recorded in CRM inbox: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async guestFor(propertyId: string, entityType: string, entityId: string) {
    let guestId: string | undefined;
    if (entityType === 'reservation') {
      const [row] = await this.db.select({ guestId: reservations.guestId }).from(reservations)
        .where(and(eq(reservations.id, entityId), eq(reservations.propertyId, propertyId)));
      guestId = row?.guestId;
    } else if (entityType === 'folio') {
      const [row] = await this.db.select({ guestId: folios.guestId }).from(folios).where(and(eq(folios.id, entityId), eq(folios.propertyId, propertyId)));
      guestId = row?.guestId;
    }
    if (!guestId) return null;
    // guests are cross-property; the reservation / folio lookup above already scoped access to this property.
    const [guest] = await this.db.select().from(guests).where(eq(guests.id, guestId));
    return guest ?? null;
  }
}
