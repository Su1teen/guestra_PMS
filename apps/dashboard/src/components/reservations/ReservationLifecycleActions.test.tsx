import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import ReservationLifecycleActions from './ReservationLifecycleActions';
import type { Reservation } from './types';
let allowed = true;
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => allowed }) }));
vi.mock('../../lib/api', () => ({ api: { patch: vi.fn(), post: vi.fn(), get: vi.fn() } }));
const stay = { id: 'stay-a', status: 'assigned' } as Reservation;
const money = { late: true, hoursBeforeArrival: 12, lateCancellationHours: 24, available: '50000.00', paid: '50000.00', refunded: '0.00', retained: '0.00',
  suggestion: 'retain_prepayment', payments: [{ id: 'pay-1', amount: '50000.00', method: 'cash', processedAt: '2027-02-10T10:00:00Z' }] };
beforeEach(() => { allowed = true; vi.clearAllMocks(); vi.mocked(api.patch).mockResolvedValue({ data: {} }); vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.get).mockResolvedValue({ data: money }); });
describe('full booking operation parity', () => {
  it('opens existing check-in and room move workflows for this reservation', async () => {
    const workflow = vi.fn(); renderWithProviders(<ReservationLifecycleActions reservation={stay} propertyId="hotel-a" onWorkflow={workflow}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Check In' }));
    expect(workflow).toHaveBeenLastCalledWith('/front-desk?reservationId=stay-a&action=check-in');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));
    expect(workflow).toHaveBeenLastCalledWith('/front-desk?reservationId=stay-a&action=move-room');
    expect(api.patch).not.toHaveBeenCalled();
  });
  it('requires a cancellation reason and scopes the existing operation API', async () => {
    renderWithProviders(<ReservationLifecycleActions reservation={stay} propertyId="hotel-a" onWorkflow={vi.fn()}/>);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('button', { name: 'Confirm' }); expect(confirm).toBeDisabled();
    expect(await screen.findByText(/retain the prepayment \(50000.00\)/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox'), 'Guest request'); await userEvent.click(confirm);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/stay-a/manual-cancel', { reason: 'Guest request' }, expect.objectContaining({ params: { propertyId: 'hotel-a' } })));
  });
  it('retains the prepayment of a cancelled booking as a penalty with a reason', async () => {
    renderWithProviders(<ReservationLifecycleActions reservation={{ ...stay, status: 'cancelled' } as Reservation} propertyId="hotel-a" onWorkflow={vi.fn()}/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Retain prepayment as penalty' }));
    await userEvent.type(screen.getAllByRole('textbox').at(-1)!, 'Late cancellation');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/stay-a/retain-prepayment', { reason: 'Late cancellation' }, expect.anything()));
  });
  it('does not offer state-changing operations to a read-only user', () => {
    allowed = false; renderWithProviders(<ReservationLifecycleActions reservation={stay} propertyId="hotel-a" onWorkflow={vi.fn()}/>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
