import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, Check, X } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { useAuth } from '../../context/AuthContext';
export function ReservationMessageCompose({
  reservationId,
  propertyId,
}: {
  reservationId: string;
  propertyId: string;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [isMarketing, setIsMarketing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      api.post(
        `/v1/reservations/${reservationId}/messages`,
        {
          propertyId,
          channel,
          ...(channel === 'email' ? { subject: subject.trim() } : {}),
          body: body.trim(),
          isMarketing,
        },
        { skipErrorToast: true },
      ),
    onSuccess: (res) => {
      const sent = res.data?.sent ?? res.data?.data?.sent;
      if (channel === 'sms') {
        setStatus(sent ? t('reservations.smsSent') : t('reservations.smsDrafted'));
      } else {
        setStatus(sent ? t('reservations.messageSent') : t('reservations.messageDrafted'));
      }
      setSubject('');
      setBody('');
    },
    onError: (e: unknown) => {
      setStatus(errorMessage(e));
    },
  });

  const canSend =
    body.trim().length > 0 && (channel === 'sms' || subject.trim().length > 0) && !send.isPending;

  return (
    <div className="space-y-2 border-t border-gray-100 pt-4">
      <p className="text-xs font-medium text-telivity-mid-grey">{t('reservations.guestMessage')}</p>
      <label className="block text-xs text-telivity-navy">
        <span className="sr-only">{t('reservations.messageChannel')}</span>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="email">{t('reservations.messageChannelEmail')}</option>
          <option value="sms">{t('reservations.messageChannelSms')}</option>
        </select>
      </label>
      {channel === 'email' && (
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t('reservations.messageSubject')}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        placeholder={t('reservations.messageBody')}
      />
      <label className="flex items-center gap-2 text-xs text-telivity-navy">
        <input
          type="checkbox"
          checked={isMarketing}
          onChange={(e) => setIsMarketing(e.target.checked)}
          className="rounded border-gray-300"
        />
        {t('reservations.marketingMessage')}
      </label>
      <button
        type="button"
        onClick={() => send.mutate()}
        disabled={!canSend}
        className="w-full bg-telivity-teal text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      >
        {t('reservations.sendMessage')}
      </button>
      {status && <p className="text-xs text-telivity-mid-grey">{status}</p>}
    </div>
  );
}

export function ReservationOpsNotes({
  reservationId,
  propertyId,
}: {
  reservationId: string;
  propertyId: string;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const { data, refetch } = useQuery({
    queryKey: ['reservation-notes', reservationId, propertyId],
    queryFn: () =>
      api
        .get(`/v1/reservations/${reservationId}/notes`, { params: { propertyId } })
        .then((r) => r.data),
    enabled: !!reservationId && !!propertyId,
  });
  const add = useMutation({
    mutationFn: () =>
      api.post(`/v1/reservations/${reservationId}/notes`, { propertyId, body: body.trim() }),
    onSuccess: () => {
      setBody('');
      refetch();
    },
  });
  // Note mutations live on the static /reservations/notes/:noteId routes.
  const update = useMutation({
    mutationFn: (payload: { noteId: string; body?: string; isActive?: boolean }) =>
      api.patch(
        `/v1/reservations/notes/${payload.noteId}`,
        {
          propertyId,
          ...(payload.body != null ? { body: payload.body } : {}),
          ...(payload.isActive != null ? { isActive: payload.isActive } : {}),
        },
        { params: { propertyId } },
      ),
    onSuccess: () => {
      setEditingId(null);
      setEditBody('');
      refetch();
    },
  });
  const remove = useMutation({
    mutationFn: (noteId: string) =>
      api.delete(`/v1/reservations/notes/${noteId}`, { params: { propertyId } }),
    onSuccess: () => refetch(),
  });
  const notes = data?.notes ?? data?.data ?? (Array.isArray(data) ? data : []);

  return (
    <div className="space-y-2 border-t border-gray-100 pt-4">
      <p className="text-xs font-medium text-telivity-mid-grey">{t('reservations.opsNotes')}</p>
      <ul className="space-y-1 max-h-48 overflow-y-auto">
        {notes.map((n: { id: string; body: string; isActive?: boolean }) => (
          <li key={n.id} className={`text-sm bg-telivity-light-grey rounded-lg p-2 ${n.isActive === false ? 'opacity-60' : ''}`}>
            {editingId === n.id ? (
              <div className="space-y-2">
                <textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1 text-sm"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => update.mutate({ noteId: n.id, body: editBody.trim() })}
                    disabled={!editBody.trim() || update.isPending}
                    className="text-xs font-semibold text-telivity-teal hover:underline disabled:opacity-50"
                  >
                    {t('common.save')}
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-xs text-telivity-mid-grey hover:underline">
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words">{n.body}</span>
                <div className="flex gap-2 shrink-0">
                  <button
                    disabled={!hasPermission('reservations.write')}
                    onClick={() => { setEditingId(n.id); setEditBody(n.body); }}
                    aria-label={t('common.edit')}
                    className="text-telivity-slate hover:text-telivity-teal"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => update.mutate({ noteId: n.id, isActive: n.isActive === false })}
                    disabled={!hasPermission('reservations.write') || update.isPending}
                    className="text-[10px] text-telivity-mid-grey hover:underline disabled:opacity-50"
                  >
                    {n.isActive === false ? t('reservations.reactivateNote') : t('reservations.resolveNote')}
                  </button>
                  <button
                    onClick={() => { if (confirm(t('reservations.confirmDeleteNote'))) remove.mutate(n.id); }}
                    disabled={!hasPermission('reservations.write') || remove.isPending}
                    aria-label={t('common.delete')}
                    className="text-telivity-slate hover:text-telivity-orange disabled:opacity-50"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
        {notes.length === 0 && (
          <li className="text-xs text-telivity-mid-grey">{t('reservations.noOpsNotes')}</li>
        )}
      </ul>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        placeholder={t('reservations.addOpsNote')}
      />
      <button
        type="button"
        onClick={() => add.mutate()}
        disabled={!hasPermission('reservations.write') || !body.trim() || add.isPending}
        className="w-full border border-gray-200 text-telivity-slate rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-telivity-light-grey disabled:opacity-50"
      >
        {t('reservations.saveNote')}
      </button>
    </div>
  );
}

