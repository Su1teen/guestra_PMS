import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, or } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { folios, guests, integrationLinks, managementInputs, payments, properties, reservationRevenueAllocations, reservations } from '@telivityhaip/database';
import { DRIZZLE } from '../../database/database.module';
import { zonedTimeToUtc } from '../../common/date/zoned-time';
import { reportDates } from './reporting-policy';

/** Payment statuses that are money received. Refunds are child rows with originalPaymentId. */
const RECEIVED = ['captured', 'settled', 'partially_refunded', 'refunded'];
const EXCLUDED = ['cancelled', 'no_show'];
export const REVENUE_CATEGORIES = ['accommodation', 'fnb', 'bath', 'spa', 'other', 'penalty'] as const;
const CRM_SOURCE = 'guestra_crm';

const d = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const money = (v: Decimal) => Number(v.toFixed(2));

interface Stay { id: string; bookingId: string; status: string; arrivalDate: string; departureDate: string; totalAmount: string;
  confirmationNumber: string; source: string; createdAt: Date; guestName: string; crmReservationId: string | null }

/**
 * Money reports for the sales head and management, by the date money arrived in the property's time zone.
 * Cancelled and no-show bookings are left out except for the prepayment retained from them (penalties).
 * Every figure comes from payments, refunds and the saved revenue split; CRM only shows the result.
 */
@Injectable()
export class MoneyReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: any) {}

  private async property(propertyId: string) {
    const [row] = await this.db.select().from(properties).where(eq(properties.id, propertyId));
    if (!row) throw new NotFoundException(`Property ${propertyId} not found`);
    return row;
  }

  private localDate(at: Date, timeZone: string) {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }

  /** Payments, refunds and penalties of the period with the stay each belongs to. */
  private async facts(propertyId: string, from: string, to: string) {
    const days = reportDates(from, to);
    const property = await this.property(propertyId);
    const tz = property.timezone ?? 'UTC';
    const start = zonedTimeToUtc(from, '00:00', tz);
    const end = zonedTimeToUtc(new Date(Date.parse(to) + 86_400_000).toISOString().slice(0, 10), '00:00', tz);
    const paymentRows = await this.db.select({ payment: payments, folio: { reservationId: folios.reservationId, bookingId: folios.bookingId } })
      .from(payments).innerJoin(folios, and(eq(folios.id, payments.folioId), eq(folios.propertyId, propertyId)))
      .where(and(eq(payments.propertyId, propertyId), gte(payments.processedAt, start), lt(payments.processedAt, end)));
    const penaltyRows = await this.db.select().from(reservationRevenueAllocations)
      .where(and(eq(reservationRevenueAllocations.propertyId, propertyId), eq(reservationRevenueAllocations.category, 'penalty'),
        gte(reservationRevenueAllocations.occurredAt, start), lt(reservationRevenueAllocations.occurredAt, end)));
    const created = await this.db.select({ id: reservations.id }).from(reservations)
      .where(and(eq(reservations.propertyId, propertyId), gte(reservations.createdAt, start), lt(reservations.createdAt, end)));
    const reservationIds = new Set<string>([...penaltyRows.map((r: any) => r.reservationId), ...created.map((r: any) => r.id),
      ...paymentRows.map((r: any) => r.folio.reservationId).filter(Boolean)]);
    const bookingIds: string[] = [...new Set<string>(paymentRows.filter((r: any) => !r.folio.reservationId && r.folio.bookingId).map((r: any) => r.folio.bookingId as string))];
    const stays = await this.stays(propertyId, [...reservationIds], bookingIds);
    const byId = new Map(stays.map((s) => [s.id, s]));
    const firstOfBooking = new Map<string, Stay>();
    for (const s of [...stays].sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate))) if (!firstOfBooking.has(s.bookingId)) firstOfBooking.set(s.bookingId, s);
    const splits = await this.splits(propertyId, stays.map((s) => s.id));
    const items = paymentRows.map(({ payment, folio }: any) => {
      const stay = folio.reservationId ? byId.get(folio.reservationId) : firstOfBooking.get(folio.bookingId);
      const refund = Boolean(payment.originalPaymentId);
      if (!refund && !RECEIVED.includes(payment.status)) return null;
      return { id: payment.id as string, date: this.localDate(new Date(payment.processedAt), tz), amount: d(payment.amount).abs(), refund, stay: stay ?? null, method: payment.method as string };
    }).filter(Boolean) as { id: string; date: string; amount: Decimal; refund: boolean; stay: Stay | null; method: string }[];
    const penalties = penaltyRows.map((r: any) => ({ date: this.localDate(new Date(r.occurredAt), tz), amount: d(r.amount), stay: byId.get(r.reservationId) ?? null,
      reason: r.reason as string | null }));
    const newBookings = created.map((r: any) => byId.get(r.id)).filter((s: Stay | undefined): s is Stay => Boolean(s) && !EXCLUDED.includes(s!.status));
    return { days, tz, property, items, penalties, newBookings, splits };
  }

  private async stays(propertyId: string, ids: string[], bookingIds: string[]): Promise<Stay[]> {
    if (!ids.length && !bookingIds.length) return [];
    const rows = await this.db.select({ r: reservations, firstName: guests.firstName, lastName: guests.lastName }).from(reservations)
      .leftJoin(guests, eq(guests.id, reservations.guestId))
      .where(and(eq(reservations.propertyId, propertyId), or(ids.length ? inArray(reservations.id, ids) : undefined,
        bookingIds.length ? inArray(reservations.bookingId, bookingIds) : undefined)));
    const allIds = rows.map((x: any) => x.r.id);
    const links = allIds.length ? await this.db.select().from(integrationLinks).where(and(eq(integrationLinks.propertyId, propertyId),
      eq(integrationLinks.sourceSystem, CRM_SOURCE), eq(integrationLinks.localEntityType, 'reservation'), inArray(integrationLinks.localEntityId, allIds))) : [];
    const crm = new Map(links.map((l: any) => [l.localEntityId, l.externalEntityId]));
    return rows.map(({ r, firstName, lastName }: any) => ({ id: r.id, bookingId: r.bookingId, status: r.status, arrivalDate: String(r.arrivalDate),
      departureDate: String(r.departureDate), totalAmount: r.totalAmount, confirmationNumber: r.confirmationNumber, source: r.source, createdAt: r.createdAt,
      guestName: [firstName, lastName].filter(Boolean).join(' '), crmReservationId: (crm.get(r.id) as string | undefined) ?? null }));
  }

  /** Net saved split per stay and category (amount and cost). */
  private async splits(propertyId: string, ids: string[]) {
    const map = new Map<string, Record<string, { amount: Decimal; cost: Decimal }>>();
    if (!ids.length) return map;
    const rows = await this.db.select().from(reservationRevenueAllocations).where(and(eq(reservationRevenueAllocations.propertyId, propertyId),
      inArray(reservationRevenueAllocations.reservationId, ids), inArray(reservationRevenueAllocations.kind, ['snapshot', 'adjustment'])));
    for (const r of rows) {
      const stay = map.get(r.reservationId) ?? {};
      const c = stay[r.category] ?? { amount: new Decimal(0), cost: new Decimal(0) };
      stay[r.category] = { amount: c.amount.plus(r.amount), cost: c.cost.plus(r.cost) };
      map.set(r.reservationId, stay);
    }
    return map;
  }

  /** Share of each category in the stay price; without a saved split everything is accommodation. */
  private shares(stay: Stay | null, splits: Map<string, Record<string, { amount: Decimal; cost: Decimal }>>) {
    const split = stay ? splits.get(stay.id) : undefined;
    const total = d(stay?.totalAmount);
    if (!split || total.lessThanOrEqualTo(0)) return { accommodation: { share: new Decimal(1), costShare: new Decimal(0) } } as Record<string, { share: Decimal; costShare: Decimal }>;
    return Object.fromEntries(Object.entries(split).map(([category, v]) => [category, { share: v.amount.div(total), costShare: v.cost.div(total) }]));
  }

  /** «День в день»: money received per day, split by kind, with the stays behind each figure. */
  async dayByDay(propertyId: string, from: string, to: string) {
    const f = await this.facts(propertyId, from, to);
    const rows = f.days.map((date) => ({ date, newBookings: 0, prepayments: new Decimal(0), stayPayments: new Decimal(0), penalties: new Decimal(0), refunds: new Decimal(0) }));
    const at = new Map(rows.map((r) => [r.date, r]));
    const details: any[] = [];
    for (const s of f.newBookings) {
      const day = at.get(this.localDate(new Date(s.createdAt), f.tz));
      if (day) day.newBookings += 1;
    }
    for (const item of f.items) {
      const day = at.get(item.date);
      if (!day || (item.stay && EXCLUDED.includes(item.stay.status))) continue;
      const kind = item.refund ? 'refund' : item.stay && item.date < item.stay.arrivalDate ? 'prepayment' : 'stay_payment';
      if (kind === 'refund') day.refunds = day.refunds.plus(item.amount);
      else if (kind === 'prepayment') day.prepayments = day.prepayments.plus(item.amount);
      else day.stayPayments = day.stayPayments.plus(item.amount);
      const shares = this.shares(item.stay, f.splits);
      details.push({ date: item.date, kind, paymentId: item.id, method: item.method, amount: money(item.refund ? item.amount.negated() : item.amount),
        reservationId: item.stay?.id ?? null, crmReservationId: item.stay?.crmReservationId ?? null, confirmationNumber: item.stay?.confirmationNumber ?? null,
        guestName: item.stay?.guestName ?? null, arrivalDate: item.stay?.arrivalDate ?? null, departureDate: item.stay?.departureDate ?? null,
        stayTotal: item.stay ? money(d(item.stay.totalAmount)) : null,
        accommodation: money(item.amount.times(shares['accommodation']?.share ?? 0).times(item.refund ? -1 : 1)),
        fnb: money(item.amount.times(shares['fnb']?.share ?? 0).times(item.refund ? -1 : 1)) });
    }
    for (const p of f.penalties) {
      const day = at.get(p.date);
      if (!day) continue;
      day.penalties = day.penalties.plus(p.amount);
      details.push({ date: p.date, kind: 'penalty', amount: money(p.amount), reservationId: p.stay?.id ?? null, crmReservationId: p.stay?.crmReservationId ?? null,
        confirmationNumber: p.stay?.confirmationNumber ?? null, guestName: p.stay?.guestName ?? null, arrivalDate: p.stay?.arrivalDate ?? null,
        departureDate: p.stay?.departureDate ?? null, stayTotal: p.stay ? money(d(p.stay.totalAmount)) : null, reason: p.reason, accommodation: 0, fnb: 0 });
    }
    const out = rows.map((r) => ({ date: r.date, newBookings: r.newBookings, prepayments: money(r.prepayments), stayPayments: money(r.stayPayments),
      penalties: money(r.penalties), refunds: money(r.refunds), total: money(r.prepayments.plus(r.stayPayments).plus(r.penalties).minus(r.refunds)) }));
    const sum = (k: keyof (typeof out)[number]) => out.reduce((s, r) => s.plus(r[k] as number), new Decimal(0));
    return { propertyId, propertyName: f.property.name, timezone: f.tz, currencyCode: f.property.currencyCode ?? 'KZT', from, to,
      totals: { newBookings: out.reduce((s, r) => s + r.newBookings, 0), prepayments: money(sum('prepayments')), stayPayments: money(sum('stayPayments')),
        penalties: money(sum('penalties')), refunds: money(sum('refunds')), total: money(sum('total')) },
      rows: out, details: details.sort((a, b) => a.date.localeCompare(b.date)) };
  }

  /**
   * Accommodation paid in the period per stay (prepayments included, refunds deducted), for manager
   * commission. Penalties, cancelled and no-show stays and free stays are excluded. CRM attributes the
   * rows to managers; stays without a manager are "Оформлено через Guestra".
   */
  async commissionBase(propertyId: string, from: string, to: string) {
    const f = await this.facts(propertyId, from, to);
    const rate = Number(f.property.settings?.commissionRatePercent ?? 10);
    const perStay = new Map<string, { stay: Stay; paid: Decimal; accommodation: Decimal }>();
    for (const item of f.items) {
      if (!item.stay || EXCLUDED.includes(item.stay.status) || d(item.stay.totalAmount).lessThanOrEqualTo(0)) continue;
      const share = this.shares(item.stay, f.splits)['accommodation']?.share ?? new Decimal(0);
      const signed = item.refund ? item.amount.negated() : item.amount;
      const row = perStay.get(item.stay.id) ?? { stay: item.stay, paid: new Decimal(0), accommodation: new Decimal(0) };
      row.paid = row.paid.plus(signed); row.accommodation = row.accommodation.plus(signed.times(share));
      perStay.set(item.stay.id, row);
    }
    const rows = [...perStay.values()].map(({ stay, paid, accommodation }) => ({ reservationId: stay.id, crmReservationId: stay.crmReservationId,
      confirmationNumber: stay.confirmationNumber, guestName: stay.guestName, source: stay.source, arrivalDate: stay.arrivalDate, departureDate: stay.departureDate,
      stayTotal: money(d(stay.totalAmount)), paid: money(paid), accommodationPaid: money(accommodation),
      commission: money(accommodation.times(rate).div(100)) }));
    return { propertyId, propertyName: f.property.name, currencyCode: f.property.currencyCode ?? 'KZT', from, to, ratePercent: rate,
      totals: { accommodationPaid: money(rows.reduce((s, r) => s.plus(r.accommodationPaid), new Decimal(0))),
        commission: money(rows.reduce((s, r) => s.plus(r.commission), new Decimal(0))) }, rows };
  }

  /** Revenue by category on the payment date (stay split applied to each payment), cost of included components, penalties. */
  private async actuals(propertyId: string, from: string, to: string) {
    const f = await this.facts(propertyId, from, to);
    const revenue: Record<string, Decimal> = Object.fromEntries(REVENUE_CATEGORIES.map((c) => [c, new Decimal(0)]));
    let cost = new Decimal(0);
    for (const item of f.items) {
      if (item.stay && EXCLUDED.includes(item.stay.status)) continue;
      const signed = item.refund ? item.amount.negated() : item.amount;
      for (const [category, s] of Object.entries(this.shares(item.stay, f.splits))) {
        revenue[category] = (revenue[category] ?? new Decimal(0)).plus(signed.times(s.share));
        cost = cost.plus(signed.times(s.costShare));
      }
    }
    for (const p of f.penalties) revenue['penalty'] = revenue['penalty']!.plus(p.amount);
    return { property: f.property, revenue, cost };
  }

  private async inputs(propertyId: string, from: string, to: string) {
    const rows = await this.db.select().from(managementInputs).where(and(eq(managementInputs.propertyId, propertyId),
      eq(managementInputs.startDate, from), eq(managementInputs.endDate, to))).orderBy(desc(managementInputs.createdAt));
    const latest = (kind: string) => rows.find((r: any) => r.kind === kind) ?? null;
    const byArticle = (row: any) => {
      if (!row) return null;
      const out: Record<string, Decimal> = {};
      for (const e of row.entries ?? []) out[e.article] = (out[e.article] ?? new Decimal(0)).plus(e.amount);
      return out;
    };
    return { budget: byArticle(latest('budget')), expenses: byArticle(latest('expenses')) };
  }

  /**
   * Management report: revenue by category → cost of included components → expenses entered by hand →
   * result, with plan, variance and the previous period of the same length. Missing inputs are null
   * ("не заполнено"), never 0.
   */
  async management(propertyId: string, from: string, to: string) {
    const length = reportDates(from, to).length;
    const prevTo = new Date(Date.parse(from) - 86_400_000).toISOString().slice(0, 10);
    const prevFrom = new Date(Date.parse(prevTo) - (length - 1) * 86_400_000).toISOString().slice(0, 10);
    const [now, prev, inputs, prevInputs] = await Promise.all([this.actuals(propertyId, from, to), this.actuals(propertyId, prevFrom, prevTo),
      this.inputs(propertyId, from, to), this.inputs(propertyId, prevFrom, prevTo)]);
    const line = (key: string, label: string, fact: Decimal | null, plan: Decimal | null, previous: Decimal | null) => ({ key, label,
      fact: fact === null ? null : money(fact), plan: plan === null ? null : money(plan), previous: previous === null ? null : money(previous),
      variance: fact !== null && plan !== null ? money(fact.minus(plan)) : null });
    const labels: Record<string, string> = { accommodation: 'Проживание', fnb: 'Питание (F&B)', bath: 'Баня', spa: 'SPA', other: 'Прочее', penalty: 'Штрафы' };
    const revenue = REVENUE_CATEGORIES.map((c) => line(c, labels[c]!, now.revenue[c]!, inputs.budget?.[c] ?? null, prev.revenue[c]!));
    const revenueTotal = REVENUE_CATEGORIES.reduce((s, c) => s.plus(now.revenue[c]!), new Decimal(0));
    const prevRevenueTotal = REVENUE_CATEGORIES.reduce((s, c) => s.plus(prev.revenue[c]!), new Decimal(0));
    const planRevenue = inputs.budget ? REVENUE_CATEGORIES.reduce((s, c) => s.plus(inputs.budget![c] ?? 0), new Decimal(0)) : null;
    const expenseArticles = [...new Set([...Object.keys(inputs.expenses ?? {}), ...Object.keys(inputs.budget ?? {}).filter((a) => !(REVENUE_CATEGORIES as readonly string[]).includes(a) && a !== 'cost')])];
    const expenses = expenseArticles.map((a) => line(a, a, inputs.expenses ? inputs.expenses[a] ?? new Decimal(0) : null, inputs.budget?.[a] ?? null, prevInputs.expenses?.[a] ?? null));
    const expensesTotal = inputs.expenses ? Object.values(inputs.expenses).reduce((s, v) => s.plus(v), new Decimal(0)) : null;
    const prevExpensesTotal = prevInputs.expenses ? Object.values(prevInputs.expenses).reduce((s, v) => s.plus(v), new Decimal(0)) : null;
    const result = expensesTotal === null ? null : revenueTotal.minus(now.cost).minus(expensesTotal);
    const prevResult = prevExpensesTotal === null ? null : prevRevenueTotal.minus(prev.cost).minus(prevExpensesTotal);
    return { propertyId, propertyName: now.property.name, currencyCode: now.property.currencyCode ?? 'KZT', from, to, previous: { from: prevFrom, to: prevTo },
      basis: 'payment_date', revenue, revenueTotal: line('revenue_total', 'Итого доходы', revenueTotal, planRevenue, prevRevenueTotal),
      cost: line('cost', 'Себестоимость (включённые услуги)', now.cost, inputs.budget?.['cost'] ?? null, prev.cost),
      expenses, expensesTotal: line('expenses_total', 'Итого расходы', expensesTotal, null, prevExpensesTotal),
      result: line('result', 'Результат', result, null, prevResult), expensesFilled: inputs.expenses !== null };
  }
}
