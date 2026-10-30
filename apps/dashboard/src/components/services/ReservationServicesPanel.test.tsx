import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import i18n from '../../i18n';
import ReservationServicesPanel from './ReservationServicesPanel';

vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'operator' }, hasPermission: () => true }) }));
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT', properties: [{ id: 'hotel-a', timezone: 'Asia/Almaty' }] }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
const openDocument = vi.hoisted(() => vi.fn());
vi.mock('../../lib/folio-document', () => ({ openFolioDocument: openDocument }));

const calendar = { complete: true, services: [{ id: 'svc', name: 'Массаж', isActive: true, durationMinutes: 60, agentBookingMode: 'live_booking', postingRule: 'on_consumption', taxMode: 'none' }],
  resources: [{ id: 'resource', serviceId: 'svc', name: 'Кабинет', capacity: 1, isActive: true, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }], bookings: [], blocks: [], allocations: [] };

beforeEach(async () => {
  await i18n.changeLanguage('ru'); vi.clearAllMocks(); sessionStorage.clear();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.endsWith('/history')) return { data: [] };
    if (path.startsWith('/v1/services/bookings/')) return { data: { id: 'b2', serviceId: 'svc', startAt: '2027-01-01T05:00:00Z', endAt: '2027-01-01T06:00:00Z', status: 'scheduled', revision: 1, participants: 1, quantity: 1, totalAmount: '15000.00', currencyCode: 'KZT', allocations: [{ resourceId: 'resource' }] } };
    if (path === '/v1/services/bookings') return { data: [{ id: 'b1', name: 'Массаж', status: 'scheduled', startAt: '2027-01-02T05:00:00Z', participants: 2, totalAmount: '15000.00', currencyCode: 'KZT' }] };
    if (path.includes('/ancillary/reservations/')) return { data: [] };
    if (path === '/v1/folios') return { data: { data: [{ id: 'folio-1', type: 'guest' }] } };
    return { data: calendar };
  });
  vi.mocked(api.post).mockImplementation(async (path: string) => path.endsWith('availability')
    ? { data: { available: true, pricing: { totalAmount: '15000.00', baseAmount: '15000.00', taxAmount: '0.00' }, currencyCode: 'KZT' } }
    : { data: { serviceBookingId: 'b2' } });
});

const reservation = { id: 'stay', guestId: 'guest', arrivalDate: '2027-01-01', departureDate: '2027-01-04', status: 'checked_in' };

it('lists the stay services and books a new one for the reservation guest without leaving the card', async () => {
  renderWithProviders(<ReservationServicesPanel reservation={reservation} propertyId="hotel-a"/>);
  expect(await screen.findByText(/Незавершённых услуг: 1/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Добавить услугу' }));
  await screen.findByRole('dialog', { name: 'Услуга для гостя брони' });
  expect(screen.queryByLabelText('Имя клиента')).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: 'Проверить время и стоимость' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Подтвердить запись' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/services/bookings',
    expect.objectContaining({ guestId: 'guest', reservationId: 'stay', expectedTotal: '15000.00' }), expect.anything()));
  expect(await screen.findByRole('dialog', { name: 'Карточка услуги' })).toBeInTheDocument();
});

it('opens the guest folio receipt of the reservation', async () => {
  renderWithProviders(<ReservationServicesPanel reservation={reservation} propertyId="hotel-a" readOnly/>);
  expect(screen.queryByRole('button', { name: 'Добавить услугу' })).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: /Фолио \(PDF\)/ }));
  await waitFor(() => expect(openDocument).toHaveBeenCalledWith('folio-1', 'hotel-a'));
});
