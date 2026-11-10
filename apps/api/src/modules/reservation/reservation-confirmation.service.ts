import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, bookings, depositLedgerEntries, folios, guests, properties, ratePlans, reservationServices, reservations, roomTypes, rooms, services } from '@telivityhaip/database';
import type { AcceptedPricingSnapshot } from '@telivityhaip/database';
import { actorFields, type AuditActor } from '@telivityhaip/shared';
import { DRIZZLE } from '../../database/database.module';
import { EmailService } from '../agent/guest-comms/email.service';
import { NotificationService } from '../notifications/notification.service';
import { PolicyService } from '../policy/policy.service';
import { WebhookService } from '../webhook/webhook.service';
import { DOCUMENT_CSS, day, esc, moment, money } from '../../common/documents/guest-document';

export { DOCUMENT_CSS };

/** `proposal` = offer for a tentative booking (terms, guarantee, deadline); `confirmation` = confirmed booking. */
export type ReservationDocumentKind = 'proposal' | 'confirmation';
export type DocumentChannel = 'email' | 'sms';

export interface DocumentNight { date: string; roomAmount: string; taxAmount: string; total: string }
export interface DocumentSupplementLine { kind: 'adult' | 'child'; bandLabel: string | null; age: number | null; ordinal: number; amountPerNight: string }

export interface ReservationDocumentRoom {
  reservationId: string;
  status: string;
  roomType: string;
  roomNumber: string | null;
  ratePlan: string;
  mealPlan: string | null;
  adults: number;
  children: number;
  childAges: number[];
  totalAmount: string;
  nights: DocumentNight[];
  /** Extra-guest supplement already included in every night of this room. */
  supplement: { amountPerNight: string; lines: DocumentSupplementLine[] } | null;
}

export interface ReservationConfirmation {
  kind: ReservationDocumentKind;
  confirmationNumber: string;
  status: string;
  groupName: string | null;
  guest: { name: string; email: string | null; phone: string | null };
  property: { name: string; address: string; phone: string | null; email: string | null; website: string | null;
    checkInTime: string; checkOutTime: string; language: string };
  stay: { arrivalDate: string; departureDate: string; nights: number; adults: number; children: number; childAges: number[];
    roomType: string; ratePlan: string; mealPlan: string | null };
  rooms: ReservationDocumentRoom[];
  services: Array<{ name: string; quantity: number; amount: string }>;
  price: { currencyCode: string; roomTotal: string; taxTotal: string; servicesTotal: string; adjustment: string | null; total: string };
  payment: { paid: string; balance: string };
  /** Tentative booking terms: deadline and the guarantee still to be received. */
  guarantee: { optionUntil: string | null; requiredDeposit: string | null; depositDue: string | null; guaranteeType: string | null };
  sent: { proposalAt: string | null; confirmationAt: string | null };
  /** Set when the proposal is resent as a reminder before the option deadline. */
  reminder?: boolean;
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Nightly lines of a stay: the accepted snapshot when present, otherwise the total spread evenly. */
export function documentNights(r: { arrivalDate: string; nights: number; totalAmount: string | null;
  acceptedPricingSnapshot?: AcceptedPricingSnapshot | null }): DocumentNight[] {
  const snapshot = r.acceptedPricingSnapshot;
  if (snapshot?.nights?.length) {
    return snapshot.nights.map((n) => ({ date: n.date, roomAmount: new Decimal(n.roomAmount).toFixed(2),
      taxAmount: new Decimal(n.taxAmount).toFixed(2), total: new Decimal(n.roomAmount).plus(n.taxAmount).toFixed(2) }));
  }
  const count = Math.max(1, r.nights);
  const total = new Decimal(r.totalAmount ?? 0);
  const each = total.dividedBy(count).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(r.arrivalDate + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + i);
    const amount = i === count - 1 ? total.minus(each.times(count - 1)) : each; // last night absorbs rounding
    return { date: date.toISOString().slice(0, 10), roomAmount: amount.toFixed(2), taxAmount: '0.00', total: amount.toFixed(2) };
  });
}

/** Guest-facing proposal / booking confirmation built from PMS operational data (one booking, all its rooms). */
@Injectable()
export class ReservationConfirmationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly email: EmailService,
    private readonly policies: PolicyService,
    private readonly webhooks: WebhookService,
    private readonly notifications: NotificationService,
  ) {}

  async build(reservationId: string, propertyId: string, kindOverride?: ReservationDocumentKind): Promise<ReservationConfirmation> {
    const [row] = await this.db.select({ reservation: reservations, booking: bookings, guest: guests, property: properties,
      roomType: roomTypes, ratePlan: ratePlans })
      .from(reservations)
      .innerJoin(bookings, and(eq(bookings.id, reservations.bookingId), eq(bookings.propertyId, propertyId)))
      .innerJoin(guests, eq(guests.id, reservations.guestId))
      .innerJoin(properties, eq(properties.id, reservations.propertyId))
      .innerJoin(roomTypes, and(eq(roomTypes.id, reservations.roomTypeId), eq(roomTypes.propertyId, propertyId)))
      .innerJoin(ratePlans, and(eq(ratePlans.id, reservations.ratePlanId), eq(ratePlans.propertyId, propertyId)))
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    const { reservation: r, booking, guest, property, roomType, ratePlan } = row;
    const lang = String(property.defaultLanguage ?? 'ru').startsWith('en') ? 'en' : 'ru';
    const meal = (code: string | null) => code ? (MEAL_PLAN[code]?.[lang] ?? code) : null;

    // Every active room of the booking is part of the same document.
    const siblings = await this.db.select({ reservation: reservations, roomTypeName: roomTypes.name, ratePlanName: ratePlans.name,
      mealPlan: ratePlans.mealPlan, roomNumber: rooms.number })
      .from(reservations)
      .innerJoin(roomTypes, eq(roomTypes.id, reservations.roomTypeId))
      .innerJoin(ratePlans, eq(ratePlans.id, reservations.ratePlanId))
      .leftJoin(rooms, and(eq(rooms.id, reservations.roomId), eq(rooms.propertyId, propertyId)))
      .where(and(eq(reservations.bookingId, booking.id), eq(reservations.propertyId, propertyId), ne(reservations.status, 'cancelled')))
      .orderBy(reservations.createdAt);
    const stays = siblings.length ? siblings
      : [{ reservation: r, roomTypeName: roomType.name, ratePlanName: ratePlan.name, mealPlan: ratePlan.mealPlan, roomNumber: null }];
    const ids = stays.map((s: any) => s.reservation.id);

    const serviceRows = await this.db.select({ line: reservationServices, name: services.name }).from(reservationServices)
      .innerJoin(services, eq(services.id, reservationServices.serviceId))
      .where(and(eq(reservationServices.propertyId, propertyId), inArray(reservationServices.reservationId, ids),
        ne(reservationServices.status, 'cancelled')));
    const folioRows = await this.db.select({ totalPayments: folios.totalPayments }).from(folios)
      .where(and(eq(folios.propertyId, propertyId), inArray(folios.reservationId, ids)));
    const depositRows = await this.db.select({ amount: depositLedgerEntries.amount, paymentId: depositLedgerEntries.paymentId,
      status: depositLedgerEntries.status }).from(depositLedgerEntries)
      .where(and(eq(depositLedgerEntries.propertyId, propertyId), inArray(depositLedgerEntries.reservationId, ids)));

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
    const paid = [...folioRows.map((f: any) => f.totalPayments),
      ...depositRows.filter((d: any) => !d.paymentId && ['held', 'applied'].includes(d.status)).map((d: any) => d.amount)]
      .reduce((sum: Decimal, v: string | null) => sum.plus(v ?? 0), new Decimal(0));
    const policy = await this.policies.getPolicySummary(propertyId, r.ratePlanId);
    const address = [property.addressLine1, property.addressLine2, property.city, property.postalCode].filter(Boolean).join(', ');

    const pending = stays.filter((s: any) => s.reservation.status === 'pending');
    const required = pending.some((s: any) => s.reservation.requiredDeposit != null)
      ? pending.reduce((sum: Decimal, s: any) => sum.plus(s.reservation.requiredDeposit ?? 0), new Decimal(0)) : null;
    const deadlines = pending.map((s: any) => s.reservation.optionUntil).filter(Boolean).map((d: any) => new Date(d).getTime());
    const kind: ReservationDocumentKind = kindOverride ?? (pending.length ? 'proposal' : 'confirmation');
    const allAges = stays.flatMap((s: any) => s.reservation.childAges ?? []);

    return {
      kind,
      confirmationNumber: booking.confirmationNumber,
      status: r.status,
      groupName: booking.groupName ?? null,
      guest: { name: [guest.firstName, guest.lastName].filter(Boolean).join(' '), email: guest.email ?? null, phone: guest.phone ?? null },
      property: { name: property.name, address, phone: property.phone ?? null, email: property.email ?? null, website: property.website ?? null,
        checkInTime: property.checkInTime, checkOutTime: property.checkOutTime, language: lang },
      stay: { arrivalDate: r.arrivalDate, departureDate: r.departureDate, nights: r.nights,
        adults: stays.reduce((n: number, s: any) => n + (s.reservation.adults ?? 0), 0),
        children: stays.reduce((n: number, s: any) => n + (s.reservation.children ?? 0), 0),
        childAges: allAges,
        roomType: roomType.name, ratePlan: ratePlan.name, mealPlan: meal(ratePlan.mealPlan) },
      rooms: stays.map((s: any) => {
        const supplement = s.reservation.acceptedPricingSnapshot?.occupancySupplement ?? null;
        return {
          reservationId: s.reservation.id, status: s.reservation.status, roomType: s.roomTypeName, roomNumber: s.roomNumber ?? null,
          ratePlan: s.ratePlanName, mealPlan: meal(s.mealPlan),
          adults: s.reservation.adults ?? 0, children: s.reservation.children ?? 0, childAges: s.reservation.childAges ?? [],
          totalAmount: new Decimal(s.reservation.totalAmount ?? 0).toFixed(2),
          nights: documentNights(s.reservation),
          supplement: supplement ? { amountPerNight: supplement.amountPerNight,
            lines: supplement.lines.map((l: any) => ({ kind: l.kind, bandLabel: l.bandLabel, age: l.age, ordinal: l.ordinal, amountPerNight: l.amountPerNight })) } : null,
        };
      }),
      services: serviceRows.map((s: any) => ({ name: s.name, quantity: s.line.quantity,
        amount: new Decimal(s.line.unitPrice).times(s.line.quantity).toFixed(2) })),
      price: { currencyCode: r.currencyCode, roomTotal: roomTotal.toFixed(2), taxTotal: taxTotal.toFixed(2), servicesTotal: servicesTotal.toFixed(2),
        adjustment: adjustment.isZero() ? null : adjustment.toFixed(2), total: total.toFixed(2) },
      payment: { paid: paid.toFixed(2), balance: Decimal.max(0, total.minus(paid)).toFixed(2) },
      guarantee: {
        optionUntil: deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null,
        requiredDeposit: required ? required.toFixed(2) : null,
        depositDue: required ? Decimal.max(0, required.minus(paid)).toFixed(2) : null,
        guaranteeType: r.guaranteeType ?? null,
      },
      sent: { proposalAt: r.proposalSentAt ? new Date(r.proposalSentAt).toISOString() : null,
        confirmationAt: r.confirmationSentAt ? new Date(r.confirmationSentAt).toISOString() : null },
      cancellationPolicy: policy.description,
      specialRequests: r.specialRequests ?? null,
    };
  }

  async html(reservationId: string, propertyId: string, kind?: ReservationDocumentKind) {
    return renderConfirmation(await this.build(reservationId, propertyId, kind));
  }

  /**
   * Sends the proposal or confirmation to the guest by email (full document) or SMS (short text).
   * Records the send time on every room of the booking, the audit trail and a `reservation.message_sent` event.
   */
  async send(reservationId: string, propertyId: string,
    options: { kind?: ReservationDocumentKind; channel?: DocumentChannel; to?: string; reminder?: boolean } | string | undefined, actor?: AuditActor) {
    const opts = typeof options === 'string' || options === undefined ? { to: options } : options;
    const built = await this.build(reservationId, propertyId, opts.kind);
    const data: ReservationConfirmation = 'reminder' in opts && opts.reminder && built.kind === 'proposal' ? { ...built, reminder: true } : built;
    const channel = opts.channel ?? 'email';
    const L = LABELS[data.property.language as 'ru' | 'en'];
    const title = data.kind === 'proposal' ? L.proposalTitle : L.title;
    const subject = `${data.reminder ? `${L.reminderPrefix}: ` : ''}${title} ${data.confirmationNumber} — ${data.property.name}`;
    let recipient: string;
    let result: { sent: boolean; status?: string };
    if (channel === 'sms') {
      recipient = (opts.to ?? data.guest.phone ?? '').trim();
      if (!/^\+?[0-9 ()-]{6,20}$/.test(recipient)) throw new BadRequestException('Guest has no valid phone number');
      const sms = await this.notifications.sendSms(propertyId, recipient, smsText(data));
      result = { sent: sms.sent, status: sms.sent ? 'sent' : 'draft' };
    } else {
      recipient = (opts.to ?? data.guest.email ?? '').trim();
      if (!EMAIL_RE.test(recipient)) throw new BadRequestException('Guest has no valid email address');
      result = await this.email.send({ to: recipient, subject, html: renderConfirmation(data), text: confirmationText(data) });
    }
    const now = new Date();
    const stamp = data.kind === 'proposal' ? { proposalSentAt: now } : { confirmationSentAt: now };
    if (result.sent) {
      await this.db.update(reservations).set({ ...stamp, updatedAt: now })
        .where(and(eq(reservations.propertyId, propertyId), inArray(reservations.id, data.rooms.map((room) => room.reservationId))));
    }
    await this.db.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: reservationId,
      action: data.reminder ? 'option_reminder_sent' : data.kind === 'proposal' ? 'proposal_sent' : 'confirmation_sent', ...actorFields(actor),
      description: `${title}: ${channel === 'sms' ? 'SMS' : 'email'} ${recipient}${result.sent ? '' : ' (не доставлено провайдером)'}`,
      newValue: { to: recipient, channel, status: result.status, sent: result.sent, total: data.price.total, confirmationNumber: data.confirmationNumber } });
    await this.webhooks.emit('reservation.message_sent', 'reservation', reservationId,
      { reservationId, channel, kind: data.reminder ? 'booking_option_reminder' : data.kind === 'proposal' ? 'booking_proposal' : 'booking_confirmation', to: recipient,
        subject, sent: result.sent, isMarketing: false }, propertyId);
    return { kind: data.kind, channel, to: recipient, sent: result.sent, status: result.status, sentAt: result.sent ? now.toISOString() : null };
  }
}

export const LABELS = {
  ru: { title: 'Подтверждение бронирования', proposalTitle: 'Предложение по бронированию', number: 'Номер бронирования', guest: 'Гость',
    hotel: 'Отель', room: 'Категория номера', roomNo: 'Номер', group: 'Группа',
    arrival: 'Заезд', departure: 'Выезд', nights: 'Ночей', guests: 'Гости', adults: 'взр.', children: 'дет.', years: 'лет', rate: 'Тариф', meals: 'Питание',
    services: 'Услуги', price: 'Стоимость проживания', rooms: 'Номера', tax: 'Налоги', servicesTotal: 'Услуги',
    adjustment: 'Скидка / корректировка', total: 'Итого', paid: 'Оплачено', balance: 'К оплате', cancellation: 'Условия отмены',
    payment: 'Условия оплаты', paymentText: 'Оплата остатка производится до или при заезде.', checkIn: 'Заезд с', checkOut: 'Выезд до',
    contacts: 'Контакты отеля', requests: 'Пожелания', print: 'Печать / PDF', none: 'Нет', byNight: 'Стоимость по ночам', date: 'Дата',
    nightRate: 'Проживание', nightTax: 'Налог', nightTotal: 'Сумма', supplement: 'Доплата за дополнительных гостей (за ночь, включена в цену)',
    adultExtra: 'Доп. взрослый', child: 'Ребёнок', childOrdinal: '-й', free: 'бесплатно', perNight: 'за ночь',
    proposalIntro: 'Бронь предварительная. Чтобы подтвердить её, внесите гарантию до указанного срока.',
    guaranteeTitle: 'Подтверждение брони', depositRequired: 'Гарантийный платёж', depositDue: 'Осталось внести', optionUntil: 'Действует до',
    noDeadline: 'Срок не установлен', confirmedIntro: 'Ваше бронирование подтверждено. Ждём вас!',
    reminderPrefix: 'Напоминание', reminderIntro: 'Напоминаем: бронь ещё не подтверждена. Чтобы сохранить её, внесите гарантию до указанного срока.' },
  en: { title: 'Booking confirmation', proposalTitle: 'Booking proposal', number: 'Confirmation number', guest: 'Guest', hotel: 'Hotel',
    room: 'Room category', roomNo: 'Room', group: 'Group',
    arrival: 'Arrival', departure: 'Departure', nights: 'Nights', guests: 'Guests', adults: 'adults', children: 'children', years: 'y.o.', rate: 'Rate', meals: 'Meals',
    services: 'Services', price: 'Stay price', rooms: 'Rooms', tax: 'Taxes', servicesTotal: 'Services',
    adjustment: 'Discount / adjustment', total: 'Total', paid: 'Paid', balance: 'Balance due', cancellation: 'Cancellation policy',
    payment: 'Payment terms', paymentText: 'The remaining balance is payable before or at check-in.', checkIn: 'Check-in from', checkOut: 'Check-out until',
    contacts: 'Hotel contacts', requests: 'Requests', print: 'Print / PDF', none: 'None', byNight: 'Price by night', date: 'Date',
    nightRate: 'Room', nightTax: 'Tax', nightTotal: 'Amount', supplement: 'Extra guest supplement (per night, included)',
    adultExtra: 'Extra adult', child: 'Child', childOrdinal: '', free: 'free', perNight: 'per night',
    proposalIntro: 'This booking is tentative. Pay the guarantee before the deadline to confirm it.',
    guaranteeTitle: 'Confirming your booking', depositRequired: 'Guarantee payment', depositDue: 'Still to pay', optionUntil: 'Valid until',
    noDeadline: 'No deadline set', confirmedIntro: 'Your booking is confirmed. We look forward to welcoming you!',
    reminderPrefix: 'Reminder', reminderIntro: 'A reminder: your booking is not confirmed yet. Pay the guarantee before the deadline to keep it.' },
};

/** "2 взр., 2 дет. (4, 9 лет)" */
export function partyLabel(adults: number, children: number, ages: number[], lang: 'ru' | 'en') {
  const L = LABELS[lang];
  const kids = children ? `, ${children} ${L.children}${ages.length ? ` (${ages.join(', ')} ${L.years})` : ''}` : '';
  return `${adults} ${L.adults}${kids}`;
}

function supplementLabel(line: DocumentSupplementLine, lang: 'ru' | 'en') {
  const L = LABELS[lang];
  if (line.kind === 'adult') return `${L.adultExtra} ${line.ordinal}${L.childOrdinal}`;
  const band = line.bandLabel ? ` ${line.bandLabel}` : '';
  const age = line.age != null ? ` (${line.age} ${L.years})` : '';
  return `${L.child}${band}${age}, ${line.ordinal}${L.childOrdinal}`;
}

export function renderConfirmation(d: ReservationConfirmation): string {
  const lang = d.property.language as 'ru' | 'en';
  const L = LABELS[lang];
  const m = (v: string) => money(v, d.price.currencyCode, lang);
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
  const title = d.kind === 'proposal' ? L.proposalTitle : L.title;
  const party = partyLabel(d.stay.adults, d.stay.children, d.stay.childAges, lang);

  const roomBlocks = d.rooms.map((room, index) => {
    const head = `${d.rooms.length > 1 ? `${index + 1}. ` : ''}${esc(room.roomType)}${room.roomNumber ? ` · ${esc(L.roomNo)} ${esc(room.roomNumber)}` : ''}`;
    const nights = room.nights.map(n => `<tr><td>${esc(day(n.date, lang, true))}</td><td class="num">${m(n.roomAmount)}</td>`
      + `<td class="num">${m(n.taxAmount)}</td><td class="num">${m(n.total)}</td></tr>`).join('');
    const supplement = room.supplement?.lines.length
      ? `<div class="supp">${esc(L.supplement)}: ${room.supplement.lines.map(l => `${esc(supplementLabel(l, lang))} — ${new Decimal(l.amountPerNight).isZero() ? esc(L.free) : m(l.amountPerNight)}`).join('; ')}</div>` : '';
    return `<div class="room"><div class="room-head"><div><strong>${head}</strong><div class="muted">${esc(room.ratePlan)}${room.mealPlan ? ` · ${esc(room.mealPlan)}` : ''}</div></div>`
      + `<div class="muted" style="text-align:right">${esc(partyLabel(room.adults, room.children, room.childAges, lang))}</div></div>`
      + `<table class="grid"><thead><tr><th>${esc(L.date)}</th><th class="num">${esc(L.nightRate)}</th><th class="num">${esc(L.nightTax)}</th><th class="num">${esc(L.nightTotal)}</th></tr></thead>`
      + `<tbody>${nights}</tbody><tfoot><tr><td>${esc(L.nights)}: ${room.nights.length}</td><td></td><td></td><td class="num">${m(room.totalAmount)}</td></tr></tfoot></table>${supplement}</div>`;
  }).join('');

  const guarantee = d.kind === 'proposal'
    ? `<div class="callout wait"><b>${esc(L.guaranteeTitle)}</b>${esc(d.reminder ? L.reminderIntro : L.proposalIntro)}<br>`
      + `${d.guarantee.requiredDeposit ? `${esc(L.depositRequired)}: <strong>${m(d.guarantee.requiredDeposit)}</strong>` : ''}`
      + `${d.guarantee.depositDue && d.guarantee.depositDue !== d.guarantee.requiredDeposit ? ` · ${esc(L.depositDue)}: <strong>${m(d.guarantee.depositDue)}</strong>` : ''}`
      + `<br>${esc(L.optionUntil)}: <strong>${d.guarantee.optionUntil ? esc(moment(d.guarantee.optionUntil, lang)) : esc(L.noDeadline)}</strong></div>`
    : `<div class="callout ok"><b>${esc(L.confirmedIntro)}</b></div>`;

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} ${esc(d.confirmationNumber)}</title><style>${DOCUMENT_CSS}</style></head><body><main class="sheet">
<div class="no-print"><button onclick="window.print()">${esc(L.print)}</button></div>
<header><div><h1>${esc(title)}</h1><div class="muted">${esc(L.number)}: <strong>${esc(d.confirmationNumber)}</strong></div>
<span class="badge ${d.kind === 'proposal' ? 'wait' : 'ok'}">${esc(d.kind === 'proposal' ? L.proposalTitle : L.title)}</span></div>
<div class="hotel"><strong>${esc(d.property.name)}</strong><br>${[d.property.address, d.property.phone, d.property.email].filter(Boolean).map(esc).join('<br>')}</div></header>
${guarantee}
<table class="facts" style="margin-top:16px">${row(L.guest, esc(d.guest.name))}${d.groupName ? row(L.group, esc(d.groupName)) : ''}
${row(L.arrival, `${esc(day(d.stay.arrivalDate, lang))} · ${esc(L.checkIn)} ${esc(d.property.checkInTime)}`)}
${row(L.departure, `${esc(day(d.stay.departureDate, lang))} · ${esc(L.checkOut)} ${esc(d.property.checkOutTime)}`)}
${row(L.nights, String(d.stay.nights))}${row(L.guests, esc(party))}
${d.rooms.length === 1 ? row(L.rate, esc(d.stay.ratePlan)) + row(L.meals, esc(d.stay.mealPlan ?? L.none)) : row(L.rooms, String(d.rooms.length))}
${d.services.length ? row(L.services, d.services.map(s => `${esc(s.name)} × ${s.quantity}`).join('<br>')) : ''}
${d.specialRequests ? row(L.requests, esc(d.specialRequests)) : ''}</table>
<h2>${esc(L.byNight)}</h2>${roomBlocks}
<h2>${esc(L.price)}</h2><table class="totals">
<tr><td>${esc(L.price)}</td><td class="num">${m(d.price.roomTotal)}</td></tr>
${new Decimal(d.price.taxTotal).isZero() ? '' : `<tr><td>${esc(L.tax)}</td><td class="num">${m(d.price.taxTotal)}</td></tr>`}
${new Decimal(d.price.servicesTotal).isZero() ? '' : `<tr><td>${esc(L.servicesTotal)}</td><td class="num">${m(d.price.servicesTotal)}</td></tr>`}
${d.price.adjustment ? `<tr><td>${esc(L.adjustment)}</td><td class="num">${m(d.price.adjustment)}</td></tr>` : ''}
<tr class="grand"><td>${esc(L.total)}</td><td class="num">${m(d.price.total)}</td></tr>
<tr><td>${esc(L.paid)}</td><td class="num">${m(d.payment.paid)}</td></tr><tr><td><strong>${esc(L.balance)}</strong></td><td class="num"><strong>${m(d.payment.balance)}</strong></td></tr></table>
<h2>${esc(L.payment)}</h2><p>${esc(L.paymentText)}</p>
<h2>${esc(L.cancellation)}</h2><p>${esc(d.cancellationPolicy)}</p>
<h2>${esc(L.contacts)}</h2><p>${[d.property.address, d.property.phone, d.property.email, d.property.website].filter(Boolean).map(esc).join('<br>')}</p>
</main></body></html>`;
}

export function confirmationText(d: ReservationConfirmation): string {
  const lang = d.property.language as 'ru' | 'en';
  const L = LABELS[lang];
  const lines = [`${d.reminder ? `${L.reminderPrefix}. ` : ''}${d.kind === 'proposal' ? L.proposalTitle : L.title} ${d.confirmationNumber}`, ...(d.reminder ? [L.reminderIntro] : []), `${L.guest}: ${d.guest.name}`, `${L.hotel}: ${d.property.name}`,
    `${L.arrival}: ${d.stay.arrivalDate} (${L.checkIn} ${d.property.checkInTime})`,
    `${L.departure}: ${d.stay.departureDate} (${L.checkOut} ${d.property.checkOutTime})`,
    `${L.guests}: ${partyLabel(d.stay.adults, d.stay.children, d.stay.childAges, lang)}`];
  for (const room of d.rooms) {
    lines.push('', `${room.roomType}${room.roomNumber ? ` (${room.roomNumber})` : ''} — ${partyLabel(room.adults, room.children, room.childAges, lang)}`);
    for (const n of room.nights) lines.push(`  ${n.date}: ${n.total} ${d.price.currencyCode}`);
  }
  lines.push('', `${L.total}: ${d.price.total} ${d.price.currencyCode}`, `${L.paid}: ${d.payment.paid} ${d.price.currencyCode}`);
  if (d.kind === 'proposal') {
    if (d.guarantee.requiredDeposit) lines.push(`${L.depositRequired}: ${d.guarantee.requiredDeposit} ${d.price.currencyCode}`);
    lines.push(`${L.optionUntil}: ${d.guarantee.optionUntil ?? L.noDeadline}`);
  }
  lines.push(`${L.cancellation}: ${d.cancellationPolicy}`, [d.property.phone, d.property.email].filter(Boolean).join(' · '));
  return lines.join('\n');
}

/** Short SMS version: number, dates, total and what to do next. */
export function smsText(d: ReservationConfirmation): string {
  const lang = d.property.language as 'ru' | 'en';
  const L = LABELS[lang];
  const head = `${d.property.name}: ${d.reminder ? `${L.reminderPrefix}. ` : ''}${d.kind === 'proposal' ? L.proposalTitle : L.title} ${d.confirmationNumber}`;
  const stay = `${d.stay.arrivalDate} → ${d.stay.departureDate}, ${partyLabel(d.stay.adults, d.stay.children, d.stay.childAges, lang)}`;
  const total = `${L.total}: ${d.price.total} ${d.price.currencyCode}`;
  const next = d.kind === 'proposal' && d.guarantee.requiredDeposit
    ? `${L.depositRequired}: ${d.guarantee.depositDue ?? d.guarantee.requiredDeposit} ${d.price.currencyCode}${d.guarantee.optionUntil ? `, ${L.optionUntil.toLowerCase()} ${moment(d.guarantee.optionUntil, lang)}` : ''}`
    : '';
  return [head, stay, total, next, d.property.phone ?? ''].filter(Boolean).join('. ');
}
