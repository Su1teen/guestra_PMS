import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import OptionActions from './OptionActions';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

const render = (multi = false) => renderWithProviders(<OptionActions reservationId="r1" propertyId="hotel-a" currency="KZT"
  due="45000.00" optionUntil="2099-01-01T10:00:00.000Z" multi={multi} onConfirm={vi.fn()} />);

beforeEach(() => vi.clearAllMocks());

describe('unconfirmed booking actions', () => {
  it('records a manual prepayment prefilled with the guarantee still due', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { confirmed: true, paid: '45000.00', required: '45000.00' } });
    render();
    await userEvent.click(screen.getByRole('button', { name: /Prepayment received/ }));
    expect(screen.getByLabelText(/Amount/)).toHaveValue('45000.00');
    await userEvent.type(screen.getByLabelText('Document number'), 'PP-17');
    await userEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/r1/prepayment',
      { amount: '45000.00', method: 'bank_transfer', reference: 'PP-17' }, expect.objectContaining({ params: { propertyId: 'hotel-a' } })));
  });

  it('extends the option of the whole booking and releases it by hand', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { updated: 2 } });
    vi.mocked(api.post).mockResolvedValue({ data: { released: 2 } });
    render(true);
    await userEvent.click(screen.getByRole('button', { name: /Extend option/ }));
    await userEvent.click(screen.getByRole('button', { name: '+24 h' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/v1/reservations/r1/option',
      { optionUntil: '2099-01-02T10:00:00.000Z', wholeBooking: true }, expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: /Release booking/ }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Release booking' }).at(-1)!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/r1/option/release', { wholeBooking: true }, expect.anything()));
  });

  it('reminds the guest through the chosen channel', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { sent: true, to: '+7700' } });
    render();
    await userEvent.click(screen.getByRole('button', { name: /Remind guest/ }));
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'sms');
    await userEvent.click(screen.getByRole('button', { name: 'Send reminder' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/r1/option/remind', { channel: 'sms' }, expect.anything()));
  });
});
