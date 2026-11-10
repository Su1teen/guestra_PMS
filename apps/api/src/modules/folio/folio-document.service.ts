import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { auditLogs, bookings, charges, folios, guests, payments, properties, reservations, rooms, roomTypes } from '@telivityhaip/database';
import { actorFields, type AuditActor } from '@telivityhaip/shared';
import Decimal from 'decimal.js';
import { EmailService } from '../agent/guest-comms/email.service';
import { WebhookService } from '../webhook/webhook.service';
import { DRIZZLE } from '../../database/database.module';
import { folioPaymentSumWhere } from '../payment/payment-ledger';
import { paymentMethodLabel, renderFolioDocument, type FolioDocumentData, type FolioDocumentNight } from './folio-document.renderer';

/**
 * Nightly view of a stay: posted room charges per date, and the accepted tariff for nights not posted yet.
 * Every night carries the head count, so the guest sees price per night and number of guests.
 */
export function stayNights(roomCharges: Array<{ serviceDate: Date | string; amount: string; taxAmount?: string | null }>,
  tariff: Array<{ date: string; roomAmount: string; taxAmount: string }>, guests: number): FolioDocumentNight[] {
  const posted = new Map<string, { amount: Decimal; tax: Decimal }>();
  for (const charge of roomCharges) {
    const date = new Date(charge.serviceDate).toISOString().slice(0, 10);
    const sum = posted.get(date) ?? { amount: new Decimal(0), tax: new Decimal(0) };
    posted.set(date, { amount: sum.amount.plus(charge.amount), tax: sum.tax.plus(charge.taxAmount ?? 0) });
  }
  const dates = [...new Set([...tariff.map((n) => n.date), ...posted.keys()])].sort();
  return dates.map((date) => {
    const billed = posted.get(date);
    const planned = tariff.find((n) => n.date === date);
    return { date, guests, posted: !!billed,
      amount: (billed ? billed.amount : new Decimal(planned?.roomAmount ?? 0)).toFixed(2),
      tax: (billed ? billed.tax : new Decimal(planned?.taxAmount ?? 0)).toFixed(2) };
  });
}

/** Builds the guest-facing folio document strictly from the property-scoped ledger. */
@Injectable()
export class FolioDocumentService {
  constructor(@Inject(DRIZZLE) private readonly db: any, private readonly email: EmailService, private readonly webhooks: WebhookService) {}

  async data(id: string, propertyId: string): Promise<FolioDocumentData> {
    const [row] = await this.db
      .select({ folio: folios, property: properties, reservation: reservations, booking: bookings, guest: guests,
        roomNumber: rooms.number, roomTypeName: roomTypes.name })
      .from(folios)
      .innerJoin(properties, eq(properties.id, folios.propertyId))
      .leftJoin(reservations, and(eq(reservations.id, folios.reservationId), eq(reservations.propertyId, folios.propertyId)))
      .leftJoin(bookings, and(eq(bookings.id, folios.bookingId), eq(bookings.propertyId, folios.propertyId)))
      .leftJoin(guests, eq(guests.id, folios.guestId))
      .leftJoin(rooms, and(eq(rooms.id, reservations.roomId), eq(rooms.propertyId, folios.propertyId)))
      .leftJoin(roomTypes, and(eq(roomTypes.id, reservations.roomTypeId), eq(roomTypes.propertyId, folios.propertyId)))
      .where(and(eq(folios.id, id), eq(folios.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Folio ${id} not found`);
    const [chargeRows, paymentRows] = await Promise.all([
      this.db.select().from(charges)
        .where(and(eq(charges.folioId, id), eq(charges.propertyId, propertyId)))
        .orderBy(asc(charges.serviceDate), asc(charges.postedAt)),
      this.db.select().from(payments)
        .where(folioPaymentSumWhere(id, propertyId))
        .orderBy(asc(payments.createdAt)),
    ]);
    const { folio, property, reservation, guest } = row;
    const address = [property.addressLine1, property.city].filter(Boolean).join(', ');
    return {
      final: folio.status === 'settled' || folio.status === 'closed',
      folioNumber: folio.folioNumber,
      issueDate: (folio.closedAt ?? folio.settledAt ?? new Date()).toISOString(),
      propertyName: property.name,
      propertyAddress: address || null,
      propertyContact: [property.phone, property.email].filter(Boolean).join(' · ') || null,
      guestName: guest ? `${guest.firstName} ${guest.lastName}`.trim() : folio.companyName ?? '—',
      guestContact: guest?.phone ?? guest?.email ?? null,
      confirmationNumber: row.booking?.confirmationNumber ?? null,
      roomNumber: row.roomNumber ?? null,
      roomTypeName: row.roomTypeName ?? null,
      arrivalDate: reservation?.arrivalDate ?? null,
      departureDate: reservation?.departureDate ?? null,
      guests: reservation ? (reservation.adults ?? 0) + (reservation.children ?? 0) : null,
      party: reservation ? { adults: reservation.adults ?? 0, children: reservation.children ?? 0, childAges: reservation.childAges ?? [] } : null,
      nights: reservation ? stayNights(chargeRows.filter((c: any) => c.type === 'room'), // reversals are negative rows and net out
        reservation.acceptedPricingSnapshot?.nights ?? [], (reservation.adults ?? 0) + (reservation.children ?? 0)) : [],
      currencyCode: folio.currencyCode,
      timeZone: property.timezone,
      // Every ledger row is shown, reversals included, so the lines add up to totalCharges.
      lines: chargeRows.map((charge: any) => ({
        date: charge.serviceDate ? new Date(charge.serviceDate).toISOString() : null,
        description: charge.isReversal ? `Сторно: ${charge.description}` : charge.description,
        amount: String(charge.amount),
        tax: charge.taxAmount != null ? String(charge.taxAmount) : null,
      })),
      payments: paymentRows.map((payment: any) => ({
        date: new Date(payment.processedAt ?? payment.createdAt).toISOString(),
        method: Number(payment.amount) < 0 ? `Возврат · ${paymentMethodLabel(payment.method)}` : paymentMethodLabel(payment.method),
        reference: payment.cardLastFour ? `•••• ${payment.cardLastFour}` : null,
        amount: String(payment.amount),
      })),
      totalCharges: String(folio.totalCharges),
      totalPayments: String(folio.totalPayments),
      balance: String(folio.balance),
    };
  }

  async render(id: string, propertyId: string): Promise<string> {
    return renderFolioDocument(await this.data(id, propertyId));
  }

  /** Emails the folio / receipt to the guest; audited and emitted as `reservation.message_sent`. */
  async send(id: string, propertyId: string, to: string | undefined, actor?: AuditActor) {
    const [row] = await this.db.select({ email: guests.email }).from(folios)
      .leftJoin(guests, eq(guests.id, folios.guestId))
      .where(and(eq(folios.id, id), eq(folios.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Folio ${id} not found`);
    const recipient = (to ?? row.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new BadRequestException('Guest has no valid email address');
    const data = await this.data(id, propertyId);
    const subject = `${data.final ? 'Итоговое фолио' : 'Предварительное фолио'} ${data.folioNumber} — ${data.propertyName}`;
    const text = [subject, `Начислено: ${data.totalCharges} ${data.currencyCode}`, `Оплачено: ${data.totalPayments} ${data.currencyCode}`,
      `Остаток: ${data.balance} ${data.currencyCode}`].join('\n');
    const result = await this.email.send({ to: recipient, subject, html: renderFolioDocument(data), text });
    await this.db.insert(auditLogs).values({ propertyId, entityType: 'folio', entityId: id, action: 'document_sent', ...actorFields(actor),
      description: `Фолио отправлено на ${recipient}`, newValue: { to: recipient, sent: result.sent, balance: data.balance, final: data.final } });
    await this.webhooks.emit('reservation.message_sent', 'folio', id,
      { folioId: id, channel: 'email', kind: 'folio_document', to: recipient, subject, sent: result.sent, isMarketing: false, text }, propertyId);
    return { to: recipient, sent: result.sent, status: result.status };
  }
}
