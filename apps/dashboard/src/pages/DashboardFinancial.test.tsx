import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import Dashboard from './Dashboard';
import { renderWithProviders } from '../test/helpers';
import { layoutKey, workspaceTemplate } from '../lib/dashboard-layout';
import { PROPERTY, summary } from '../test/revenue-fixtures';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../lib/socket', () => ({ getSocket: () => ({ on: vi.fn(), off: vi.fn() }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'financial-reader' }, hasPermission: () => true }) }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: PROPERTY, isPortfolioMode: false, currencyCode: 'KZT', properties: [{ id: PROPERTY, timezone: 'Asia/Almaty' }] }) }));
vi.mock('../components/dashboard/WorkspaceSettings', () => ({ default: () => null }));
vi.mock('../components/dashboard/WorkspaceCanvas', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

beforeEach(() => {
  localStorage.clear(); api.get.mockReset();
  const layout = workspaceTemplate();
  layout.pages[0].widgets = [{ id: 'drr', type: 'drr', width: 3, height: 1, settings: { period: 'today', density: 'comfortable' } }];
  localStorage.setItem(layoutKey('financial-reader', PROPERTY), JSON.stringify(layout));
  api.get.mockImplementation((path: string) => Promise.resolve({ data: path.endsWith('management-summary')
    ? { data: { ...summary, financial: { ...summary.financial, actual: { ...summary.financial.actual, status: 'PARTIAL', closedDays: 0, expectedDays: 1 } } } }
    : path.endsWith('business-date') ? { data: { date: '2026-10-12', currencyCode: 'KZT', timezone: 'Asia/Almaty' } }
      : { persistent: false } }));
});

describe('Dashboard financial completeness', () => {
  it('keeps report errors inline instead of duplicating global validation toasts', async () => {
    const layout = workspaceTemplate();
    layout.pages[0].widgets = [
      { id: 'metrics', type: 'metrics', width: 3, height: 1, settings: { period: 'today', density: 'comfortable' } },
      { id: 'drr', type: 'drr', width: 3, height: 1, settings: { period: 'today', density: 'comfortable' } },
    ];
    localStorage.setItem(layoutKey('financial-reader', PROPERTY), JSON.stringify(layout));
    renderWithProviders(<Dashboard />);
    await waitFor(() => {
      for (const report of ['financial-summary', 'management-summary', 'occupancy']) {
        expect(api.get).toHaveBeenCalledWith('/v1/reports/' + report, expect.objectContaining({ skipErrorToast: true }));
      }
    });
  });
  it('uses shared DRR financial completeness when the separate metrics widget is hidden', async () => {
    renderWithProviders(<Dashboard />);
    expect(await screen.findByText(/2026-10-12 · PARTIAL · 0\/1 · charges.serviceDate/)).toBeInTheDocument();
    expect(screen.queryByText(/UNKNOWN/)).not.toBeInTheDocument();
    expect(api.get.mock.calls.some(([path]) => path.endsWith('financial-summary'))).toBe(false);
  });
});
