import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import ReservationPriceDecisions from './ReservationPriceDecisions';
import type { Reservation } from './types';
let granted: string[] = [];
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: (key: string) => granted.includes(key) }) }));
vi.mock('../../lib/api', () => ({ api: { post: vi.fn() } }));
beforeEach(() => { granted = ['reservations.price_type', 'reservations.correct_closed']; vi.clearAllMocks(); vi.mocked(api.post).mockResolvedValue({ data: {} }); });
describe('price type and closed stay corrections', () => {
  it('needs a counterparty for barter and posts a scoped decision with its reason', async () => {
    renderWithProviders(<ReservationPriceDecisions reservation={{ id: 'stay-a', status: 'confirmed' } as Reservation} propertyId="hotel-a"/>);
    expect(screen.queryByRole('button', { name: 'Исправить закрытую бронь' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Тип цены' }));
    await userEvent.selectOptions(screen.getByRole('combobox'), 'barter');
    await userEvent.type(screen.getByRole('textbox', { name: 'Причина' }), 'Обмен на съёмку');
    const save = screen.getByRole('button', { name: 'Сохранить' }); expect(save).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: /Контрагент/ }), 'Блогер'); await userEvent.click(save);
    expect(api.post).toHaveBeenCalledWith('/v1/reservations/stay-a/price-type', { priceType: 'barter', reason: 'Обмен на съёмку', counterparty: 'Блогер' },
      expect.objectContaining({ params: { propertyId: 'hotel-a' } }));
  });
  it('corrects a closed stay only with the right and a changed field', async () => {
    renderWithProviders(<ReservationPriceDecisions reservation={{ id: 'stay-b', status: 'checked_out', totalAmount: '50000.00' } as unknown as Reservation} propertyId="hotel-a"/>);
    await userEvent.click(screen.getByRole('button', { name: 'Исправить закрытую бронь' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Причина' }), 'Ошибка в сумме');
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Сумма брони' }), '45000'); await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(api.post).toHaveBeenCalledWith('/v1/reservations/stay-b/correct-closed', { reason: 'Ошибка в сумме', totalAmount: '45000' }, expect.anything());
  });
  it('shows nothing without the rights on a standard stay', () => {
    granted = []; renderWithProviders(<ReservationPriceDecisions reservation={{ id: 'stay-c', status: 'checked_out' } as Reservation} propertyId="hotel-a"/>);
    expect(screen.queryByRole('region', { name: 'Тип цены и исправления' })).not.toBeInTheDocument();
  });
});
