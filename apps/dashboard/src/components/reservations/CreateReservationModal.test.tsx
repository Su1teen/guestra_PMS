import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import CreateReservationModal from './CreateReservationModal';
import { api } from '../../lib/api';
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT', properties: [] }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('../guests/FindGuest', () => ({ default: ({ onSelectGuest }: any) => <button onClick={() => onSelectGuest({ id: 'guest-a', firstName: 'Анна', lastName: 'Иванова' })}>Select test guest</button> }));
const prefill = { roomId: 'room-a', roomNumber: '101', roomTypeId: 'type-a', roomTypeName: 'Стандарт', checkInDate: '2026-10-10', checkOutDate: '2026-10-12' };
const price = { currency: 'KZT', totalAmount: '2640.02', taxTotal: '240.00', lineItems: [{ date: '2026-10-10', rate: '1200.01', tax: '120.00' }, { date: '2026-10-11', rate: '1200.01', tax: '120.00' }] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue({ data: [{ id: 'plan-a', name: 'Тариф A', roomTypeId: 'type-a' }] });
  vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === '/v1/reservations/quote' ? price : { id: 'reservation-a' } }));
  vi.mocked(api.patch).mockResolvedValue({ data: {} });
});
async function start() {
  renderWithProviders(<CreateReservationModal open prefill={prefill} onClose={vi.fn()}/>);
  await userEvent.click(screen.getByRole('button', { name: 'Select test guest' }));
  const button = await screen.findByRole('button', { name: /Create and confirm/ });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}
describe('calendar booking server price', () => {
  it('creates using server decimals and the selected property', async () => {
    await userEvent.click(await start());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/staff-create', expect.objectContaining({ expectedTotal: '2640.02', currencyCode: 'KZT', propertyId: 'hotel-a', ratePlanId: 'plan-a' }), expect.anything()));
  });
  it('refuses creation when the fresh quote changes', async () => {
    const button = await start();
    vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === '/v1/reservations/quote' ? { ...price, totalAmount: '2800.00' } : { id: 'reservation-a' } }));
    await userEvent.click(button);
    await screen.findByText('The price has changed. Review the new total and confirm again.');
    expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === '/v1/reservations/staff-create')).toHaveLength(0);
  });
  it('retries the identical atomic request after a lost response', async () => {
    let attempts = 0;
    vi.mocked(api.post).mockImplementation(async (url) => {
      if (url === '/v1/reservations/quote') return { data: price };
      if (++attempts === 1) throw new Error('Network Error');
      return { data: { id: 'reservation-a', replayed: true } };
    });
    await userEvent.click(await start());
    await screen.findByText(/The server response was lost/);
    await userEvent.click(screen.getByRole('button', { name: 'Continue booking' }));
    await waitFor(() => expect(attempts).toBe(2));
    const calls = vi.mocked(api.post).mock.calls.filter(([url]) => url === '/v1/reservations/staff-create');
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(api.patch).not.toHaveBeenCalled();
  });
});
