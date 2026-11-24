import { index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { properties } from './property.js';
import { bookings, reservations } from './reservation.js';
import { payments } from './folio.js';

/**
 * Remote payment requests: an invoice the hotel's payment provider sends to the guest
 * (for Kaspi, a push into the guest's Kaspi app by phone number) for a reservation's prepayment.
 *
 * The money never passes through Guestra. A paid request is recorded as an ordinary captured
 * payment on the stay's folio (`payment_id`), so the ledger, reports and automatic confirmation
 * see it like any other payment. Every attempt is a row: after a failed or expired invoice the
 * next attempt is a new request with its own idempotency key, and history stays intact.
 *
 * status: creating -> sent -> paid | failed | expired | cancelled; `unknown` = the provider gave
 * no definite answer to the create call (the invoice may exist; the same key is retried).
 * review_reason marks money staff must look at (late payment, refund at the provider...).
 */
export const remotePaymentRequests = pgTable('remote_payment_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  propertyId: uuid('property_id').notNull().references(() => properties.id),
  reservationId: uuid('reservation_id').notNull().references(() => reservations.id),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id),
  provider: varchar('provider', { length: 20 }).notNull(),
  /** `test` (provider sandbox, no money moves) or `live`. */
  mode: varchar('mode', { length: 10 }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currencyCode: varchar('currency_code', { length: 3 }).notNull(),
  phoneMasked: varchar('phone_masked', { length: 24 }).notNull(),
  /** Keyed hash of the number: tells "same number again" from "another number" without storing it. */
  phoneDigest: varchar('phone_digest', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('creating'),
  providerInvoiceId: varchar('provider_invoice_id', { length: 64 }),
  providerStatus: varchar('provider_status', { length: 30 }),
  payUrl: text('pay_url'),
  providerExpiresAt: timestamp('provider_expires_at', { withTimezone: true }),
  paymentId: uuid('payment_id').references(() => payments.id),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  refundedAmount: numeric('refunded_amount', { precision: 12, scale: 2 }),
  errorCode: varchar('error_code', { length: 60 }),
  reviewReason: varchar('review_reason', { length: 40 }),
  /** `agent` (AI in a chat) or `staff`. */
  source: varchar('source', { length: 20 }).notNull(),
  requestedBy: varchar('requested_by', { length: 200 }),
  conversationId: varchar('conversation_id', { length: 200 }),
  checkAttempts: integer('check_attempts').notNull().default(0),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  reservationIdx: index('remote_payment_requests_reservation_idx').on(table.propertyId, table.reservationId),
  invoiceUnique: uniqueIndex('remote_payment_requests_invoice_unique').on(table.provider, table.providerInvoiceId),
  // At most one open invoice per stay: a second push for the same money would invite a double payment.
  openUnique: uniqueIndex('remote_payment_requests_open_unique').on(table.propertyId, table.reservationId)
    .where(sql`status in ('creating', 'sent', 'unknown')`),
  openIdx: index('remote_payment_requests_open_idx').on(table.status, table.lastCheckedAt),
}));
