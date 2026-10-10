import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import WorkspaceReportWidget from './WorkspaceReportWidget';
import type { WorkspaceWidget } from '../../lib/dashboard-layout';
let allowed = true;
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'report-reader' }, hasPermission: () => allowed }) }));
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', properties: [
  { id: 'hotel-a', name: 'Отель А', timezone: 'Asia/Almaty', currencyCode: 'KZT' },
  { id: 'hotel-b', name: 'Отель Б', timezone: 'Asia/Almaty', currencyCode: 'EUR' },
] }) }));
vi.mock('../../lib/hotel-date', () => ({ hotelDate: () => '2026-10-10' }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn() } }));
const widget = (type: WorkspaceWidget['type'], period: WorkspaceWidget['settings']['period'] = 'past7'): WorkspaceWidget =>
  ({ id: type, type, width: 1, height: 1, settings: { propertyId: 'hotel-b', period, density: 'compact' } });
beforeEach(() => { allowed = true; vi.clearAllMocks(); });
describe('workspace reports', () => {
  it('reads the selected property and past period from the existing report', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { summary: { avgOccupancy: 0.75 } } });
    renderWithProviders(<WorkspaceReportWidget widget={widget('occupancy')}/>);
    await screen.findByText('75%');
    expect(api.get).toHaveBeenCalledWith('/v1/reports/occupancy-trend', expect.objectContaining({ params: { propertyId: 'hotel-b', startDate: '2026-10-04', endDate: '2026-10-10' } }));
  });
  it('uses a future stay window for booking pace and shows actual daily values', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { summary: { avgRoomsOnBooks: 4 }, daily: [{ date: '2026-10-11', roomsOnBooks: 7 }] } });
    renderWithProviders(<WorkspaceReportWidget widget={widget('bookingPace', 'next7')}/>);
    await screen.findByText('2026-10-11');
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/v1/reports/booking-pace', expect.objectContaining({ params: { propertyId: 'hotel-b', startDate: '2026-10-10', endDate: '2026-10-16' } }));
  });
  it('keeps errors distinct from a zero occupancy value', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('offline'));
    renderWithProviders(<WorkspaceReportWidget widget={widget('occupancy')}/>);
    await screen.findByRole('button', { name: 'Try Again' });
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
  it('does not fetch data without report permission', () => {
    allowed = false; renderWithProviders(<WorkspaceReportWidget widget={widget('pickup')}/>);
    expect(api.get).not.toHaveBeenCalled();
  });
});
