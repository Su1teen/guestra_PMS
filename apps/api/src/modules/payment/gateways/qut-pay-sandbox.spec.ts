import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { QutPaySandbox, normalizeQutPayPhone, verifyQutPayWebhook } from './qut-pay-sandbox';

const apiKey = 'qp_test_fixture';
const input = { amount: 20_000, phone: '+7 (700) 123-45-67', orderId: 'deposit:123', description: '�।����� �஭�' };
const fixture = {
  id: 'inv_SAMPLE', externalOrderId: input.orderId, status: 'pending', amount: input.amount,
  mode: 'sandbox', kind: 'phone', currency: 'KZT', payUrl: 'https://qut.kz/pay/inv_SAMPLE',
};

describe('QUT Pay sandbox phone invoices', () => {
  it('creates a phone invoice and keeps the same order and idempotency key on a replay', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(fixture, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ ...fixture, idempotentReplay: true }));
    const adapter = new QutPaySandbox(apiKey, send);
    expect(await adapter.createPhoneInvoice(input)).toEqual(await adapter.createPhoneInvoice(input));
    for (const [url, options] of send.mock.calls) {
      expect(url).toBe('https://api.qut.kz/api/v1/invoices');
      expect(options).toMatchObject({ method: 'POST', redirect: 'error' });
      const headers = new Headers(options?.headers);
      expect(headers.get('X-API-Key')).toBe(apiKey);
      expect(headers.get('Idempotency-Key')).toBe(input.orderId);
      expect(JSON.parse(String(options?.body))).toEqual({
        amount: 20_000, customer: { phone: '77001234567' }, description: input.description,
        externalOrderId: input.orderId, kind: 'phone',
      });
    }
  });

  it('rejects bad phones, live keys and fractional tenge before sending', async () => {
    const send = vi.fn<typeof fetch>();
    const adapter = new QutPaySandbox(apiKey, send);
    expect(normalizeQutPayPhone('8 700 123 45 67')).toBe('77001234567');
    expect(() => new QutPaySandbox('qp_live_fixture', send)).toThrow();
    await expect(adapter.createPhoneInvoice({ ...input, amount: 0.5 })).rejects.toMatchObject({ code: 'input' });
    await expect(adapter.createPhoneInvoice({ ...input, phone: '1234567' })).rejects.toMatchObject({ code: 'input' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([{ mode: 'live' }, { kind: 'qr' }, { currency: 'USD' }, { amount: 40_000 },
    { externalOrderId: 'different' }, { payUrl: 'https://outside.example/pay/inv_SAMPLE' },
    { payUrl: 'https://qut.kz/pay/inv_OTHER' }])('rejects an inconsistent invoice response: %j', async (changes) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...fixture, ...changes }));
    await expect(new QutPaySandbox(apiKey, send).createPhoneInvoice(input))
      .rejects.toMatchObject({ code: 'unexpected_invoice' });
  });

  it('reads a paid invoice independently of the webhook', async () => {
    const paidAt = '2026-11-24T00:30:00.000Z';
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...fixture, status: 'paid', paidAt }));
    const adapter = new QutPaySandbox(apiKey, send);
    await expect(adapter.getPhoneInvoice(fixture.id)).resolves.toMatchObject({ status: 'paid', paidAt });
    expect(send).toHaveBeenCalledWith(`https://api.qut.kz/api/v1/invoices/${fixture.id}`, expect.objectContaining({ method: 'GET' }));
  });

  it('reports the absence of a definitive create result without leaking provider bodies', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: 'kaspi_create_unconfirmed', phone: input.phone }, { status: 502 }))
      .mockRejectedValueOnce(new Error(apiKey));
    const adapter = new QutPaySandbox(apiKey, send);
    await expect(adapter.createPhoneInvoice(input)).rejects.toMatchObject({ code: 'uncertain', providerStatus: 502 });
    await expect(adapter.createPhoneInvoice(input)).rejects.toMatchObject({ code: 'uncertain', providerStatus: 0 });
  });
});

describe('QUT Pay sandbox webhook signatures', () => {
  const secret = 'fixture-webhook-secret';
  const body = Buffer.from('{"label": "�।�����"}\n');
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
