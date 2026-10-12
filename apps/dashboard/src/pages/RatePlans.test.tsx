import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RatePlans from './RatePlans';
import { PROPERTY, plan, calendar } from '../test/revenue-fixtures';
const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), allowed: true }));
vi.mock('../lib/api', () => ({ api: { get: state.get, post: state.post } }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', currencyCode: 'KZT', properties: [] }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'actor' }, hasPermission: (...keys: string[]) => !keys.includes('rateplans.manage') || state.allowed }) }));
beforeEach(() => {
  state.get.mockReset(); state.post.mockReset(); state.allowed = true; sessionStorage.clear();
  state.get.mockImplementation((path: string) => Promise.resolve({ data: path.endsWith('live-calendar') ? calendar : path.endsWith('/types') ? [{ id: PROPERTY, name: 'Standard' }] : path.endsWith('/restrictions') || path.endsWith('approval-queue') ? [] : path === '/v1/rate-plans' ? [plan] : plan }));
  state.post.mockResolvedValue({ data: { record: plan, replayed: false } });
});
function mount(path = '/rate-plans') {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path="/rate-plans/*" element={<RatePlans />} /></Routes></MemoryRouter></QueryClientProvider>);
}
describe('Rate Plans guarded contracts', () => {
  it('requires a creation reason and sends requestId/revision/currency/property with recovery', async () => {
    const view = mount(); await screen.findByRole('link', { name: 'Canonical BAR' });
    fireEvent.click(screen.getByRole('button', { name: /New Rate Plan/i }));
    const dialog = screen.getByRole('dialog');
    const text = dialog.querySelectorAll('input[type="text"]');
    fireEvent.change(text[0], { target: { value: 'New BAR' } }); fireEvent.change(text[1], { target: { value: 'BAR2' } });
    const room = dialog.querySelectorAll('select')[1];
    fireEvent.change(room, { target: { value: PROPERTY } });
    fireEvent.change(dialog.querySelector('input[type="number"]')!, { target: { value: '19000' } });
    expect(screen.getByRole('button', { name: 'Create Rate Plan' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Required creation reason'), { target: { value: 'New commercial plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Rate Plan' }));
    await waitFor(() => expect(state.post).toHaveBeenCalled());
    expect(state.post).toHaveBeenCalledWith('/v1/rate-plans', expect.objectContaining({ propertyId: PROPERTY, currencyCode: 'KZT', expectedRevision: 0, requestId: expect.any(String), reason: 'New commercial plan', baseAmount: '19000.00' }), expect.objectContaining({ params: { propertyId: PROPERTY } }));
    await screen.findByText(/Saved · New commercial plan/);
    view.unmount(); state.allowed = false; mount();
    expect(screen.queryByRole('button', { name: /New Rate Plan/i })).not.toBeInTheDocument();
  });
  it('uses canonical calendar quote and redirects existing edits to the guarded live workflow', async () => {
    mount('/rate-plans/' + plan.id); await screen.findByRole('link', { name: 'Preview global plan change →' });
    expect(screen.getByRole('link', { name: 'Preview global plan change →' })).toHaveAttribute('href', `/revenue?ratePlanId=${plan.id}&kind=plan&propertyId=${PROPERTY}`);
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/v1/rate-plans/live-calendar', expect.objectContaining({ params: expect.objectContaining({ propertyId: PROPERTY, ratePlanId: plan.id, nights: 1 }) })));
    expect(state.post).not.toHaveBeenCalled();
    expect(screen.getByText(/canonical one-night price and quote including tax/)).toBeInTheDocument();
  });
});
