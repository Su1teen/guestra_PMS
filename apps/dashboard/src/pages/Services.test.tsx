import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/helpers';
import { api } from '../lib/api';
import Services from './Services';
import i18n from '../i18n';
import { serviceRecoveryKey } from '../lib/staff-booking-recovery';
const access = vi.hoisted(() => ({ read: true, write: true, finance: false, propertyId: 'hotel-a' as string | null }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'operator' }, hasPermission: (...keys: string[]) => keys.every(k => k === 'services.read' ? access.read : k === 'reservations.write' ? access.write : ['folios.manage','folios.read'].includes(k) ? access.finance : false) }) }));
vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: access.propertyId, currencyCode: 'KZT', properties: [{ id: 'hotel-a', timezone: 'Asia/Almaty' }] }) }));
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
const calendar = { complete: true, services: [{ id: 'svc', name: 'Массаж', isActive: true, durationMinutes: 60, agentBookingMode: 'live_booking', postingRule: 'on_consumption', taxMode: 'none' }], resources: [{ id: 'resource', serviceId: 'svc', name: 'Кабинет', capacity: 1, isActive: true, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 }], bookings: [], blocks: [], allocations: [] };
beforeEach(async () => {
  await i18n.changeLanguage('ru'); vi.clearAllMocks(); sessionStorage.clear(); access.read = true; access.write = true; access.finance = false; access.propertyId = 'hotel-a';
  window.history.replaceState({}, '', '/services?date=2027-01-01&propertyId=hotel-a');
  vi.mocked(api.get).mockImplementation(async path => {
    if (path.endsWith('/history')) return { data: [] };
    if (path.includes('/bookings/')) return { data: { id: 'accepted', serviceId: 'svc', startAt: '2027-01-01T04:00:00Z', endAt: '2027-01-01T05:00:00Z', status: 'scheduled', revision: 1, participants: 1, quantity: 1, totalAmount: '100.00', currencyCode: 'KZT', allocations: [{ resourceId: 'resource' }] } };
    return { data: calendar };
  });
  vi.mocked(api.post).mockImplementation(async path => path.endsWith('availability') ? { data: { available: true, pricing: { totalAmount: '100.00', baseAmount: '100.00', taxAmount: '0.00' }, currencyCode: 'KZT' } } : { data: { serviceBookingId: 'accepted' } });
});
it('requires a concrete permitted property and does not request portfolio data', () => {
  access.propertyId = 'portfolio'; renderWithProviders(<Services/>);
  expect(screen.getByText(/Выберите объект/)).toBeInTheDocument(); expect(api.get).not.toHaveBeenCalled();
});
it('shows the resource calendar without mutation controls for a read-only operator', async () => {
  access.write = false; renderWithProviders(<Services/>); await screen.findByRole('rowheader');
  expect(screen.queryByRole('button', { name: 'Записать на услугу' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '+ Записать' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Настроить' })).not.toBeInTheDocument();
});
it('uses one contextual form, previews server pricing and sends the selected resource and guest', async () => {
  window.history.replaceState({}, '', '/services?date=2027-01-01&action=book&guestId=guest&reservationId=stay&propertyId=hotel-a');
  renderWithProviders(<Services/>); await screen.findByRole('dialog', { name: 'Запись на услугу' });
  expect(screen.queryByLabelText('Имя клиента')).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('Ресурс'), 'resource');
  await userEvent.click(screen.getByRole('button', { name: 'Проверить время и стоимость' }));
  await screen.findByRole('button', { name: 'Подтвердить запись' });
  expect(api.post).toHaveBeenCalledWith('/v1/services/availability', expect.objectContaining({ propertyId: 'hotel-a', resourceId: 'resource', guestId: 'guest', startAt: '2027-01-01T04:00:00.000Z' }), expect.anything());
  await userEvent.click(screen.getByRole('button', { name: 'Подтвердить запись' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/services/bookings', expect.objectContaining({ guestId: 'guest', reservationId: 'stay', expectedTotal: '100.00', idempotencyKey: expect.any(String) }), expect.anything()));
});
it('retries an uncertain submission with its original key and unchanged payload', async () => {
  window.history.replaceState({}, '', '/services?date=2027-01-01&action=book&guestId=guest&propertyId=hotel-a');
  let submits = 0;
  vi.mocked(api.post).mockImplementation(async path => {
    if (path.endsWith('availability')) return { data: { available: true, pricing: { totalAmount: '100.00', baseAmount: '100.00', taxAmount: '0.00' }, currencyCode: 'KZT' } };
    if (++submits === 1) throw new Error('Network Error'); return { data: { serviceBookingId: 'accepted' } };
  });
  renderWithProviders(<Services/>); await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: 'Проверить время и стоимость' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Подтвердить запись' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Повторить исходный запрос' }));
  await waitFor(() => expect(submits).toBe(2));
  const requests = vi.mocked(api.post).mock.calls.filter(([path]) => path === '/v1/services/bookings');
  expect(requests[0]![1]).toEqual(requests[1]![1]);
  expect(sessionStorage.getItem(serviceRecoveryKey('operator', 'hotel-a'))).toBeNull();
});
it('restores only a token after reload and closes a never accepted request before allowing a fresh attempt', async () => {
  const token = crypto.randomUUID(); sessionStorage.setItem(serviceRecoveryKey('operator', 'hotel-a'), token);
  vi.mocked(api.post).mockResolvedValue({ data: { status: 'closed' } });
  renderWithProviders(<Services/>); await screen.findByRole('rowheader');
  await userEvent.click(screen.getByRole('button', { name: 'Закрыть непринятый запрос' }));
  await waitFor(() => expect(sessionStorage.getItem(serviceRecoveryKey('operator', 'hotel-a'))).toBeNull());
  expect(api.post).toHaveBeenCalledWith('/v1/services/booking-request/close', { propertyId: 'hotel-a', idempotencyKey: token }, expect.anything());
  expect(screen.queryByText(/Есть незавершённый запрос/)).not.toBeInTheDocument();
});
it('opens the accepted booking when closure discovers a committed request', async () => {
  const token = crypto.randomUUID(); sessionStorage.setItem(serviceRecoveryKey('operator', 'hotel-a'), token);
  vi.mocked(api.post).mockResolvedValue({ data: { status: 'committed', serviceBookingId: 'accepted' } });
  renderWithProviders(<Services/>); await screen.findByRole('rowheader');
  await userEvent.click(screen.getByRole('button', { name: 'Закрыть непринятый запрос' }));
  await screen.findByRole('dialog', { name: 'Карточка услуги' });
  expect(sessionStorage.getItem(serviceRecoveryKey('operator', 'hotel-a'))).toBeNull();
});
it('lets a financial operator record actual consumption without a time/resource booking or payment claim', async () => {
  access.write = false; access.finance = true;
  window.history.replaceState({}, '', '/services?date=2027-01-01&action=book&guestId=guest&reservationId=stay&propertyId=hotel-a');
  vi.mocked(api.post).mockImplementation(async path => path.endsWith('/quote') ? { data: { pricing: { totalAmount: '100.00', baseAmount: '100.00', taxAmount: '0.00' }, currencyCode: 'KZT' } } : { data: { kind: 'consumption', folioId: 'folio' } });
  renderWithProviders(<Services/>); await screen.findByRole('dialog', { name: 'Оформить услугу' });
  expect(screen.queryByLabelText('Начало')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Ресурс')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Проверить стоимость' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Начислить оказанную услугу' }));
  expect(vi.mocked(api.post).mock.calls.filter(([path]) => path === '/v1/services/consumption')).toHaveLength(0);
  await userEvent.click(screen.getByRole('checkbox', { name: /Услуга фактически оказана/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Начислить оказанную услугу' }));
  await screen.findByText(/Услуга начислена в фолио. Оплата не подтверждалась/);
  const posted = vi.mocked(api.post).mock.calls.find(([path]) => path === '/v1/services/consumption')![1];
  expect(posted).toMatchObject({ propertyId: 'hotel-a', serviceId: 'svc', guestId: 'guest', reservationId: 'stay', provided: true, expectedTotal: '100.00' });
  for (const field of ['startAt','endAt','resourceId','participants']) expect(posted).not.toHaveProperty(field);
  expect(screen.getByRole('link', { name: 'Открыть фолио' })).toHaveAttribute('href', '/folios/folio?propertyId=hotel-a');
});
it('shows bookings on the hourly chessboard and books a free hour on click', async () => {
  vi.mocked(api.get).mockImplementation(async path => {
    if (path.endsWith('/history')) return { data: [] };
    if (path.includes('/bookings/')) return { data: { id: 'booked', serviceId: 'svc', startAt: '2027-01-01T05:00:00Z', endAt: '2027-01-01T06:00:00Z', status: 'scheduled', revision: 1, participants: 1, quantity: 1, totalAmount: '100.00', currencyCode: 'KZT', allocations: [{ resourceId: 'resource' }] } };
    return { data: { ...calendar, bookings: [{ id: 'booked', serviceId: 'svc', guestName: 'Айгерим', startAt: '2027-01-01T05:00:00Z', endAt: '2027-01-01T06:00:00Z', status: 'scheduled', participants: 1, quantity: 1, totalAmount: '100.00', currencyCode: 'KZT' }], allocations: [{ serviceBookingId: 'booked', resourceId: 'resource' }] } };
  });
  renderWithProviders(<Services/>);
  // 10:00 Asia/Almaty is 05:00Z.
  const booked = await screen.findByRole('button', { name: /Кабинет 10:00: Айгерим/ });
  await userEvent.click(booked);
  expect(await screen.findByRole('dialog', { name: 'Карточка услуги' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByRole('button', { name: /Кабинет 12:00: Свободно/ }));
  expect(await screen.findByRole('dialog', { name: 'Запись на услугу' })).toBeInTheDocument();
  expect(screen.getByLabelText('Начало')).toHaveValue('2027-01-01T12:00');
});
