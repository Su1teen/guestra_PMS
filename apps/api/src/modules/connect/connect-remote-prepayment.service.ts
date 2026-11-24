import {
  BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auditLogs, integrationLinks, payments, properties, reservations } from '@telivityhaip/database';
import { and, eq } from 'drizzle-orm';
import { numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import Decimal from 'decimal.js';
import { createHmac } from 'node:crypto';
import { DRIZZLE } from '../../database/database.module';
import { FolioService } from '../folio/folio.service';
import {
  normalizeQutPayPhone, QutPaySandbox, QutPaySandboxError, type SandboxPhoneInvoice, verifyQutPayWebhook,
} from '../payment/gateways/qut-pay-sandbox';
import { ReservationGuaranteeService } from '../reservation/reservation-guarantee.service';
import { integrationDeployment, sandboxProperties } from './connect-operation-schema';

export const sandboxRemotePrepayments = pgTable('sandbox_remote_prepayments', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  phoneDigest: text('phone_digest').notNull(),
  providerInvoiceId: text('provider_invoice_id'),
  providerStatus: text('provider_status'),
  paymentId: uuid('payment_id'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  reviewReason: text('review_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const prepayments = sandboxRemotePrepayments;
type Prepayment = typeof prepayments.$inferSelect;
const identifier = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const paymentOrder = new RegExp(`^deposit:(${identifier}):(${identifier})$`);
const paymentEvents = new Set(['invoice.paid', 'invoice.failed', 'invoice.expired', 'invoice.cancelled']);

@Injectable()
export class ConnectRemotePrepaymentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase,
    private readonly config: ConfigService,
    private readonly folios: FolioService,
    private readonly guarantee: ReservationGuaranteeService,
  ) {}

  isEnabled() {
    return this.config.get('INTEGRATION_ENVIRONMENT') === 'sandbox' &&
      this.config.get('QUTPAY_SANDBOX_PREPAYMENTS_ENABLED') === 'true';
  }

  isConfigured() {
    return this.isEnabled() && /^qp_test_[A-Za-z0-9_-]+$/.test(this.config.get('QUTPAY_API_KEY', '')) &&
      this.config.get('QUTPAY_WEBHOOK_SECRET', '').length >= 16;
  }

  private configuration() {
    if (!this.isEnabled()) {
      throw new NotFoundException('REMOTE_PREPAYMENT_DISABLED');
    }
    const apiKey = this.config.get<string>('QUTPAY_API_KEY', '');
    const secret = this.config.get<string>('QUTPAY_WEBHOOK_SECRET', '');
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('REMOTE_PREPAYMENT_NOT_CONFIGURED');
    }
    return { apiKey, secret };
  }

  private async attest(propertyId: string) {
    const [deployment] = await this.db.select().from(integrationDeployment).limit(1);
    const [property] = await this.db.select().from(sandboxProperties).where(eq(sandboxProperties.propertyId, propertyId));
    if (deployment?.environment !== 'sandbox' || !property) throw new ForbiddenException('SANDBOX_ISOLATION_REQUIRED');
    const [current] = await this.db.select({ organizationId: properties.organizationId }).from(properties)
      .where(eq(properties.id, propertyId));
    if (!current || property.tenantId !== (current.organizationId ?? propertyId)) {
      throw new ForbiddenException('SANDBOX_ISOLATION_REQUIRED');
    }
  }

  async available(propertyId: string) {
    if (!this.isConfigured()) return false;
    try {
      await this.attest(propertyId);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  private async callProvider<T>(call: () => Promise<T>) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof QutPaySandboxError)) throw error;
      if (error.code === 'input') throw new BadRequestException('REMOTE_PREPAYMENT_INVALID_INPUT');
      if (error.providerStatus === 409) throw new ConflictException('REMOTE_PREPAYMENT_PROVIDER_CONFLICT');
      throw new ServiceUnavailableException('REMOTE_PREPAYMENT_REQUIRES_PROVIDER_READBACK');
    }
  }

  async create(reservationId: string, propertyId: string, customerId: string, phoneInput: string, expectedAmount?: string) {
    const { apiKey, secret } = this.configuration();
    await this.attest(propertyId);
    const phone = await this.callProvider(async () => normalizeQutPayPhone(phoneInput));
    const phoneDigest = createHmac('sha256', secret).update(phone).digest('hex');
    const record = await this.db.transaction(async tx => {
      const [identity] = await tx.select({ guestId: integrationLinks.localEntityId }).from(integrationLinks).where(and(
        eq(integrationLinks.propertyId, propertyId), eq(integrationLinks.sourceSystem, 'guestra_crm'),
        eq(integrationLinks.externalEntityType, 'customer'), eq(integrationLinks.externalEntityId, customerId),
        eq(integrationLinks.localEntityType, 'guest'),
      ));
      if (!identity) throw new NotFoundException('VERIFIED_IDENTITY_REQUIRED');
      const [reservation] = await tx.select().from(reservations).where(and(eq(reservations.propertyId, propertyId),
        eq(reservations.id, reservationId), eq(reservations.guestId, identity.guestId))).for('update');
      if (!reservation) throw new NotFoundException('RESERVATION_NOT_FOUND');
      const scope = and(eq(prepayments.propertyId, propertyId), eq(prepayments.reservationId, reservationId));
      const [previous] = await tx.select().from(prepayments).where(scope);
      if (previous?.paymentId || previous?.reviewReason) throw new ConflictException('REMOTE_PREPAYMENT_ALREADY_SETTLED');
      if (reservation.currencyCode !== 'KZT' || reservation.status !== 'pending' || reservation.requiredDeposit == null ||
          (reservation.optionUntil && reservation.optionUntil <= new Date())) {
        throw new ConflictException('REMOTE_PREPAYMENT_OPTION_UNAVAILABLE');
      }
      const paid = await this.guarantee.paidForBooking(reservation.bookingId, propertyId, tx);
      const due = new Decimal(reservation.requiredDeposit).minus(paid);
      if (!due.isInteger() || due.lte(0)) throw new ConflictException('REMOTE_PREPAYMENT_WHOLE_TENGE_REQUIRED');
      if (expectedAmount !== undefined && due.toFixed(2) !== expectedAmount) {
        throw new ConflictException('REMOTE_PREPAYMENT_TERMS_CHANGED');
      }
      if (previous) {
        if (previous.phoneDigest !== phoneDigest || !due.eq(previous.amount)) {
          throw new ConflictException('REMOTE_PREPAYMENT_TERMS_CHANGED');
        }
        return previous;
      }
      const [created] = await tx.insert(prepayments).values({
        propertyId, reservationId, amount: due.toFixed(2), phoneDigest,
      }).returning();
      if (!created) throw new ServiceUnavailableException('REMOTE_PREPAYMENT_NOT_PERSISTED');
      return created;
    });

    const orderId = `deposit:${propertyId}:${record.id}`;
    const provider = new QutPaySandbox(apiKey);
    const invoice = await this.callProvider(() => record.providerInvoiceId
      ? provider.getPhoneInvoice(record.providerInvoiceId)
      : provider.createPhoneInvoice({ amount: Number(record.amount), phone, orderId, description: 'Предоплата бронирования' }));
    await this.reconcile(record, invoice);
    if (invoice.status !== 'new' && invoice.status !== 'pending') {
      throw new ConflictException('REMOTE_PREPAYMENT_INVOICE_NOT_PAYABLE');
    }
    return { invoiceId: invoice.id, reservationId, amount: record.amount, currency: 'KZT',
      payUrl: invoice.payUrl, expiresAt: invoice.expiresAt, status: invoice.status, mode: 'sandbox' };
  }

  async webhook(body: Buffer, timestamp: unknown, signature: unknown) {
    const { apiKey, secret } = this.configuration();
    if (!verifyQutPayWebhook(secret, body, timestamp, signature)) throw new UnauthorizedException('INVALID_WEBHOOK_SIGNATURE');
    let event: { event?: string; invoice?: { id?: string; externalOrderId?: string; mode?: string } };
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      throw new BadRequestException('INVALID_WEBHOOK_BODY');
    }
    if (!event || !paymentEvents.has(event.event ?? '') || event.invoice?.mode === 'live' ||
        typeof event.invoice?.externalOrderId !== 'string' || typeof event.invoice.id !== 'string') return;
    const order = paymentOrder.exec(event.invoice.externalOrderId);
    if (!order) return;
    const propertyId = order[1]!;
    await this.attest(propertyId);
    const [record] = await this.db.select().from(prepayments).where(and(eq(prepayments.propertyId, propertyId), eq(prepayments.id, order[2]!)));
    if (!record) return;
    const provider = new QutPaySandbox(apiKey);
    const invoice = await this.callProvider(() => provider.getPhoneInvoice(event.invoice!.id!));
    if (event.event === 'invoice.paid' && invoice.status !== 'paid') {
      throw new ServiceUnavailableException('REMOTE_PREPAYMENT_PAID_NOT_VERIFIED');
    }
    await this.reconcile(record, invoice);
  }

  private async reconcile(record: Prepayment, invoice: SandboxPhoneInvoice) {
    const { id, propertyId, reservationId } = record;
    if (invoice.externalOrderId !== `deposit:${propertyId}:${id}` || !new Decimal(record.amount).eq(invoice.amount)) {
      throw new ConflictException('REMOTE_PREPAYMENT_INVOICE_MISMATCH');
    }
    const prepaymentScope = and(eq(prepayments.propertyId, propertyId), eq(prepayments.id, id));
    const shouldConfirm = await this.db.transaction(async tx => {
      const [reservation] = await tx.select().from(reservations)
        .where(and(eq(reservations.propertyId, propertyId), eq(reservations.id, reservationId))).for('update');
      const [current] = await tx.select().from(prepayments).where(prepaymentScope).for('update');
      if (!current || !reservation) throw new NotFoundException('REMOTE_PREPAYMENT_NOT_FOUND');
      if (current.providerInvoiceId && current.providerInvoiceId !== invoice.id) {
        throw new ConflictException('REMOTE_PREPAYMENT_INVOICE_MISMATCH');
      }
      if (current.paymentId) return true;
      if (current.reviewReason) return false;
      if (invoice.status !== 'paid') {
        const terminal = current.providerStatus && !['new', 'pending'].includes(current.providerStatus);
        if (!terminal) await tx.update(prepayments).set({ providerInvoiceId: invoice.id, providerStatus: invoice.status }).where(prepaymentScope);
        return false;
      }

      const paidAt = invoice.paidAt == null ? null : new Date(invoice.paidAt);
      if (!paidAt || !Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5_000 ||
          paidAt.getTime() < current.createdAt.getTime() - 5_000) {
        throw new ServiceUnavailableException('REMOTE_PREPAYMENT_PAID_TIMESTAMP_UNVERIFIED');
      }
      const paid = await this.guarantee.paidForBooking(reservation.bookingId, propertyId, tx);
      const validOption = reservation.status === 'pending' && reservation.currencyCode === 'KZT' && reservation.requiredDeposit != null &&
        (!reservation.optionUntil || paidAt <= reservation.optionUntil) && new Decimal(reservation.requiredDeposit).minus(paid).eq(current.amount);
      const folio = validOption ? await this.folios.createAutoFolio(reservation, tx) : null;
      const settled = { providerInvoiceId: invoice.id, providerStatus: invoice.status, paidAt };
      if (!folio || folio.status !== 'open') {
        await tx.update(prepayments).set({ ...settled, reviewReason: 'RESERVATION_TERMS_CHANGED' }).where(prepaymentScope);
        await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: reservationId,
          action: 'sandbox_remote_prepayment_requires_review', newValue: { invoiceId: invoice.id, amount: current.amount } });
        return false;
      }

      const [payment] = await tx.insert(payments).values({ propertyId, folioId: folio.id, method: 'other',
        amount: current.amount, currencyCode: 'KZT', status: 'captured', gatewayProvider: 'qutpay-sandbox',
        gatewayTransactionId: invoice.id, processedAt: paidAt, notes: 'QUT Pay sandbox prepayment' }).returning({ id: payments.id });
      if (!payment) throw new ServiceUnavailableException('REMOTE_PREPAYMENT_NOT_PERSISTED');
      await this.folios.recalculateBalance(folio.id, propertyId, tx);
      await tx.update(prepayments).set({ ...settled, paymentId: payment.id }).where(prepaymentScope);
      await tx.insert(auditLogs).values({ propertyId, entityType: 'reservation', entityId: reservationId,
        action: 'sandbox_remote_prepayment_recorded', newValue: { invoiceId: invoice.id, paymentId: payment.id, amount: current.amount } });
      return true;
    });
    if (shouldConfirm) await this.guarantee.confirmIfGuaranteed(reservationId, propertyId, { notifyGuest: false });
  }
}
