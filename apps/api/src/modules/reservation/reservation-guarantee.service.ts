import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { auditLogs, depositLedgerEntries, folios, properties, reservations } from '@telivityhaip/database';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { DRIZZLE } from '../../database/database.module';
import { DomainEventOutboxService } from '../webhook/domain-event-outbox.service';
import { WebhookService, type WebhookPayload } from '../webhook/webhook.service';
import { ReservationService } from './reservation.service';
import { ReservationConfirmationService } from './reservation-confirmation.service';
import { FolioService } from '../folio/folio.service';
import { PaymentService } from '../payment/payment.service';

import { BOOKING_POLICY_DEFAULTS, GUARANTEE_TYPES, MANUAL_PREPAYMENT_METHODS, type GuaranteeType, type ManualPrepaymentMethod } from './guarantee';

export { GUARANTEE_TYPES, type GuaranteeType };

export interface PrepaymentInput {
  amount: string;
  method: ManualPrepaymentMethod;
  /** Bank transfer number, receipt number, terminal slip... */
  reference?: string;
  /** When the money was received; defaults to now. */
  receivedAt?: string;
}

export interface OptionChangeInput {
  /** New option deadline (ISO); null removes the deadline. */
  optionUntil?: string | null;
  /** New guarantee amount for this stay; null = manual confirmation only. */
  requiredDeposit?: string | null;
  wholeBooking?: boolean;
  reason?: string;
}

type PropertySettings = { depositPercentage?: number; optionHoldHours?: number;
  optionExpiryAction?: 'cancel' | 'notify'; autoSendConfirmation?: boolean } | null | undefined;

export interface HoldOverrides {
  /** ISO timestamp; null = no deadline, undefined = property default. */
  optionUntil?: string | null;
  /** Money string; null = manual confirmation only, undefined = property deposit percentage. */
  requiredDeposit?: string | null;
}

export interface ConfirmInput {
  guaranteeType?: GuaranteeType;
  reason?: string;
  /** Send the guest confirmation now; defaults to the property's auto-send setting. */
  notifyGuest?: boolean;
}

/** Open booking statuses that still count towards a group guarantee. */
const OPEN = ['pending', 'confirmed', 'assigned'] as const;

/**
 * Tentative (option) bookings and their confirmation.
 *
 * Staff-created stays start as `pending` with an option deadline and the guarantee amount the hotel needs.
 * They become confirmed manually (with the guarantee type) or automatically once payments and deposits on the
 * booking reach the guarantee. Confirmation emits `reservation.confirmed` and, unless switched off, sends the
 * guest the confirmation document. An option past its deadline is released or reported to staff, per property.
 * Hotel policy (hold hours, deposit share, expiry action) lives in property settings; nothing is assumed here.
 */
@Injectable()
export class ReservationGuaranteeService {
  private readonly logger = new Logger(ReservationGuaranteeService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly outbox: DomainEventOutboxService,
    private readonly webhooks: WebhookService,
    @Inject(forwardRef(() => ReservationService)) private readonly reservationService: ReservationService,
    private readonly confirmation: ReservationConfirmationService,
    @Inject(forwardRef(() => FolioService)) private readonly folios: FolioService,
    @Inject(forwardRef(() => PaymentService)) private readonly payments: PaymentService,
  ) {}

  /** Option deadline and guarantee amount for a new tentative stay. */
  static holdTerms(settings: PropertySettings, totalAmount: string, overrides: HoldOverrides = {}, now = new Date()) {
    let optionUntil: Date | null = null;
    if (overrides.optionUntil !== undefined) {
      if (overrides.optionUntil !== null) {
        optionUntil = new Date(overrides.optionUntil);
        if (Number.isNaN(optionUntil.getTime())) throw new BadRequestException('optionUntil must be a valid date-time');
        if (optionUntil.getTime() <= now.getTime()) throw new BadRequestException('Option deadline must be in the future');
      }
    } else if (settings?.optionHoldHours && settings.optionHoldHours > 0) {
      optionUntil = new Date(now.getTime() + settings.optionHoldHours * 3_600_000);
    }
    let requiredDeposit: string | null = null;
    if (overrides.requiredDeposit !== undefined) {
      if (overrides.requiredDeposit !== null) {
        const amount = new Decimal(overrides.requiredDeposit);
        if (amount.isNegative() || amount.greaterThan(totalAmount)) throw new BadRequestException('Required deposit must be between 0 and the stay total');
        requiredDeposit = amount.toFixed(2);
      }
    } else {
      const percentage = settings?.depositPercentage ?? BOOKING_POLICY_DEFAULTS.depositPercentage;
      if (percentage >= 0) requiredDeposit = new Decimal(totalAmount).times(Math.min(percentage, 100)).dividedBy(100).toDecimalPlaces(2).toFixed(2);
    }
    return { optionUntil, requiredDeposit };
  }

  async settings(propertyId: string, tx?: any): Promise<PropertySettings> {
    const [row] = await (tx ?? this.db).select({ settings: properties.settings }).from(properties).where(eq(properties.id, propertyId));
    return row?.settings ?? null;
  }

  /** Confirm one tentative stay. `auto` is used by the payment listener (guarantee = deposit). */
  async confirm(reservationId: string, propertyId: string, input: ConfirmInput = {}, actor?: AuditActor, mode: 'manual' | 'auto' = 'manual') {
    const reason = input.reason?.trim() || null;
    if (input.guaranteeType && !GUARANTEE_TYPES.includes(input.guaranteeType)) throw new BadRequestException('Unknown guarantee type');
    if (mode === 'manual' && input.guaranteeType === 'none' && !reason) {
      throw new BadRequestException('A reason is required to confirm without a guarantee');
    }
    const confirmed = await this.db.transaction(async (tx: any) => {
      const [row] = await tx.select().from(reservations)
        .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId))).for('update');
      if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
      if (row.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: `Reservation is already ${row.status}` });
      return this.confirmLocked(tx, row, input.guaranteeType ?? null, reason, actor, mode);
    });
    await this.outbox.deliver(propertyId, `reservation:${reservationId}:confirmed`);
    const notification = await this.notifyAfterConfirm(confirmed, input.notifyGuest, actor);
    return { ...confirmed, notification };
  }

  /** Confirm every tentative stay of the booking the reservation belongs to. */
  async confirmBookingOf(reservationId: string, propertyId: string, input: ConfirmInput = {}, actor?: AuditActor) {
    const [row] = await this.db.select({ bookingId: reservations.bookingId }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    return this.confirmBooking(row.bookingId, propertyId, input, actor);
  }

  /** Confirm every tentative stay of a booking (group or multi-room) and send one confirmation. */
  async confirmBooking(bookingId: string, propertyId: string, input: ConfirmInput = {}, actor?: AuditActor) {
    const reason = input.reason?.trim() || null;
    if (input.guaranteeType === 'none' && !reason) throw new BadRequestException('A reason is required to confirm without a guarantee');
    const rows = await this.db.transaction(async (tx: any) => {
      const pending = await tx.select().from(reservations).where(and(eq(reservations.bookingId, bookingId),
        eq(reservations.propertyId, propertyId), eq(reservations.status, 'pending'))).orderBy(reservations.id).for('update');
      if (!pending.length) throw new ConflictException({ code: 'NOTHING_TO_CONFIRM', message: 'The booking has no unconfirmed rooms' });
      const done = [];
      for (const row of pending) done.push(await this.confirmLocked(tx, row, input.guaranteeType ?? null, reason, actor, 'manual'));
      return done;
    });
    for (const row of rows) await this.outbox.deliver(propertyId, `reservation:${row.id}:confirmed`);
    const notification = await this.notifyAfterConfirm(rows[0], input.notifyGuest, actor);
    return { confirmed: rows.length, reservations: rows, notification };
  }

  /** Confirms a row already locked by the caller's transaction; the caller delivers the outbox event. */
  async confirmLocked(tx: any, row: any, guaranteeType: GuaranteeType | null, reason: string | null,
    actor: AuditActor | undefined, mode: 'manual' | 'auto') {
    // A room held by the option stays with the stay: confirmation lands directly in `assigned`.
    const status = row.roomId ? 'assigned' : 'confirmed';
    const now = new Date();
    const [updated] = await tx.update(reservations)
      .set({ status, guaranteeType, confirmedAt: now, confirmedBy: actor?.userId ?? null, updatedAt: now })
      .where(and(eq(reservations.id, row.id), eq(reservations.propertyId, row.propertyId), eq(reservations.status, 'pending')))
      .returning();
    if (!updated) throw new ConflictException('Reservation changed while confirming');
    await tx.insert(auditLogs).values({ propertyId: row.propertyId, entityType: 'reservation', entityId: row.id, action: 'confirm',
      ...actorFields(actor), description: mode === 'auto' ? 'Бронь подтверждена автоматически: гарантия получена' : 'Бронь подтверждена',
      previousValue: { status: row.status, optionUntil: row.optionUntil ?? null },
      newValue: { status, guaranteeType, reason, mode } });
    await this.outbox.persist(tx, { event: 'reservation.confirmed', entityType: 'reservation', entityId: row.id,
      propertyId: row.propertyId, timestamp: now.toISOString(),
      data: { reservationId: row.id, bookingId: row.bookingId, status, guaranteeType, mode } }, `reservation:${row.id}:confirmed`);
    return updated;
  }

  private async notifyAfterConfirm(row: any, notifyGuest: boolean | undefined, actor?: AuditActor) {
    const settings = await this.settings(row.propertyId);
    const shouldSend = notifyGuest ?? settings?.autoSendConfirmation !== false;
    if (!shouldSend) return { attempted: false as const };
    try {
      const result = await this.confirmation.send(row.id, row.propertyId, { kind: 'confirmation' }, actor);
      return { attempted: true as const, ...result };
    } catch (error) {
      // Confirmation is already committed; a missing email must not undo it. Staff sees this in the response.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Confirmation for ${row.id} not sent: ${message}`);
      return { attempted: true as const, sent: false, error: message };
    }
  }

  /** Money received for a booking: folio payments (net of refunds) plus deposits not linked to a payment. */
  async paidForBooking(bookingId: string, propertyId: string, tx?: any) {
    const db = tx ?? this.db;
    const stays = await db.select({ id: reservations.id }).from(reservations)
      .where(and(eq(reservations.bookingId, bookingId), eq(reservations.propertyId, propertyId)));
    const ids = stays.map((s: any) => s.id);
    if (!ids.length) return new Decimal(0);
    // Room folios plus a booking-level (master) folio, where group payments are often posted.
    const folioRows = await db.select({ totalPayments: folios.totalPayments }).from(folios)
      .where(and(eq(folios.propertyId, propertyId), or(inArray(folios.reservationId, ids), eq(folios.bookingId, bookingId))));
    const depositRows = await db.select({ amount: depositLedgerEntries.amount }).from(depositLedgerEntries)
      .where(and(eq(depositLedgerEntries.propertyId, propertyId), inArray(depositLedgerEntries.reservationId, ids),
        isNull(depositLedgerEntries.paymentId), inArray(depositLedgerEntries.status, ['held', 'applied'] as any)));
    return [...folioRows.map((f: any) => f.totalPayments), ...depositRows.map((d: any) => d.amount)]
      .reduce((sum: Decimal, value: string | null) => sum.plus(value ?? 0), new Decimal(0));
  }

  /**
   * Confirms the booking's tentative stays when the money received covers their guarantee.
   * Only stays with a guarantee amount qualify; the others wait for a manual decision.
   */
  async confirmIfGuaranteed(reservationId: string, propertyId: string) {
    const [row] = await this.db.select({ bookingId: reservations.bookingId }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) return { confirmed: 0 };
    const stays = await this.db.select().from(reservations).where(and(eq(reservations.bookingId, row.bookingId),
      eq(reservations.propertyId, propertyId), inArray(reservations.status, [...OPEN] as any)));
    const waiting = stays.filter((s: any) => s.status === 'pending' && s.requiredDeposit != null);
    if (!waiting.length) return { confirmed: 0 };
    const required = waiting.reduce((sum: Decimal, s: any) => sum.plus(s.requiredDeposit), new Decimal(0));
    const paid = await this.paidForBooking(row.bookingId, propertyId);
    if (paid.lessThanOrEqualTo(0) || paid.lessThan(required)) return { confirmed: 0, paid: paid.toFixed(2), required: required.toFixed(2) };
    let confirmed = 0;
    for (const stay of waiting) {
      try {
        // One guest confirmation per booking: it lists every room.
        await this.confirm(stay.id, propertyId, { guaranteeType: 'deposit', notifyGuest: confirmed === 0 ? undefined : false }, undefined, 'auto');
        confirmed += 1;
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error; // confirmed concurrently
      }
    }
    return { confirmed, paid: paid.toFixed(2), required: required.toFixed(2) };
  }

  @OnEvent('payment.received')
  async onPayment(payload: WebhookPayload) {
    const folioId = payload?.data?.['folioId'];
    if (!payload?.propertyId || typeof folioId !== 'string') return;
    await this.safely(async () => {
      const [folio] = await this.db.select({ reservationId: folios.reservationId, bookingId: folios.bookingId }).from(folios)
        .where(and(eq(folios.id, folioId), eq(folios.propertyId, payload.propertyId!)));
      let reservationId = folio?.reservationId ?? null;
      if (!reservationId && folio?.bookingId) {
        const [stay] = await this.db.select({ id: reservations.id }).from(reservations)
          .where(and(eq(reservations.bookingId, folio.bookingId), eq(reservations.propertyId, payload.propertyId!))).limit(1);
        reservationId = stay?.id ?? null;
      }
      if (reservationId) await this.confirmIfGuaranteed(reservationId, payload.propertyId!);
    });
  }

  @OnEvent('deposit.received')
  async onDeposit(payload: WebhookPayload) {
    if (!payload?.propertyId || !payload.entityId) return;
    await this.safely(async () => {
      const [deposit] = await this.db.select({ reservationId: depositLedgerEntries.reservationId }).from(depositLedgerEntries)
        .where(and(eq(depositLedgerEntries.id, payload.entityId), eq(depositLedgerEntries.propertyId, payload.propertyId!)));
      if (deposit?.reservationId) await this.confirmIfGuaranteed(deposit.reservationId, payload.propertyId!);
    });
  }

  private async safely(work: () => Promise<void>) {
    try { await work(); } catch (error) {
      // Listeners must never break the payment that triggered them; staff can still confirm manually.
      this.logger.error(`Automatic confirmation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handles tentative stays whose option deadline passed: releases them (`cancel`) or reminds staff (`notify`,
   * the default when the hotel has not chosen). Idempotent; meant for an external scheduler and night audit.
   */
  async sweepExpiredOptions(propertyId: string, now = new Date()) {
    const settings = await this.settings(propertyId);
    const action = (settings?.optionExpiryAction ?? BOOKING_POLICY_DEFAULTS.optionExpiryAction) === 'cancel' ? 'cancel' : 'notify';
    const expired = await this.db.select().from(reservations).where(and(eq(reservations.propertyId, propertyId),
      eq(reservations.status, 'pending'), isNotNull(reservations.optionUntil), lt(reservations.optionUntil, now)));
    const result = { action, expired: expired.length, cancelled: 0, notified: 0, failed: 0 };
    for (const row of expired) {
      try {
        if (action === 'cancel') {
          await this.reservationService.cancel(row.id, propertyId, { cancellationReason: 'Истёк срок опции: гарантия не получена' });
          result.cancelled += 1;
        } else {
          await this.webhooks.emit('reservation.option_expired', 'reservation', row.id,
            { reservationId: row.id, bookingId: row.bookingId, optionUntil: row.optionUntil, requiredDeposit: row.requiredDeposit }, propertyId);
          result.notified += 1;
        }
      } catch (error) {
        result.failed += 1;
        this.logger.warn(`Option sweep for ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }

  /**
   * Front desk records a prepayment received outside a gateway (cash, bank transfer, offline terminal).
   * It is a real captured payment on the stay's guest folio, so it appears in the ledger and the folio
   * balance; when the money covers the booking's guarantee, the tentative rooms are confirmed at once.
   */
  async recordPrepayment(reservationId: string, propertyId: string, input: PrepaymentInput, actor?: AuditActor) {
    if (!MANUAL_PREPAYMENT_METHODS.includes(input.method)) throw new BadRequestException('Unsupported prepayment method');
    let amount: Decimal;
    try { amount = new Decimal(input.amount); } catch { throw new BadRequestException('Prepayment amount must be positive'); }
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) throw new BadRequestException('Prepayment amount must be positive');
    const [row] = await this.db.select().from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    if (!(OPEN as readonly string[]).includes(row.status)) {
      throw new ConflictException({ code: 'NOT_OPEN', message: `A prepayment cannot be recorded on a ${row.status} reservation` });
    }
    const folio = await this.folios.createAutoFolio({ id: row.id, propertyId, bookingId: row.bookingId, guestId: row.guestId, currencyCode: row.currencyCode });
    const reference = input.reference?.trim() || null;
    const payment = await this.payments.recordPayment({
      folioId: folio.id, propertyId, method: input.method, amount: amount.toFixed(2), currencyCode: row.currencyCode,
      notes: ['Предоплата (отмечена вручную)', reference].filter(Boolean).join(': '),
      ...(input.receivedAt ? { processedAt: input.receivedAt } : {}),
    });
    await this.db.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: row.id, action: 'prepayment_recorded',
      ...actorFields(actor), description: `Предоплата принята вручную: ${amount.toFixed(2)} ${row.currencyCode}`,
      newValue: { paymentId: payment.id, folioId: folio.id, amount: amount.toFixed(2), method: input.method, reference } });
    // The payment listener does the same; calling it here returns the outcome to the desk in this response.
    const outcome: { confirmed: number; required?: string } = row.status === 'pending'
      ? await this.confirmIfGuaranteed(row.id, propertyId) : { confirmed: 0 };
    const paid = await this.paidForBooking(row.bookingId, propertyId);
    const [after] = await this.db.select({ status: reservations.status }).from(reservations)
      .where(and(eq(reservations.id, row.id), eq(reservations.propertyId, propertyId)));
    const status = after?.status ?? row.status;
    return { paymentId: payment.id, folioId: folio.id, amount: amount.toFixed(2), paid: paid.toFixed(2),
      confirmed: row.status === 'pending' && status !== 'pending', status, required: outcome.required ?? null };
  }

  /** Tentative stays the change applies to: the one stay, or every tentative stay of its booking. */
  private async pendingScope(tx: any, reservationId: string, propertyId: string, wholeBooking: boolean, lock = true) {
    const [row] = await tx.select().from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    const query = tx.select().from(reservations).where(wholeBooking
      ? and(eq(reservations.bookingId, row.bookingId), eq(reservations.propertyId, propertyId), eq(reservations.status, 'pending'))
      : and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId), eq(reservations.status, 'pending')))
      .orderBy(reservations.id);
    const rows = lock ? await query.for('update') : await query;
    if (!rows.length) throw new ConflictException({ code: 'NOT_PENDING', message: 'There is no unconfirmed stay to change' });
    return rows;
  }

  /** Extends (or removes) the option deadline and/or changes the guarantee amount of tentative stays. */
  async changeOption(reservationId: string, propertyId: string, input: OptionChangeInput, actor?: AuditActor, now = new Date()) {
    if (input.optionUntil === undefined && input.requiredDeposit === undefined) throw new BadRequestException('Nothing to change');
    let optionUntil: Date | null | undefined;
    if (input.optionUntil !== undefined) {
      optionUntil = input.optionUntil === null ? null : new Date(input.optionUntil);
      if (optionUntil && (Number.isNaN(optionUntil.getTime()) || optionUntil.getTime() <= now.getTime())) {
        throw new BadRequestException('Option deadline must be a future date-time');
      }
    }
    if (input.requiredDeposit !== undefined && input.wholeBooking) {
      throw new BadRequestException('Change the guarantee amount per room');
    }
    return this.db.transaction(async (tx: any) => {
      const rows = await this.pendingScope(tx, reservationId, propertyId, !!input.wholeBooking);
      const updated = [];
      for (const row of rows) {
        const set: Record<string, unknown> = { updatedAt: now };
        if (optionUntil !== undefined) set['optionUntil'] = optionUntil;
        if (input.requiredDeposit !== undefined) {
          if (input.requiredDeposit === null) set['requiredDeposit'] = null;
          else {
            const amount = new Decimal(input.requiredDeposit);
            if (amount.isNegative() || amount.greaterThan(row.totalAmount ?? 0)) throw new BadRequestException('Required deposit must be between 0 and the stay total');
            set['requiredDeposit'] = amount.toFixed(2);
          }
        }
        const [after] = await tx.update(reservations).set(set)
          .where(and(eq(reservations.id, row.id), eq(reservations.propertyId, propertyId), eq(reservations.status, 'pending'))).returning();
        await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: row.id, action: 'option_changed', ...actorFields(actor),
          description: optionUntil !== undefined ? (optionUntil ? 'Срок опции изменён' : 'Срок опции снят') : 'Сумма гарантии изменена',
          previousValue: { optionUntil: row.optionUntil ?? null, requiredDeposit: row.requiredDeposit ?? null },
          newValue: { optionUntil: after.optionUntil ?? null, requiredDeposit: after.requiredDeposit ?? null, reason: input.reason?.trim() || null } });
        updated.push(after);
      }
      return { updated: updated.length, reservations: updated };
    });
  }

  /** Staff releases tentative stays by hand (nothing is released automatically by default): cancels them with the reason. */
  async releaseOption(reservationId: string, propertyId: string, input: { reason?: string; wholeBooking?: boolean }, actor?: AuditActor) {
    const rows = await this.pendingScope(this.db, reservationId, propertyId, !!input.wholeBooking, false);
    const reason = input.reason?.trim() || 'Опция снята вручную: гарантия не получена';
    let released = 0;
    for (const row of rows) {
      await this.reservationService.cancel(row.id, propertyId, { cancellationReason: reason });
      await this.db.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: row.id, action: 'option_released',
        ...actorFields(actor), description: reason, previousValue: { status: 'pending', optionUntil: row.optionUntil ?? null }, newValue: { status: 'cancelled' } });
      released += 1;
    }
    return { released };
  }

  /** Reminds the guest of an unconfirmed booking: resends the proposal with the deadline and the amount still due. */
  async remindGuest(reservationId: string, propertyId: string, input: { channel?: 'email' | 'sms'; to?: string }, actor?: AuditActor) {
    const [row] = await this.db.select({ status: reservations.status }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!row) throw new NotFoundException(`Reservation ${reservationId} not found`);
    if (row.status !== 'pending') throw new ConflictException({ code: 'NOT_PENDING', message: 'Only an unconfirmed booking can be reminded' });
    return this.confirmation.send(reservationId, propertyId, { kind: 'proposal', channel: input.channel, to: input.to, reminder: true }, actor);
  }

  /** Tentative stays for the work list: overdue first, then by deadline. */
  async listPending(propertyId: string) {
    const rows = await this.db.select({ id: reservations.id, bookingId: reservations.bookingId, arrivalDate: reservations.arrivalDate,
      departureDate: reservations.departureDate, optionUntil: reservations.optionUntil, requiredDeposit: reservations.requiredDeposit,
      totalAmount: reservations.totalAmount, currencyCode: reservations.currencyCode, guestId: reservations.guestId,
      proposalSentAt: reservations.proposalSentAt })
      .from(reservations).where(and(eq(reservations.propertyId, propertyId), eq(reservations.status, 'pending')));
    const now = Date.now();
    return rows.map((r: any) => ({ ...r, overdue: r.optionUntil ? new Date(r.optionUntil).getTime() < now : false }))
      .sort((a: any, b: any) => (a.optionUntil ? new Date(a.optionUntil).getTime() : Infinity) - (b.optionUntil ? new Date(b.optionUntil).getTime() : Infinity));
  }
}
