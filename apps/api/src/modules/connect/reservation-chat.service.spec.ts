import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { ReservationChatService, chatDocumentText } from './reservation-chat.service';
import { DocumentLinkService } from '../reservation/document-link.service';
import { GuestChannelLogListener } from '../guest-inbox/guest-channel-log.listener';

const propertyId = '10000000-0000-4000-8000-000000000001', reservationId = '30000000-0000-4000-8000-000000000003';
const config = new ConfigService({ CONNECT_QUOTE_SIGNING_SECRET: 'x'.repeat(40), PMS_PUBLIC_URL: 'https://pms.example.test/' });

describe('signed document links', () => {
  const links = new DocumentLinkService(config);
  it('opens exactly the signed document until it expires', () => {
    const now = Date.UTC(2027, 0, 1);
    const token = links.sign(propertyId, reservationId, 'proposal', 30, now);
    expect(links.verify(token, now + 1000)).toMatchObject({ p: propertyId, r: reservationId, k: 'proposal' });
    expect(() => links.verify(token, now + 31 * 86_400_000)).toThrow(NotFoundException);
    const [body, signature] = token.split('.');
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), r: 'other' })).toString('base64url');
    expect(() => links.verify(`${altered}.${signature}`, now)).toThrow(NotFoundException);
    expect(links.url(propertyId, reservationId, 'confirmation')).toMatch(/^https:\/\/pms\.example\.test\/api\/v1\/public\/documents\/[\w-]+\.[\w-]+$/);
  });
  it('refuses to sign without a strong secret', () => {
    expect(() => new DocumentLinkService(new ConfigService({})).sign(propertyId, reservationId, 'proposal')).toThrow('DOCUMENT_LINK_SECRET_NOT_CONFIGURED');
  });
});

function setup(guest: Record<string, unknown> = { id: 'guest-1', firstName: 'Алия', lastName: 'С', email: 'aliya@example.test', phone: '+77010000001' }) {
  const queue: any[][] = [[{ guestId: 'guest-1', bookingId: 'booking-1' }], [guest]];
  const builder: any = { from: () => builder, where: () => builder, then: (r: any) => Promise.resolve(queue.shift() ?? []).then(r) };
  const writes: any[] = [];
  const db = { select: vi.fn(() => builder), insert: vi.fn(() => ({ values: async (v: any) => writes.push(v) })),
    update: vi.fn(() => ({ set: (v: any) => ({ where: async () => writes.push(v) }) })) };
  const crmCalls: any[] = [];
  const crm = { configured: () => true, verified: async () => ({ crmPropertyId: 'crm-property' }),
    call: vi.fn(async (_m: unknown, path: string, method: string, body: any) => { crmCalls.push({ path, method, body }); return { delivered: true, channel: body?.channel ?? 'simulator', conversationId: 'c1' }; }) };
  const inbox = { authorize: vi.fn(async () => ({ id: 'staff-1', name: 'Дана', grants: [] })),
    guestPayload: (g: any) => ({ pmsGuestId: g.id, email: g.email, phone: g.phone }),
    deliverDirect: vi.fn(async () => ({ sent: false, error: 'not_sent' })) };
  const confirmation = { build: vi.fn(async () => ({ kind: 'proposal', confirmationNumber: 'HTL-1', guest: { name: 'Алия С' },
    property: { name: 'LES', language: 'ru' }, rooms: [{ reservationId }, { reservationId: 'r2' }] })) };
  const service = new ReservationChatService(db as any, crm as any, inbox as any, confirmation as any, new DocumentLinkService(config));
  return { service, crmCalls, inbox, writes };
}

describe('booking documents in guest chats', () => {
  afterEach(() => vi.restoreAllMocks());
  it('sends the prepared text with the signed link into a new staff chat and stamps every room', async () => {
    const { service, crmCalls, writes } = setup();
    const result = await service.send(reservationId, propertyId, { mode: 'manual', idempotencyKey: 'chat-doc-0001' }, undefined);
    const call = crmCalls.find((c) => c.path === 'v2/document-confirmations');
    expect(call.body).toMatchObject({ pmsReservationId: reservationId, confirmationNumber: 'HTL-1', kind: 'proposal', mode: 'manual',
      channel: 'simulator', staffReference: 'pms:staff-1', idempotencyKey: 'chat-doc-0001' });
    expect(call.body.documentUrl).toMatch(/^https:\/\/pms\.example\.test\/api\/v1\/public\/documents\//);
    expect(call.body.text).toContain(call.body.documentUrl);
    expect(call.body.text).toContain('ответьте «Да»');
    expect(writes.some((w) => w.proposalSentAt)).toBe(true);
    expect(writes.some((w) => w.action === 'document_sent_to_chat')).toBe(true);
    expect(result).toMatchObject({ delivered: true });
  });
  it('lets the AI conversation be chosen by the CRM and keeps the link in edited text', async () => {
    const { service, crmCalls } = setup();
    await service.send(reservationId, propertyId, { mode: 'ai' }, undefined);
    expect(crmCalls[0].body.channel).toBeUndefined();
    await expect(setup().service.send(reservationId, propertyId, { mode: 'manual', text: 'Документ без ссылки' }, undefined))
      .rejects.toThrow('The message must keep the document link');
  });
  it('delivers email through PMS and tells the CRM the result', async () => {
    const { service, crmCalls, inbox } = setup();
    await service.send(reservationId, propertyId, { mode: 'manual', channel: 'email' }, undefined);
    expect(inbox.deliverDirect).toHaveBeenCalledWith(propertyId, 'email', 'aliya@example.test', expect.stringContaining('/public/documents/'), expect.stringContaining('HTL-1'));
    expect(crmCalls[0].body.delivery).toEqual({ sent: false, error: 'not_sent' });
  });
  it('writes English text for English properties', () => {
    expect(chatDocumentText({ kind: 'confirmation', confirmationNumber: 'A1', hotel: 'H', guestName: 'Ann', url: 'https://x', language: 'en' }))
      .toContain('reply "Yes"');
  });
});

describe('email and SMS copies in guest chats', () => {
  it('records a sent confirmation email in the guest email chat', async () => {
    const queue: any[][] = [[{ guestId: 'guest-1' }], [{ id: 'guest-1', firstName: 'Алия', lastName: 'С', email: 'a@example.test', phone: null }]];
    const builder: any = { from: () => builder, where: () => builder, then: (r: any) => Promise.resolve(queue.shift() ?? []).then(r) };
    const crm = { configured: () => true, mapping: async () => ({}), call: vi.fn(async () => ({})) };
    const listener = new GuestChannelLogListener({ select: () => builder } as any, crm as any);
    await listener.onMessageSent({ event: 'reservation.message_sent', entityType: 'reservation', entityId: reservationId, propertyId,
      timestamp: '2027-01-01T00:00:00.000Z', data: { channel: 'email', subject: 'Подтверждение HTL-1', text: 'Детали брони', sent: true, kind: 'booking_confirmation' } } as any);
    expect(crm.call).toHaveBeenCalledWith({}, 'v2/inbox/messages/external', 'POST', expect.objectContaining({ channel: 'email',
      text: 'Подтверждение HTL-1\n\nДетали брони', kind: 'booking_confirmation', delivery: { sent: true, subject: 'Подтверждение HTL-1' },
      guest: expect.objectContaining({ pmsGuestId: 'guest-1' }) }));
  });
  it('skips marketing and channels it does not record', async () => {
    const crm = { configured: () => true, mapping: vi.fn(), call: vi.fn() };
    const listener = new GuestChannelLogListener({} as any, crm as any);
    await listener.onMessageSent({ entityType: 'reservation', entityId: 'r', propertyId, data: { channel: 'email', isMarketing: true } } as any);
    await listener.onMessageSent({ entityType: 'reservation', entityId: 'r', propertyId, data: { channel: 'push' } } as any);
    expect(crm.call).not.toHaveBeenCalled();
  });
});
