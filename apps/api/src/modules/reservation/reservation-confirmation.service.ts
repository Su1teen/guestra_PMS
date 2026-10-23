import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, bookings, folios, guests, properties, ratePlans, reservationServices, reservations, roomTypes, services } from '@telivityhaip/database';
import { actorFields, type AuditActor } from '@telivityhaip/shared';
import { DRIZZLE } from '../../database/database.module';
import { EmailService } from '../agent/guest-comms/email.service';
import { PolicyService } from '../policy/policy.service';
import { WebhookService } from '../webhook/webhook.service';

export interface ReservationConfirmation {
  confirmationNumber: string;
  status: string;
  guest: { name: string; email: string | null; phone: string | null };
  property: { name: string; address: string; phone: string | null; email: string | null; website: string | null;
    checkInTime: string; checkOutTime: string; language: string };
  stay: { arrivalDate: string; departureDate: string; nights: number; adults: number; children: number;
    roomType: string; ratePlan: string; mealPlan: string | null };
  rooms: Array<{ roomType: string; adults: number; children: number; totalAmount: string }>;
  services: Array<{ name: string; quantity: number; amount: string }>;
  price: { currencyCode: string; roomTotal: string; taxTotal: string; servicesTotal: string; adjustment: string | null; total: string };
  payment: { paid: string; balance: string };
  cancellationPolicy: string;
  specialRequests: string | null;
}

const MEAL_PLAN: Record<string, { ru: string; en: string }> = {
  room_only: { ru: 'Без питания', en: 'Room only' },
  breakfast: { ru: 'Завтрак включён', en: 'Breakfast included' },
  half_board: { ru: 'Полупансион', en: 'Half board' },
  full_board: { ru: 'Полный пансион', en: 'Full board' },
  all_inclusive: { ru: 'Всё включено', en: 'All inclusive' },
};

/** Guest-facing booking confirmation built from PMS operational data (one booking, all its rooms). */
@Injectable()
export class ReservationConfirmationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly email: EmailService,
    private readonly policies: PolicyService,
    private readonly webhooks: WebhookService,
  ) {}

  async build(reservationId: string, propertyId: string): Promise<ReservationConfirmation> {
    const [row] = await this.db.select({ reservation: reservations, booking: bookings, guest: guests, property: properties,
      roomType: roomTypes, ratePlan: ratePlans })
      .from(reservations)
      .innerJoin(bookings, and(eq(bookings.id, reservations.bookingId), eq(bookings.propertyId, propertyId)))
      .innerJoin(guests, eq(guests.id, reservations.guestId))
      .innerJoin(properties, eq(properties.id, reservations.propertyId))
      .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
      .innerJoin(ratePlans, eq(ratePlans.id, reservations.ratePlanId))
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    const { reservation: r, booking, guest, property, roomType, ratePlan } = row;
    const lang = String(property.defaultLanguage ?? 'ru').startsWith('en') ? 'en' : 'ru';

    // Every active room of the booking is part of the same confirmation.
    const siblings = await this.db.select({ reservation: reservations, roomTypeName: roomTypes.name }).from(reservations)
      .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
      .where(and(eq(reservations.bookingId, booking.id), eq(reservations.propertyId, propertyId), ne(reservations.status, 'cancelled')));
    const stays = siblings.length ? siblings : [{ reservation: r, roomTypeName: roomType.name }];
    const ids = stays.map((s: any) => s.reservation.id);

    const serviceRows = (await this.db.select({ line: reservationServices, name: services.name }).from(reservationServices)
      .innerJoin(services, eq(services.id, reservationServices.serviceId))
      .where(and(eq(reservationServices.propertyId, propertyId), ne(reservationServices.status, 'cancelled'))))
      .filter((s: any) => ids.includes(s.line.reservationId));
    const folioRows = (await this.db.select().from(folios).where(eq(folios.propertyId, propertyId)))
      .filter((f: any) => ids.includes(f.reservationId));

    let roomTotal = new Decimal(0), taxTotal = new Decimal(0), servicesTotal = new Decimal(0), adjustment = new Decimal(0), total = new Decimal(0);
    for (const { reservation } of stays) {
      const snapshot = reservation.acceptedPricingSnapshot;
      total = total.plus(reservation.totalAmount ?? 0);
      if (snapshot) {
        roomTotal = roomTotal.plus(snapshot.roomTotal); taxTotal = taxTotal.plus(snapshot.taxTotal);
        servicesTotal = servicesTotal.plus(snapshot.servicesTotal ?? 0).plus(snapshot.servicesTaxTotal ?? 0);
        if (snapshot.adjustment) adjustment = adjustment.plus(snapshot.adjustment.amount);
      } else roomTotal = roomTotal.plus(reservation.totalAmount ?? 0);
    }
    const paid = folioRows.reduce((sum: Decimal, f: any) => sum.plus(f.totalPayments ?? 0), new Decimal(0));
    const policy = await this.policies.getPolicySummary(propertyId, r.ratePlanId);
    const address = [property.addressLine1, property.addressLine2, property.city, property.postalCode].filter(Boolean).join(', ');

    return {
      confirmationNumber: booking.confirmationNumber,
      status: r.status,
      guest: { name: [guest.firstName, guest.lastName].filter(Boolean).join(' '), email: guest.email ?? null, phone: guest.phone ?? null },
      property: { name: property.name, address, phone: property.phone ?? null, email: property.email ?? null, website: property.website ?? null,
        checkInTime: property.checkInTime, checkOutTime: property.checkOutTime, language: lang },
      stay: { arrivalDate: r.arrivalDate, departureDate: r.departureDate, nights: r.nights,
        adults: stays.reduce((n: number, s: any) => n + (s.reservation.adults ?? 0), 0),
        children: stays.reduce((n: number, s: any) => n + (s.reservation.children ?? 0), 0),
        roomType: roomType.name, ratePlan: ratePlan.name, mealPlan: ratePlan.mealPlan ? (MEAL_PLAN[ratePlan.mealPlan]?.[lang] ?? ratePlan.mealPlan) : null },
      rooms: stays.map((s: any) => ({ roomType: s.roomTypeName, adults: s.reservation.adults ?? 0, children: s.reservation.children ?? 0,
        totalAmount: new Decimal(s.reservation.totalAmount ?? 0).toFixed(2) })),
      services: serviceRows.map((s: any) => ({ name: s.name, quantity: s.line.quantity,
        amount: new Decimal(s.line.unitPrice).times(s.line.quantity).toFixed(2) })),
      price: { currencyCode: r.currencyCode, roomTotal: roomTotal.toFixed(2), taxTotal: taxTotal.toFixed(2), servicesTotal: servicesTotal.toFixed(2),
        adjustment: adjustment.isZero() ? null : adjustment.toFixed(2), total: total.toFixed(2) },
      payment: { paid: paid.toFixed(2), balance: Decimal.max(0, total.minus(paid)).toFixed(2) },
      cancellationPolicy: policy.description,
      specialRequests: r.specialRequests ?? null,
    };
  }

  async html(reservationId: string, propertyId: string) {
    return renderConfirmation(await this.build(reservationId, propertyId));
  }

  async send(reservationId: string, propertyId: string, to: string | undefined, actor?: AuditActor) {
    const data = await this.build(reservationId, propertyId);
    const recipient = (to ?? data.guest.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new BadRequestException('Guest has no valid email address');
    const subject = data.property.language === 'en'
      ? `Booking confirmation ${data.confirmationNumber} — ${data.property.name}`
      : `Подтверждение бронирования ${data.confirmationNumber} — ${data.property.name}`;
    const html = renderConfirmation(data);
    const result = await this.email.send({ to: recipient, subject, html, text: confirmationText(data) });
    await this.db.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: reservationId, action: 'confirmation_sent',
      ...actorFields(actor), description: `Подтверждение отправлено на ${recipient}`,
      newValue: { to: recipient, status: result.status, total: data.price.total, confirmationNumber: data.confirmationNumber } });
    await this.webhooks.emit('reservation.message_sent', 'reservation', reservationId,
      { reservationId, channel: 'email', kind: 'booking_confirmation', to: recipient, subject, sent: result.sent, isMarketing: false }, propertyId);
    return { to: recipient, sent: result.sent, status: result.status };
  }
}

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const LABELS = {
  ru: { title: 'Подтверждение бронирования', number: 'Номер бронирования', guest: 'Гость', hotel: 'Отель', room: 'Категория номера',
    arrival: 'Заезд', departure: 'Выезд', nights: 'Ночей', guests: 'Гости', adults: 'взр.', children: 'дет.', rate: 'Тариф', meals: 'Питание',
    services: 'Включённые услуги', price: 'Стоимость проживания', rooms: 'Номера', tax: 'Налоги', servicesTotal: 'Услуги',
    adjustment: 'Скидка / корректировка', total: 'Итого', paid: 'Оплачено', balance: 'К оплате', cancellation: 'Условия отмены',
    payment: 'Условия оплаты', paymentText: 'Оплата остатка производится до или при заезде.', checkIn: 'Заезд с', checkOut: 'Выезд до',
    contacts: 'Контакты отеля', requests: 'Пожелания', print: 'Печать / PDF', none: 'Нет' },
  en: { title: 'Booking confirmation', number: 'Confirmation number', guest: 'Guest', hotel: 'Hotel', room: 'Room category',
    arrival: 'Arrival', departure: 'Departure', nights: 'Nights', guests: 'Guests', adults: 'adults', children: 'children', rate: 'Rate', meals: 'Meals',
    services: 'Included services', price: 'Stay price', rooms: 'Rooms', tax: 'Taxes', servicesTotal: 'Services',
    adjustment: 'Discount / adjustment', total: 'Total', paid: 'Paid', balance: 'Balance due', cancellation: 'Cancellation policy',
    payment: 'Payment terms', paymentText: 'The remaining balance is payable before or at check-in.', checkIn: 'Check-in from', checkOut: 'Check-out until',
    contacts: 'Hotel contacts', requests: 'Requests', print: 'Print / PDF', none: 'None' },
};

function money(value: string, currency: string, lang: string) {
  return `${new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))} ${currency}`;
}
function day(value: string, lang: string) {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ru-RU', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(value + 'T00:00:00Z'));
}

export function renderConfirmation(d: ReservationConfirmation): string {
  const lang = d.property.language as 'ru' | 'en';
  const L = LABELS[lang];
  const m = (v: string) => money(v, d.price.currencyCode, lang);
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
  const party = `${d.stay.adults} ${L.adults}${d.stay.children ? `, ${d.stay.children} ${L.children}` : ''}`;
  const roomList = d.rooms.length > 1
    ? row(L.rooms, d.rooms.map(r => `${esc(r.roomType)} · ${r.adults} ${L.adults}${r.children ? `, ${r.children} ${L.children}` : ''} · ${m(r.totalAmount)}`).join('<br>'))
    : row(L.room, esc(d.stay.roomType));
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(L.title)} ${esc(d.confirmationNumber)}</title><style>
body{margin:0;background:#f1f3f5;font-family:Arial,Helvetica,sans-serif;color:#1d2b36}.sheet{max-width:720px;margin:24px auto;background:#fff;padding:32px;border-radius:8px}
h1{font-size:22px;margin:0 0 4px}.muted{color:#66737f;font-size:13px}table{width:100%;border-collapse:collapse;margin:18px 0}th{text-align:left;width:42%;color:#66737f;font-weight:normal}
th,td{padding:8px 6px;border-bottom:1px solid #e6e9ec;font-size:14px;vertical-align:top}td{font-weight:600}.total td{font-size:17px}h2{font-size:15px;margin:22px 0 4px}
p{font-size:14px;line-height:1.5}.no-print{text-align:right}.no-print button{padding:8px 14px;border:0;border-radius:6px;background:#1d6f72;color:#fff;cursor:pointer}
@media print{body{background:#fff}.sheet{margin:0;padding:0}.no-print{display:none}}</style></head><body><main class="sheet">
<div class="no-print"><button onclick="window.print()">${esc(L.print)}</button></div>
<h1>${esc(L.title)}</h1><p class="muted">${esc(d.property.name)}</p>
<table>${row(L.number, esc(d.confirmationNumber))}${row(L.guest, esc(d.guest.name))}${row(L.hotel, esc(d.property.name))}${roomList}
${row(L.arrival, `${esc(day(d.stay.arrivalDate, lang))} · ${esc(L.checkIn)} ${esc(d.property.checkInTime)}`)}
${row(L.departure, `${esc(day(d.stay.departureDate, lang))} · ${esc(L.checkOut)} ${esc(d.property.checkOutTime)}`)}
${row(L.nights, String(d.stay.nights))}${row(L.guests, esc(party))}${row(L.rate, esc(d.stay.ratePlan))}
${row(L.meals, esc(d.stay.mealPlan ?? L.none))}
${row(L.services, d.services.length ? d.services.map(s => `${esc(s.name)} × ${s.quantity}`).join('<br>') : esc(L.none))}
${d.specialRequests ? row(L.requests, esc(d.specialRequests)) : ''}</table>
<h2>${esc(L.price)}</h2><table>${row(L.price, m(d.price.roomTotal))}${new Decimal(d.price.taxTotal).isZero() ? '' : row(L.tax, m(d.price.taxTotal))}
${new Decimal(d.price.servicesTotal).isZero() ? '' : row(L.servicesTotal, m(d.price.servicesTotal))}
${d.price.adjustment ? row(L.adjustment, m(d.price.adjustment)) : ''}<tr class="total"><th>${esc(L.total)}</th><td>${m(d.price.total)}</td></tr>
${row(L.paid, m(d.payment.paid))}${row(L.balance, m(d.payment.balance))}</table>
<h2>${esc(L.payment)}</h2><p>${esc(L.paymentText)}</p>
<h2>${esc(L.cancellation)}</h2><p>${esc(d.cancellationPolicy)}</p>
<h2>${esc(L.contacts)}</h2><p>${[d.property.address, d.property.phone, d.property.email, d.property.website].filter(Boolean).map(esc).join('<br>')}</p>
</main></body></html>`;
}

export function confirmationText(d: ReservationConfirmation): string {
  const L = LABELS[d.property.language as 'ru' | 'en'];
  return [`${L.title} ${d.confirmationNumber}`, `${L.guest}: ${d.guest.name}`, `${L.hotel}: ${d.property.name}`,
    `${L.room}: ${d.rooms.map(r => r.roomType).join(', ')}`, `${L.arrival}: ${d.stay.arrivalDate} (${L.checkIn} ${d.property.checkInTime})`,
    `${L.departure}: ${d.stay.departureDate} (${L.checkOut} ${d.property.checkOutTime})`,
    `${L.guests}: ${d.stay.adults} ${L.adults}${d.stay.children ? `, ${d.stay.children} ${L.children}` : ''}`,
    `${L.total}: ${d.price.total} ${d.price.currencyCode}`, `${L.cancellation}: ${d.cancellationPolicy}`,
    [d.property.phone, d.property.email].filter(Boolean).join(' · ')].join('\n');
}
