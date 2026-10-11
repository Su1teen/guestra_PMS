import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import Sidebar from './Sidebar';

const auth = vi.hoisted(() => ({
  permissions: new Set<string>(['reservations.read']),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    hasRole: () => true,
    hasPermission: (permission: string) => auth.permissions.has(permission),
  }),
}));

describe('Sidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    auth.permissions = new Set([
      'dashboard.view',
      'frontdesk.access',
      'reservations.read',
      'guests.read',
      'rooms.read',
      'housekeeping.read',
      'folios.read',
      'groups.read',
      'commercial.read',
      'cashier.access',
      'houseaccounts.read',
      'accounting.view',
      'tax.manage',
      'rateplans.read',
      'revenue.manage',
      'nightaudit.run',
      'reports.view',
      'channels.manage',
      'settings.manage',
      'communications.manage',
      'reviews.manage',
      'admin.users.manage',
    ]);
  });

  it('renders primary items and keeps advanced tools collapsed by default', async () => {
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={false} onClose={() => {}} />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Front Desk')).toBeInTheDocument();
    expect(screen.getByText('Reservations')).toBeInTheDocument();
    expect(screen.getByText('Booking Requests')).toBeInTheDocument();
    expect(screen.getByText('Guests')).toBeInTheDocument();
    expect(screen.getByText('Rooms')).toBeInTheDocument();
    expect(screen.getByText('Housekeeping')).toBeInTheDocument();
    expect(screen.getByText('Folios & Billing')).toBeInTheDocument();
    expect(screen.getByText('Rate Plans')).toBeInTheDocument();
    expect(screen.getByText('Night Audit')).toBeInTheDocument();
    expect(screen.getByText('Financial reports')).toBeInTheDocument();
    expect(screen.queryByText('Channels')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Advanced tools' }));
    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('shows booking requests only with reservations.read', () => {
    auth.permissions.delete('reservations.read');
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={false} onClose={() => {}} />);
    expect(screen.queryByText('Booking Requests')).not.toBeInTheDocument();

    auth.permissions.add('reservations.read');
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={false} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'Booking Requests' })).toHaveAttribute(
      'href',
      '/booking-requests',
    );
  });

  it('shows Guestra branding', () => {
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={false} onClose={() => {}} />);
    expect(screen.getByText('Guestra')).toBeInTheDocument();
    expect(screen.getByText('Hotel AI Platform')).toBeInTheDocument();
  });

  it('has hidden sidebar by default on mobile (translate-x-full)', () => {
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={false} onClose={() => {}} />);
    const aside = screen.getByRole('navigation', { name: /main/i }).closest('aside');
    expect(aside?.className).toContain('-translate-x-full');
  });

  it('shows sidebar when mobileOpen is true', () => {
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={true} onClose={() => {}} />);
    const aside = screen.getByRole('navigation', { name: /main/i }).closest('aside');
    expect(aside?.className).toContain('translate-x-0');
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={true} onClose={onClose} />);
    await userEvent.click(screen.getAllByLabelText('Close menu').at(-1)!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when a nav link is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={true} onClose={onClose} />);
    await userEvent.click(screen.getByText('Rooms'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders overlay when mobileOpen', () => {
    const { container } = renderWithProviders(
      <Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={true} onClose={() => {}} />,
    );
    const overlay = container.querySelector('.fixed.inset-0.bg-black\\/40');
    expect(overlay).toBeInTheDocument();
  });

  it('does not render overlay when closed', () => {
    const { container } = renderWithProviders(
      <Sidebar collapsed={false} onToggleCollapsed={() => {}} mobileOpen={false} onClose={() => {}} />,
    );
    const overlay = container.querySelector('.fixed.inset-0.bg-black\\/40');
    expect(overlay).not.toBeInTheDocument();
  });
  it('persists advanced tools and exposes a working collapsed control with accessible icons', async () => {
    const toggle=vi.fn();
    renderWithProviders(<Sidebar collapsed={true} onToggleCollapsed={toggle} mobileOpen={false} onClose={()=>{}}/>);
    await userEvent.click(screen.getByRole('button',{name:'Expand menu'}));expect(toggle).toHaveBeenCalledOnce();
    expect(screen.getByRole('link',{name:'Dashboard'})).toHaveAttribute('title','Dashboard');
    await userEvent.click(screen.getByRole('button',{name:'Advanced tools'}));
    expect(localStorage.getItem('guestra.navigation.advanced')).toBe('true');
    expect(screen.getByRole('link',{name:'Internal agents'})).toHaveAttribute('href','/revenue?section=agents');
  });
  it('opens an advanced direct destination and highlights only its tab', () => {
    window.history.replaceState({},'', '/settings?tab=users');
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={()=>{}} mobileOpen={false} onClose={()=>{}}/>);
    expect(screen.getByRole('button',{name:'Advanced tools'})).toHaveAttribute('aria-expanded','true');
    expect(screen.getByRole('link',{name:'Users & Roles'})).toHaveAttribute('aria-current','page');
    expect(screen.getByRole('link',{name:'Settings'})).not.toHaveAttribute('aria-current','page');
  });
  it('omits unauthorized advanced destinations', async () => {
    auth.permissions.delete('channels.manage');auth.permissions.delete('admin.users.manage');
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={()=>{}} mobileOpen={false} onClose={()=>{}}/>);
    await userEvent.click(screen.getByRole('button',{name:'Advanced tools'}));
    expect(screen.queryByRole('link',{name:'Channels'})).not.toBeInTheDocument();
    expect(screen.queryByRole('link',{name:'Users & Roles'})).not.toBeInTheDocument();
  });
  it('closes the mobile overlay with Escape and restores body scrolling', async () => {
    const close=vi.fn(); const {unmount}=renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={()=>{}} mobileOpen={true} onClose={close}/>);
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.keyboard('{Escape}');expect(close).toHaveBeenCalledOnce();
    unmount();expect(document.body.style.overflow).not.toBe('hidden');
  });
  it('still opens when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype,'getItem').mockImplementationOnce(()=>{throw Error('Storage denied');});
    renderWithProviders(<Sidebar collapsed={false} onToggleCollapsed={()=>{}} mobileOpen={false} onClose={()=>{}}/>);
    expect(screen.getByRole('link',{name:'Dashboard'})).toBeInTheDocument();
  });
});
