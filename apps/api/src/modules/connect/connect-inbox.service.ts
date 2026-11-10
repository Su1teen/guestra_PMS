import { Injectable, Inject, ForbiddenException, ServiceUnavailableException, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { integrationLinks, reservations, serviceBookings, serviceRequests, folios, guests, properties, bookings } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { PermissionsService } from '../auth/permissions.service';
import type { AuthUser } from '../auth/current-user.decorator';
import { ConnectV2Service } from './connect-v2.service';
import { CrmInboxClient } from '../guest-inbox/crm-inbox.client';
import { EmailService } from '../agent/guest-comms/email.service';
import { NotificationService } from '../notifications/notification.service';

export interface InboxStaff { id: string; name: string; grants: string[] }
export interface InboxFilters { queue?: string; channel?: string; mode?: string; unread?: string; search?: string; offset?: number; limit?: number }

const QUEUES = ['focus', 'payment', 'follow_up', 'waiting_guest', 'all', 'archive'];

/**
 * PMS Guest Inbox. Conversations live in the CRM (every channel: messengers, AI Studio simulator, email, SMS);
 * PMS staff read and answer them here with the CRM's own queues and filters. Email and SMS are delivered by
 * PMS (it owns those providers) and then recorded in the CRM chat. Stay context comes from PMS itself, only
 * for a guest the CRM verified, and only the parts the staff member may see.
 */
@Injectable()
export class ConnectInboxService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly config: ConfigService,
    private readonly permissions: PermissionsService, private readonly operational: ConnectV2Service,
    private readonly crm: CrmInboxClient, private readonly email: EmailService, private readonly notifications: NotificationService) {}

  /**
   * Signed-in staff with communications.manage. A sandbox with staff auth switched off may opt in to a shared
   * sandbox staff identity (GUESTRA_INBOX_SANDBOX_STAFF); production never allows an anonymous inbox.
   */
  async authorize(propertyId: string, user: AuthUser | undefined): Promise<InboxStaff> {
    if (this.config.get('GUESTRA_INBOX_ENABLED') !== 'true') throw new ServiceUnavailableException('INBOX_DISABLED');
    if (!user?.sub) {
      const environment = this.config.get('INTEGRATION_ENVIRONMENT', 'production');
      if (this.config.get('GUESTRA_INBOX_SANDBOX_STAFF') === 'true' && this.config.get('AUTH_ENABLED') === 'false' && ['sandbox', 'test'].includes(environment))
        return { id: 'sandbox-staff', name: 'Сотрудник (sandbox)', grants: ['communications.manage', 'reservations.read', 'services.read', 'ops.read', 'folios.read'] };
      // A demo or anonymous session can never spend a server's integration credential.
      throw new ForbiddenException('AUTHENTICATED_STAFF_REQUIRED');
    }
    const local = await this.permissions.findLocalUser(user.sub, user.email);
    const grants = local ? await this.permissions.getEffectivePermissions(local.id, propertyId) : [];
    if (!local || !grants.includes('communications.manage')) throw new ForbiddenException('INBOX_SCOPE_DENIED');
    const name = local.name || local.email || 'Сотрудник';
    return { id: local.id, name, grants };
  }

  private staffFields(staff: InboxStaff) { return { staffReference: 'pms:' + staff.id, staffName: staff.name.slice(0, 120) }; }

  /** Whether the inbox can be used here; the dashboard shows setup guidance instead of a broken page. */
  async status(propertyId: string, user: AuthUser | undefined) {
    if (this.config.get('GUESTRA_INBOX_ENABLED') !== 'true') return { enabled: false, reason: 'INBOX_DISABLED' };
    try {
      const staff = await this.authorize(propertyId, user);
      await this.crm.verified(propertyId);
      return { enabled: true, staffName: staff.name };
    } catch (error: any) {
      const reason = error?.response?.message ?? error?.message ?? 'CRM_UNAVAILABLE';
      return { enabled: false, reason: typeof reason === 'string' ? reason : 'CRM_UNAVAILABLE' };
    }
  }

  async list(propertyId: string, user: AuthUser | undefined, filters: InboxFilters = {}) {
    await this.authorize(propertyId, user);
    const mapping = await this.crm.verified(propertyId);
    if (filters.queue && !QUEUES.includes(filters.queue)) throw new BadRequestException('Unknown queue');
    return this.crm.call(mapping, 'v2/inbox', 'GET', undefined, {
      queue: filters.queue, channel: filters.channel, mode: filters.mode, unread: filters.unread, search: filters.search?.slice(0, 120),
      offset: filters.offset != null ? String(filters.offset) : undefined, limit: filters.limit != null ? String(filters.limit) : undefined });
  }

  async detail(propertyId: string, id: string, user: AuthUser | undefined) {
    const { grants } = await this.authorize(propertyId, user);
    const mapping = await this.crm.verified(propertyId);
    const conversation = await this.crm.call(mapping, 'v2/inbox/' + encodeURIComponent(id));
    if (conversation['propertyId'] !== mapping.crmPropertyId || typeof conversation['customerId'] !== 'string') throw new ForbiddenException('CONVERSATION_SCOPE_MISMATCH');
    const [link] = await this.db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId),
      eq(integrationLinks.sourceSystem, 'guestra_crm'), eq(integrationLinks.externalEntityType, 'customer'),
      eq(integrationLinks.externalEntityId, conversation['customerId']), eq(integrationLinks.localEntityType, 'guest')));
    const context: Record<string, unknown> = { verifiedGuest: false };
    if (link) {
      context['verifiedGuest'] = true; context['guestId'] = link.localEntityId;
      if (grants.includes('reservations.read')) context['reservations'] = await this.db.select({ id: reservations.id, status: reservations.status,
        arrivalDate: reservations.arrivalDate, departureDate: reservations.departureDate, totalAmount: reservations.totalAmount,
        currencyCode: reservations.currencyCode, optionUntil: reservations.optionUntil, detailsConfirmedAt: reservations.detailsConfirmedAt,
        confirmationNumber: bookings.confirmationNumber })
        .from(reservations).innerJoin(bookings, and(eq(bookings.id, reservations.bookingId), eq(bookings.propertyId, reservations.propertyId)))
        .where(and(eq(reservations.propertyId, propertyId), eq(reservations.guestId, link.localEntityId))).limit(50);
      if (grants.includes('services.read')) context['services'] = await this.db.select({ id: serviceBookings.id, status: serviceBookings.status, startAt: serviceBookings.startAt, endAt: serviceBookings.endAt })
        .from(serviceBookings).where(and(eq(serviceBookings.propertyId, propertyId), eq(serviceBookings.guestId, link.localEntityId))).limit(50);
      if (grants.includes('ops.read')) context['requests'] = await this.db.select({ id: serviceRequests.id, status: serviceRequests.status, title: serviceRequests.title })
        .from(serviceRequests).where(and(eq(serviceRequests.propertyId, propertyId), eq(serviceRequests.guestId, link.localEntityId))).limit(50);
      if (grants.includes('folios.read')) {
        const rows = await this.db.select({ id: folios.id }).from(folios).where(and(eq(folios.propertyId, propertyId), eq(folios.guestId, link.localEntityId))).limit(20);
        context['folios'] = [];
        for (const row of rows) (context['folios'] as unknown[]).push(await this.operational.snapshot(propertyId, 'folio', row.id, conversation['customerId']));
      }
    }
    return { ...conversation, operationalContext: context };
  }

  /** Staff reply or internal note. Email/SMS chats are delivered by PMS first, then recorded with the outcome. */
  async reply(propertyId: string, id: string, input: { text: string; asNote?: boolean; idempotencyKey?: string; subject?: string }, user: AuthUser | undefined) {
    const staff = await this.authorize(propertyId, user);
    const mapping = await this.crm.verified(propertyId);
    const text = input.text?.trim();
    if (!text) throw new BadRequestException('Message text is required');
    const key = input.idempotencyKey ?? randomUUID();
    let delivery: Record<string, unknown> | undefined;
    if (!input.asNote) {
      const conversation = await this.crm.call(mapping, 'v2/inbox/' + encodeURIComponent(id));
      if (conversation['channel'] === 'email' || conversation['channel'] === 'sms') {
        delivery = await this.deliverDirect(propertyId, String(conversation['channel']),
          String(conversation[conversation['channel'] === 'email' ? 'email' : 'phone'] ?? ''), text, input.subject);
      }
    }
    return this.crm.call(mapping, 'v2/inbox/' + encodeURIComponent(id) + '/messages', 'POST',
      { text, asNote: !!input.asNote, idempotencyKey: key, ...(delivery ? { delivery } : {}), ...this.staffFields(staff) });
  }

  async automation(propertyId: string, id: string, mode: 'ai' | 'human', user: AuthUser | undefined) {
    const staff = await this.authorize(propertyId, user);
    const mapping = await this.crm.verified(propertyId);
    return this.crm.call(mapping, 'v2/inbox/' + encodeURIComponent(id) + '/automation', 'POST', { mode, ...this.staffFields(staff) });
  }

  /** Kept for existing clients: hand the conversation to a person. */
  async takeover(propertyId: string, id: string, user: AuthUser | undefined) { return this.automation(propertyId, id, 'human', user); }

  async update(propertyId: string, id: string, input: { status?: 'open' | 'pending' | 'closed'; read?: boolean }, user: AuthUser | undefined) {
    const staff = await this.authorize(propertyId, user);
    const mapping = await this.crm.verified(propertyId);
    return this.crm.call(mapping, 'v2/inbox/' + encodeURIComponent(id), 'PATCH',
      { ...(input.status ? { status: input.status } : {}), ...(input.read ? { read: true } : {}), ...this.staffFields(staff) });
  }

  /** Start a chat with a guest of this property (or continue their channel chat) with a first message. */
  async start(propertyId: string, input: { guestId: string; channel: string; text: string; automationMode?: 'ai' | 'human'; newChat?: boolean;
    idempotencyKey?: string; subject?: string }, user: AuthUser | undefined) {
    const staff = await this.authorize(propertyId, user);
    const guest = await this.guestAtProperty(propertyId, input.guestId);
    const mapping = await this.crm.verified(propertyId);
    const text = input.text?.trim();
    if (!text) throw new BadRequestException('Message text is required');
    const delivery = input.channel === 'email' || input.channel === 'sms'
      ? await this.deliverDirect(propertyId, input.channel, (input.channel === 'email' ? guest.email : guest.phone) ?? '', text, input.subject) : undefined;
    return this.crm.call(mapping, 'v2/inbox/conversations', 'POST', { guest: this.guestPayload(guest), channel: input.channel, text,
      automationMode: input.automationMode ?? 'human', newChat: input.newChat ?? true, idempotencyKey: input.idempotencyKey ?? randomUUID(),
      ...(delivery ? { delivery } : {}), ...this.staffFields(staff) });
  }

  guestPayload(guest: any) {
    return { pmsGuestId: guest.id, firstName: guest.firstName ?? null, lastName: guest.lastName ?? null, email: guest.email ?? null,
      phone: guest.phone ?? null, language: guest.language ?? null };
  }

  /**
   * guests are cross-property rows: access is allowed only for a guest with a reservation at this property
   * (CLAUDE.md multi-tenancy exception for the guests table).
   */
  async guestAtProperty(propertyId: string, guestId: string) {
    const [stay] = await this.db.select({ id: reservations.id }).from(reservations)
      .where(and(eq(reservations.propertyId, propertyId), eq(reservations.guestId, guestId))).limit(1);
    if (!stay) throw new NotFoundException('Guest has no reservation at this property');
    const [guest] = await this.db.select().from(guests).where(eq(guests.id, guestId));
    if (!guest) throw new NotFoundException('Guest not found');
    return guest;
  }

  /** Email / SMS through the PMS providers; the result is what the CRM records as delivery. */
  async deliverDirect(propertyId: string, channel: string, to: string, text: string, subject?: string) {
    const recipient = to.trim();
    if (channel === 'sms') {
      if (!/^\+?[0-9 ()-]{6,20}$/.test(recipient)) throw new BadRequestException('Guest has no valid phone number');
      const result = await this.notifications.sendSms(propertyId, recipient, text);
      return { sent: result.sent, ...(result.sent ? {} : { error: 'not_sent' }) };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new BadRequestException('Guest has no valid email address');
    const [property] = await this.db.select({ name: properties.name }).from(properties).where(eq(properties.id, propertyId));
    const title = subject?.trim() || `Сообщение от ${property?.name ?? 'отеля'}`;
    const html = `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
    const result = await this.email.send({ to: recipient, subject: title, html, text });
    return { sent: result.sent, subject: title, ...(result.sent ? {} : { error: result.status ?? 'not_sent' }) };
  }
}
