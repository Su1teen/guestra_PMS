import { beforeEach, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import { staffRecoveryKey, saveStaffRequest, readStaffRequest } from '../../lib/staff-booking-recovery';
import StaffBookingRecovery from './StaffBookingRecovery';
const context = vi.hoisted(() => ({ propertyId: 'hotel-a' }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { sub: 'staff-a' }, hasPermission: () => true }) }));
vi.mock('../../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: context.propertyId }) }));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const token = 'a0000001-0000-4000-a000-000000000001';
const key = staffRecoveryKey('staff-a', 'hotel-a');
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); context.propertyId = 'hotel-a'; });
it('recovers a committed result after remount without creating a second booking', async () => {
  saveStaffRequest(key, token);
  vi.mocked(api.get).mockResolvedValue({ data: { state: 'committed', reservationId: 'stay-a' } });
  const first = renderWithProviders(<StaffBookingRecovery/>);
  await screen.findByRole('link', { name: 'Open saved booking' });
  first.unmount();
  renderWithProviders(<StaffBookingRecovery/>);
  const link = await screen.findByRole('link', { name: 'Open saved booking' });
  expect(link).toHaveAttribute('href', '/reservations/stay-a?propertyId=hotel-a');
  expect(api.post).not.toHaveBeenCalled();
  await userEvent.click(link);
  expect(readStaffRequest(key)).toBeNull();
});
it('keeps an unconfirmed token and checks again without resubmitting a payload', async () => {
  saveStaffRequest(key, token);
  vi.mocked(api.get).mockResolvedValue({ data: { state: 'unconfirmed' } });
  renderWithProviders(<StaffBookingRecovery/>);
  await screen.findByText(/No saved booking was found/);
  await userEvent.click(screen.getByRole('button', { name: 'Check result' }));
  expect(readStaffRequest(key)).toBe(token);
  expect(api.post).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe(token);
});
it('isolates recovery by user and property and ignores malformed data', () => {
  saveStaffRequest(key, token);
  expect(readStaffRequest(staffRecoveryKey('staff-b', 'hotel-a'))).toBeNull();
  expect(readStaffRequest(staffRecoveryKey('staff-a', 'hotel-b'))).toBeNull();
  sessionStorage.setItem(key, '{"guestId":"guest-a"}');
  expect(readStaffRequest(key)).toBeNull();
});
it('clears the token only after the server fences the uncommitted request', async () => {
  saveStaffRequest(key, token);
  vi.mocked(api.get).mockResolvedValue({ data: { state: 'unconfirmed' } });
  vi.mocked(api.post).mockResolvedValue({ data: { state: 'closed' } });
  renderWithProviders(<StaffBookingRecovery/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Close attempt and create a new booking' }));
  expect(api.post).toHaveBeenCalledWith(`/v1/reservations/staff-create/${token}/close`, undefined,
    { params: { propertyId: 'hotel-a' }, skipErrorToast: true });
  expect(readStaffRequest(key)).toBeNull();
});
it('keeps recovery when a late creation won the race with closing', async () => {
  saveStaffRequest(key, token);
  vi.mocked(api.get).mockResolvedValue({ data: { state: 'unconfirmed' } });
  vi.mocked(api.post).mockResolvedValue({ data: { state: 'committed', reservationId: 'saved-late' } });
  renderWithProviders(<StaffBookingRecovery/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Close attempt and create a new booking' }));
  expect(await screen.findByRole('link', { name: 'Open saved booking' })).toHaveAttribute('href', '/reservations/saved-late?propertyId=hotel-a');
  expect(readStaffRequest(key)).toBe(token);
});
it('keeps the token when closing is not confirmed by the server', async () => {
  saveStaffRequest(key, token);
  vi.mocked(api.get).mockResolvedValue({ data: { state: 'unconfirmed' } });
  vi.mocked(api.post).mockRejectedValue(new Error('offline'));
  renderWithProviders(<StaffBookingRecovery/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Close attempt and create a new booking' }));
  await screen.findByRole('alert');
  expect(readStaffRequest(key)).toBe(token);
});

it('finishes only the original attempt if the hotel changes while closure is in flight', async () => {
  const otherKey = staffRecoveryKey('staff-a', 'hotel-b');
  const otherToken = 'b0000001-0000-4000-a000-000000000001';
  saveStaffRequest(key, token); saveStaffRequest(otherKey, otherToken);
  vi.mocked(api.get).mockResolvedValue({ data: { state: 'unconfirmed' } });
  let resolve!: (value: any) => void;
  vi.mocked(api.post).mockReturnValue(new Promise(done => { resolve = done; }));
  const view = renderWithProviders(<StaffBookingRecovery/>);
  await userEvent.click(await screen.findByRole('button', { name: 'Close attempt and create a new booking' }));
  context.propertyId = 'hotel-b'; view.rerender(<StaffBookingRecovery/>);
  await act(async () => { resolve({ data: { state: 'closed' } }); });
  await waitFor(() => expect(readStaffRequest(key)).toBeNull());
  expect(readStaffRequest(otherKey)).toBe(otherToken);
  expect(api.post).toHaveBeenCalledWith('/v1/reservations/staff-create/' + token + '/close', undefined, expect.objectContaining({ params: { propertyId: 'hotel-a' } }));
});
