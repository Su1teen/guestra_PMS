import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PROPERTY, PLAN, REQUEST, plan, preview, proposal, rate } from '../../test/revenue-fixtures';
import { pricingRecoveryKey } from '../../lib/live-revenue';
import LiveRateWorkflow from './LiveRateWorkflow';

const state = vi.hoisted(() => ({ actor: 'reviewer', allowed: new Set(['rateplans.read', 'rateplans.manage', 'revenue.manage']), get: vi.fn(), post: vi.fn() }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: state.actor }, hasPermission: (...keys: string[]) => keys.every(k => state.allowed.has(k)) }) }));
vi.mock('../../lib/api', () => ({ api: { get: state.get, post: state.post } }));
beforeEach(() => {
  sessionStorage.clear(); state.get.mockReset(); state.post.mockReset(); state.actor = 'reviewer';
  state.allowed = new Set(['rateplans.read', 'rateplans.manage', 'revenue.manage']);
  state.get.mockImplementation((path: string) => Promise.resolve({ data: path.includes('/requests/') ? { state: 'unconfirmed' } : path.endsWith('/pricing-history') ? [] : [proposal] }));
  state.post.mockImplementation((path: string) => Promise.resolve({ data: path.endsWith('live-preview') ? preview : { record: proposal, replayed: false } }));
});
function mount(section = 'queue', edit = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn(); const invalidate = vi.spyOn(client, 'invalidateQueries');
  const view = render(<QueryClientProvider client={client}><LiveRateWorkflow propertyId={PROPERTY} section={section} editRate={edit ? rate : null} onCloseEditor={onClose} plans={[plan]} /></QueryClientProvider>);
  return { ...view, onClose, client, invalidate };
}
describe('guarded live rate workflow', () => {
  it('previews read-only, then submits the exact request/revision/stateToken without accepted-price writes', async () => {
    mount('overview', true);
    fireEvent.change(screen.getByLabelText('Required reason'), { target: { value: 'Reviewed by revenue manager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    await screen.findByRole('button', { name: 'Submit proposal' });
    expect(state.post).toHaveBeenCalledTimes(1);
    const [path, change, options] = state.post.mock.calls[0];
    expect(path).toBe('/v1/rate-plans/live-preview');
    expect(change).toMatchObject({ propertyId: PROPERTY, ratePlanId: PLAN, expectedRevision: 7, reason: 'Reviewed by revenue manager', kind: 'restriction_create' });
    expect(options.params.propertyId).toBe(PROPERTY);
    expect(change.stateToken).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Submit proposal' }));
    await screen.findByText(/Saved · pending/);
    expect(state.post.mock.calls[1][0]).toBe('/v1/rate-plans/rate-changes');
    expect(state.post.mock.calls[1][1]).toEqual({ ...change, stateToken: preview.stateToken });
    expect(sessionStorage.getItem(pricingRecoveryKey(PROPERTY, 'reviewer'))).toBeNull();
    expect(state.post.mock.calls.every(([url]) => !String(url).includes('/reservations'))).toBe(true);
  });
  it('sends proposal revision and identical recovery ID for decisions, then invalidates canonical/financial queries', async () => {
    const { invalidate } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'Validated canonical quotes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/Saved · pending/);
    expect(state.post).toHaveBeenCalledWith(`/v1/rate-plans/rate-changes/${REQUEST}/apply`, expect.objectContaining({ expectedRevision: 2, reason: 'Validated canonical quotes', requestId: expect.any(String) }), expect.objectContaining({ params: { propertyId: PROPERTY } }));
    for (const key of ['rate-plans', 'reports', 'dashboard', 'revenue']) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
  });
  it('blocks self approval, premature apply and write controls without permissions', async () => {
    state.actor = 'initiator'; state.get.mockResolvedValue({ data: [{ ...proposal, preview: { ...preview, approvalRequired: true } }] });
    const view = mount(); await screen.findByText('Canonical rule review');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    view.unmount(); state.allowed = new Set(['rateplans.read']);
    mount(); await screen.findByText('Canonical rule review');
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });
  it('surfaces stale preview without submission or silent retry', async () => {
    state.post.mockRejectedValue({ response: { status: 409, data: { code: 'STALE_PREVIEW' } } });
    mount('overview', true);
    fireEvent.change(screen.getByLabelText('Required reason'), { target: { value: 'Change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh and preview again');
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Submit proposal' })).not.toBeInTheDocument();
  });
  it('persists an ambiguous write, verifies state and retries the exact immutable body', async () => {
    state.post.mockRejectedValueOnce({ response: { status: 503, data: { message: 'Lost response' } } });
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const retry = await screen.findByRole('button', { name: 'Retry identical request' });
    await waitFor(() => expect(retry).toBeEnabled());
    const saved = JSON.parse(sessionStorage.getItem(pricingRecoveryKey(PROPERTY, 'reviewer'))!);
    expect(saved.requestId).toBe(state.post.mock.calls[0][1].requestId);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    fireEvent.click(retry); await screen.findByText(/Saved · pending/);
    expect(state.post.mock.calls[1]).toEqual(state.post.mock.calls[0]);
    expect(sessionStorage.length).toBe(0);
  });
  it('restores actor/property-scoped requests after navigation and acknowledges committed outcomes without rewriting', async () => {
    const saved = { propertyId: PROPERTY, requestId: REQUEST, path: `/v1/rate-plans/rate-changes/${REQUEST}/apply`, body: { requestId: REQUEST, expectedRevision: 2, reason: 'Review' } };
    sessionStorage.setItem(pricingRecoveryKey(PROPERTY, 'reviewer'), JSON.stringify(saved));
    state.get.mockImplementation((url: string) => Promise.resolve({ data: url.includes('/requests/') ? { state: 'committed', record: proposal } : [proposal] }));
    mount('overview', true);
    expect(await screen.findByRole('button', { name: 'Acknowledge & refresh' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(state.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge & refresh' }));
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });
  it('renders approval/audit history with before/after and property scope', async () => {
    state.get.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('/pricing-history') ? [{ id: REQUEST, occurredAt: '2026-10-12T00:00:00Z', userEmail: 'reviewer@example.invalid', description: 'Rate changed', previousValue: { baseAmount: '10000' }, newValue: { baseAmount: '12000' } }] : [proposal] }));
    mount('history'); await screen.findByText(/reviewer@example.invalid/);
    expect(screen.getAllByText(/"baseAmount": "12000"/)).toHaveLength(2);
    expect(state.get).toHaveBeenCalledWith('/v1/rate-plans/pricing-history', expect.objectContaining({ params: { propertyId: PROPERTY } }));
  });
});
