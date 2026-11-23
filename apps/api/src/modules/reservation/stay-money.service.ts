import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, folios, payments, properties, reservationRevenueAllocations, reservations } from '@telivityhaip/database';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import { PaymentService } from '../payment/payment.service';
import { WebhookService } from '../webhook/webhook.service';
import { ReservationService } from './reservation.service';

/** Statuses whose prepayment counts as received money; refunds and failed payments do not. */
const RECEIVED = ['captured', 'settled', 'partially_refunded', 'refunded'];
const DEFAULT_LATE_HOURS = 24;

/** UTC instant of a wall-clock time in an IANA zone. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time.length === 5 ? time : '15:00'}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(guess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

export interface ReasonInput { reason: string }
export interface RetainInput extends ReasonInput { amount?: string }
export interface RefundInput extends ReasonInput { paymentId: string; amount?: string }

/**
 * Manual money decisions on a stay: cancel or no-show with a reason, retain the prepayment as a penalty,
 * refund a payment. A person decides each one; the system only suggests (late cancellation suggests
 * retaining). The original payment is never deleted: a penalty is a fee charge, a refund its own row.
 */
@Injectable()
export class StayMoneyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    @Inject(forwardRef(() => ReservationService)) private readonly reservations: ReservationService,
    @Inject(forwardRef(() => FolioService)) private readonly folios: FolioService,
    @Inject(forwardRef(() => PaymentService)) private readonly payments: PaymentService,
    private readonly webhooks: WebhookService,
  ) {}

  private reason(input: Partial<ReasonInput> | undefined) {
    const reason = input?.reason?.trim();
    if (!reason) throw new BadRequestException('A reason is required');
    return reason.slice(0, 500);
  }

  private async stay(reservationId: string, propertyId: string) {
    const [row] = await this.db.select().from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    return row;
  }

  /** Folios of the stay: its own and its booking's shared folio. */
  private async folioIds(row: any) {
    const rows = await this.db.select({ id: folios.id }).from(folios).where(and(eq(folios.propertyId, row.propertyId),
      or(eq(folios.reservationId, row.id), and(isNull(folios.reservationId), eq(folios.bookingId, row.bookingId)))));
    return rows.map((f: any) => f.id as string);
  }

  /** Money received for the stay, refunds, and penalties already retained. */
  async money(reservationId: string, propertyId: string) {
    const row = await this.stay(reservationId, propertyId);
    const ids = await this.folioIds(row);
    const rows = ids.length ? await this.db.select().from(payments).where(and(eq(payments.propertyId, propertyId), inArray(payments.folioId, ids))) : [];
    const received = rows.filter((p: any) => !p.originalPaymentId && RECEIVED.includes(p.status));
    const refunds = rows.filter((p: any) => p.originalPaymentId);
    const penalties = await this.db.select({ amount: reservationRevenueAllocations.amount }).from(reservationRevenueAllocations)
      .where(and(eq(reservationRevenueAllocations.propertyId, propertyId), eq(reservationRevenueAllocations.reservationId, reservationId),
        eq(reservationRevenueAllocations.category, 'penalty')));
    const sum = (list: { amount: string }[]) => list.reduce((s, p) => s.plus(new Decimal(p.amount).abs()), new Decimal(0));
    const paid = sum(received), refunded = sum(refunds), retained = sum(penalties);
    return { row, folioIds: ids, received, paid: paid.toFixed(2), refunded: refunded.toFixed(2), retained: retained.toFixed(2),
      available: Decimal.max(0, paid.minus(refunded).minus(retained)).toFixed(2) };
  }

  /** What the system suggests for a cancellation now: retain the prepayment when it is later than the property's limit. */
  async cancellationAdvice(reservationId: string, propertyId: string, now = new Date()) {
    const money = await this.money(reservationId, propertyId);
    const [property] = await this.db.select({ timezone: properties.timezone, checkInTime: properties.checkInTime, settings: properties.settings })
      .from(properties).where(eq(properties.id, propertyId));
    const limitHours = property?.settings?.lateCancellationHours ?? DEFAULT_LATE_HOURS;
    const arrival = zonedTimeToUtc(String(money.row.arrivalDate), property?.checkInTime ?? '15:00', property?.timezone ?? 'UTC');
    const hoursBefore = (arrival.getTime() - now.getTime()) / 3_600_000;
    const late = hoursBefore < limitHours;
    return { reservationId, status: money.row.status, arrivalAt: arrival.toISOString(), hoursBeforeArrival: Math.round(hoursBefore * 10) / 10,
      lateCancellationHours: limitHours, late, paid: money.paid, refunded: money.refunded, retained: money.retained, available: money.available,
      suggestion: late && new Decimal(money.available).greaterThan(0) ? 'retain_prepayment' as const : new Decimal(money.available).greaterThan(0) ? 'refund_or_keep' as const : 'nothing_to_settle' as const };
  }

  private async audit(row: any, action: string, description: string, actor: AuditActor | undefined, value: Record<string, unknown>) {
    await this.db.insert(auditLogs).values({ propertyId: row.propertyId, entityType: 'reservation', entityId: row.id, action, ...actorFields(actor),
      description, newValue: value });
  }

  async cancel(reservationId: string, propertyId: string, input: ReasonInput, actor?: AuditActor) {
    const reason = this.reason(input);
    const row = await this.stay(reservationId, propertyId);
    const advice = await this.cancellationAdvice(reservationId, propertyId);
    const updated = await this.reservations.cancel(reservationId, propertyId, { cancellationReason: reason });
    await this.audit(row, 'cancelled_manually', `Отмена: ${reason}`, actor, { reason, previousStatus: row.status, suggestion: advice.suggestion });
    return { reservation: updated, advice };
  }

  async noShow(reservationId: string, propertyId: string, input: ReasonInput, actor?: AuditActor) {
    const reason = this.reason(input);
    const row = await this.stay(reservationId, propertyId);
    const updated = await this.reservations.markNoShow(reservationId, propertyId);
    await this.audit(row, 'no_show_marked', `Незаезд: ${reason}`, actor, { reason, previousStatus: row.status });
    return { reservation: updated, advice: await this.cancellationAdvice(reservationId, propertyId) };
  }

  /** Retains received money as a penalty: a fee charge on the folio plus a penalty row for reports. */
  async retainPrepayment(reservationId: string, propertyId: string, input: RetainInput, actor?: AuditActor, now = new Date()) {
    const reason = this.reason(input);
    const money = await this.money(reservationId, propertyId);
    if (!['cancelled', 'no_show'].includes(money.row.status)) {
      throw new ConflictException({ code: 'NOT_CANCELLED', message: 'Cancel the booking or mark a no-show before retaining the prepayment' });
    }
    const amount = new Decimal(input.amount ?? money.available);
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) throw new BadRequestException('Nothing to retain');
    if (amount.greaterThan(money.available)) throw new BadRequestException(`At most ${money.available} can be retained`);
    const folioId = money.folioIds[0];
    if (!folioId) throw new ConflictException({ code: 'NO_FOLIO', message: 'The booking has no folio' });
    const charge = await this.folios.postCharge(folioId, { propertyId, type: 'fee', description: `Штраф: удержание предоплаты (${reason})`.slice(0, 255),
      amount: amount.toFixed(2), currencyCode: money.row.currencyCode, serviceDate: now.toISOString().slice(0, 10) } as any);
    await this.db.insert(reservationRevenueAllocations).values({ propertyId, reservationId, kind: 'penalty', category: 'penalty',
      description: 'Удержанная предоплата', amount: amount.toFixed(2), currencyCode: money.row.currencyCode, reason,
      actorId: actor?.userId ?? null, sourceId: charge?.id ?? null, occurredAt: now });
    await this.audit(money.row, 'prepayment_retained', `Предоплата удержана как штраф: ${amount.toFixed(2)} ${money.row.currencyCode}`, actor,
      { amount: amount.toFixed(2), reason, chargeId: charge?.id ?? null });
    await this.webhooks.emit('reservation.penalty_retained', 'reservation', reservationId, { reservationId, amount: amount.toFixed(2), reason }, propertyId);
    return { retained: amount.toFixed(2), chargeId: charge?.id ?? null, money: await this.money(reservationId, propertyId) };
  }

  /** Refunds a payment of this stay: a separate refund row dated today; the original payment stays. */
  async refund(reservationId: string, propertyId: string, input: RefundInput, actor?: AuditActor, now = new Date()) {
    const reason = this.reason(input);
    const money = await this.money(reservationId, propertyId);
    const original = money.received.find((p: any) => p.id === input.paymentId);
    if (!original) throw new NotFoundException('Payment not found on this booking');
    const amount = new Decimal(input.amount ?? original.amount);
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) throw new BadRequestException('Refund amount must be positive');
    if (amount.greaterThan(money.available)) throw new BadRequestException(`At most ${money.available} can be refunded`);
    const refund: any = await this.payments.refundPayment(original.id, propertyId, amount.toFixed(2),
      { idempotencyKey: `stay-refund:${reservationId}:${original.id}:${amount.toFixed(2)}:${now.toISOString().slice(0, 16)}` });
    const refundId = refund?.id ?? refund?.refund?.id ?? null;
    await this.db.insert(reservationRevenueAllocations).values({ propertyId, reservationId, kind: 'refund', category: 'refund',
      description: 'Возврат', amount: amount.negated().toFixed(2), currencyCode: money.row.currencyCode, reason,
      actorId: actor?.userId ?? null, sourceId: refundId, occurredAt: now });
    await this.audit(money.row, 'refund_recorded', `Возврат: ${amount.toFixed(2)} ${money.row.currencyCode}`, actor,
      { amount: amount.toFixed(2), reason, paymentId: original.id, refundId });
    return { refunded: amount.toFixed(2), refundId, money: await this.money(reservationId, propertyId) };
  }
}
