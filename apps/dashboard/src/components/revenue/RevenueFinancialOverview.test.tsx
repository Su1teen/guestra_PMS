import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import RevenueFinancialOverview from './RevenueFinancialOverview';
import { PROPERTY, summary } from '../../test/revenue-fixtures';
import { formatMoney } from '../../lib/money';
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../lib/api', () => ({ api }));
beforeEach(() => { api.get.mockReset(); api.get.mockResolvedValue({ data: summary }); });
function mount(canRead = true) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><RevenueFinancialOverview propertyId={PROPERTY} canRead={canRead} /></MemoryRouter></QueryClientProvider>);
}
describe('ReportsService financial overview', () => {
  it('renders currency-separated A/R while retaining valid earned KPIs', async () => {
    api.get.mockResolvedValue({ data: { ...summary, financial: { ...summary.financial,
      outstandingBalances: { ...summary.financial.outstandingBalances, accountsReceivableDue: null,
        accountsReceivableCurrencyStatus: 'CURRENCY_MISMATCH', accountsReceivableByCurrency: [{ currencyCode: 'USD', due: 250, credits: -30 }] } } } });
    mount(); await screen.findByText('Total Revenue / Actual');
    expect(within(screen.getByText('A/R').parentElement!).getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('receivables');
    expect(screen.getByRole('alert')).toHaveTextContent(formatMoney(250, 'USD', 'en'));
    expect(screen.getByRole('alert')).toHaveTextContent(formatMoney(-30, 'USD', 'en'));
    expect(screen.getByText('Total Revenue / Actual').parentElement!.children[1].textContent).toBe(formatMoney(12500, 'KZT', 'en'));
  });
  it('renders reconciled ledger amounts, operational date and currency, not cash/deposits as actual', async () => {
    mount(); await screen.findByText('Total Revenue / Actual');
    const card = screen.getByText('Total Revenue / Actual').parentElement!;
    expect(card.children[1].textContent).toBe(formatMoney(12500, 'KZT', 'en'));
    expect(within(card).queryByText(formatMoney(4000, 'KZT', 'en'))).not.toBeInTheDocument();
    expect(screen.getByText(/Whole property, operational date/)).toHaveTextContent('2026-10-12');
    expect(screen.getByText(/Forecast · INSUFFICIENT_HISTORY/)).toBeInTheDocument();
    expect(screen.getByText('Plan to Date · NO_PLAN')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open DRR & reconciliation' })).toHaveAttribute('href', `/reports?report=daily-revenue&propertyId=${PROPERTY}`);
    expect(api.get).toHaveBeenCalledWith('/v1/reports/revenue-overview', expect.objectContaining({ params: { propertyId: PROPERTY } }));
    for (const label of ['MTD', 'YTD', 'LY', 'LYTD', 'Room Revenue', 'F&B Revenue', 'Ancillary Revenue', 'ALOS']) expect(screen.getByText(label)).toBeInTheDocument();
  });
  it('renders missing actuals as unavailable and partial coverage honestly', async () => {
    api.get.mockResolvedValue({ data: { ...summary, financial: { ...summary.financial, actual: { ...summary.financial.actual, value: null, status: 'NO_POSTINGS', closedDays: 0 } } } });
    mount(); await screen.findByText('Total Revenue / Actual');
    expect(within(screen.getByText('Total Revenue / Actual').parentElement!).getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Missing postings are not zero revenue');
    expect(screen.getByText('NO_POSTINGS · 0/1')).toBeInTheDocument();
  });
  it('does not query without report permission and exposes actionable network failure', async () => {
    const view = mount(false); expect(api.get).not.toHaveBeenCalled(); view.unmount();
    api.get.mockRejectedValue({ response: { status: 503, data: { message: 'Report unavailable' } } });
    mount(); expect(await screen.findByRole('alert')).toHaveTextContent('Report unavailable');
    expect(screen.getByRole('button', { name: 'Retry KPIs' })).toBeInTheDocument();
  });
});
