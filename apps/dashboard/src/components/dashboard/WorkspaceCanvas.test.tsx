import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import { workspaceTemplate } from '../../lib/dashboard-layout';
import WorkspaceCanvas from './WorkspaceCanvas';

vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ properties: [] }) }));

const layout = workspaceTemplate();
layout.pages[0].widgets = [{ id: 'metrics', type: 'metrics', width: 3, height: 1, settings: { period: 'today', density: 'comfortable' } }];
const refetch = vi.fn().mockResolvedValue({});
beforeEach(() => refetch.mockClear());

describe('Dashboard widget failures', () => {
  it('shows the report error instead of misdiagnosing every failure as a connection error', () => {
    renderWithProviders(<WorkspaceCanvas layout={layout} pageId={layout.startPageId} onChange={vi.fn()}
      queryStates={{ metrics: [{ isError: true, isPending: false, refetch, error: { response: { status: 403 } } }] }}>
      <div data-widget="metrics">Not a loaded KPI</div>
    </WorkspaceCanvas>);
    expect(screen.getByText('Access restricted')).toBeInTheDocument();
    expect(screen.queryByText('Not a loaded KPI')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument();
  });

  it('does not replace a loading report with fabricated zero KPIs', () => {
    renderWithProviders(<WorkspaceCanvas layout={layout} pageId={layout.startPageId} onChange={vi.fn()}
      queryStates={{ metrics: [{ isError: false, isPending: true, refetch }] }}>
      <div data-widget="metrics">Not a loaded KPI</div>
    </WorkspaceCanvas>);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Not a loaded KPI')).not.toBeInTheDocument();
  });
});
