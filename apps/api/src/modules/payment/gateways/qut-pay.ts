import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayJsonRequest, type GatewayFetchFn } from './payment-gateway-http';

/**
 * QUT Pay client for remote Kaspi invoices ("phone" invoices: a push to the guest's Kaspi app).
 * Guestra never holds the money: it goes to the hotel's Kaspi account, we only issue and read invoices.
 *
 * The key decides the mode: `qp_test_` keys talk to the provider's sandbox (no Kaspi, payments are
 * simulated), `qp_live_` keys issue real invoices. Responses from the other mode are rejected.
 */
const API_URL = 'https://api.qut.kz/api/v1';
const INVOICE_ID = /^inv_[A-Za-z0-9]+$/;
const ORDER_ID = /^[A-Za-z0-9:_-]{1,100}$/;
const DEFINITE_SERVER_ERRORS = new Set(['kaspi_session_expired', 'kaspi_session_not_configured']);
export const QUTPAY_INVOICE_STATUSES = [
  'new', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded',
] as const;
export type QutPayInvoiceStatus = (typeof QUTPAY_INVOICE_STATUSES)[number];
export type QutPayMode = 'test' | 'live';

export interface QutPayInvoice {
  id: string;
  externalOrderId: string;
  status: QutPayInvoiceStatus;
  amount: number;
  refundedAmount: number;
  payUrl: string;
  expiresAt: string | null;
  paidAt: string | null;
}

/**
 * `input` — rejected before sending; `rejected` — the provider answered with a definite error (see `providerCode`);
 * `uncertain` — no definite answer (timeout, 5xx): the invoice may exist, retry with the same idempotency key;
 * `unexpected_invoice` — the answer does not match what we asked for.
 */
export type QutPayErrorCode = 'configuration' | 'input' | 'rejected' | 'uncertain' | 'unexpected_invoice';

export class QutPayError extends Error {
  constructor(
    readonly code: QutPayErrorCode,
    readonly httpStatus?: number,
    /** Provider error code such as `kaspi_customer_not_found`, `invoice_not_open`, `tariff_limit_reached`. */
    readonly providerCode?: string,
  ) {
    super(`QUT Pay: ${code}${providerCode ? ` (${providerCode})` : ''}`);
  }
}

export function qutPayMode(apiKey: string): QutPayMode | null {
  if (/^qp_test_[A-Za-z0-9_-]+$/.test(apiKey)) return 'test';
  if (/^qp_live_[A-Za-z0-9_-]+$/.test(apiKey)) return 'live';
  return null;
}

/** Kazakhstan mobile number in the provider's format `7XXXXXXXXXX`. */
export function normalizeQutPayPhone(input: string): string {
  const compact = input.trim().replace(/[\s()-]/g, '').replace(/^\+7/, '7').replace(/^8(?=\d{10}$)/, '7');
  if (!/^7\d{10}$/.test(compact)) throw new QutPayError('input', undefined, 'invalid_phone');
  return compact;
}

/** `77011234567` -> `+7 701 ***-**-67`: enough for staff to recognise the number, nothing more. */
export function maskQutPayPhone(phone: string): string {
  return `+7 ${phone.slice(1, 4)} ***-**-${phone.slice(-2)}`;
}

export class QutPayClient {
  readonly mode: QutPayMode;

  constructor(private readonly apiKey: string, private readonly fetchFn: GatewayFetchFn = fetch) {
    const mode = qutPayMode(apiKey);
    if (!mode) throw new QutPayError('configuration');
    this.mode = mode;
  }

  /**
   * Issues a phone invoice. The idempotency key makes a retry after a timeout return the same invoice
   * instead of pushing a second one to the guest.
   */
  async createPhoneInvoice(input: {
    amount: number; phone: string; orderId: string; description: string; metadata?: Record<string, string>;
  }) {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || !ORDER_ID.test(input.orderId)) {
      throw new QutPayError('input');
    }
    const invoice = await this.request('/invoices', {
      method: 'POST',
      idempotencyKey: input.orderId,
      body: JSON.stringify({
        kind: 'phone',
        amount: input.amount,
        customer: { phone: normalizeQutPayPhone(input.phone) },
        externalOrderId: input.orderId,
        description: input.description.slice(0, 60),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
    });
    if (invoice.externalOrderId !== input.orderId || invoice.amount !== input.amount) {
      throw new QutPayError('unexpected_invoice');
    }
    return invoice;
  }

  /** Current state; `live` asks Kaspi right now instead of the provider's last poll. */
  async getInvoice(invoiceId: string, live = false) {
    if (!INVOICE_ID.test(invoiceId)) throw new QutPayError('input');
    const invoice = await this.request(`/invoices/${invoiceId}${live ? '?live=1' : ''}`, { method: 'GET' });
    if (invoice.id !== invoiceId) throw new QutPayError('unexpected_invoice');
    return invoice;
  }

  /** The invoice issued for our order id, if any: settles a create call that got no definite answer. */
  async findByOrderId(orderId: string): Promise<QutPayInvoice | null> {
    if (!ORDER_ID.test(orderId)) throw new QutPayError('input');
    const result = await this.send(`/invoices?externalOrderId=${encodeURIComponent(orderId)}&limit=5`, { method: 'GET' });
    const list = Array.isArray(result?.['invoices']) ? result['invoices'] as Record<string, unknown>[] : null;
    if (!list) throw new QutPayError('unexpected_invoice');
    const invoices = list.map(row => this.parseInvoice(row)).filter(row => row.externalOrderId === orderId);
    if (invoices.length > 1) throw new QutPayError('unexpected_invoice');
    return invoices[0] ?? null;
  }

  /** Cancels an open phone invoice in Kaspi. `invoice_not_open` (already paid, expired...) comes back as `rejected`. */
  async cancelInvoice(invoiceId: string) {
    if (!INVOICE_ID.test(invoiceId)) throw new QutPayError('input');
    const invoice = await this.request(`/invoices/${invoiceId}/cancel`, { method: 'POST' });
    if (invoice.id !== invoiceId) throw new QutPayError('unexpected_invoice');
    return invoice;
  }

  /** Sandbox only: moves a test invoice to `paid`, `failed` or `expired`, as the guest or Kaspi would. */
  async simulate(invoiceId: string, status: 'paid' | 'failed' | 'expired') {
    if (this.mode !== 'test' || !INVOICE_ID.test(invoiceId)) throw new QutPayError('input');
    const invoice = await this.request(`/invoices/${invoiceId}/simulate`, { method: 'POST', body: JSON.stringify({ status }) });
    if (invoice.id !== invoiceId) throw new QutPayError('unexpected_invoice');
    return invoice;
  }

  private async request(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<QutPayInvoice> {
    return this.parseInvoice(await this.send(path, init));
  }

  private async send(path: string, init: RequestInit & { idempotencyKey?: string }) {
    const result = await gatewayJsonRequest(`${API_URL}${path}`, {
      ...init,
      headers: { 'X-API-Key': this.apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    }, this.fetchFn);
    if (!result.ok) {
      const providerCode = typeof result.data?.['error'] === 'string' ? result.data['error'] as string : undefined;
      // No answer or a server-side failure: the operation may have happened. A disconnected cashier is
      // a definite "nothing was issued", even though it comes with a 5xx status.
      const uncertain = result.status === 0 || (result.status >= 500 && !DEFINITE_SERVER_ERRORS.has(providerCode ?? ''));
      throw new QutPayError(uncertain ? 'uncertain' : 'rejected', result.status, providerCode);
    }
    return result.data;
  }

  private parseInvoice(data: Record<string, unknown> | undefined): QutPayInvoice {
    const { mode, kind, currency, id, externalOrderId, amount, status, payUrl, expiresAt, paidAt, refundedAmount } = data ?? {};
    if (mode !== (this.mode === 'test' ? 'sandbox' : 'live') || kind !== 'phone' || currency !== 'KZT' ||
        typeof id !== 'string' || !INVOICE_ID.test(id) || typeof externalOrderId !== 'string' ||
        typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 ||
        !QUTPAY_INVOICE_STATUSES.includes(status as QutPayInvoiceStatus) || typeof payUrl !== 'string') {
      throw new QutPayError('unexpected_invoice');
    }
    let hostedUrl: URL;
    try {
      hostedUrl = new URL(payUrl);
    } catch {
      throw new QutPayError('unexpected_invoice');
    }
    if (hostedUrl.origin !== 'https://qut.kz' || hostedUrl.username || hostedUrl.password || hostedUrl.pathname !== `/pay/${id}`) {
      throw new QutPayError('unexpected_invoice');
    }
    return {
      id,
      externalOrderId,
      status: status as QutPayInvoiceStatus,
      amount,
      refundedAmount: typeof refundedAmount === 'number' && refundedAmount > 0 ? refundedAmount : 0,
      payUrl: hostedUrl.href,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
      paidAt: typeof paidAt === 'string' ? paidAt : null,
    };
  }
}

/** Checks `X-Webhook-Signature: sha256=<hex>` = HMAC-SHA256(secret, timestamp + "." + raw body), within 5 minutes. */
export function verifyQutPayWebhook(
  secret: string,
  rawBody: Buffer,
  timestamp: unknown,
  signature: unknown,
  now = Date.now(),
): boolean {
  if (!secret || typeof timestamp !== 'string' || !/^\d{1,11}$/.test(timestamp) ||
      typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
