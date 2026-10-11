import { beforeEach, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import StaffShiftTemplates from './StaffShiftTemplates';
vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
const template = {
  id: 'pattern',
  revision: 2,
  name: 'Будни',
  userId: 'worker',
  weekdays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '18:00',
  overnight: 0,
};
const props = {
  propertyId: 'hotel',
  staff: [{ id: 'worker', name: 'Сотрудник' }],
  date: '2027-01-01',
  recoveryKey: 'test-template-recovery',
  pending: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.get).mockResolvedValue({ data: [template] });
});
it('requires preview and preserves the original generated-shift request after an uncertain response', async () => {
  vi.mocked(api.post).mockImplementation(async (path) => {
    if (path.endsWith('/preview'))
      return {
        data: { canApply: true, candidates: [{}], absenceWarnings: [] },
      };
    throw new Error('Connection lost');
  });
  renderWithProviders(<StaffShiftTemplates {...props} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Будни · Сотрудник' }),
  );
  expect(
    screen.getByRole('button', { name: 'Создать смены по шаблону' }),
  ).toBeDisabled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Проверить период' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Создать смены по шаблону' }),
    ).toBeEnabled(),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Создать смены по шаблону' }),
  );
  await screen.findByRole('button', { name: 'Повторить исходную операцию' });
  const original = vi
    .mocked(api.post)
    .mock.calls.find(([p]) => p.endsWith('/apply'))![1];
  expect(sessionStorage.getItem(props.recoveryKey)).toBe(
    (original as any).idempotencyKey,
  );
  expect(screen.getByLabelText('По дату')).toBeDisabled();
  await userEvent.click(
    screen.getByRole('button', { name: 'Повторить исходную операцию' }),
  );
  await waitFor(() =>
    expect(
      vi.mocked(api.post).mock.calls.filter(([p]) => p.endsWith('/apply')),
    ).toHaveLength(2),
  );
  expect(
    vi.mocked(api.post).mock.calls.filter(([p]) => p.endsWith('/apply'))[1][1],
  ).toEqual(original);
});
it('shows absence warnings and prevents applying patterns over existing shift exceptions', async () => {
  vi.mocked(api.post).mockResolvedValue({
    data: {
      canApply: false,
      candidates: [{}],
      absenceWarnings: ['absence'],
      conflictingShiftIds: ['individual'],
    },
  });
  renderWithProviders(<StaffShiftTemplates {...props} />);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Будни · Сотрудник' }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Проверить период' }),
  );
  await screen.findByText(/Есть отпуск/);
  expect(
    screen.getByRole('button', { name: 'Создать смены по шаблону' }),
  ).toBeDisabled();
});
