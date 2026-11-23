import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../components/ui/Toast';
import Reservations from './Reservations';
import { hotelDate } from '../lib/hotel-date';

vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'prop-1', currencyCode: 'KZT', properties: [{ id: 'prop-1', timezone: 'Asia/Almaty' }] }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
import { api } from '../lib/api';

const today = hotelDate('Asia/Almaty');
const plus = (days: number) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const calendar = {
  complete: true, rooms: [{ id: 'room-1', number: '101', roomTypeId: 'rt', status: 'vacant_clean' }, { id: 'room-2', number: '102', roomTypeId: 'rt', status: 'out_of_order' }],
  roomTypes: [{ id: 'rt', name: 'Шале' }], reservations: [], blocks: [], inventoryBlocks: [], availability: [],
  history: [{ id: 'old', roomId: 'room-1', roomTypeId: 'rt', status: 'cancelled', arrivalDate: plus(1), departureDate: plus(3), guestName: 'Ушедший Гость', confirmationNumber: 'LES-9' }],
};

function renderCalendar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<MemoryRouter initialEntries={['/calendar']}><QueryClientProvider client={client}><ToastProvider><Reservations/></ToastProvider></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url === '/v1/reservations/calendar' ? calendar : [] }) as any);
});

describe('tape chart history and today', () => {
  it('marks today, badges an out-of-order room, and shows history only when asked without blocking the room', async () => {
    renderCalendar();
    expect(await screen.findByText('101')).toBeInTheDocument();
    expect(document.querySelector('th[aria-current="date"]')).not.toBeNull();
    expect(screen.getAllByText('Ремонт').length).toBeGreaterThan(0);
    expect(screen.queryByText('Ушедший Гость')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/История/));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/v1/reservations/calendar', expect.objectContaining({ params: expect.objectContaining({ includeHistory: true }) })));
    expect(await screen.findByRole('button', { name: /Отменена, LES-9/ })).toBeInTheDocument();
    // The cancelled stay's night stays free to sell.
    const night = screen.getByRole('button', { name: new RegExp(`101.*${plus(1)}|${plus(1)}.*101`) });
    expect(night).not.toBeDisabled();
  });
});
