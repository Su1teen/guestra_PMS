import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import MaintenanceWorkspace from './MaintenanceWorkspace';
import i18n from '../../i18n';
const access = vi.hoisted(() => ({ write: true }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { sub: 'actor' },
    hasPermission: (key: string) => key === 'maintenance.view' || access.write,
  }),
}));
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
vi.mock('./PrivatePhotos', () => ({
  default: () => <p>Защищённые фотографии</p>,
}));
const ticket = {
  id: 'ticket-a',
  revision: 4,
  title: 'Протечка',
  description: 'Вода в ванной',
  status: 'resolved',
  category: 'plumbing',
  priority: 'high',
  assigneeId: null,
  roomId: 'room-a',
  blocksInventory: true,
  returnToServiceRequired: true,
  comments: [],
  resolution: 'Труба заменена',
};
beforeEach(async () => {
  await i18n.changeLanguage('ru');
  vi.clearAllMocks();
  sessionStorage.clear();
  access.write = true;
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: String(url).endsWith('/request')
      ? { state: 'unconfirmed' }
      : {
          ticket,
          roomNumber: '101',
          history: [
            {
              id: 'audit-a',
              description: 'update',
              occurredAt: '2026-10-11T12:00:00Z',
            },
          ],
        },
  }));
  vi.mocked(api.patch).mockResolvedValue({ data: ticket });
  vi.mocked(api.post).mockResolvedValue({ data: ticket });
});
const render = () =>
  renderWithProviders(
    <MaintenanceWorkspace
      propertyId="hotel-a"
      ticketId="ticket-a"
      onClose={vi.fn()}
      onSaved={vi.fn()}
      assignees={[]}
    />,
  );
it('keeps the task readable without write permission and hides mutation controls', async () => {
  access.write = false;
  render();
  await screen.findByDisplayValue('Протечка');
  expect(screen.getByDisplayValue('Протечка')).toBeDisabled();
  expect(screen.getByText('История изменений')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Сохранить изменения' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Подтвердить возврат' }),
  ).not.toBeInTheDocument();
});
it('sends the accepted revision and one stable key without silently removing the room block', async () => {
  render();
  await screen.findByDisplayValue('Протечка');
  await userEvent.click(
    screen.getByRole('button', { name: 'Сохранить изменения' }),
  );
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith(
      '/v1/maintenance/ticket-a',
      expect.objectContaining({
        expectedRevision: 4,
        idempotencyKey: expect.any(String),
        resolution: 'Труба заменена',
      }),
      { params: { propertyId: 'hotel-a' } },
    ),
  );
  expect(vi.mocked(api.patch).mock.calls[0][1]).not.toHaveProperty(
    'blocksInventory',
  );
});
it('freezes an uncertain request, retries identical payload and retains no guest details in session storage', async () => {
  vi.mocked(api.patch).mockRejectedValueOnce(new Error('network'));
  render();
  await screen.findByDisplayValue('Протечка');
  await userEvent.click(
    screen.getByRole('button', { name: 'Сохранить изменения' }),
  );
  await screen.findByRole('button', { name: 'Повторить исходный запрос' });
  expect(screen.getByDisplayValue('Протечка')).toBeDisabled();
  const original = vi.mocked(api.patch).mock.calls[0][1] as {
    idempotencyKey: string;
  };
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(
    original.idempotencyKey,
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Повторить исходный запрос' }),
  );
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.patch).mock.calls[1][1]).toEqual(original);
});
it('recovers a committed operation after reload and clears the pending token', async () => {
  sessionStorage.setItem(
    'guestra.maintenance-request.v1:actor:hotel-a',
    '11111111-1111-4111-8111-111111111111',
  );
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: String(url).endsWith('/request')
      ? { state: 'committed', result: ticket }
      : { ticket, history: [] },
  }));
  render();
  await screen.findByRole('button', { name: 'Проверить результат' });
  await userEvent.click(
    screen.getByRole('button', { name: 'Проверить результат' }),
  );
  await waitFor(() => expect(sessionStorage.length).toBe(0));
  expect(api.patch).not.toHaveBeenCalled();
});
