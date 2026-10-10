import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import ReservationLifecycleActions from './ReservationLifecycleActions';
import type { Reservation } from './types';
let allowed = true;
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => allowed }) }));
vi.mock('../../lib/api', () => ({ api: { patch: vi.fn() } }));
const stay = { id: 'stay-a', status: 'assigned' } as Reservation;
beforeEach(() => { allowed = true; vi.clearAllMocks(); vi.mocked(api.patch).mockResolvedValue({ data: {} }); });
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
    await userEvent.type(screen.getByRole('textbox'), 'Guest request'); await userEvent.click(confirm);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/v1/reservations/stay-a/cancel', { cancellationReason: 'Guest request' }, expect.objectContaining({ params: { propertyId: 'hotel-a' } })));
  });
  it('does not offer state-changing operations to a read-only user', () => {
    allowed = false; renderWithProviders(<ReservationLifecycleActions reservation={stay} propertyId="hotel-a" onWorkflow={vi.fn()}/>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
