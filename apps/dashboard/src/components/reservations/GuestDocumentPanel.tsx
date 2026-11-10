import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FileText, Mail, MessageSquare, MessagesSquare, Printer, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { useToast } from '../ui/Toast';
import ChatDocumentSender from './ChatDocumentSender';

type Kind = 'proposal' | 'confirmation';
type Channel = 'email' | 'sms' | 'chat';

interface DocumentData {
  kind: Kind;
  status: string;
  guest: { name: string; email: string | null; phone: string | null };
  sent: { proposalAt: string | null; confirmationAt: string | null };
  guarantee: { optionUntil: string | null; requiredDeposit: string | null; depositDue: string | null };
}

/**
 * "Сформировать → Отправить": builds the guest document (proposal for a tentative booking, confirmation
 * otherwise) right next to the booking details, previews it, and sends it by email, SMS or into a guest chat
 * (AI conversation or a new staff chat) asking the guest to confirm the details.
 */
export default function GuestDocumentPanel({ reservationId, propertyId, canSend, compact, onSent }: {
  reservationId: string; propertyId: string; canSend: boolean; compact?: boolean; onSent?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<Kind | null>(null);
  const [channel, setChannel] = useState<Channel>('email');
  const [recipient, setRecipient] = useState('');
  const [preview, setPreview] = useState<string | null>(null);

  const dataQuery = useQuery<DocumentData>({
    queryKey: ['reservation-document', propertyId, reservationId],
    queryFn: () => api.get(`/v1/reservations/${reservationId}/confirmation`, { params: { propertyId } }).then((r) => r.data?.data ?? r.data),
  });
  const data = dataQuery.data;
  const effectiveKind: Kind = kind ?? data?.kind ?? 'confirmation';

  useEffect(() => {
    if (!data) return;
    setRecipient(channel === 'sms' ? data.guest.phone ?? '' : data.guest.email ?? '');
  }, [channel, data]);
  useEffect(() => { setPreview(null); }, [effectiveKind]);

  const build = useMutation({
    mutationFn: () => api.get(`/v1/reservations/${reservationId}/confirmation/document`, {
      params: { propertyId, kind: effectiveKind }, responseType: 'text', transformResponse: (body: string) => body,
    }).then((r) => String(r.data)),
    onSuccess: (html) => setPreview(html),
    onError: (error) => toast('error', errorMessage(error)),
  });

  const send = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservationId}/confirmation/send`, {
      kind: effectiveKind, channel, ...(channel === 'sms' ? { phone: recipient.trim() } : { email: recipient.trim() }),
    }, { params: { propertyId } }).then((r) => r.data?.data ?? r.data),
    onSuccess: (result: { sent: boolean; to: string }) => {
      toast(result.sent ? 'success' : 'error', result.sent ? t('booking.doc.sentTo', { to: result.to }) : t('booking.doc.notDelivered'));
      void queryClient.invalidateQueries({ queryKey: ['reservation-document', propertyId, reservationId] });
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      onSent?.();
    },
    onError: (error) => toast('error', errorMessage(error)),
  });

  const sentAt = effectiveKind === 'proposal' ? data?.sent.proposalAt : data?.sent.confirmationAt;
  const sentLabel = useMemo(() => sentAt
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(sentAt))
    : null, [sentAt, i18n.resolvedLanguage]);
  const recipientValid = channel === 'sms' ? /^\+?[0-9 ()-]{6,20}$/.test(recipient.trim()) : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim());

  const openPrintable = () => {
    if (!preview) return;
    const url = URL.createObjectURL(new Blob([preview], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <section className="card" aria-labelledby={`doc-${reservationId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-telivity-teal" aria-hidden />
          <h3 id={`doc-${reservationId}`} className="text-sm font-semibold text-telivity-navy">{t('booking.doc.title')}</h3>
          {sentLabel && <span className="chip bg-emerald-100 text-emerald-900"><CheckCircle2 size={12} />{t('booking.doc.sentAt', { at: sentLabel })}</span>}
        </div>
        <div className="inline-flex rounded-lg border border-gray-300 p-0.5" role="tablist" aria-label={t('booking.doc.kind')}>
          {(['proposal', 'confirmation'] as Kind[]).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={effectiveKind === k} onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${effectiveKind === k ? 'bg-telivity-navy text-white' : 'text-telivity-slate hover:bg-telivity-light-grey'}`}>
              {t(`booking.doc.${k}`)}
            </button>
          ))}
        </div>
      </div>

      <div className={`grid gap-4 p-4 ${compact ? '' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]'}`}>
        <div className="space-y-3">
          <p className="text-sm text-telivity-slate">{t(effectiveKind === 'proposal' ? 'booking.doc.proposalHint' : 'booking.doc.confirmationHint')}</p>
          <button type="button" className="btn-secondary w-full" onClick={() => build.mutate()} disabled={build.isPending}>
            <FileText size={16} />{build.isPending ? t('booking.doc.building') : preview ? t('booking.doc.rebuild') : t('booking.doc.build')}
          </button>

          <div className="space-y-2">
            <div className="inline-flex w-full rounded-lg border border-gray-300 p-0.5" role="tablist" aria-label={t('booking.doc.channel')}>
              {([['email', Mail], ['sms', MessageSquare], ['chat', MessagesSquare]] as const).map(([c, Icon]) => (
                <button key={c} type="button" role="tab" aria-selected={channel === c} onClick={() => setChannel(c)}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold ${channel === c ? 'bg-primary-50 text-primary-800' : 'text-telivity-slate'}`}>
                  <Icon size={14} />{t(`booking.doc.${c}`)}
                </button>
              ))}
            </div>
            {channel === 'chat' ? <ChatDocumentSender reservationId={reservationId} propertyId={propertyId} kind={effectiveKind} canSend={canSend} /> : <>
            <label className="block">
              <span className="label">{channel === 'sms' ? t('booking.doc.phone') : t('booking.doc.email')}</span>
              <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="field"
                inputMode={channel === 'sms' ? 'tel' : 'email'} placeholder={channel === 'sms' ? '+7 700 000 00 00' : 'guest@example.com'} />
            </label>
            <button type="button" className="btn-primary btn-lg w-full" disabled={!canSend || !recipientValid || send.isPending}
              onClick={() => send.mutate()} title={!canSend ? t('booking.doc.noPermission') : undefined}>
              <Send size={16} />{send.isPending ? t('booking.doc.sending') : t('booking.doc.send')}
            </button>
            {!recipientValid && recipient && <p className="text-xs text-red-700">{t('booking.doc.invalidRecipient')}</p>}
            </>}
          </div>
        </div>

        <div className="min-h-[220px] overflow-hidden rounded-lg border border-gray-200 bg-telivity-light-grey">
          {preview ? (
            <div className="flex h-full flex-col">
              <div className="flex justify-end border-b border-gray-200 bg-white px-2 py-1.5">
                <button type="button" className="btn-ghost min-h-0 px-2 py-1 text-xs" onClick={openPrintable}><Printer size={14} />{t('booking.doc.print')}</button>
              </div>
              <iframe title={t('booking.doc.preview')} srcDoc={preview} sandbox="" className="h-[440px] w-full bg-white" />
            </div>
          ) : (
            <div className="flex h-full min-h-[220px] items-center justify-center p-6 text-center text-sm text-telivity-mid-grey">
              {dataQuery.isError ? errorMessage(dataQuery.error) : t('booking.doc.empty')}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
