import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { format } from 'date-fns';
import DynamicPricing from './DynamicPricing';
const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { get: state.get } }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', isPortfolioMode: false, currencyCode: 'KZT', properties: [] }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ data, onClick }: { data: { date: string }[]; onClick: (s: unknown) => void }) => <button type="button" onClick={() => onClick({ activePayload: [{ payload: data[1] }] })}>Choose second chart date: {data[1]?.date}</button>,
  Line: () => null, Bar: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null, ReferenceLine: () => null,
}));
beforeEach(() => { state.get.mockReset(); state.get.mockResolvedValue({ data: {} }); });
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><DynamicPricing /></MemoryRouter></QueryClientProvider>);
}
describe('read-only pricing simulation', () => {
  it('labels scenario amounts and synthetic demand distinctly from confirmed forecast, retaining the solver', () => {
    mount();
    expect(screen.getByText(/Does not change live rates/)).toBeInTheDocument();
    expect(screen.getByText(/Synthetic demand is never applied to Live/)).toBeInTheDocument();
    expect(screen.getByText(/Real forecast: INSUFFICIENT_HISTORY/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Live Rate Management →' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calculate base rate' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(31);
  });
  it('synchronizes chart date selection with the pricing waterfall without a mutation', () => {
    mount(); const chart = screen.getByRole('button', { name: /Choose second chart date/ });
    const date = chart.textContent!.split(': ')[1]; fireEvent.click(chart);
    const selected = document.querySelector('tr.bg-telivity-teal\\/10');
    expect(selected).toHaveTextContent(format(new Date(`${date}T00:00:00`), 'd MMM'));
    expect(state.get.mock.calls.every(([path]) => ['/v1/reports/occupancy', '/v1/reports/booking-pace'].includes(path))).toBe(true);
  });
});
