import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/helpers';
import { api } from '../lib/api';
import PriceCalendar from './PriceCalendar';

vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT', properties: [] }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() } }));

const today = new Date(); const ym = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const calendar = { roomTypes: [{ id: 'rt', name: 'Шале', minPrice: null, maxPrice: null }], ratePlans: [{ id: 'plan', name: 'Базовый', roomTypeId: 'rt' }],
  rules: [{ id: 'r1', kind: 'holiday', name: 'Наурыз', startDate: `${ym}-10`, endDate: `${ym}-10`, roomTypeIds: [], adjustmentType: 'fixed_price', value: '90000.00', isActive: true, reason: 'Праздник', revision: 1 }],
  days: [{ date: `${ym}-10`, ratePlanId: 'plan', roomTypeId: 'rt', price: 90000, currencyCode: 'KZT',
    steps: [{ step: 'base', label: 'Базовая цена тарифа', amount: 50000 }, { step: 'holiday', label: 'Праздник «Наурыз»', amount: 90000 }] }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data: url.endsWith('/history') ? [] : calendar }) as any);
  vi.mocked(api.post).mockResolvedValue({ data: { days: [{ date: `${ym}-11`, ratePlanId: 'plan', before: 50000, after: 60000 }], truncated: false } } as any);
});

describe('price calendar', () => {
  it('shows the final price of a night and why it is so', async () => {
    renderWithProviders(<PriceCalendar/>);
    await userEvent.click((await screen.findAllByText('Праздник «Наурыз»'))[0]!);
    expect(screen.getByText('Почему такая цена')).toBeInTheDocument();
    expect(screen.getByText('Базовая цена тарифа')).toBeInTheDocument();
  });

  it('previews a new season before saving it', async () => {
    renderWithProviders(<PriceCalendar/>);
    await userEvent.click(await screen.findByRole('button', { name: 'Сезон' }));
    await userEvent.type(screen.getByLabelText('Название'), 'Зима');
    await userEvent.type(screen.getByLabelText('Процент'), '20');
    await userEvent.type(screen.getByLabelText('Причина'), 'Высокий сезон');
    const save = screen.getByRole('button', { name: 'Сохранить' }); expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Предпросмотр' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/price-calendar/rules/preview', expect.objectContaining({ kind: 'season', name: 'Зима', value: '20' }), expect.anything()));
    expect(await screen.findByText('Станет')).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/price-calendar/rules', expect.objectContaining({ reason: 'Высокий сезон' }), expect.anything()));
  });
});
