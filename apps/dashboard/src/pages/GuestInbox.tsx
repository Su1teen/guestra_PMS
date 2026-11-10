import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, CheckCircle2, FileText, Inbox as InboxIcon, Lock, Mail, MessageSquare, Plus, RotateCcw, Search, Send, StickyNote, UserRound, X } from 'lucide-react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/error-message';
import { useProperty } from '../context/PropertyContext';
import { propertyHref } from '../lib/navigation';
import { useToast } from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import FindGuest from '../components/guests/FindGuest';

export const QUEUES = ['focus', 'payment', 'follow_up', 'waiting_guest', 'all', 'archive'] as const;
export const CHANNELS = ['telegram', 'whatsapp', 'instagram', 'simulator', 'email', 'sms'] as const;
const MESSENGERS = ['telegram', 'whatsapp', 'instagram', 'simulator'];
type Queue = (typeof QUEUES)[number];

interface Attention { state: string; label: string; priority: number; requiresHuman: boolean }
interface DocumentRef { id: string; status: string; kind: string; pmsReservationId: string }
interface ConversationRow {
  id: string; customerName: string; phone: string | null; email: string | null; channel: string; status: string; automationMode: string;
  unreadCount: number; lastMessageAt: string; reservationCode: string | null; attention?: Attention; document?: DocumentRef | null;
  lastMessage?: { text: string; direction: string; senderType: string; at: string } | null;
}
interface ListResponse { conversations: ConversationRow[]; total?: number; hasMore?: boolean;
  counts?: { queues: Record<Queue, number>; channels: Record<string, number>; unread: number } }
interface Message {
  id: string; direction: 'in' | 'out' | 'note'; senderType: string; text: string; at: string; deliveryStatus: string; staffName?: string | null;
  subject?: string | null; deliveryError?: string | null; documentConfirmationId?: string | null;
  attachments?: { id: string; fileName?: string | null; processingStatus: string }[];
}
interface Detail {
  id: string; customerName: string; phone: string | null; email: string | null; channel: string; status: string; automationMode: string;
  unreadCount: number; handoff: { reasonCode: string | null; note: string | null; requestedAction: string | null } | null; reservationCode: string | null;
  documents: Array<DocumentRef & { mode: string; createdAt: string; confirmedAt: string | null; documentUrl: string }>;
  messages: Message[]; hasOlderMessages: boolean;
  operationalContext: { verifiedGuest: boolean; guestId?: string;
    reservations?: { id: string; status: string; arrivalDate: string; departureDate: string; confirmationNumber?: string; optionUntil?: string | null;
      detailsConfirmedAt?: string | null; totalAmount?: string; currencyCode?: string }[];
    services?: { id: string; status: string; startAt: string }[]; requests?: { id: string; status: string; title: string }[];
    folios?: { id: string; balance: string; currencyCode: string; receivedAmount: string }[] };
}

const unwrap = <T,>(r: { data: any }) => (r.data?.data ?? r.data) as T;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
const ChannelIcon = ({ channel, size = 14 }: { channel: string; size?: number }) =>
  channel === 'email' ? <Mail size={size} aria-hidden /> : channel === 'simulator' ? <Bot size={size} aria-hidden /> : <MessageSquare size={size} aria-hidden />;

/**
 * Guest conversations on every channel (messengers, AI Studio, email, SMS) stored in the CRM, worked from PMS with
 * the CRM's queues and filters: reply or add a note, take a chat over from the AI or hand it back, close it,
 * start a new chat, and see the guest's stays and the documents they were asked to confirm.
 */
export default function GuestInbox() {
  const { t, i18n } = useTranslation();
  const { propertyId } = useProperty();
  const { toast } = useToast();
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [queue, setQueue] = useState<Queue>(() => (QUEUES as readonly string[]).includes(params.get('queue') ?? '') ? params.get('queue') as Queue : 'focus');
  const [channel, setChannel] = useState('all');
  const [mode, setMode] = useState('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [subject, setSubject] = useState('');
  const [asNote, setAsNote] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const selected = params.get('conversation');
  const threadEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { const id = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(id); }, [searchInput]);
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('conversation', id); else next.delete('conversation');
    setParams(next, { replace: true });
  };
  const fmt = (iso: string, withDate = true) => new Intl.DateTimeFormat(i18n.resolvedLanguage,
    withDate ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const shortTime = (iso: string) => new Date(iso).toDateString() === new Date().toDateString() ? fmt(iso, false)
    : new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: '2-digit', month: 'short' }).format(new Date(iso));

  const status = useQuery<{ enabled: boolean; reason?: string; staffName?: string }>({
    queryKey: ['guest-inbox-status', propertyId], enabled: !!propertyId,
    queryFn: () => api.get('/v1/guest-inbox/status', { params: { propertyId }, skipErrorToast: true }).then(unwrap<{ enabled: boolean; reason?: string }>),
  });
  const enabled = status.data?.enabled === true;
  const filters = { queue, ...(channel !== 'all' ? { channel } : {}), ...(mode !== 'all' ? { mode } : {}), ...(unreadOnly ? { unread: 'true' } : {}), ...(search ? { search } : {}) };
  const list = useQuery<ListResponse>({
    queryKey: ['guest-inbox', propertyId, filters], enabled: enabled && !!propertyId, refetchInterval: 10_000,
    queryFn: () => api.get('/v1/guest-inbox', { params: { propertyId, ...filters }, isSilentPoll: true, skipErrorToast: true }).then(unwrap<ListResponse>),
  });
  const detail = useQuery<Detail>({
    queryKey: ['guest-inbox', propertyId, 'detail', selected], enabled: enabled && !!propertyId && !!selected, refetchInterval: 8_000,
    queryFn: () => api.get('/v1/guest-inbox/' + encodeURIComponent(selected!), { params: { propertyId }, isSilentPoll: true, skipErrorToast: true }).then(unwrap<Detail>),
  });
  const conversation = detail.data;
  const refresh = () => void cache.invalidateQueries({ queryKey: ['guest-inbox', propertyId] });

  const markRead = useMutation({ mutationFn: (id: string) => api.patch('/v1/guest-inbox/' + encodeURIComponent(id), { read: true }, { params: { propertyId }, skipErrorToast: true }),
    onSuccess: refresh });
  useEffect(() => { if (conversation && conversation.unreadCount > 0 && !markRead.isPending) markRead.mutate(conversation.id); },
    [conversation?.id, conversation?.unreadCount]);
  useEffect(() => { threadEnd.current?.scrollIntoView?.({ block: 'end' }); }, [conversation?.id, conversation?.messages.length]);
  useEffect(() => { setDraft(''); setSubject(''); setAsNote(false); }, [selected]);

  const action = (fn: () => Promise<unknown>, done: string) => ({ mutationFn: fn, onSuccess: () => { toast('success', done); refresh(); },
    onError: (error: unknown) => toast('error', errorMessage(error)) });
  const reply = useMutation(action(() => api.post('/v1/guest-inbox/' + encodeURIComponent(selected!) + '/messages',
    { text: draft.trim(), asNote, ...(subject.trim() ? { subject: subject.trim() } : {}), idempotencyKey: crypto.randomUUID() },
    { params: { propertyId }, skipErrorToast: true }).then((r) => { setDraft(''); return r; }), asNote ? t('guestInbox.noteSaved') : t('guestInbox.replySent')));
  const automation = useMutation({ mutationFn: (next: 'ai' | 'human') => api.post('/v1/guest-inbox/' + encodeURIComponent(selected!) + '/automation', { mode: next },
    { params: { propertyId }, skipErrorToast: true }), onSuccess: (_r, next) => { toast('success', t(next === 'ai' ? 'guestInbox.aiResumed' : 'guestInbox.takenOver')); refresh(); },
    onError: (error) => toast('error', errorMessage(error)) });
  const setStatus = useMutation({ mutationFn: (next: 'open' | 'closed') => api.patch('/v1/guest-inbox/' + encodeURIComponent(selected!), { status: next },
    { params: { propertyId }, skipErrorToast: true }), onSuccess: (_r, next) => { toast('success', t(next === 'closed' ? 'guestInbox.closed' : 'guestInbox.reopened')); refresh(); },
    onError: (error) => toast('error', errorMessage(error)) });
  const confirmDoc = useMutation({ mutationFn: (doc: DocumentRef) => api.post(`/v1/reservations/${doc.pmsReservationId}/confirmation/chat/${encodeURIComponent(doc.id)}/resolve`,
    { outcome: 'confirmed' }, { params: { propertyId }, skipErrorToast: true }), onSuccess: () => { toast('success', t('chatDoc.markedConfirmed')); refresh(); },
    onError: (error) => toast('error', errorMessage(error)) });

  const rows = list.data?.conversations ?? [];
  const counts = list.data?.counts;
  const messenger = conversation ? MESSENGERS.includes(conversation.channel) : false;
  const aiOwned = messenger && conversation?.automationMode !== 'human';
  const replyBlocked = !asNote && aiOwned;
  const openDocs = useMemo(() => conversation?.documents.filter((d) => d.status === 'awaiting' || d.status === 'answered') ?? [], [conversation]);

  if (!propertyId) return <p className="p-6">{t('guestInbox.selectProperty')}</p>;
  if (status.isLoading) return <p className="p-6 text-telivity-slate">{t('guestInbox.loading')}</p>;
  if (!enabled) {
    const reason = status.data?.reason ?? (status.isError ? 'CRM_UNAVAILABLE' : 'INBOX_DISABLED');
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-telivity-navy"><InboxIcon size={24} />{t('guestInbox.title')}</h1>
        <div className="card mt-4 p-5">
          <p className="font-medium text-telivity-navy">{t(`guestInbox.reasons.${reason}`, { defaultValue: t('guestInbox.reasons.CRM_UNAVAILABLE') })}</p>
          <p className="mt-2 text-sm text-telivity-slate">{t('guestInbox.reasonsHint')}</p>
        </div>
      </div>
    );
  }

  const bubble = (m: Message) => {
    const out = m.direction === 'out', note = m.direction === 'note';
    const who = note ? t('guestInbox.note') : !out ? conversation?.customerName : m.senderType === 'ai' ? t('guestInbox.sender.ai')
      : m.senderType === 'system' ? t('guestInbox.sender.system') : m.staffName ?? t('guestInbox.sender.staff');
    const doc = m.documentConfirmationId ? conversation?.documents.find((d) => d.id === m.documentConfirmationId) : undefined;
    return (
      <article key={m.id} className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm ${note ? 'ml-auto border border-amber-200 bg-amber-50 text-amber-950'
        : out ? `ml-auto ${m.senderType === 'human' ? 'bg-primary-600 text-white' : 'bg-primary-50 text-telivity-navy ring-1 ring-primary-100'}` : 'bg-white text-telivity-navy ring-1 ring-gray-200'}`}>
        <p className={`mb-0.5 flex items-center gap-1 text-xs font-semibold ${out && m.senderType === 'human' && !note ? 'text-white/80' : 'text-telivity-mid-grey'}`}>
          {note && <StickyNote size={12} />}{m.senderType === 'ai' && <Bot size={12} />}{who}
        </p>
        {m.subject && <p className="mb-1 font-semibold">{m.subject}</p>}
        <p className="whitespace-pre-wrap break-words">{m.text}</p>
        {m.attachments?.map((a) => <p key={a.id} className="mt-1 text-xs opacity-80">📎 {a.fileName || t('guestInbox.attachment')}</p>)}
        {doc && <p className="mt-2"><span className={`chip ${doc.status === 'confirmed' ? 'bg-emerald-100 text-emerald-900' : doc.status === 'awaiting' ? 'bg-amber-100 text-amber-900' : 'bg-red-100 text-red-800'}`}>
          <FileText size={12} />{t(`chatDoc.status.${doc.status}`)}</span></p>}
        <p className={`mt-1 text-xs ${out && m.senderType === 'human' && !note ? 'text-white/70' : 'text-telivity-mid-grey'}`}>
          {fmt(m.at)}{out ? ` · ${t(`guestInbox.delivery.${m.deliveryStatus}`, { defaultValue: m.deliveryStatus })}` : ''}
        </p>
        {m.deliveryStatus === 'failed' && m.deliveryError && <p className="mt-1 text-xs font-medium text-red-700">{t('guestInbox.deliveryFailed')}</p>}
      </article>
    );
  };

  const context = conversation?.operationalContext;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-telivity-navy"><InboxIcon size={24} />{t('guestInbox.title')}
          {!!counts?.unread && <span className="chip bg-primary-600 text-white">{counts.unread}</span>}</h1>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <label className="relative min-w-[200px] max-w-xs flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-telivity-mid-grey" />
            <input className="field pl-9" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('guestInbox.search')} aria-label={t('guestInbox.search')} />
          </label>
          <select className="field w-auto" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label={t('guestInbox.channel')}>
            <option value="all">{t('guestInbox.allChannels')}</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{t(`guestInbox.channels.${c}`)}{counts?.channels[c] ? ` · ${counts.channels[c]}` : ''}</option>)}
          </select>
          <select className="field w-auto" value={mode} onChange={(e) => setMode(e.target.value)} aria-label={t('guestInbox.modeFilter')}>
            <option value="all">{t('guestInbox.modes.all')}</option>
            {['ai', 'needs_human', 'human'].map((m) => <option key={m} value={m}>{t(`guestInbox.modes.${m}`)}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-sm text-telivity-slate"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />{t('guestInbox.unreadOnly')}</label>
          <button type="button" className="btn-primary" onClick={() => setStartOpen(true)}><Plus size={16} />{t('guestInbox.newChat')}</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-gray-200" role="tablist" aria-label={t('guestInbox.queue')}>
        {QUEUES.map((q) => (
          <button key={q} type="button" role="tab" aria-selected={queue === q} onClick={() => setQueue(q)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${queue === q ? 'border-primary-600 text-telivity-navy' : 'border-transparent text-telivity-slate hover:text-telivity-navy'}`}>
            {t(`guestInbox.queues.${q}`)}<span className="ml-1.5 text-xs text-telivity-mid-grey">{counts?.queues[q] ?? ''}</span>
          </button>
        ))}
      </div>
      {(list.isError || detail.isError) && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        {errorMessage(list.error ?? detail.error) || t('guestInbox.unavailable')}</div>}

      <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
        <section className="card flex min-h-[240px] flex-col overflow-hidden xl:min-h-0" aria-label={t('guestInbox.conversations')}>
          <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
            {list.isLoading && <p className="p-4 text-sm text-telivity-slate">{t('guestInbox.loading')}</p>}
            {!list.isLoading && !rows.length && <p className="p-4 text-sm text-telivity-slate">{t('guestInbox.empty')}</p>}
            {rows.map((c) => (
              <button key={c.id} type="button" onClick={() => select(c.id)} aria-current={selected === c.id}
                className={`w-full border-l-[3px] px-3 py-3 text-left ${selected === c.id ? 'border-primary-600 bg-primary-50/60' : 'border-transparent hover:bg-telivity-light-grey'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-800">{initials(c.customerName)}</span>
                    <span className="truncate font-medium text-telivity-navy">{c.customerName}</span>
                  </span>
                  <span className="shrink-0 text-xs text-telivity-mid-grey">{shortTime(c.lastMessageAt)}</span>
                </div>
                {c.lastMessage && <p className="mt-1 line-clamp-1 text-sm text-telivity-slate">{c.lastMessage.direction === 'out' ? `${t('guestInbox.you')}: ` : ''}{c.lastMessage.text}</p>}
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs">
                  <span className="flex shrink-0 items-center gap-1 text-telivity-mid-grey"><ChannelIcon channel={c.channel} size={12} />{t(`guestInbox.channels.${c.channel}`, { defaultValue: c.channel })}</span>
                  {c.attention && <span className={`truncate font-medium ${c.attention.requiresHuman ? 'text-amber-800' : 'text-telivity-mid-grey'}`}>· {c.attention.label}</span>}
                  {c.document && c.document.status !== 'superseded' && <span className="shrink-0" title={t(`chatDoc.status.${c.document.status}`)}><FileText size={12} className={c.document.status === 'confirmed' ? 'text-emerald-600' : 'text-amber-600'} /></span>}
                  {c.unreadCount > 0 && <span className="ml-auto h-2.5 w-2.5 shrink-0 rounded-full bg-primary-600" aria-label={t('guestInbox.unread')} />}
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="card flex min-h-[480px] min-w-0 flex-col overflow-hidden xl:min-h-0" aria-label={t('guestInbox.thread')}>
          {!selected ? <p className="m-auto p-6 text-telivity-slate">{t('guestInbox.selectConversation')}</p> : !conversation ? <p className="m-auto p-6 text-telivity-slate">{t('guestInbox.loading')}</p> : <>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-telivity-navy">{conversation.customerName}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-telivity-slate">
                  <ChannelIcon channel={conversation.channel} size={12} />{t(`guestInbox.channels.${conversation.channel}`, { defaultValue: conversation.channel })}
                  {messenger && <span className={`chip ${conversation.automationMode === 'ai' ? 'bg-primary-50 text-primary-800' : conversation.automationMode === 'needs_human' ? 'bg-amber-100 text-amber-900' : 'bg-gray-100 text-gray-800'}`}>
                    {t(`guestInbox.modes.${conversation.automationMode}`)}</span>}
                  {conversation.status === 'closed' && <span className="chip bg-gray-100 text-gray-700">{t('guestInbox.statusClosed')}</span>}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {messenger && (conversation.automationMode === 'human'
                  ? <button type="button" className="btn-secondary" disabled={automation.isPending} onClick={() => automation.mutate('ai')}><Bot size={16} />{t('guestInbox.resumeAi')}</button>
                  : <button type="button" className="btn-primary" disabled={automation.isPending} onClick={() => automation.mutate('human')}><UserRound size={16} />{t('guestInbox.takeover')}</button>)}
                {conversation.status === 'closed'
                  ? <button type="button" className="btn-secondary" disabled={setStatus.isPending} onClick={() => setStatus.mutate('open')}><RotateCcw size={16} />{t('guestInbox.reopen')}</button>
                  : <button type="button" className="btn-ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate('closed')}><CheckCircle2 size={16} />{t('guestInbox.close')}</button>}
              </div>
            </header>
            {conversation.handoff && <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-950">
              <strong>{t('guestInbox.handoff')}</strong>{conversation.handoff.requestedAction || conversation.handoff.note ? `: ${conversation.handoff.requestedAction ?? conversation.handoff.note}` : ''}</div>}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-telivity-light-grey/60 px-4 py-4">
              {conversation.hasOlderMessages && <p className="text-center text-xs text-telivity-mid-grey">{t('guestInbox.recentMessages')}</p>}
              {conversation.messages.map(bubble)}
              <div ref={threadEnd} />
            </div>
            <form className="border-t border-gray-200 bg-white px-4 py-3" onSubmit={(e) => { e.preventDefault(); if (draft.trim() && !replyBlocked) reply.mutate(); }}>
              <div className="mb-2 flex gap-1" role="tablist">
                <button type="button" role="tab" aria-selected={!asNote} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${!asNote ? 'bg-primary-50 text-primary-800' : 'text-telivity-slate'}`} onClick={() => setAsNote(false)}>{t('guestInbox.replyTab')}</button>
                <button type="button" role="tab" aria-selected={asNote} className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold ${asNote ? 'bg-amber-100 text-amber-900' : 'text-telivity-slate'}`} onClick={() => setAsNote(true)}><Lock size={12} />{t('guestInbox.noteTab')}</button>
              </div>
              {replyBlocked && <p className="mb-2 rounded-md bg-telivity-light-grey px-2.5 py-2 text-xs text-telivity-slate">{t('guestInbox.aiOwnsReply')}</p>}
              {!asNote && conversation.channel === 'email' && <input className="field mb-2" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t('guestInbox.subject')} maxLength={300} />}
              <textarea className="field min-h-[72px] resize-y" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={replyBlocked} maxLength={10000}
                placeholder={asNote ? t('guestInbox.notePlaceholder') : t('guestInbox.replyPlaceholder')} aria-label={asNote ? t('guestInbox.noteTab') : t('guestInbox.replyTab')}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim() && !replyBlocked) { e.preventDefault(); reply.mutate(); } }} />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-telivity-mid-grey">{t('guestInbox.sendHint')}</span>
                <button type="submit" className={asNote ? 'btn-secondary' : 'btn-primary'} disabled={!draft.trim() || replyBlocked || reply.isPending}>
                  {asNote ? <StickyNote size={16} /> : <Send size={16} />}{reply.isPending ? t('booking.doc.sending') : asNote ? t('guestInbox.saveNote') : t('guestInbox.send')}
                </button>
              </div>
            </form>
          </>}
        </section>

        <aside className="card min-h-0 space-y-4 overflow-y-auto p-4" aria-label={t('guestInbox.context')}>
          <h2 className="text-sm font-semibold text-telivity-navy">{t('guestInbox.context')}</h2>
          {!conversation ? <p className="text-sm text-telivity-slate">{t('guestInbox.selectConversation')}</p> : <>
            <div className="space-y-1 text-sm">
              <p className="font-medium text-telivity-navy">{conversation.customerName}</p>
              {conversation.phone && <p className="text-telivity-slate">{conversation.phone}</p>}
              {conversation.email && <p className="truncate text-telivity-slate">{conversation.email}</p>}
            </div>
            {openDocs.length > 0 && <div className="space-y-2">
              <h3 className="label">{t('guestInbox.documents')}</h3>
              {openDocs.map((d) => <div key={d.id} className={`rounded-lg border p-2.5 text-sm ${d.status === 'answered' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
                <p className="font-medium text-telivity-navy">{t(`booking.doc.${d.kind}`)} · {t(`chatDoc.status.${d.status}`)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <a className="btn-ghost min-h-0 px-2 py-1 text-xs" href={d.documentUrl} target="_blank" rel="noreferrer"><FileText size={14} />{t('guestInbox.openDocument')}</a>
                  <button type="button" className="btn-secondary min-h-0 px-2 py-1 text-xs" disabled={confirmDoc.isPending} onClick={() => confirmDoc.mutate(d)}><CheckCircle2 size={14} />{t('chatDoc.markConfirmed')}</button>
                </div>
              </div>)}
            </div>}
            {context && !context.verifiedGuest && <p className="text-sm text-telivity-mid-grey">{t('guestInbox.noStay')}</p>}
            {!!context?.reservations?.length && <div className="space-y-2">
              <h3 className="label">{t('guestInbox.stays')}</h3>
              {context.reservations.map((r) => <Link key={r.id} to={propertyHref(`/reservations/${r.id}`, propertyId)} className="block rounded-lg border border-gray-200 p-2.5 text-sm hover:bg-telivity-light-grey">
                <span className="flex items-center justify-between gap-2"><strong className="text-telivity-navy">{r.confirmationNumber ?? '—'}</strong>
                  <span className="text-xs text-telivity-slate">{t(`reservations.statuses.${r.status}`, { defaultValue: r.status })}</span></span>
                <span className="block text-telivity-slate">{r.arrivalDate} — {r.departureDate}</span>
                {r.detailsConfirmedAt && <span className="mt-1 flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 size={12} />{t('guestInbox.detailsConfirmed')}</span>}
              </Link>)}
            </div>}
            {!!context?.services?.length && <div><h3 className="label">{t('guestInbox.services')}</h3>
              {context.services.map((s) => <p key={s.id} className="text-sm text-telivity-slate">{fmt(s.startAt)} · {t(`guestInbox.states.${s.status}`, { defaultValue: s.status })}</p>)}</div>}
            {!!context?.requests?.length && <div><h3 className="label">{t('guestInbox.requests')}</h3>
              {context.requests.map((r) => <p key={r.id} className="text-sm text-telivity-slate">{r.title} · {t(`guestInbox.states.${r.status}`, { defaultValue: r.status })}</p>)}</div>}
            {!!context?.folios?.length && <div><h3 className="label">{t('guestInbox.finance')}</h3>
              {context.folios.map((f) => <p key={f.id} className="text-sm text-telivity-slate">{t('guestInbox.balance')}: {f.balance} {f.currencyCode}</p>)}</div>}
          </>}
        </aside>
      </div>

      <StartChatModal open={startOpen} onClose={() => setStartOpen(false)} propertyId={propertyId} onStarted={(id) => { setStartOpen(false); refresh(); select(id); }} />
    </div>
  );
}

function StartChatModal({ open, onClose, propertyId, onStarted }: { open: boolean; onClose: () => void; propertyId: string; onStarted: (id: string) => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [guest, setGuest] = useState<any>(null);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>('simulator');
  const [ai, setAi] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => { if (!open) { setGuest(null); setText(''); setAi(false); } }, [open]);
  const start = useMutation({
    mutationFn: () => api.post('/v1/guest-inbox/conversations', { guestId: guest.id, channel, text: text.trim(),
      automationMode: ai && MESSENGERS.includes(channel) ? 'ai' : 'human', idempotencyKey: crypto.randomUUID() }, { params: { propertyId }, skipErrorToast: true })
      .then(unwrap<{ conversationId: string; delivered: boolean }>),
    onSuccess: (r) => { toast(r.delivered ? 'success' : 'error', r.delivered ? t('guestInbox.replySent') : t('guestInbox.deliveryFailed')); onStarted(r.conversationId); },
    onError: (error) => toast('error', errorMessage(error)),
  });
  return (
    <Modal open={open} onClose={onClose} title={t('guestInbox.newChat')}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (guest && text.trim()) start.mutate(); }}>
        <FindGuest selectedGuest={guest} onSelectGuest={setGuest} label={t('guestInbox.guest')} />
        <label className="block"><span className="label">{t('guestInbox.channel')}</span>
          <select className="field" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
            {CHANNELS.filter((c) => c !== 'instagram').map((c) => <option key={c} value={c}>{t(`guestInbox.channels.${c}`)}</option>)}
          </select>
          {(channel === 'telegram' || channel === 'whatsapp') && <span className="mt-1 block text-xs text-telivity-mid-grey">{t('guestInbox.messengerExisting')}</span>}
        </label>
        {MESSENGERS.includes(channel) && <label className="flex items-center gap-2 text-sm text-telivity-slate"><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />{t('guestInbox.aiContinues')}</label>}
        <label className="block"><span className="label">{t('guestInbox.message')}</span>
          <textarea className="field min-h-[110px]" value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} /></label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}><X size={16} />{t('common.cancel')}</button>
          <button type="submit" className="btn-primary" disabled={!guest || !text.trim() || start.isPending}><Send size={16} />{t('guestInbox.send')}</button>
        </div>
      </form>
    </Modal>
  );
}
