import { createHmac, timingSafeEqual } from 'node:crypto';
import { gatewayJsonRequest, type GatewayFetchFn } from './payment-gateway-http';

const API_URL = 'https://api.qut.kz/api/v1';
const INVOICE_ID = /^inv_[a-zA-Z0-9]+$/;
const INVOICE_STATUSES = [
  'new', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded',
] as const;
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface SandboxPhoneInvoice {
  id: string;
  externalOrderId: string;
  status: InvoiceStatus;
  amount: number;
  payUrl: string;
  expiresAt: string | null;
  paidAt: string | null;
}

export class QutPaySandboxError extends Error {
  constructor(
    readonly code: 'configuration' | 'input' | 'provider' | 'uncertain' | 'unexpected_invoice',
    readonly providerStatus?: number,
  ) {
    super(`QUT Pay sandbox: ${code}`);
  }
}

export function normalizeQutPayPhone(input: string): string {
  const compact = input.trim().replace(/[\s()-]/g, '').replace(/^\+7/, '7').replace(/^8(?=\d{10}$)/, '7');
  if (!/^7\d{10}$/.test(compact)) throw new QutPaySandboxError('input');
  return compact;
}

export class QutPaySandbox {
  constructor(private readonly apiKey: string, private readonly fetchFn: GatewayFetchFn = fetch) {
    if (!/^qp_test_[A-Za-z0-9_-]+$/.test(apiKey)) throw new QutPaySandboxError('configuration');
  }

  async createPhoneInvoice(input: { amount: number; phone: string; orderId: string; description: string }) {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || !/^[A-Za-z0-9:_-]{1,100}$/.test(input.orderId)) {
      throw new QutPaySandboxError('input');
    }
    const invoice = await this.request('/invoices', {
      method: 'POST',
      idempotencyKey: input.orderId,
      body: JSON.stringify({
        kind: 'phone',
        amount: input.amount,
        customer: { phone: normalizeQutPayPhone(input.phone) },
        externalOrderId: input.orderId,
        description: input.description,
      }),
    });
    if (invoice.externalOrderId !== input.orderId || invoice.amount !== input.amount) {
      throw new QutPaySandboxError('unexpected_invoice');
    }
    return invoice;
  }

  async getPhoneInvoice(invoiceId: string) {
    if (!INVOICE_ID.test(invoiceId)) throw new QutPaySandboxError('input');
    const invoice = await this.request(`/invoices/${invoiceId}`, { method: 'GET' });
    if (invoice.id !== invoiceId) throw new QutPaySandboxError('unexpected_invoice');
    return invoice;
  }

  private async request(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<SandboxPhoneInvoice> {
    const result = await gatewayJsonRequest(`${API_URL}${path}`, {
      ...init,
      headers: { 'X-API-Key': this.apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    }, this.fetchFn);
    if (!result.ok) {
      const uncertain = result.status === 0 || result.status >= 500;
      throw new QutPaySandboxError(uncertain ? 'uncertain' : 'provider', result.status);
    }
    const { mode, kind, currency, id, externalOrderId, amount, status, payUrl, expiresAt, paidAt } = result.data ?? {};
    if (mode !== 'sandbox' || kind !== 'phone' || currency !== 'KZT' ||
        typeof id !== 'string' || !INVOICE_ID.test(id) || typeof externalOrderId !== 'string' ||
        typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0 ||
        !INVOICE_STATUSES.includes(status as InvoiceStatus) || typeof payUrl !== 'string') {
      throw new QutPaySandboxError('unexpected_invoice');
    }
    let hostedUrl: URL;
    try {
      hostedUrl = new URL(payUrl);
    } catch {
      throw new QutPaySandboxError('unexpected_invoice');
    }
    if (hostedUrl.origin !== 'https://qut.kz' || hostedUrl.username || hostedUrl.password || hostedUrl.pathname !== `/pay/${id}`) {
      throw new QutPaySandboxError('unexpected_invoice');
    }
    return {
      id,
      externalOrderId,
      status: status as InvoiceStatus,
      amount,
      payUrl: hostedUrl.href,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
      paidAt: typeof paidAt === 'string' ? paidAt : null,
    };
  }
}

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
