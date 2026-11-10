import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import ChatDocumentSender from './ChatDocumentSender';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
const url = 'https://pms.test/api/v1/public/documents/token';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (path: string) => ({ data: path.endsWith('/preview')
    ? { kind: 'proposal', url, text: `Здравствуйте! Проверьте: ${url}` }
    : { enabled: true, detailsConfirmedAt: null, detailsConfirmedBy: null,
      confirmations: [{ id: 'doc-1', status: 'awaiting', kind: 'proposal', mode: 'manual', createdAt: '2027-01-01T09:00:00.000Z', confirmedAt: null, resolvedBy: null, pmsSyncError: null }] } }));
  vi.mocked(api.post).mockResolvedValue({ data: { conversationId: 'c-1', channel: 'simulator', delivered: true, deliveryError: null } });
});

describe('document to chat', () => {
  it('sends through the AI with the prepared text and opens the chat', async () => {
    renderWithProviders(<ChatDocumentSender reservationId="res-1" propertyId="hotel-a" kind="proposal" canSend />);
    expect(await screen.findByDisplayValue(`Здравствуйте! Проверьте: ${url}`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Send via AI/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/res-1/confirmation/chat',
      expect.objectContaining({ mode: 'ai', kind: 'proposal', text: `Здравствуйте! Проверьте: ${url}` }), expect.anything()));
    expect(vi.mocked(api.post).mock.calls[0]![1]).not.toHaveProperty('channel');
    expect(await screen.findByRole('link', { name: /Open chat/ })).toHaveAttribute('href', expect.stringContaining('conversation=c-1'));
  });

  it('opens a new staff chat on the chosen channel and refuses text without the link', async () => {
    renderWithProviders(<ChatDocumentSender reservationId="res-1" propertyId="hotel-a" kind="proposal" canSend />);
    const message = await screen.findByDisplayValue(`Здравствуйте! Проверьте: ${url}`);
    await userEvent.click(screen.getByRole('radio', { name: /Manually, new chat/ }));
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'email');
    await userEvent.clear(message);
    await userEvent.type(message, 'Без ссылки');
    expect(screen.getByText('Keep the document link in the message.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create chat and send/ })).toBeDisabled();
  });

  it('lets staff record a confirmation received outside the chat', async () => {
    renderWithProviders(<ChatDocumentSender reservationId="res-1" propertyId="hotel-a" kind="proposal" canSend />);
    await userEvent.click(await screen.findByRole('button', { name: /Guest confirmed/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/res-1/confirmation/chat/doc-1/resolve', { outcome: 'confirmed' }, expect.anything()));
  });
});
