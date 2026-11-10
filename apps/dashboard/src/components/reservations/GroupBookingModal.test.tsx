import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import GroupBookingModal from './GroupBookingModal';
import { api } from '../../lib/api';

vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT', properties: [] }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('../guests/FindGuest', () => ({ default: ({ onSelectGuest }: any) => <button onClick={() => onSelectGuest({ id: 'guest-a', firstName: 'Анна', lastName: 'Иванова', email: 'a@example.com' })}>Select test guest</button> }));

const quote = { currency: 'KZT', nights: 2, totalAmount: '80000.00', available: true, shortages: [],
  lines: [{ roomTypeId: 'type-a', ratePlanId: 'plan-a', quantity: 2, lineTotal: '80000.00', perRoom: { totalAmount: '40000.00' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data:
    url === '/v1/rooms/types' ? [{ id: 'type-a', name: 'Стандарт', maxOccupancy: 3 }]
    : url === '/v1/rate-plans' ? [{ id: 'plan-a', name: 'BAR', roomTypeId: 'type-a' }]
    : url.includes('/booking-policy') ? { childAgeBands: [], childAgeBandsConfigured: false, optionHoldHours: null, optionExpiryAction: null, depositPercentage: null, autoSendConfirmation: true }
    : url.includes('/confirmation') ? { kind: 'proposal', status: 'pending', guest: { name: 'Анна', email: 'a@example.com', phone: null }, sent: { proposalAt: null, confirmationAt: null }, guarantee: {} }
    : [] }));
  vi.mocked(api.post).mockImplementation(async (url: string) => ({ data: url === '/v1/reservations/quote/group' ? quote
    : { booking: { id: 'b1', confirmationNumber: 'HTL-G1', groupName: 'Свадьба' }, reservations: [{ id: 'r1' }, { id: 'r2' }], totalAmount: '80000.00' } }));
});

async function fill() {
  renderWithProviders(<GroupBookingModal open onClose={vi.fn()} initialCheckIn="2027-05-01" initialCheckOut="2027-05-03" />);
  await userEvent.type(screen.getByPlaceholderText('e.g. Spring conference'), 'Свадьба');
  await userEvent.click(screen.getByRole('button', { name: 'Select test guest' }));
  await userEvent.selectOptions(await screen.findByLabelText('Category'), 'type-a');
  const quantity = screen.getByLabelText('Rooms');
  await userEvent.clear(quantity);
  await userEvent.type(quantity, '2'); // clearing and typing must give 2, not 12
}

describe('group booking', () => {
  it('quotes every line and creates the whole group with the accepted total', async () => {
    await fill();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/quote/group',
      expect.objectContaining({ propertyId: 'hotel-a', checkIn: '2027-05-01', checkOut: '2027-05-03',
        rooms: [expect.objectContaining({ roomTypeId: 'type-a', ratePlanId: 'plan-a', quantity: 2, adults: 2 })] }), expect.anything()));
    const create = await screen.findByRole('button', { name: /Create group · 2 rooms/ });
    await waitFor(() => expect(create).toBeEnabled());
    await userEvent.click(create);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/group-booking',
      expect.objectContaining({ groupName: 'Свадьба', guestId: 'guest-a', expectedTotal: '80000.00', confirmation: 'tentative' }), expect.anything()));
    expect(await screen.findByText('Group no. HTL-G1 created')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send to guest/ })).toBeInTheDocument();
  });

  it('blocks creation and explains a shortage', async () => {
    vi.mocked(api.post).mockImplementation(async () => ({ data: { ...quote, available: false, shortages: [{ roomTypeId: 'type-a', requested: 2, available: 1 }] } }));
    await fill();
    expect(await screen.findByText('Only 1 of 2 available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create group/ })).toBeDisabled();
  });
});
