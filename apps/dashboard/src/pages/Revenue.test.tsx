import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Revenue from './Revenue';
import { PROPERTY, calendar, plan, summary } from '../test/revenue-fixtures';
const state = vi.hoisted(() => ({ propertyId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', allowed: true, get: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { get: state.get } }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: state.propertyId, isPortfolioMode: state.propertyId === 'portfolio', properties: [] }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'actor' }, hasPermission: () => state.allowed }) }));
vi.mock('./RevenueAdvanced', () => ({ default: () => <div>Preserved Advanced Tools</div> }));
beforeEach(() => {
  state.propertyId = PROPERTY; state.allowed = true; sessionStorage.clear(); state.get.mockReset();
  state.get.mockImplementation((path: string) => Promise.resolve({ data: path.endsWith('revenue-overview') ? summary : path.endsWith('live-calendar') ? calendar : path === '/v1/rate-plans' ? [plan] : [] }));
});
function mount(path = '/revenue') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Revenue /></MemoryRouter></QueryClientProvider>;
  return { ...render(element), element };
}
describe('Revenue live workspace routing and isolation', () => {
  it('defaults to real financial/calendar overview with unavailable forecast and simulation separation', async () => {
    mount(); await screen.findByText('Financial overview');
    expect(screen.getByRole('heading', { name: 'Revenue Management' })).toBeInTheDocument();
    expect(await screen.findByText('Configured canonical rules only')).toBeInTheDocument();
    expect(screen.queryByText('Preserved Advanced Tools')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open simulation' })).toHaveAttribute('href', `/dynamic-pricing?propertyId=${PROPERTY}`);
    expect(screen.getAllByText('Forecast · INSUFFICIENT_HISTORY')).toHaveLength(2);
  });
  it('preserves Advanced Tools and recovers unrecognized sections to overview', async () => {
    const view = mount('/revenue?section=agents'); expect(screen.getByText('Preserved Advanced Tools')).toBeInTheDocument(); view.unmount();
    mount('/revenue?section=obsolete'); expect(await screen.findByText('Financial overview')).toBeInTheDocument();
  });
  it('never sends live/calendar/report reads without grants or in portfolio mode', () => {
    state.allowed = false; const view = mount(); expect(state.get).not.toHaveBeenCalled(); view.unmount();
    state.propertyId = 'portfolio'; state.allowed = true; mount(); expect(state.get).not.toHaveBeenCalled();
    expect(screen.getByText(/Select a property/)).toBeInTheDocument();
  });
  it('resets filters/editor and scopes every read on property switch', async () => {
    const view = mount(); await screen.findByText('Financial overview');
    fireEvent.change(screen.getByLabelText('Quote nights'), { target: { value: '7' } });
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/v1/rate-plans/live-calendar', expect.objectContaining({ params: expect.objectContaining({ propertyId: PROPERTY, nights: 7 }) })));
    state.propertyId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
    view.rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Revenue /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByLabelText('Quote nights')).toHaveValue(1);
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/v1/rate-plans/live-calendar', expect.objectContaining({ params: expect.objectContaining({ propertyId: state.propertyId, nights: 1 }) })));
  });
});
