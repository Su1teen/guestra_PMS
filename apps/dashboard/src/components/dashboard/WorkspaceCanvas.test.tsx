import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen,fireEvent } from '@testing-library/react';
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
  it('shows editing controls only in Customize and commits keyboard move and resize',()=>{
    const onChange=vi.fn();const {rerender}=renderWithProviders(<WorkspaceCanvas layout={layout} pageId={layout.startPageId} onChange={onChange}><div data-widget="metrics">Показатели</div></WorkspaceCanvas>);
    expect(screen.queryByRole('button',{name:/Изменить размер/})).not.toBeInTheDocument();
    rerender(<WorkspaceCanvas customizing layout={layout} pageId={layout.startPageId} onChange={onChange}><div data-widget="metrics">Показатели</div></WorkspaceCanvas>);
    fireEvent.keyDown(screen.getByRole('button',{name:/^Move Hotel metrics widget$/}),{key:'ArrowDown'});
    expect(onChange.mock.calls[0][0].pages[0].widgets[0].grid.y).toBe(1);
    fireEvent.keyDown(screen.getByRole('button',{name:/Изменить размер/}),{key:'ArrowDown'});
    expect(onChange.mock.calls[1][0].pages[0].widgets[0].grid.h).toBe(7);
  });
});
