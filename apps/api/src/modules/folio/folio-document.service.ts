import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { bookings, charges, folios, guests, payments, properties, reservations, rooms, roomTypes } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { folioPaymentSumWhere } from '../payment/payment-ledger';
import { paymentMethodLabel, renderFolioDocument, type FolioDocumentData } from './folio-document.renderer';

/** Builds the guest-facing folio document strictly from the property-scoped ledger. */
@Injectable()
export class FolioDocumentService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

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
}
