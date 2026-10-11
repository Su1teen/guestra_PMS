import { beforeEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import { api } from '../../lib/api';
import PrivatePhotos from './PrivatePhotos';
import i18n from '../../i18n';
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { sub: 'actor' } }),
}));
vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const capability = {
  configured: true,
  canUpload: true,
  maxBytes: 10485760,
  contentTypes: ['image/png'],
  attachments: [],
};
beforeEach(async () => {
  await i18n.changeLanguage('ru');
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.get).mockResolvedValue({ data: capability });
  vi.mocked(api.post).mockResolvedValue({ data: { id: 'photo-a' } });
});
const render = () =>
  renderWithProviders(
    <PrivatePhotos
      propertyId="hotel-a"
      ownerId="ticket-a"
      kind="maintenance"
      canUpload
    />,
  );
it('hides upload if private storage is unavailable instead of offering a public URL', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { ...capability, configured: false },
  });
  render();
  await screen.findByText(/Приватное хранилище не настроено/);
  expect(screen.queryByLabelText('Выбрать фотографию')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('honors current server permissions even if the page allows editing', async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { ...capability, canUpload: false },
  });
  render();
  await screen.findByText('Фотографий пока нет.');
  expect(screen.queryByLabelText('Выбрать фотографию')).not.toBeInTheDocument();
});
it('retries the same multipart key after an uncertain upload and stores only the recovery token', async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error('network'));
  render();
  const file = new File(['photo'], 'photo.png', { type: 'image/png' });
  await userEvent.upload(
    await screen.findByLabelText('Выбрать фотографию'),
    file,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Загрузить' }));
  await screen.findByRole('button', { name: 'Повторить загрузку' });
  const first = vi.mocked(api.post).mock.calls[0][1] as FormData;
  expect(first.get('file')).toBe(file);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(
    first.get('idempotencyKey'),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Повторить загрузку' }),
  );
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(
    (vi.mocked(api.post).mock.calls[1][1] as FormData).get('idempotencyKey'),
  ).toBe(first.get('idempotencyKey'));
});
