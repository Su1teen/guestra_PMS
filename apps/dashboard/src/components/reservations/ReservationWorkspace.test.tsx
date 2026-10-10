import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import { GuestQuickViewProvider } from '../guests/GuestQuickView';
import ReservationWorkspace from './ReservationWorkspace';
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'staff-a' }, hasPermission: (...permissions: string[]) => permissions.every(p => ['guests.read', 'reservations.read'].includes(p)) }) }));
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT', properties: [{ id: 'hotel-a' }], setPropertyId: vi.fn() }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn() } }));
vi.mock('./ReservationPartyPanel', () => ({ default: () => <div/> }));
const guest = { id: 'guest-a', firstName: 'Анна', lastName: 'Тест', notes: 'Без перьевых подушек' };
const reservation = { id: 'stay-a', guestId: guest.id, status: 'cancelled', arrivalDate: '2026-05-01', departureDate: '2026-05-03', adults: 1, children: 0,
  notes: 'Проверить время приезда', specialRequests: 'Тихий этаж' };
const guest360 = { guest, summary: { totalStays: 0, propertiesVisited: [], currencyCode: 'KZT', roomRevenue: 0, ancillaryRevenue: 0, totalRevenue: 0, averageSpendPerStay: 0 }, stays: [], services: [], timeline: [] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async url => ({ data: url.includes('/360') ? guest360 : url.endsWith('/notes') ? { notes: [{ id: 'note-a', body: 'Подготовить детскую кровать' }] } : { reservation, guest, confirmationNumber: 'TEST' } }));
});
it('shows all four existing kinds of notes without opening a tab or another dialog', async () => {
  renderWithProviders(<GuestQuickViewProvider><ReservationWorkspace reservationId="stay-a" onClose={vi.fn()}/></GuestQuickViewProvider>);
  await screen.findByText(guest.notes);
  expect(screen.getByText(reservation.notes)).toBeInTheDocument();
  expect(screen.getByText(reservation.specialRequests)).toBeInTheDocument();
  expect(await screen.findByText('Подготовить детскую кровать')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('opens the guest by name and restores the same selected drawer after closing Quick View', async () => {
  const onClose = vi.fn();
  renderWithProviders(<GuestQuickViewProvider><ReservationWorkspace reservationId="stay-a" onClose={onClose}/></GuestQuickViewProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Анна Тест' }));
  await screen.findByRole('dialog', { name: /Guest quick view/ });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(onClose).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Анна Тест' })).toBeInTheDocument());
  expect(screen.getByText(reservation.notes)).toBeInTheDocument();
  expect(window.location.pathname).toBe('/');
});
