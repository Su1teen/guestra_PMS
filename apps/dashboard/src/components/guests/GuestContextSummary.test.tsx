import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import GuestContextSummary from './GuestContextSummary';
import type { Guest360 } from './Guest360Panel';
let allowed = true;
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'staff-a' }, hasPermission: () => allowed }) }));
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ setPropertyId: vi.fn() }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn() } }));
const guest = { id: 'guest-a', firstName: 'Анна', lastName: 'Тест', notes: 'Тихий номер. Аллергия на перо.' };
beforeEach(() => { allowed = true; vi.clearAllMocks(); });
describe('guest context under the selected booking', () => {
  it('shows profile notes immediately while the API is still loading', () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<GuestContextSummary guest={guest} propertyId="hotel-a"/>);
    expect(screen.getByText(guest.notes)).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/v1/guests/guest-a/360', expect.objectContaining({ params: { propertyId: 'hotel-a' } }));
  });
  it('expands actual history, excludes the current booking, and links with property scope', async () => {
    const data = { guest, stays: [
      { id: 'current', propertyId: 'hotel-a', arrivalDate: '2026-10-10', departureDate: '2026-10-12', status: 'confirmed' },
      { id: 'previous', propertyId: 'hotel-a', propertyName: 'Отель A', arrivalDate: '2026-05-01', departureDate: '2026-05-03', status: 'checked_out', roomNumber: '101' },
    ], bookedServices: [] } as unknown as Guest360;
    renderWithProviders(<GuestContextSummary guest={guest} data={data} propertyId="hotel-a" excludeReservationId="current"/>);
    expect(screen.queryByText('2026-05-01 — 2026-05-03')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous bookings (1)' }));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/reservations/previous?propertyId=hotel-a');
    expect(screen.queryByText('2026-10-10 — 2026-10-12')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
  it('keeps supplied notes readable when Guest 360 fails and offers retry', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('Network Error'));
    renderWithProviders(<GuestContextSummary guest={guest} propertyId="hotel-a"/>);
    await screen.findByRole('button', { name: 'Try Again' });
    expect(screen.getByText(guest.notes)).toBeInTheDocument();
  });
  it('does not fetch or display a guest without permission', async () => {
    allowed = false;
    renderWithProviders(<GuestContextSummary guest={guest} propertyId="hotel-a"/>);
    await waitFor(() => expect(api.get).not.toHaveBeenCalled());
    expect(screen.queryByText(guest.notes)).not.toBeInTheDocument();
  });
});
