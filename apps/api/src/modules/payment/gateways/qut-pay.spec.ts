import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { maskQutPayPhone, normalizeQutPayPhone, QutPayClient, qutPayMode, verifyQutPayWebhook } from './qut-pay';

const apiKey = 'qp_test_fixture';
const input = { amount: 20_000, phone: '+7 (700) 123-45-67', orderId: 'deposit-123', description: 'Предоплата брони' };
const fixture = {
  id: 'inv_SAMPLE', externalOrderId: input.orderId, status: 'pending', amount: input.amount, refundedAmount: 0,
  mode: 'sandbox', kind: 'phone', currency: 'KZT', payUrl: 'https://qut.kz/pay/inv_SAMPLE', expiresAt: '2026-11-25T00:00:00.000Z',
};

describe('QUT Pay phone invoices', () => {
  it('derives the mode from the key and refuses anything else', () => {
    expect(qutPayMode('qp_test_abc')).toBe('test');
    expect(qutPayMode('qp_live_abc')).toBe('live');
    expect(qutPayMode('sk_live_abc')).toBeNull();
    expect(() => new QutPayClient('secret')).toThrow();
    expect(new QutPayClient('qp_live_abc', vi.fn()).mode).toBe('live');
  });

  it('creates a phone invoice and keeps the same order and idempotency key on a replay', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fixture, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ ...fixture, idempotentReplay: true }));
    const client = new QutPayClient(apiKey, send);
    const metadata = { reservationId: 'r1' };
    expect(await client.createPhoneInvoice({ ...input, metadata })).toEqual(await client.createPhoneInvoice({ ...input, metadata }));
    for (const [url, options] of send.mock.calls) {
      expect(url).toBe('https://api.qut.kz/api/v1/invoices');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      const headers = new Headers(options?.headers);
      expect(headers.get('X-API-Key')).toBe(apiKey);
      expect(headers.get('Idempotency-Key')).toBe(input.orderId);
      expect(JSON.parse(String(options?.body))).toEqual({
        amount: 20_000, customer: { phone: '77001234567' }, description: input.description,
        externalOrderId: input.orderId, kind: 'phone', metadata,
      });
    }
  });

  it('cuts the description to the 60 characters Kaspi shows', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture, { status: 201 }));
    await new QutPayClient(apiKey, send).createPhoneInvoice({ ...input, description: 'x'.repeat(80) });
    expect(JSON.parse(String(send.mock.calls[0]![1]?.body)).description).toHaveLength(60);
  });

  it('rejects bad phones and fractional tenge before sending', async () => {
    const send = vi.fn<typeof fetch>();
    const client = new QutPayClient(apiKey, send);
    expect(normalizeQutPayPhone('8 700 123 45 67')).toBe('77001234567');
    expect(normalizeQutPayPhone('+77001234567')).toBe('77001234567');
    expect(maskQutPayPhone('77011234567')).toBe('+7 701 ***-**-67');
    await expect(client.createPhoneInvoice({ ...input, amount: 0.5 })).rejects.toMatchObject({ code: 'input' });
    await expect(client.createPhoneInvoice({ ...input, phone: '1234567' })).rejects.toMatchObject({ code: 'input' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'live' }, { kind: 'qr' }, { currency: 'USD' }, { amount: 40_000 },
    { externalOrderId: 'different' }, { payUrl: 'https://outside.example/pay/inv_SAMPLE' },
    { payUrl: 'https://qut.kz/pay/inv_OTHER' }])('rejects an inconsistent invoice response: %j', async (changes) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...fixture, ...changes }));
    await expect(new QutPayClient(apiKey, send).createPhoneInvoice(input)).rejects.toMatchObject({ code: 'unexpected_invoice' });
  });

  it('a live key refuses sandbox invoices', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture));
    await expect(new QutPayClient('qp_live_x', send).getInvoice(fixture.id)).rejects.toMatchObject({ code: 'unexpected_invoice' });
  });

  it('reads, cancels and simulates by invoice id', async () => {
    const paidAt = '2026-11-24T00:30:00.000Z';
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...fixture, status: 'paid', paidAt }))
      .mockResolvedValueOnce(Response.json({ ...fixture, status: 'cancelled' }))
      .mockResolvedValueOnce(Response.json({ ...fixture, status: 'paid', paidAt }));
    const client = new QutPayClient(apiKey, send);
    await expect(client.getInvoice(fixture.id, true)).resolves.toMatchObject({ status: 'paid', paidAt });
    await expect(client.cancelInvoice(fixture.id)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(client.simulate(fixture.id, 'paid')).resolves.toMatchObject({ status: 'paid' });
    expect(send.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`https://api.qut.kz/api/v1/invoices/${fixture.id}?live=1`, 'GET'],
      [`https://api.qut.kz/api/v1/invoices/${fixture.id}/cancel`, 'POST'],
      [`https://api.qut.kz/api/v1/invoices/${fixture.id}/simulate`, 'POST'],
    ]);
    await expect(new QutPayClient('qp_live_x', send).simulate(fixture.id, 'paid')).rejects.toMatchObject({ code: 'input' });
  });

  it('finds the invoice of an order id, or none', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ total: 1, invoices: [fixture] }))
      .mockResolvedValueOnce(Response.json({ total: 0, invoices: [] }));
    const client = new QutPayClient(apiKey, send);
    await expect(client.findByOrderId(input.orderId)).resolves.toMatchObject({ id: fixture.id });
    await expect(client.findByOrderId(input.orderId)).resolves.toBeNull();
    expect(send.mock.calls[0]![0]).toBe(`https://api.qut.kz/api/v1/invoices?externalOrderId=${input.orderId}&limit=5`);
  });

  it('tells a definite refusal from an answer that never came', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'kaspi_create_unconfirmed', message: 'x' }, { status: 502 }))
      .mockRejectedValueOnce(new Error(apiKey))
      .mockResolvedValueOnce(Response.json({ error: 'kaspi_customer_not_found', message: 'x' }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ error: 'kaspi_session_expired', message: 'x' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: 'invoice_not_open', message: 'x' }, { status: 409 }));
    const client = new QutPayClient(apiKey, send);
    await expect(client.createPhoneInvoice(input)).rejects.toMatchObject({ code: 'uncertain', httpStatus: 502, providerCode: 'kaspi_create_unconfirmed' });
    await expect(client.createPhoneInvoice(input)).rejects.toMatchObject({ code: 'uncertain', httpStatus: 0 });
    await expect(client.createPhoneInvoice(input)).rejects.toMatchObject({ code: 'rejected', providerCode: 'kaspi_customer_not_found' });
    await expect(client.createPhoneInvoice(input)).rejects.toMatchObject({ code: 'rejected', providerCode: 'kaspi_session_expired' });
    await expect(client.cancelInvoice(fixture.id)).rejects.toMatchObject({ code: 'rejected', providerCode: 'invoice_not_open' });
  });

  it('never puts the key into an error message', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error(apiKey));
    const error = await new QutPayClient(apiKey, send).getInvoice(fixture.id).catch(e => e as Error);
    expect(error.message).not.toContain(apiKey);
  });
});

describe('QUT Pay webhook signatures', () => {
  const secret = 'fixture-webhook-secret';
  const body = Buffer.from('{"label": "предоплата"}\n');
  const timestamp = '1795480200';
  const now = Number(timestamp) * 1000;
  const signature = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');

  it('authenticates the exact body within the timestamp window', () => {
    expect(verifyQutPayWebhook(secret, body, timestamp, signature, now)).toBe(true);
    expect(verifyQutPayWebhook(secret, Buffer.from(body.toString().trim()), timestamp, signature, now)).toBe(false);
    expect(verifyQutPayWebhook(secret, body, timestamp, signature, now + 301_000)).toBe(false);
    expect(verifyQutPayWebhook(secret, body, timestamp, signature, now - 301_000)).toBe(false);
    expect(verifyQutPayWebhook('', body, timestamp, signature, now)).toBe(false);
    expect(verifyQutPayWebhook(secret, body, [timestamp], signature, now)).toBe(false);
    expect(verifyQutPayWebhook(secret, body, timestamp, 'sha256=bad', now)).toBe(false);
  });
});
