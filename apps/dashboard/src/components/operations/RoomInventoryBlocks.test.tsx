import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import RoomInventoryBlocks from './RoomInventoryBlocks';
import i18n from '../../i18n';
const access = vi.hoisted(() => ({ write: true }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'actor' },
    hasPermission: (...keys: string[]) =>
      keys.every(
        (key) =>
          ['maintenance.view', 'rooms.read'].includes(key) || access.write,
      ),
  }),
}));
vi.mock('../../context/PropertyContext', () => ({
  useProperty: () => ({
    properties: [{ id: 'hotel-a', timezone: 'Asia/Almaty' }],
  }),
}));
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
const block = {
  id: 'block-a',
  roomId: 'room-a',
  startDate: '2026-01-01',
  endDate: '2026-01-03',
  kind: 'OOO',
  reason: 'Ремонт окна',
  revision: 1,
  status: 'active',
};
beforeEach(async () => {
  await i18n.changeLanguage('ru');
  vi.clearAllMocks();
  sessionStorage.clear();
  access.write = true;
  window.history.replaceState({}, '', '/operations?tab=maintenance');
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: String(url).endsWith('/request')
      ? { state: 'unconfirmed' }
      : String(url).endsWith('/inventory-blocks')
        ? [
            {
              block,
              roomNumber: '101',
              physicalRoomStatus: 'guest_ready',
              overdue: true,
            },
          ]
        : { block, room: { status: 'guest_ready' }, history: [] },
  }));
  vi.mocked(api.post).mockResolvedValue({
    data: { canApply: true, conflictingReservationIds: [], shortages: [] },
  });
});
const render = () =>
  renderWithProviders(
    <RoomInventoryBlocks
      propertyId="hotel-a"
      rooms={[{ id: 'room-a', number: '101' }]}
    />,
  );
it('shows an expired block separately from physical readiness and hides inventory actions without write rights', async () => {
  access.write = false;
  render();
  expect(
    await screen.findByText('Просрочена блокировка / Требуется подтверждение'),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Фактический статус: Готов к гостю/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Планировать блокировку' }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /101 · OOO/ }));
  await screen.findByRole('dialog');
  expect(
    screen.queryByRole('button', { name: 'Подтвердить Return-to-Service' }),
  ).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});
it('freezes a failed block save, stores only its token and retries the original previewed payload', async () => {
  render();
  await userEvent.click(
    screen.getByRole('button', { name: 'Планировать блокировку' }),
  );
  await userEvent.selectOptions(
    screen.getByLabelText('Номер блокировки'),
    'room-a',
  );
  fireEvent.change(screen.getByLabelText('Начало блокировки'), {
    target: { value: '2026-10-12' },
  });
  fireEvent.change(screen.getByLabelText('Ожидаемое окончание'), {
    target: { value: '2026-10-14' },
  });
  await userEvent.type(
    screen.getByLabelText('Причина блокировки'),
    'Проверка труб',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Проверить конфликты' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Сохранить блокировку' }),
    ).toBeEnabled(),
  );
  vi.mocked(api.post).mockRejectedValueOnce(new Error('network'));
  await userEvent.click(
    screen.getByRole('button', { name: 'Сохранить блокировку' }),
  );
  await screen.findByRole('button', { name: 'Повторить исходный запрос' });
  expect(screen.getByLabelText('Причина блокировки')).toBeDisabled();
  const original = vi.mocked(api.post).mock.calls[1][1] as any;
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(
    original.idempotencyKey,
  );
  vi.mocked(api.post).mockResolvedValueOnce({
    data: { ...block, ...original },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Повторить исходный запрос' }),
  );
  await waitFor(() =>
    expect(vi.mocked(api.post).mock.calls[2][1]).toEqual(original),
  );
  await waitFor(() => expect(sessionStorage.length).toBe(0));
});
