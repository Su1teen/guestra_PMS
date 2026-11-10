import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/helpers';
import GuestInbox from './GuestInbox';
import { api } from '../lib/api';

vi.mock('../context/PropertyContext', () => ({ useProperty: () => ({ propertyId: 'hotel-a', currencyCode: 'KZT', properties: [] }) }));
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

const list = { total: 2, counts: { queues: { focus: 1, payment: 0, follow_up: 0, waiting_guest: 1, all: 2, archive: 0 }, channels: { simulator: 1, email: 1 }, unread: 1 },
  conversations: [
    { id: 'c-ai', customerName: 'Алия Серикова', phone: null, email: null, channel: 'simulator', status: 'open', automationMode: 'ai', unreadCount: 1,
      lastMessageAt: '2027-01-01T10:00:00.000Z', reservationCode: null, attention: { state: 'document_answer', label: 'Гость ответил по документу', priority: 85, requiresHuman: true },
      document: { id: 'doc-1', status: 'answered', kind: 'proposal', pmsReservationId: 'res-1' }, lastMessage: { text: 'Нет, даты другие', direction: 'in', senderType: 'contact', at: '2027-01-01T10:00:00.000Z' } },
    { id: 'c-mail', customerName: 'Ivan Petrov', phone: null, email: 'ivan@example.test', channel: 'email', status: 'pending', automationMode: 'human', unreadCount: 0,
      lastMessageAt: '2027-01-01T09:00:00.000Z', reservationCode: null, attention: { state: 'no_action', label: 'Ждём гостя', priority: 0, requiresHuman: false }, document: null, lastMessage: null },
  ] };
const detailAi = { id: 'c-ai', customerName: 'Алия Серикова', phone: '+7701', email: null, channel: 'simulator', status: 'open', automationMode: 'ai', unreadCount: 1,
  handoff: null, reservationCode: null, hasOlderMessages: false,
  documents: [{ id: 'doc-1', status: 'answered', kind: 'proposal', pmsReservationId: 'res-1', mode: 'ai', createdAt: '2027-01-01T09:00:00.000Z', confirmedAt: null, documentUrl: 'https://pms.test/d/1' }],
  messages: [
    { id: 'm1', direction: 'out', senderType: 'system', text: 'Проверьте документ', at: '2027-01-01T09:00:00.000Z', deliveryStatus: 'sent', documentConfirmationId: 'doc-1' },
    { id: 'm2', direction: 'in', senderType: 'contact', text: 'Нет, даты другие', at: '2027-01-01T10:00:00.000Z', deliveryStatus: 'received' },
    { id: 'm3', direction: 'note', senderType: 'human', text: 'Перезвонить', at: '2027-01-01T10:05:00.000Z', deliveryStatus: 'sent', staffName: 'Дана' },
  ],
  operationalContext: { verifiedGuest: true, reservations: [{ id: 'res-1', status: 'pending', arrivalDate: '2027-02-01', departureDate: '2027-02-03', confirmationNumber: 'HTL-1', detailsConfirmedAt: null }] } };

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/guest-inbox');
  vi.mocked(api.get).mockImplementation(async (url: string) => ({ data:
    url === '/v1/guest-inbox/status' ? { enabled: true, staffName: 'Дана' }
    : url === '/v1/guest-inbox' ? list
    : url === '/v1/guest-inbox/c-ai' ? detailAi
    : {} }));
  vi.mocked(api.post).mockResolvedValue({ data: { id: 'c-ai', automationMode: 'human' } });
  vi.mocked(api.patch).mockResolvedValue({ data: {} });
});

describe('guest inbox', () => {
  it('shows CRM queues with counts and filters by channel', async () => {
    renderWithProviders(<GuestInbox />);
    expect(await screen.findByText('Алия Серикова')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Focus\s*1/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.selectOptions(screen.getByLabelText('Channel'), 'email');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/v1/guest-inbox', expect.objectContaining({
      params: expect.objectContaining({ propertyId: 'hotel-a', queue: 'focus', channel: 'email' }) })));
  });

  it('keeps the reply closed while the AI owns the chat, shows notes, and lets staff take over', async () => {
    renderWithProviders(<GuestInbox />);
    await userEvent.click(await screen.findByText('Алия Серикова'));
    const thread = await screen.findByRole('region', { name: 'Conversation' });
    expect(await within(thread).findByText('Перезвонить')).toBeInTheDocument();
    expect(within(thread).getByText(/Guest replied/)).toBeInTheDocument();
    expect(within(thread).getByRole('textbox', { name: 'Reply to guest' })).toBeDisabled();
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/v1/guest-inbox/c-ai', { read: true }, expect.anything()));
    await userEvent.click(within(thread).getByRole('button', { name: /Take over/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/guest-inbox/c-ai/automation', { mode: 'human' }, expect.anything()));
  });

  it('records a document as confirmed from the guest context', async () => {
    renderWithProviders(<GuestInbox />);
    await userEvent.click(await screen.findByText('Алия Серикова'));
    const context = await screen.findByRole('complementary', { name: 'Guest context' });
    await userEvent.click(await within(context).findByRole('button', { name: /Guest confirmed/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/v1/reservations/res-1/confirmation/chat/doc-1/resolve', { outcome: 'confirmed' }, expect.anything()));
  });

  it('explains why the inbox is unavailable instead of failing', async () => {
    vi.mocked(api.get).mockImplementation(async () => ({ data: { enabled: false, reason: 'VERIFIED_PROPERTY_MAPPING_REQUIRED' } }));
    renderWithProviders(<GuestInbox />);
    expect(await screen.findByText('This hotel is not linked to the CRM yet.')).toBeInTheDocument();
  });
});
