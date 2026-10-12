import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Reports from './Reports';
import ManagementReport from './ManagementReport';
import { summary, PROPERTY } from '../test/revenue-fixtures';
import { formatMoney } from '../lib/money';
const state = vi.hoisted(() => ({ get: vi.fn(), propertyId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', portfolio: false, missing: false }));
vi.mock('../lib/api', () => ({ api: { get: state.get, patch: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: state.propertyId, currencyCode: state.portfolio ? null : 'KZT', isPortfolioMode: state.portfolio, properties: [{ id: PROPERTY, name: 'Hotel A' }] }) }));
beforeEach(() => {
  state.propertyId = PROPERTY; state.portfolio = false; state.missing = false; state.get.mockReset();
  state.get.mockImplementation((path, options) => {
    if (path.endsWith('business-date')) return Promise.resolve({ data: { date: options.params.propertyId === PROPERTY ? '2027-05-01' : '2027-05-02' } });
    if (path.includes('preferences')) return Promise.resolve({ data: {} });
    if (path.endsWith('management-summary')) return Promise.resolve({ data: summary });
    return Promise.resolve({ data: { date: options.params.date, currencyCode: 'KZT', actual: { ...summary.financial.actual, value: state.missing ? null : 115, status: state.missing ? 'NO_POSTINGS' : 'PARTIAL' }, revenue: { total: 140, room: 100 }, netRevenueByCategory: { room: 75, foodBeverage: 25, other: 15, tax: 9 }, adjustments: 16 } });
  });
});
function shell(children: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), path = '/reports?report=daily-revenue') {
  return <QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{children}</MemoryRouter></QueryClientProvider>;
}
describe('Live shared financial consumer boundary', () => {
  it('renders signed earned daily actuals/taxes/status and requests the operational date, resetting on property switch', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(shell(<Reports />, client));
    await screen.findByText(/115\.00/);
    expect(screen.queryByText(/140\.00/)).not.toBeInTheDocument();
    expect(screen.getByText(/PARTIAL · charges.serviceDate/)).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith('/v1/reports/daily-revenue', expect.objectContaining({ params: { propertyId: PROPERTY, date: '2027-05-01' } }));
    state.get.mockClear(); state.propertyId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; view.rerender(shell(<Reports />, client));
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/v1/reports/daily-revenue', expect.objectContaining({ params: { propertyId: state.propertyId, date: '2027-05-02' } })));
    expect(state.get.mock.calls.some(([path, opts]) => path.endsWith('daily-revenue') && opts.params.date === '2027-05-01')).toBe(false);
  });
  it('renders NO_POSTINGS as missing rather than confirmed zero', async () => {
    state.missing = true; render(shell(<Reports />));
    await screen.findByText(/NO_POSTINGS · charges.serviceDate/);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText(formatMoney(0, 'KZT'))).not.toBeInTheDocument();
  });
  it('defaults Management to authoritative shared actuals, isolates demo and resets the live date on property switch', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(shell(<ManagementReport />, client, '/management'));
    await screen.findByText('Total Revenue / Actual');
    expect(screen.queryByText('ДЕМО · MOCK DATA')).not.toBeInTheDocument();
    const date = view.container.querySelector('input[type="date"]')!;
    fireEvent.change(date, { target: { value: '2027-05-01' } });
    await waitFor(() => expect(state.get).toHaveBeenCalledWith('/v1/reports/management-summary', expect.objectContaining({ params: { propertyId: PROPERTY, date: '2027-05-01' } })));
    state.propertyId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; view.rerender(shell(<ManagementReport />, client, '/management'));
    expect(view.container.querySelector('input[type="date"]')).toHaveValue('');
    fireEvent.click(screen.getByRole('tab', { name: 'Демонстрация · MOCK DATA' }));
    expect(screen.queryByText('Total Revenue / Actual')).not.toBeInTheDocument();
    expect(screen.getByText('ДЕМО · MOCK DATA')).toBeInTheDocument();
  });
});
