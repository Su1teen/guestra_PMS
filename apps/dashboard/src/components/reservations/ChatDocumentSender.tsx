import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, ExternalLink, Send, UserRound } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { propertyHref } from '../../lib/navigation';
import { useToast } from '../ui/Toast';

type Kind = 'proposal' | 'confirmation';
type Mode = 'ai' | 'manual';
export const CHAT_CHANNELS = ['simulator', 'telegram', 'whatsapp', 'email', 'sms'] as const;

interface ChatConfirmation {
  id: string; status: 'awaiting' | 'confirmed' | 'answered' | 'declined' | 'superseded'; kind: Kind; mode: Mode;
  createdAt: string; confirmedAt: string | null; resolvedBy: string | null; pmsSyncError: string | null;
}
interface ChatStatus { enabled: boolean; detailsConfirmedAt: string | null; detailsConfirmedBy: string | null; confirmations: ChatConfirmation[] }
interface SendResult { conversationId: string; channel: string; delivered: boolean; deliveryError: string | null }

const STATUS_TONE: Record<ChatConfirmation['status'], string> = {
  awaiting: 'bg-amber-100 text-amber-900', confirmed: 'bg-emerald-100 text-emerald-900', answered: 'bg-red-100 text-red-800',
  declined: 'bg-red-100 text-red-800', superseded: 'bg-gray-100 text-gray-700',
};

/**
 * Sends the booking document into a guest chat and asks the guest to confirm the details.
 * AI: into the guest's AI conversation (the agent keeps answering questions; a plain "yes" is recorded).
 * Manual: a new staff chat with the prepared, editable text. The guest's answer comes back on the booking.
 */
export default function ChatDocumentSender({ reservationId, propertyId, kind, canSend }: {
  reservationId: string; propertyId: string; kind: Kind; canSend: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('ai');
  const [channel, setChannel] = useState<(typeof CHAT_CHANNELS)[number]>('simulator');
  const [text, setText] = useState('');
  const [last, setLast] = useState<SendResult | null>(null);

  const status = useQuery<ChatStatus>({
    queryKey: ['reservation-chat', propertyId, reservationId],
    queryFn: () => api.get(`/v1/reservations/${reservationId}/confirmation/chat`, { params: { propertyId }, skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
    refetchInterval: 15_000,
  });
  const preview = useQuery<{ text: string; url: string }>({
    queryKey: ['reservation-chat-preview', propertyId, reservationId, kind],
    enabled: status.data?.enabled === true,
    queryFn: () => api.get(`/v1/reservations/${reservationId}/confirmation/chat/preview`, { params: { propertyId, kind }, skipErrorToast: true })
      .then((r) => r.data?.data ?? r.data),
  });
  useEffect(() => { if (preview.data) setText(preview.data.text); }, [preview.data]);

  const send = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservationId}/confirmation/chat`, {
      mode, kind, ...(mode === 'manual' ? { channel } : {}), text: text.trim(), idempotencyKey: crypto.randomUUID(),
    }, { params: { propertyId }, skipErrorToast: true }).then((r) => (r.data?.data ?? r.data) as SendResult),
    onSuccess: (result) => {
      setLast(result);
      toast(result.delivered ? 'success' : 'error', result.delivered ? t('chatDoc.sent') : t('chatDoc.notDelivered'));
      for (const key of [['reservation-chat', propertyId, reservationId], ['reservation-document', propertyId, reservationId], ['guest-inbox']])
        void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast('error', errorMessage(error)),
  });
  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/v1/reservations/${reservationId}/confirmation/chat/${id}/resolve`, { outcome: 'confirmed' },
      { params: { propertyId }, skipErrorToast: true }),
    onSuccess: () => { toast('success', t('chatDoc.markedConfirmed')); void queryClient.invalidateQueries({ queryKey: ['reservation-chat', propertyId, reservationId] }); },
    onError: (error) => toast('error', errorMessage(error)),
  });

  const fmt = (iso: string) => new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  if (status.isLoading) return <p className="text-sm text-telivity-mid-grey">{t('common.loading')}</p>;
  if (!status.data?.enabled) return <p className="rounded-lg bg-telivity-light-grey px-3 py-2 text-sm text-telivity-slate">{t('chatDoc.disabled')}</p>;
  const linkKept = !preview.data || text.includes(preview.data.url);
  const history = status.data.confirmations.filter((c) => c.status !== 'superseded').slice(0, 3);

  return (
    <div className="space-y-3">
      {status.data.detailsConfirmedAt && (
        <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <CheckCircle2 size={16} />{t('chatDoc.guestConfirmed', { at: fmt(status.data.detailsConfirmedAt) })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('chatDoc.mode')}>
        {([['ai', Bot, 'chatDoc.ai', 'chatDoc.aiHint'], ['manual', UserRound, 'chatDoc.manual', 'chatDoc.manualHint']] as const).map(([m, Icon, label, hint]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
            className={`rounded-lg border p-2.5 text-left ${mode === m ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:bg-telivity-light-grey'}`}>
            <span className="flex items-center gap-1.5 text-sm font-semibold text-telivity-navy"><Icon size={15} />{t(label)}</span>
            <span className="mt-0.5 block text-xs text-telivity-slate">{t(hint)}</span>
          </button>
        ))}
      </div>
      {mode === 'manual' && (
        <label className="block">
          <span className="label">{t('chatDoc.channel')}</span>
          <select className="field" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            {CHAT_CHANNELS.map((c) => <option key={c} value={c}>{t(`guestInbox.channels.${c}`)}</option>)}
          </select>
        </label>
      )}
      <label className="block">
        <span className="label">{t('chatDoc.message')}</span>
        <textarea className="field min-h-[140px] resize-y text-sm" value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} />
      </label>
      {!linkKept && <p className="text-xs text-red-700">{t('chatDoc.keepLink')}</p>}
      <button type="button" className="btn-primary btn-lg w-full" disabled={!canSend || !text.trim() || !linkKept || send.isPending || preview.isLoading}
        onClick={() => send.mutate()}>
        <Send size={16} />{send.isPending ? t('booking.doc.sending') : t(mode === 'ai' ? 'chatDoc.sendAi' : 'chatDoc.sendManual')}
      </button>
      {last && (
        <Link className="flex items-center gap-1.5 text-sm font-medium text-primary-700 hover:underline"
          to={propertyHref(`/guest-inbox?conversation=${encodeURIComponent(last.conversationId)}`, propertyId)}>
          <ExternalLink size={14} />{t('chatDoc.openChat')}
        </Link>
      )}
      {history.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {history.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className={`chip ${STATUS_TONE[c.status]}`}>{t(`chatDoc.status.${c.status}`)}</span>
                <span className="ml-2 text-telivity-slate">{t(`booking.doc.${c.kind}`)} · {t(c.mode === 'ai' ? 'chatDoc.ai' : 'chatDoc.manual')} · {fmt(c.createdAt)}</span>
              </span>
              {(c.status === 'awaiting' || c.status === 'answered') && canSend && (
                <button type="button" className="btn-ghost min-h-0 px-2 py-1 text-xs" disabled={resolve.isPending} onClick={() => resolve.mutate(c.id)}>
                  <CheckCircle2 size={14} />{t('chatDoc.markConfirmed')}
                </button>
              )}
              {c.pmsSyncError && <span className="w-full text-xs text-red-700">{t('chatDoc.syncPending')}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
