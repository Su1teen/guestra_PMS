import { describe, expect, it } from 'vitest';
import { canDecideChange, isAmbiguousPricingError, liveRateKey, pricingError, pricingRecoveryKey, readPricingRecovery, realisedMoney, ratioValue, unwrap, validCalendarRange, type RateChange, type FinancialKpis } from './live-revenue';
import { formatMoney } from './money';
import { kpis } from '../test/revenue-fixtures';

const requestId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const propertyId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const request = { requestId, propertyId, path: '/v1/rate-plans/rate-changes', body: { requestId, propertyId, expectedRevision: 3, reason: 'Human review' } };
const proposal = (approvalRequired = true, status: RateChange['status'] = 'pending') => ({ status, requestedBy: 'initiator', preview: { approvalRequired } } as RateChange);
describe('live revenue boundaries', () => {
  it('accepts at most 93 inclusive days and rejects impossible/reversed dates', () => {
    expect(validCalendarRange('2026-01-01', '2026-04-03')).toBe(true);
    expect(validCalendarRange('2026-01-01', '2026-04-04')).toBe(false);
    expect(validCalendarRange('2026-02-30', '2026-03-01')).toBe(false);
    expect(validCalendarRange('2026-02-01', '2026-01-01')).toBe(false);
    expect(validCalendarRange('', '')).toBe(false);
  });
  it('does not render missing actuals or unavailable ratios as zero', () => {
    const actual = { value: null, status: 'NO_POSTINGS', source: 'ledger', closedDays: 0, expectedDays: 1 };
    expect(realisedMoney(0, actual, 'KZT', 'ru')).toBe('—');
    expect(realisedMoney(0, { ...actual, value: 0, status: 'COMPLETE' }, 'KZT', 'ru')).toBe(formatMoney(0, 'KZT', 'ru'));
    expect(ratioValue({ ...kpis, adr: 0, ratioStatus: { adr: 'NO_ROOMS_SOLD' } } as FinancialKpis, 'adr')).toBeNull();
  });
  it('preserves partial amounts without fabrication or currency substitution', () => {
    const actual = { value: 100, status: 'PARTIAL', source: 'ledger', closedDays: 0, expectedDays: 1 };
    expect(realisedMoney(100, actual, 'KZT', 'ru')).toBe(formatMoney(100, 'KZT', 'ru'));
    expect(unwrap({ data: { status: 'INSUFFICIENT_HISTORY', value: null } })).toEqual({ status: 'INSUFFICIENT_HISTORY', value: null });
  });
  it('keeps calendar selection unique across date/plan', () => {
    expect(liveRateKey({ date: '2026-01-01', ratePlanId: 'plan' })).toBe('2026-01-01:plan');
  });
  it.each([undefined, 500, 502, 503])('recovers ambiguous status %s rather than generating a new request', status => {
    expect(isAmbiguousPricingError({ response: status ? { status } : undefined })).toBe(true);
  });
  it.each([400, 403, 409, 422])('does not blindly retry definitive status %s', status => {
    expect(isAmbiguousPricingError({ response: { status } })).toBe(false);
  });
  it('explains stale conflicts and permission errors actionably', () => {
    expect(pricingError({ response: { status: 409, data: { code: 'STALE_PREVIEW' } } }, false)).toContain('Refresh and preview again');
    expect(pricingError({ response: { status: 403 } }, false)).toContain('independent approver');
  });
});
describe('actor/property request fences', () => {
  it('restores the exact body and guard for identical retry', () => {
    expect(readPricingRecovery(JSON.stringify(request), propertyId)).toEqual(request);
    expect(pricingRecoveryKey(propertyId, 'actor-a')).not.toBe(pricingRecoveryKey(propertyId, 'actor-b'));
    expect(pricingRecoveryKey(propertyId, 'actor-a')).not.toBe(pricingRecoveryKey('other', 'actor-a'));
  });
  it('rejects corrupted, cross-property and mismatched request storage', () => {
    for (const value of [null, 'bad JSON', JSON.stringify({}), JSON.stringify({ ...request, propertyId: 'other' }), JSON.stringify({ ...request, body: { ...request.body, propertyId: 'other' } }), JSON.stringify({ ...request, requestId: 'different' })]) {
      expect(readPricingRecovery(value, propertyId)).toBeNull();
    }
  });
  it('only allows documented mutation paths, including guarded plan creation', () => {
    for (const path of ['/v1/rate-plans', `/v1/rate-plans/rate-changes/${requestId}/approve`, `/v1/rate-plans/rate-changes/${requestId}/apply`, `/v1/rate-plans/rate-changes/${requestId}/reject`]) expect(readPricingRecovery(JSON.stringify({ ...request, path }), propertyId)).not.toBeNull();
    for (const path of ['https://example.com', '/v1/reservations', '/v1/rate-plans/../../payments', '/v1/rate-plans/rate-changes/nope/apply']) expect(readPricingRecovery(JSON.stringify({ ...request, path }), propertyId)).toBeNull();
  });
});
describe('approval controls', () => {
  it('requires an independent authenticated actor under mandatory approval', () => {
    expect(canDecideChange(proposal(), 'approve', 'initiator', true, true)).toBe(false);
    expect(canDecideChange(proposal(), 'approve', undefined, true, true)).toBe(false);
    expect(canDecideChange(proposal(), 'approve', 'reviewer', true, true)).toBe(true);
    expect(canDecideChange(proposal(), 'apply', 'reviewer', true, true)).toBe(false);
    expect(canDecideChange(proposal(true, 'approved'), 'apply', 'reviewer', true, false)).toBe(true);
  });
  it('permits applying optional-approval proposals but never terminal ones or unauthorized writes', () => {
    expect(canDecideChange(proposal(false), 'apply', 'initiator', true, false)).toBe(true);
    expect(canDecideChange(proposal(false), 'apply', 'initiator', false, true)).toBe(false);
    expect(canDecideChange(proposal(false), 'reject', 'initiator', true, false)).toBe(false);
    for (const status of ['applied', 'rejected'] as const) for (const action of ['apply', 'approve', 'reject'] as const) expect(canDecideChange(proposal(false, status), action, 'reviewer', true, true)).toBe(false);
  });
});
