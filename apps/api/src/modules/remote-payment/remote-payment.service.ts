import {
  BadGatewayException, BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger,
  NotFoundException, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  auditLogs, bookings, integrationLinks, payments, properties, remotePaymentRequests, reservations,
} from '@telivityhaip/database';
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { createHmac } from 'node:crypto';
import { actorFields, type AuditActor } from '../../common/audit/audit-actor';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import {
  maskQutPayPhone, normalizeQutPayPhone, QutPayClient, QutPayError, verifyQutPayWebhook,
  type QutPayInvoice, type QutPayMode,
} from '../payment/gateways/qut-pay';
import { OPTION_EXPIRED_REASON } from '../reservation/guarantee';
import { ReservationGuaranteeService } from '../reservation/reservation-guarantee.service';
import { WebhookService, type WebhookPayload } from '../webhook/webhook.service';

type Request = typeof remotePaymentRequests.$inferSelect;
type Status = 'creating' | 'unknown' | 'sent' | 'paid' | 'failed' | 'expired' | 'cancelled';
const OPEN: Status[] = ['creating', 'unknown', 'sent'];
const PROVIDER = 'qutpay';
/** Reasons a paid request needs a person: the money is recorded, the decision is staff's. */
export type ReviewReason = 'paid_after_option_expiry' | 'reservation_not_open' | 'reservation_already_confirmed'
  | 'folio_not_open' | 'invoice_mismatch' | 'provider_refund';

export interface CreateRemotePaymentInput {
  propertyId: string;
  reservationId: string;
  phone: string;
  source: 'agent' | 'staff';
  requestedBy?: string;
  conversationId?: string;
  /** The amount the guest was told ("12500.00"); a different amount due now is a conflict, not a surprise invoice. */
  expectedAmount?: string;
}

/**
 * Remote prepayment by an invoice in the guest's Kaspi app (provider: QUT Pay).
 *
 * Guestra issues the invoice and learns the outcome; the money goes straight to the hotel. A paid
 * invoice becomes an ordinary captured payment on the stay's folio and emits `payment.received`,
 * so the existing guarantee listener confirms the option, or opens the "paid after option expiry"
 * task when the option was already released. Nothing here confirms or restores a booking itself.
 *
 * The outcome arrives by signed webhook, and a scheduler re-reads open invoices in case a webhook
 * is lost. An invoice is cancelled at the provider as soon as its stay stops waiting for the money.
 *
 * Enabled per property by operations (`QUTPAY_PROPERTY_IDS`); the key decides test or live mode.
 */
@Injectable()
export class RemotePaymentService {
  private readonly logger = new Logger(RemotePaymentService.name);
  private client?: QutPayClient;

  constructor(
    @Inject(DRIZZLE) private readonly db: any,
    private readonly config: ConfigService,
    private readonly folios: FolioService,
    private readonly guarantee: ReservationGuaranteeService,
    private readonly webhooks: WebhookService,
  ) {}

  // ---------------------------------------------------------------- configuration

  private provider(): QutPayClient | null {
    const key = this.config.get<string>('QUTPAY_API_KEY', '') ?? '';
    if (!key) return null;
    if (!this.client) {
      try { this.client = new QutPayClient(key); } catch { return null; }
    }
    return this.client;
  }

  private secret() {
    const secret = this.config.get<string>('QUTPAY_WEBHOOK_SECRET', '') ?? '';
    return secret.length >= 16 ? secret : null;
  }

  private enabledProperties() {
    return new Set(String(this.config.get<string>('QUTPAY_PROPERTY_IDS', '') ?? '')
      .split(',').map(id => id.trim().toLowerCase()).filter(Boolean));
  }

  /** Remote prepayment is offered for this property: provider key, webhook secret and the property switched on. */
  isEnabled(propertyId: string) {
    return !!this.provider() && !!this.secret() && this.enabledProperties().has(propertyId.toLowerCase());
  }

  mode(): QutPayMode | null { return this.provider()?.mode ?? null; }

  private require(propertyId: string) {
    const provider = this.provider();
    if (!this.isEnabled(propertyId) || !provider) throw new NotFoundException({ code: 'REMOTE_PAYMENT_DISABLED', message: 'Remote prepayment is not enabled for this property' });
    return provider;
  }

  private phoneDigest(phone: string) {
    return createHmac('sha256', this.secret() ?? 'remote-payment').update(phone).digest('hex');
  }

  // ---------------------------------------------------------------- reading

  view(row: Request, optionUntil?: Date | null) {
    return {
      requestId: row.id, reservationId: row.reservationId, provider: row.provider, mode: row.mode,
      status: row.status, amount: row.amount, currencyCode: row.currencyCode, phone: row.phoneMasked,
      payUrl: OPEN.includes(row.status as Status) ? row.payUrl : null,
      providerExpiresAt: row.providerExpiresAt?.toISOString() ?? null,
      optionUntil: optionUntil === undefined ? undefined : optionUntil?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null, paymentId: row.paymentId, refundedAmount: row.refundedAmount,
      errorCode: row.errorCode, reviewReason: row.reviewReason, source: row.source,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listForReservation(propertyId: string, reservationId: string) {
    const [stay] = await this.db.select({ id: reservations.id, optionUntil: reservations.optionUntil }).from(reservations)
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, propertyId)));
    if (!stay) throw new NotFoundException(`Reservation ${reservationId} not found`);
    const rows: Request[] = await this.db.select().from(remotePaymentRequests)
      .where(and(eq(remotePaymentRequests.propertyId, propertyId), eq(remotePaymentRequests.reservationId, reservationId)))
      .orderBy(desc(remotePaymentRequests.createdAt));
    return { enabled: this.isEnabled(propertyId), mode: this.isEnabled(propertyId) ? this.mode() : null,
      requests: rows.map(row => this.view(row, stay.optionUntil)) };
  }

  /** CRM read: the stay must belong to the CRM customer (customer -> guest link at this property). */
  async listForCustomer(propertyId: string, reservationId: string, customerId: string) {
    await this.customerStay(this.db, propertyId, reservationId, customerId);
    return this.listForReservation(propertyId, reservationId);
  }

  private async customerStay(db: any, propertyId: string, reservationId: string, customerId: string) {
    const [link] = await db.select({ guestId: integrationLinks.localEntityId }).from(integrationLinks).where(and(
      eq(integrationLinks.propertyId, propertyId), eq(integrationLinks.sourceSystem, 'guestra_crm'),
      eq(integrationLinks.externalEntityType, 'customer'), eq(integrationLinks.externalEntityId, customerId),
      eq(integrationLinks.localEntityType, 'guest')));
    if (!link) throw new NotFoundException({ code: 'VERIFIED_IDENTITY_REQUIRED', message: 'Customer is not linked to a guest at this property' });
    const [stay] = await db.select({ id: reservations.id }).from(reservations).where(and(eq(reservations.id, reservationId),
      eq(reservations.propertyId, propertyId), eq(reservations.guestId, link.guestId)));
    if (!stay) throw new NotFoundException({ code: 'RESERVATION_NOT_FOUND', message: `Reservation ${reservationId} not found` });
  }

  // ---------------------------------------------------------------- creating

  /** CRM path: same as staff, after checking the stay belongs to the CRM customer. */
  async createForCustomer(customerId: string, input: CreateRemotePaymentInput) {
    await this.customerStay(this.db, input.propertyId, input.reservationId, customerId);
    return this.create(input);
  }

  /**
   * Sends (or returns the already open) Kaspi invoice for the prepayment still due on a tentative stay.
   * The amount is the booking's guarantee minus money already received, rounded up to whole tenge
   * because Kaspi phone invoices accept whole tenge only.
   */
  async create(input: CreateRemotePaymentInput, attempt = 0): Promise<ReturnType<RemotePaymentService['view']>> {
    const provider = this.require(input.propertyId);
    let phone: string;
    try { phone = normalizeQutPayPhone(input.phone); } catch {
      throw new UnprocessableEntityException({ code: 'REMOTE_PAYMENT_INVALID_PHONE', message: 'Phone must be a Kazakhstan mobile number +7XXXXXXXXXX' });
    }
    const digest = this.phoneDigest(phone);
    const decision = await this.db.transaction(async (tx: any) => {
      const [stay] = await tx.select().from(reservations)
        .where(and(eq(reservations.id, input.reservationId), eq(reservations.propertyId, input.propertyId))).for('update');
      if (!stay) throw new NotFoundException(`Reservation ${input.reservationId} not found`);
      if (stay.status !== 'pending' || stay.requiredDeposit == null) {
        throw new ConflictException({ code: 'REMOTE_PAYMENT_NOT_AWAITING_PREPAYMENT', message: 'The stay is not waiting for a prepayment' });
      }
      if (stay.currencyCode !== 'KZT') throw new ConflictException({ code: 'REMOTE_PAYMENT_CURRENCY_UNSUPPORTED', message: 'Kaspi invoices are in KZT only' });
      if (stay.optionUntil && stay.optionUntil.getTime() <= Date.now()) {
        throw new ConflictException({ code: 'REMOTE_PAYMENT_OPTION_EXPIRED', message: 'The option deadline has passed' });
      }
      const amount = await this.amountDue(tx, stay);
      if (amount.lte(0)) throw new ConflictException({ code: 'REMOTE_PAYMENT_ALREADY_COVERED', message: 'The prepayment is already covered' });
      if (input.expectedAmount !== undefined && !amount.eq(input.expectedAmount)) {
        throw new ConflictException({ code: 'REMOTE_PAYMENT_AMOUNT_CHANGED', message: `The amount due is now ${amount.toFixed(2)}`, amount: amount.toFixed(2) });
      }
      const [open]: Request[] = await tx.select().from(remotePaymentRequests).where(and(
        eq(remotePaymentRequests.propertyId, input.propertyId), eq(remotePaymentRequests.reservationId, stay.id),
        inArray(remotePaymentRequests.status, OPEN))).for('update');
      if (open) {
        const same = new Decimal(open.amount).eq(amount) && open.phoneDigest === digest;
        if (same && open.status === 'sent') return { kind: 'existing' as const, row: open, optionUntil: stay.optionUntil };
        if (same) return { kind: 'retry' as const, row: open, optionUntil: stay.optionUntil };
        return { kind: 'replace' as const, row: open, optionUntil: stay.optionUntil };
      }
      const [row] = await tx.insert(remotePaymentRequests).values({
        propertyId: input.propertyId, reservationId: stay.id, bookingId: stay.bookingId, provider: PROVIDER, mode: provider.mode,
        amount: amount.toFixed(2), currencyCode: 'KZT', phoneMasked: maskQutPayPhone(phone), phoneDigest: digest, status: 'creating',
        source: input.source, requestedBy: input.requestedBy?.slice(0, 200) ?? null, conversationId: input.conversationId?.slice(0, 200) ?? null,
      }).returning();
      return { kind: 'new' as const, row, optionUntil: stay.optionUntil };
    });

    if (decision.kind === 'existing') return this.view(decision.row, decision.optionUntil);
    if (decision.kind === 'replace') {
      // Another number or amount: the old invoice is withdrawn first, so the guest never holds two.
      if (attempt > 0) throw new ConflictException({ code: 'REMOTE_PAYMENT_OPEN_INVOICE', message: 'An open invoice could not be withdrawn yet; try again shortly' });
      const outcome = await this.withdraw(decision.row, 'replaced');
      if (outcome === 'paid') throw new ConflictException({ code: 'REMOTE_PAYMENT_ALREADY_PAID', message: 'The previous invoice has just been paid' });
      if (outcome !== 'closed') throw new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_PROVIDER_UNCERTAIN', message: 'The previous invoice could not be withdrawn yet; try again shortly' });
      return this.create(input, attempt + 1);
    }
    return this.issue(provider, decision.row, phone, decision.optionUntil);
  }

  /** Booking guarantee (all tentative stays with an amount) minus money received, in whole tenge. */
  private async amountDue(tx: any, stay: any) {
    const waiting = await tx.select({ requiredDeposit: reservations.requiredDeposit }).from(reservations).where(and(
      eq(reservations.bookingId, stay.bookingId), eq(reservations.propertyId, stay.propertyId), eq(reservations.status, 'pending')));
    const required = waiting.reduce((sum: Decimal, s: any) => s.requiredDeposit == null ? sum : sum.plus(s.requiredDeposit), new Decimal(0));
    const paid = await this.guarantee.paidForBooking(stay.bookingId, stay.propertyId, tx);
    return required.minus(paid).ceil();
  }

  private async issue(provider: QutPayClient, row: Request, phone: string, optionUntil: Date | null) {
    const [context] = await this.db.select({ confirmationNumber: bookings.confirmationNumber, propertyName: properties.name })
      .from(bookings).innerJoin(properties, eq(properties.id, bookings.propertyId))
      .where(and(eq(bookings.id, row.bookingId), eq(bookings.propertyId, row.propertyId)));
    // The guest sees up to 60 characters in Kaspi; no personal data goes into it.
    const description = [`Предоплата брони ${context?.confirmationNumber ?? ''}`.trim(), context?.propertyName].filter(Boolean).join(', ').slice(0, 60);
    let invoice: QutPayInvoice;
    try {
      invoice = await provider.createPhoneInvoice({ amount: Number(row.amount), phone, orderId: row.id, description,
        metadata: { propertyId: row.propertyId, reservationId: row.reservationId, requestId: row.id } });
    } catch (error) {
      throw await this.createFailed(row, error);
    }
    const applied = await this.apply(row.id, row.propertyId, invoice);
    if (applied.status === 'paid') throw new ConflictException({ code: 'REMOTE_PAYMENT_ALREADY_PAID', message: 'This invoice is already paid' });
    if (applied.status !== 'sent') {
      throw new ConflictException({ code: 'REMOTE_PAYMENT_INVOICE_NOT_PAYABLE', message: `The invoice is ${applied.status}`, status: applied.status });
    }
    return this.view(applied, optionUntil);
  }

  private async createFailed(row: Request, error: unknown): Promise<HttpException> {
    if (!(error instanceof QutPayError)) {
      await this.update(row, { status: 'unknown', errorCode: 'internal_error' });
      this.logger.error(`Remote payment ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      return new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_PROVIDER_UNCERTAIN', retryable: true, message: 'Payment provider did not answer; try again' });
    }
    if (error.code === 'uncertain' || error.code === 'unexpected_invoice') {
      // The invoice may exist: keep the request open; a retry (or the scheduler) settles it with the same key.
      await this.update(row, { status: 'unknown', errorCode: error.providerCode ?? error.code });
      return new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_PROVIDER_UNCERTAIN', retryable: true, message: 'Payment provider did not confirm the invoice yet; try again' });
    }
    const providerCode = error.providerCode ?? (error.code === 'input' ? 'invalid_input' : 'rejected');
    await this.update(row, { status: 'failed', errorCode: providerCode });
    await this.audit(row, 'remote_payment_failed', `Счёт Kaspi не выставлен: ${providerCode}`, { errorCode: providerCode });
    if (providerCode === 'kaspi_customer_not_found') {
      return new UnprocessableEntityException({ code: 'REMOTE_PAYMENT_NOT_KASPI_CUSTOMER', message: 'This number is not a Kaspi customer' });
    }
    if (providerCode === 'invalid_phone' || providerCode === 'phone_required') {
      return new UnprocessableEntityException({ code: 'REMOTE_PAYMENT_INVALID_PHONE', message: 'The payment provider rejected the phone number' });
    }
    if (providerCode.startsWith('kaspi_session')) {
      return new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_PROVIDER_DISCONNECTED', message: 'The hotel Kaspi cashier is disconnected from the payment provider' });
    }
    if (providerCode.startsWith('tariff_') || providerCode === 'request_rate_limited') {
      return new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_PROVIDER_LIMIT', message: 'The payment provider limit is reached' });
    }
    return new BadGatewayException({ code: 'REMOTE_PAYMENT_PROVIDER_REJECTED', message: `The payment provider rejected the invoice (${providerCode})` });
  }

  // ---------------------------------------------------------------- applying provider state

  /**
   * Brings a request in line with the provider's invoice. Paid money is recorded once (unique
   * idempotency key per invoice) in the same transaction that marks the request paid; the guarantee
   * listener reacts to `payment.received` after commit.
   */
  async apply(requestId: string, propertyId: string, invoice: QutPayInvoice): Promise<Request> {
    const after: { row: Request; events: Array<[string, string, string, Record<string, unknown>]> } = await this.db.transaction(async (tx: any) => {
      const events: Array<[string, string, string, Record<string, unknown>]> = [];
      const scope = and(eq(remotePaymentRequests.id, requestId), eq(remotePaymentRequests.propertyId, propertyId));
      const [target] = await tx.select({ reservationId: remotePaymentRequests.reservationId }).from(remotePaymentRequests).where(scope);
      if (!target) throw new NotFoundException('Remote payment request not found');
      // Same lock order as create(): the stay first, then the request.
      await tx.select({ id: reservations.id }).from(reservations)
        .where(and(eq(reservations.id, target.reservationId), eq(reservations.propertyId, propertyId))).for('update');
      const [row]: Request[] = await tx.select().from(remotePaymentRequests).where(scope).for('update');
      if (!row) throw new NotFoundException('Remote payment request not found');
      const base = { providerStatus: invoice.status, updatedAt: new Date(), lastCheckedAt: new Date() };
      if ((row.providerInvoiceId && row.providerInvoiceId !== invoice.id) || invoice.externalOrderId !== row.id ||
          !new Decimal(row.amount).eq(invoice.amount)) {
        if (!row.reviewReason) {
          const [flagged] = await tx.update(remotePaymentRequests).set({ ...base, reviewReason: 'invoice_mismatch' })
            .where(eq(remotePaymentRequests.id, row.id)).returning();
          events.push(['payment_request.needs_review', 'reservation', row.reservationId, { reviewReason: 'invoice_mismatch', invoiceId: invoice.id }]);
          return { row: flagged, events };
        }
        return { row, events };
      }
      const identity = { ...base, providerInvoiceId: invoice.id, payUrl: invoice.payUrl,
        providerExpiresAt: invoice.expiresAt ? new Date(invoice.expiresAt) : row.providerExpiresAt };

      if (invoice.status === 'new' || invoice.status === 'pending') {
        if (row.status === 'paid') return { row, events };
        const status: Status = OPEN.includes(row.status as Status) ? 'sent' : row.status as Status;
        const [updated] = await tx.update(remotePaymentRequests).set({ ...identity, status, errorCode: status === 'sent' ? null : row.errorCode })
          .where(eq(remotePaymentRequests.id, row.id)).returning();
        if (row.status !== 'sent' && status === 'sent') {
          events.push(['payment_request.sent', 'payment_request', row.id, this.eventData(updated)]);
        }
        return { row: updated, events };
      }

      if (invoice.status === 'failed' || invoice.status === 'expired' || invoice.status === 'cancelled') {
        if (row.status === 'paid' || row.status === invoice.status) {
          const [updated] = await tx.update(remotePaymentRequests).set(identity).where(eq(remotePaymentRequests.id, row.id)).returning();
          return { row: updated, events };
        }
        const [updated] = await tx.update(remotePaymentRequests).set({ ...identity, status: invoice.status })
          .where(eq(remotePaymentRequests.id, row.id)).returning();
        events.push([`payment_request.${invoice.status}`, 'payment_request', row.id, this.eventData(updated)]);
        return { row: updated, events };
      }

      // paid, partially_refunded, refunded: money reached the hotel.
      let updated = !row.paymentId && !row.paidAt
        ? await this.recordPaid(tx, row, invoice, identity, events)
        : (await tx.update(remotePaymentRequests).set(identity).where(eq(remotePaymentRequests.id, row.id)).returning())[0];
      const refunded = new Decimal(invoice.refundedAmount);
      if (refunded.gt(updated.refundedAmount ?? 0)) {
        // A refund made at the provider: staff record it in the folio with a reason (refunds stay manual).
        [updated] = await tx.update(remotePaymentRequests).set({ refundedAmount: refunded.toFixed(2), reviewReason: 'provider_refund', updatedAt: new Date() })
          .where(eq(remotePaymentRequests.id, row.id)).returning();
        await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: row.reservationId, action: 'remote_payment_refunded_at_provider',
          description: `Возврат в Kaspi по счёту ${invoice.id}: ${refunded.toFixed(2)} KZT — внесите возврат в фолио`, newValue: { requestId: row.id, refundedAmount: refunded.toFixed(2) } });
        events.push(['payment_request.needs_review', 'reservation', row.reservationId, { ...this.eventData(updated), reviewReason: 'provider_refund' }]);
      }
      return { row: updated, events };
    });
    for (const [event, entityType, entityId, data] of after.events) {
      try { await this.webhooks.emit(event as any, entityType, entityId, data, propertyId); }
      catch (error) { this.logger.warn(`Event ${event} for ${entityId} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return after.row;
  }

  private async recordPaid(tx: any, row: Request, invoice: QutPayInvoice, identity: Record<string, unknown>,
    events: Array<[string, string, string, Record<string, unknown>]>): Promise<Request> {
    const now = new Date();
    const reported = invoice.paidAt ? new Date(invoice.paidAt) : null;
    const paidAt = reported && Number.isFinite(reported.getTime()) && reported.getTime() <= now.getTime() ? reported : now;
    const [stay] = await tx.select().from(reservations)
      .where(and(eq(reservations.id, row.reservationId), eq(reservations.propertyId, row.propertyId))).for('update');
    let review: ReviewReason | null = null;
    if (stay.status === 'cancelled' && stay.cancellationReason === OPTION_EXPIRED_REASON) review = 'paid_after_option_expiry';
    else if (['cancelled', 'no_show', 'checked_out'].includes(stay.status)) review = 'reservation_not_open';
    else if (stay.status !== 'pending') review = 'reservation_already_confirmed';

    const folio = await this.folios.createAutoFolio(stay, tx);
    if (folio.status !== 'open') {
      const [updated] = await tx.update(remotePaymentRequests).set({ ...identity, status: 'paid', paidAt, reviewReason: 'folio_not_open' })
        .where(eq(remotePaymentRequests.id, row.id)).returning();
      await tx.insert(auditLogs).values({ propertyId: row.propertyId, entityType: 'reservation', entityId: row.reservationId, action: 'remote_payment_unposted',
        description: `Оплата Kaspi ${row.amount} KZT по счёту ${invoice.id} получена, но фолио закрыто: разнесите вручную`, newValue: { requestId: row.id, invoiceId: invoice.id } });
      events.push(['payment_request.needs_review', 'reservation', row.reservationId, { ...this.eventData(updated), reviewReason: 'folio_not_open' }]);
      return updated;
    }
    const test = row.mode === 'test';
    const idempotencyKey = `${PROVIDER}:${invoice.id}`;
    const [inserted] = await tx.insert(payments).values({
      propertyId: row.propertyId, folioId: folio.id, method: 'other', amount: row.amount, currencyCode: row.currencyCode,
      status: 'captured', gatewayProvider: test ? 'qutpay_test' : PROVIDER, gatewayTransactionId: invoice.id, idempotencyKey,
      processedAt: paidAt,
      notes: test ? 'ТЕСТ: счёт Kaspi в песочнице QUT Pay, деньги не поступали' : 'Kaspi: предоплата по счёту на телефон (QUT Pay)',
    }).onConflictDoNothing().returning();
    const payment = inserted ?? (await tx.select().from(payments)
      .where(and(eq(payments.propertyId, row.propertyId), eq(payments.idempotencyKey, idempotencyKey))))[0];
    if (inserted) await this.folios.recalculateBalance(folio.id, row.propertyId, tx);
    const [updated] = await tx.update(remotePaymentRequests).set({ ...identity, status: 'paid', paidAt, paymentId: payment.id, reviewReason: review, errorCode: null })
      .where(eq(remotePaymentRequests.id, row.id)).returning();
    await tx.insert(auditLogs).values({ propertyId: row.propertyId, entityType: 'reservation', entityId: row.reservationId, action: 'remote_payment_received',
      description: `${test ? 'ТЕСТ. ' : ''}Предоплата через Kaspi: ${row.amount} KZT (счёт ${invoice.id})`,
      newValue: { requestId: row.id, paymentId: payment.id, folioId: folio.id, amount: row.amount, invoiceId: invoice.id, mode: row.mode, reviewReason: review } });
    if (inserted) {
      events.push(['payment.received', 'payment', payment.id, { folioId: folio.id, method: 'other', amount: row.amount, status: 'captured',
        gatewayProvider: payment.gatewayProvider, remotePaymentRequestId: row.id }]);
    }
    events.push(['payment_request.paid', 'payment_request', row.id, this.eventData(updated)]);
    // The guarantee listener raises its own task for a released option; the other cases are raised here.
    if (review && review !== 'paid_after_option_expiry') {
      events.push(['payment_request.needs_review', 'reservation', row.reservationId, { ...this.eventData(updated), reviewReason: review }]);
    }
    return updated;
  }

  private eventData(row: Request) {
    return { requestId: row.id, reservationId: row.reservationId, bookingId: row.bookingId, status: row.status,
      amount: row.amount, currencyCode: row.currencyCode, mode: row.mode, conversationId: row.conversationId,
      reviewReason: row.reviewReason, paymentId: row.paymentId };
  }

  // ---------------------------------------------------------------- webhook

  /** Signed provider callback. The body only says "look again": the state applied is read back from the provider. */
  async handleWebhook(rawBody: Buffer, timestamp: unknown, signature: unknown) {
    const secret = this.secret();
    const provider = this.provider();
    if (!secret || !provider) throw new NotFoundException('REMOTE_PAYMENT_DISABLED');
    if (!verifyQutPayWebhook(secret, rawBody, timestamp, signature)) throw new UnauthorizedException('INVALID_WEBHOOK_SIGNATURE');
    let body: { event?: unknown; invoice?: { id?: unknown; externalOrderId?: unknown; mode?: unknown } };
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { throw new BadRequestException('INVALID_WEBHOOK_BODY'); }
    if (typeof body?.event !== 'string' || !body.event.startsWith('invoice.')) return { handled: false };
    const invoiceId = body.invoice?.id;
    if (typeof invoiceId !== 'string') return { handled: false };
    if (body.invoice?.mode !== (provider.mode === 'test' ? 'sandbox' : 'live')) return { handled: false };
    // Trusted server-side lookup: the invoice id is ours only if we stored it (or it carries our request id).
    const orderId = typeof body.invoice?.externalOrderId === 'string' ? body.invoice.externalOrderId : '';
    const [row]: Request[] = await this.db.select().from(remotePaymentRequests).where(and(eq(remotePaymentRequests.provider, PROVIDER),
      /^[0-9a-f-]{36}$/.test(orderId)
        ? or(eq(remotePaymentRequests.providerInvoiceId, invoiceId), and(isNull(remotePaymentRequests.providerInvoiceId), eq(remotePaymentRequests.id, orderId)))
        : eq(remotePaymentRequests.providerInvoiceId, invoiceId))).limit(1);
    if (!row) return { handled: false };
    let invoice: QutPayInvoice;
    try { invoice = await provider.getInvoice(invoiceId); } catch (error) {
      // 503 makes the provider deliver again; the scheduler would also catch up.
      throw new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_READBACK_FAILED', message: error instanceof Error ? error.message : 'read back failed' });
    }
    await this.apply(row.id, row.propertyId, invoice);
    return { handled: true };
  }

  // ---------------------------------------------------------------- withdrawing and checking

  /** Staff action: withdraw an open invoice. */
  async cancel(propertyId: string, requestId: string, actor?: AuditActor) {
    this.require(propertyId);
    const [row]: Request[] = await this.db.select().from(remotePaymentRequests)
      .where(and(eq(remotePaymentRequests.id, requestId), eq(remotePaymentRequests.propertyId, propertyId)));
    if (!row) throw new NotFoundException('Remote payment request not found');
    if (!OPEN.includes(row.status as Status)) throw new ConflictException({ code: 'REMOTE_PAYMENT_NOT_OPEN', message: `The request is ${row.status}` });
    const outcome = await this.withdraw(row, 'staff', actor);
    if (outcome === 'unknown') throw new ServiceUnavailableException({ code: 'REMOTE_PAYMENT_PROVIDER_UNCERTAIN', message: 'The payment provider did not confirm; try again' });
    return this.current(row);
  }

  /** Staff action: read the invoice from the provider now. */
  async refresh(propertyId: string, requestId: string) {
    this.require(propertyId);
    const [row]: Request[] = await this.db.select().from(remotePaymentRequests)
      .where(and(eq(remotePaymentRequests.id, requestId), eq(remotePaymentRequests.propertyId, propertyId)));
    if (!row) throw new NotFoundException('Remote payment request not found');
    await this.check(row);
    return this.current(row);
  }

  private async current(row: Request) {
    const [after]: Request[] = await this.db.select().from(remotePaymentRequests)
      .where(and(eq(remotePaymentRequests.id, row.id), eq(remotePaymentRequests.propertyId, row.propertyId)));
    return this.view(after ?? row);
  }

  /**
   * Cancels the invoice at the provider. `closed` = no longer payable, `paid` = it turned out paid
   * (recorded through the normal path), `unknown` = no definite answer yet (the scheduler retries).
   */
  private async withdraw(row: Request, reason: 'staff' | 'replaced' | 'stay_closed', actor?: AuditActor): Promise<'closed' | 'paid' | 'unknown'> {
    const provider = this.provider();
    if (!provider) return 'unknown';
    if (!row.providerInvoiceId) {
      const found = await this.settleUnknown(provider, row);
      if (found === 'none') {
        await this.update(row, { status: 'cancelled', errorCode: 'not_created' });
        return 'closed';
      }
      if (found === 'unknown') return 'unknown';
      const [fresh]: Request[] = await this.db.select().from(remotePaymentRequests).where(and(eq(remotePaymentRequests.id, row.id), eq(remotePaymentRequests.propertyId, row.propertyId)));
      if (!fresh?.providerInvoiceId || fresh.status === 'paid') return fresh?.status === 'paid' ? 'paid' : 'closed';
      row = fresh;
    }
    let invoice: QutPayInvoice;
    try { invoice = await provider.cancelInvoice(row.providerInvoiceId!); } catch (error) {
      if (!(error instanceof QutPayError) || error.code !== 'rejected') return 'unknown';
      try { invoice = await provider.getInvoice(row.providerInvoiceId!, true); } catch { return 'unknown'; }
    }
    const after = await this.apply(row.id, row.propertyId, invoice);
    if (after.status !== 'paid' && !OPEN.includes(after.status as Status)) {
      await this.audit(row, 'remote_payment_withdrawn', reason === 'staff' ? 'Счёт Kaspi отозван сотрудником'
        : reason === 'replaced' ? 'Счёт Kaspi заменён новым (другой номер или сумма)' : 'Счёт Kaspi отозван: бронь больше не ждёт предоплату',
      { requestId: row.id, invoiceId: row.providerInvoiceId, reason }, actor);
    }
    return after.status === 'paid' ? 'paid' : OPEN.includes(after.status as Status) ? 'unknown' : 'closed';
  }

  /** A create call without a definite answer: look the invoice up by our order id. */
  private async settleUnknown(provider: QutPayClient, row: Request): Promise<'found' | 'none' | 'unknown'> {
    let invoice: QutPayInvoice | null;
    try { invoice = await provider.findByOrderId(row.id); } catch { return 'unknown'; }
    if (!invoice) return 'none';
    await this.apply(row.id, row.propertyId, invoice);
    return 'found';
  }

  /** Re-reads one open request; withdraws its invoice when the stay no longer waits for the money. */
  async check(row: Request) {
    const provider = this.provider();
    if (!provider || row.mode !== provider.mode) return;
    if (!row.providerInvoiceId) {
      const found = await this.settleUnknown(provider, row);
      // Nothing was issued: after a grace period the attempt is closed so a new one can start.
      if (found === 'none' && Date.now() - row.createdAt.getTime() > 10 * 60_000) {
        await this.update(row, { status: 'failed', errorCode: row.errorCode ?? 'not_created' });
      } else if (found !== 'found') {
        await this.update(row, { checkAttempts: row.checkAttempts + 1, lastCheckedAt: new Date() });
      }
      return;
    }
    let after: Request;
    try {
      after = await this.apply(row.id, row.propertyId, await provider.getInvoice(row.providerInvoiceId, true));
    } catch (error) {
      await this.update(row, { checkAttempts: row.checkAttempts + 1, lastCheckedAt: new Date() });
      this.logger.warn(`Remote payment check ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (OPEN.includes(after.status as Status)) {
      await this.update(after, { checkAttempts: after.checkAttempts + 1 });
      const [stay] = await this.db.select({ status: reservations.status }).from(reservations)
        .where(and(eq(reservations.id, row.reservationId), eq(reservations.propertyId, row.propertyId)));
      if (stay && stay.status !== 'pending') await this.withdraw(after, 'stay_closed');
    }
  }

  /**
   * Scheduler pass over open requests (trusted server-side ids). Polling backs off from one to fifteen
   * minutes per request; the webhook normally arrives first.
   */
  async sweep(now = new Date(), limit = 50) {
    if (!this.provider()) return { checked: 0 };
    const rows: Request[] = await this.db.select().from(remotePaymentRequests)
      .where(and(inArray(remotePaymentRequests.status, OPEN), or(isNull(remotePaymentRequests.lastCheckedAt),
        lt(remotePaymentRequests.lastCheckedAt, new Date(now.getTime() - 60_000)))))
      .orderBy(asc(remotePaymentRequests.lastCheckedAt)).limit(limit * 4);
    let checked = 0;
    for (const row of rows) {
      if (checked >= limit) break;
      const waitMinutes = Math.min(15, 1 + row.checkAttempts);
      const last = row.lastCheckedAt ?? row.createdAt;
      // A request still being created by a live call is left alone for a moment.
      if (row.status === 'creating' && now.getTime() - row.createdAt.getTime() < 2 * 60_000) continue;
      if (row.lastCheckedAt && now.getTime() - last.getTime() < waitMinutes * 60_000) continue;
      checked += 1;
      try { await this.check(row); } catch (error) {
        this.logger.warn(`Remote payment sweep ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { checked };
  }

  /** A stay that stopped waiting for money (released, cancelled, confirmed by other means) withdraws its open invoice. */
  @OnEvent('reservation.cancelled')
  @OnEvent('reservation.confirmed')
  async onStayClosed(payload: WebhookPayload) {
    if (!payload?.propertyId || !payload.entityId || !this.provider()) return;
    try {
      const rows: Request[] = await this.db.select().from(remotePaymentRequests).where(and(
        eq(remotePaymentRequests.propertyId, payload.propertyId), eq(remotePaymentRequests.reservationId, payload.entityId),
        inArray(remotePaymentRequests.status, OPEN)));
      for (const row of rows) await this.withdraw(row, 'stay_closed');
    } catch (error) {
      // The scheduler withdraws it on its next pass.
      this.logger.warn(`Withdrawing invoices of ${payload.entityId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private async update(row: Request, set: Partial<Request>) {
    await this.db.update(remotePaymentRequests).set({ ...set, updatedAt: new Date() })
      .where(and(eq(remotePaymentRequests.id, row.id), eq(remotePaymentRequests.propertyId, row.propertyId)));
  }

  private async audit(row: Request, action: string, description: string, newValue: Record<string, unknown>, actor?: AuditActor) {
    await this.db.insert(auditLogs).values({ propertyId: row.propertyId, entityType: 'reservation', entityId: row.reservationId,
      action, description, newValue, ...(actor ? actorFields(actor) : {}) });
  }
}
