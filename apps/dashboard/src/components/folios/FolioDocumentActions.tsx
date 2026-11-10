import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileDown, Mail } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { openFolioDocument } from '../../lib/folio-document';
import { useToast } from '../ui/Toast';

/**
 * Guest folio / receipt for checkout: opens the printable document (price per night with head count, charges,
 * payments, balance — "Save as PDF" from the print dialog) and emails it. Works from a folio id or
 * from the reservation (its guest folio).
 */
export default function FolioDocumentActions({ propertyId, folioId, reservationId, guestEmail, compact, hideOpen }: {
  propertyId: string; folioId?: string; reservationId?: string; guestEmail?: string | null; compact?: boolean;
  /** The page already shows the document button; offer only the email send. */
  hideOpen?: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [email, setEmail] = useState(guestEmail ?? '');
  const [showEmail, setShowEmail] = useState(false);
  useEffect(() => { setEmail(guestEmail ?? ''); }, [guestEmail]);

  const foliosQuery = useQuery<Array<{ id: string; type?: string }>>({
    queryKey: ['folios', 'reservation', propertyId, reservationId],
    enabled: !folioId && !!reservationId,
    queryFn: () => api.get('/v1/folios', { params: { propertyId, reservationId, limit: 100 }, skipErrorToast: true }).then((r) => r.data?.data ?? r.data ?? []),
  });
  const targetId = folioId ?? foliosQuery.data?.find((f) => f.type === 'guest')?.id ?? foliosQuery.data?.[0]?.id;

  const open = useMutation({
    mutationFn: () => openFolioDocument(targetId!, propertyId),
    onError: (error) => toast('error', errorMessage(error)),
  });
  const send = useMutation({
    mutationFn: () => api.post(`/v1/folios/${targetId}/document/send`, { email: email.trim() }, { params: { propertyId } }).then((r) => r.data?.data ?? r.data),
    onSuccess: (result: { sent: boolean; to: string }) => {
      toast(result.sent ? 'success' : 'error', result.sent ? t('statement.sent', { to: result.to }) : t('booking.doc.notDelivered'));
      if (result.sent) setShowEmail(false);
    },
    onError: (error) => toast('error', errorMessage(error)),
  });

  if (!targetId) return null;
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex flex-wrap gap-2">
        {!hideOpen && <button type="button" className="btn-secondary" onClick={() => open.mutate()} disabled={open.isPending}>
          <FileDown size={16} />{open.isPending ? t('statement.opening') : t('statement.open')}
        </button>}
        <button type="button" className="btn-ghost" onClick={() => setShowEmail((v) => !v)} aria-expanded={showEmail}>
          <Mail size={16} />{t('statement.email')}
        </button>
      </div>
      {showEmail && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[220px] flex-1">
            <span className="label">{t('booking.doc.email')}</span>
            <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="guest@example.com" />
          </label>
          <button type="button" className="btn-primary" disabled={!validEmail || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? t('booking.doc.sending') : t('statement.send')}
          </button>
        </div>
      )}
    </div>
  );
}
