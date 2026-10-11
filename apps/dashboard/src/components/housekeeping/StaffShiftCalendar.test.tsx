import { beforeEach, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import StaffShiftCalendar from './StaffShiftCalendar';
import { staffShiftRecoveryKey } from '../../lib/staff-booking-recovery';
const access = vi.hoisted(() => ({
  manage: true,
  propertyId: 'hotel',
  portfolio: false,
}));
vi.mock('../../context/PropertyContext', () => ({
  useProperty: () => ({
    propertyId: access.propertyId,
    isPortfolioMode: access.portfolio,
    properties: [{ id: 'hotel', timezone: 'Asia/Almaty' }],
  }),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => access.manage }),
}));
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  access.manage = true;
  access.portfolio = false;
  access.propertyId = 'hotel';
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.endsWith('/identity')
      ? { staffId: 'worker' }
      : path.endsWith('/staff')
        ? [{ id: 'worker', name: 'Сотрудник' }]
        : [],
  }));
  vi.mocked(api.post).mockResolvedValue({ data: { id: 'shift' } });
});
it('sends explicit property time, confirmed status, breaks and one original request key on uncertain retry', async () => {
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection lost'))
    .mockResolvedValueOnce({ data: { id: 'shift' } });
  renderWithProviders(<StaffShiftCalendar />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Новая смена' }),
  );
  fireEvent.input(screen.getByLabelText('Начало смены'), {
    target: { value: '2027-01-10T09:00' },
  });
  fireEvent.input(screen.getByLabelText('Конец смены'), {
    target: { value: '2027-01-10T18:00' },
  });
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: /Статус/ }),
    'confirmed',
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Добавить перерыв' }),
  );
  fireEvent.input(screen.getByLabelText('Начало перерыва 1'), {
    target: { value: '2027-01-10T12:00' },
  });
  fireEvent.input(screen.getByLabelText('Конец перерыва 1'), {
    target: { value: '2027-01-10T13:00' },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Сохранить смену' }),
  );
  await screen.findByRole('button', { name: 'Повторить исходный запрос' });
  expect(api.post).toHaveBeenCalledWith(
    '/v1/housekeeping/shifts',
    expect.objectContaining({
      propertyId: 'hotel',
      userId: 'worker',
      status: 'confirmed',
      startAt: '2027-01-10T04:00:00.000Z',
      endAt: '2027-01-10T13:00:00.000Z',
      breaks: [
        {
          startAt: '2027-01-10T07:00:00.000Z',
          endAt: '2027-01-10T08:00:00.000Z',
        },
      ],
    }),
  );
  expect(screen.getByLabelText('Начало смены')).toBeDisabled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Повторить исходный запрос' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toEqual(
    vi.mocked(api.post).mock.calls[1]?.[1],
  );
});
it('does not create mutations or load manager availability for a reader', async () => {
  access.manage = false;
  renderWithProviders(<StaffShiftCalendar />);
  await screen.findByRole('rowheader', { name: 'Сотрудник' });
  expect(
    screen.queryByRole('button', { name: 'Новая смена' }),
  ).not.toBeInTheDocument();
  expect(
    vi
      .mocked(api.get)
      .mock.calls.some(([p]) => p.includes('staff-availability')),
  ).toBe(false);
});
it('requires a concrete property and never loads portfolio shifts', () => {
  access.portfolio = true;
  renderWithProviders(<StaffShiftCalendar />);
  expect(screen.getByText(/Выберите объект/)).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalled();
});
it('recovers a token after reload without storing staff data or submitting a new shift', async () => {
  const key = staffShiftRecoveryKey('demo', 'hotel');
  const token = '10000000-0000-4000-a000-000000000001';
  sessionStorage.setItem(key, token);
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.endsWith('/shift-request')
      ? { state: 'committed', shift: { id: 'shift' } }
      : path.endsWith('/staff')
        ? [{ id: 'worker', name: 'Сотрудник' }]
        : [],
  }));
  renderWithProviders(<StaffShiftCalendar />);
  await screen.findByRole('button', { name: 'Новая смена' });
  expect(screen.getByRole('button', { name: 'Новая смена' })).toBeDisabled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Проверить результат' }),
  );
  await screen.findByText('Исходная операция календаря сохранена.');
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('records absence in the existing calendar with explicit property times and no break or task limit', async () => {
  renderWithProviders(<StaffShiftCalendar />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Отпуск / отсутствие' }),
  );
  fireEvent.input(screen.getByLabelText('Начало отсутствия'), {
    target: { value: '2027-01-10T09:00' },
  });
  fireEvent.input(screen.getByLabelText('Конец отсутствия'), {
    target: { value: '2027-01-20T18:00' },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Сохранить отсутствие' }),
  );
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/v1/housekeeping/shifts',
      expect.objectContaining({
        kind: 'absence',
        absenceType: 'vacation',
        propertyId: 'hotel',
        breaks: [],
        startAt: '2027-01-10T04:00:00.000Z',
      }),
    ),
  );
  expect(vi.mocked(api.post).mock.calls[0][1]).not.toHaveProperty(
    'maxOpenTasks',
  );
});
