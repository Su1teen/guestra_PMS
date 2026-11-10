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
  sessionStorage.clear();
  vi.mocked(api.get).mockImplementation(async url => ({ data: url.includes('/360')
    ? { guest: { id: 'guest-a', firstName: 'Анна', lastName: 'Иванова' }, stays: [], bookedServices: [] }
    : url.includes('/booking-policy')
      ? { childAgeBands: [{ code: 'child_0_5', label: '0–5', minAge: 0, maxAge: 5, occupiesBed: true }], childAgeBandsConfigured: true,
        optionHoldHours: null, optionExpiryAction: null, depositPercentage: 30, autoSendConfirmation: true }
      : url.includes('/confirmation')
        ? { kind: 'proposal', status: 'pending', guest: { name: 'Анна', email: null, phone: null }, sent: { proposalAt: null, confirmationAt: null }, guarantee: {} }
        : [{ id: 'plan-a', name: 'Тариф A', roomTypeId: 'type-a' }] }));
  vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === '/v1/reservations/quote' ? price : { id: 'reservation-a' } }));
  vi.mocked(api.patch).mockResolvedValue({ data: {} });
});
async function start() {
  renderWithProviders(<CreateReservationModal open prefill={prefill} onClose={vi.fn()}/>);
  await userEvent.click(screen.getByRole('button', { name: 'Select test guest' }));
  const button = await screen.findByRole('button', { name: /Create option/ });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}
describe('calendar booking server price', () => {
  it('creates using server decimals and the selected property', async () => {
    await userEvent.click(await start());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/staff-create', expect.objectContaining({ expectedTotal: '2640.02', currencyCode: 'KZT', propertyId: 'hotel-a', ratePlanId: 'plan-a' }), expect.anything()));
  });
  it('starts as a tentative option with the policy guarantee and offers the guest document next', async () => {
    await userEvent.click(await start());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/staff-create',
      expect.objectContaining({ confirmation: 'tentative', requiredDeposit: '792.01', optionUntil: null }), expect.anything()));
    expect(await screen.findByText('Guest document')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send to guest/ })).toBeInTheDocument();
  });
  it('prices children by age and blocks pricing until every age is set', async () => {
    renderWithProviders(<CreateReservationModal open prefill={prefill} onClose={vi.fn()}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Select test guest' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Children +' }));
    expect(await screen.findByText('Enter the age of every child to price the stay.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Age of child 1'), '4');
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/quote', expect.objectContaining({ childAges: [4] }), expect.anything()));
  });
  it('sends the guarantee type when created as confirmed', async () => {
    const button = await start();
    await userEvent.click(screen.getByRole('radio', { name: /Confirmed now/ }));
    await userEvent.selectOptions(screen.getByLabelText('Guarantee'), 'card');
    await userEvent.click(await screen.findByRole('button', { name: /Create and confirm/ }));
    expect(button).toBeDefined();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/staff-create',
      expect.objectContaining({ confirmation: 'confirmed', guaranteeType: 'card' }), expect.anything()));
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
