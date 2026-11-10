import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock3, ShieldCheck, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { formatMoney } from '../../lib/money';
import { CHIP_CLASSES, GUARANTEE_TYPES, compactParty, optionState, statusTone, type GuaranteeType } from '../../lib/booking';
import { useToast } from '../ui/Toast';
import OptionActions from './OptionActions';

interface DocumentRoom { reservationId: string; status: string; roomType: string; roomNumber: string | null; adults: number; children: number; childAges: number[]; totalAmount: string }
interface DocumentData {
  confirmationNumber: string;
  groupName: string | null;
  rooms: DocumentRoom[];
  price: { currencyCode: string; total: string };
  payment: { paid: string; balance: string };
  guarantee: { optionUntil: string | null; requiredDeposit: string | null; depositDue: string | null; guaranteeType: string | null };
}

/**
 * Confirmation state of a booking in the drawer: tentative option with deadline and guarantee progress,
 * one-click confirmation (guarantee type, optional reason, guest notification), and the rooms of a group.
 */
export default function ReservationConfirmationCard({ reservation, propertyId, canWrite }: {
  reservation: { id: string; status: string; confirmedAt?: string | null; guaranteeType?: string | null; optionUntil?: string | null; detailsConfirmedAt?: string | null };
  propertyId: string; canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [guarantee, setGuarantee] = useState<GuaranteeType>('deposit');
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);

  const docQuery = useQuery<DocumentData>({
    queryKey: ['reservation-document', propertyId, reservation.id],
    queryFn: () => api.get(`/v1/reservations/${reservation.id}/confirmation`, { params: { propertyId }, skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
  });
  const doc = docQuery.data;
  const pendingRooms = doc?.rooms.filter((r) => r.status === 'pending').length ?? (reservation.status === 'pending' ? 1 : 0);
  const multi = (doc?.rooms.length ?? 1) > 1;

  const confirm = useMutation({
    mutationFn: (wholeBooking: boolean) => api.patch(`/v1/reservations/${reservation.id}/confirm`, {
      guaranteeType: guarantee, ...(reason.trim() ? { reason: reason.trim() } : {}), notifyGuest: notify, wholeBooking,
    }, { params: { propertyId }, skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
    onSuccess: (result: { notification?: { sent?: boolean; attempted?: boolean; error?: string } }) => {
      const n = result?.notification;
      toast('success', t('booking.confirmedToast'));
      if (n?.attempted && n.sent === false) toast('error', n.error ? `${t('booking.doc.notDelivered')}: ${n.error}` : t('booking.doc.notDelivered'));
      setOpen(false);
      for (const key of [['reservations'], ['reservation-document', propertyId, reservation.id], ['reservation-calendar']]) void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast('error', errorMessage(error)),
  });

  const fmtTime = (iso: string) => new Intl.DateTimeFormat(i18n.resolvedLanguage, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const tone = statusTone(reservation.status);
  const deadline = optionState(reservation.optionUntil ?? doc?.guarantee.optionUntil);
  const currency = doc?.price.currencyCode;
  const required = doc?.guarantee.requiredDeposit ? Number(doc.guarantee.requiredDeposit) : null;
  const paid = doc ? Number(doc.payment.paid) : 0;
  const progress = required ? Math.min(100, Math.round((paid / required) * 100)) : null;

  return (
    <section className={`rounded-xl border p-4 ${tone === 'tentative' ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {tone === 'tentative' ? <Clock3 className="mt-0.5 text-amber-600" size={20} /> : <ShieldCheck className="mt-0.5 text-emerald-600" size={20} />}
          <div>
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-telivity-navy">
              {tone === 'tentative' ? t('booking.status.tentativeTitle') : t('booking.status.confirmedTitle')}
              <span className={`chip ${CHIP_CLASSES[tone]}`}>{t(`reservations.statuses.${reservation.status}`, { defaultValue: reservation.status })}</span>
              {reservation.detailsConfirmedAt && <span className="chip bg-emerald-100 text-emerald-900" title={fmtTime(reservation.detailsConfirmedAt)}>{t('booking.hover.guestConfirmed')}</span>}
            </p>
            {tone === 'tentative' ? (
              <p className={`mt-1 text-sm ${deadline === 'expired' ? 'font-semibold text-red-700' : deadline === 'soon' ? 'text-amber-900' : 'text-telivity-slate'}`}>
                {deadline === 'none' ? t('booking.status.noDeadline')
                  : deadline === 'expired' ? t('booking.status.expired', { at: fmtTime((reservation.optionUntil ?? doc?.guarantee.optionUntil)!) })
                    : t('booking.status.until', { at: fmtTime((reservation.optionUntil ?? doc?.guarantee.optionUntil)!) })}
              </p>
            ) : (
              <p className="mt-1 text-sm text-telivity-slate">
                {[reservation.confirmedAt ? t('booking.status.confirmedAt', { at: fmtTime(reservation.confirmedAt) }) : null,
                  reservation.guaranteeType ? t('booking.status.guarantee', { type: t(`booking.guarantee.${reservation.guaranteeType}`) }) : null].filter(Boolean).join(' · ') || t('booking.status.confirmedPlain')}
              </p>
            )}
          </div>
        </div>
      </div>

      {tone === 'tentative' && required != null && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-telivity-slate">
            <span>{t('booking.status.guaranteeProgress', { paid: formatMoney(paid.toFixed(2), currency), required: formatMoney(required.toFixed(2), currency) })}</span>
            <span className="tabular-nums">{progress}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-amber-100" role="progressbar" aria-valuenow={progress ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-xs text-telivity-mid-grey">{t('booking.status.autoConfirmHint')}</p>
        </div>
      )}
      {deadline === 'expired' && tone === 'tentative' && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"><AlertTriangle size={16} />{t('booking.status.expiredAction')}</p>
      )}

      {tone === 'tentative' && canWrite && !open && reservation.status === 'pending' && (
        <OptionActions key={doc?.guarantee.depositDue ?? 'loading'} reservationId={reservation.id} propertyId={propertyId} currency={currency}
          due={doc?.guarantee.depositDue ?? doc?.guarantee.requiredDeposit ?? null}
          optionUntil={reservation.optionUntil ?? doc?.guarantee.optionUntil ?? null} multi={pendingRooms > 1} onConfirm={() => setOpen(true)} />
      )}

      {open && (
        <div className="mt-4 space-y-3 rounded-lg border border-gray-200 bg-white p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">{t('booking.guaranteeType')}</span>
              <select className="field" value={guarantee} onChange={(e) => setGuarantee(e.target.value as GuaranteeType)}>
                {GUARANTEE_TYPES.map((g) => <option key={g} value={g}>{t(`booking.guarantee.${g}`)}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">{t(guarantee === 'none' ? 'booking.guaranteeReason' : 'booking.comment')}</span>
              <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} required={guarantee === 'none'} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-telivity-slate">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />{t('booking.notifyGuest')}
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            {multi && pendingRooms > 1 && (
              <button type="button" className="btn-secondary" disabled={confirm.isPending || (guarantee === 'none' && !reason.trim())}
                onClick={() => confirm.mutate(true)}>{t('booking.confirmAll', { count: pendingRooms })}</button>
            )}
            <button type="button" className="btn-primary" disabled={confirm.isPending || (guarantee === 'none' && !reason.trim())}
              onClick={() => confirm.mutate(false)}>{confirm.isPending ? t('booking.confirming') : t('booking.confirmAction')}</button>
          </div>
        </div>
      )}

      {multi && doc && (
        <div className="mt-4 border-t border-gray-200 pt-3">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-telivity-mid-grey">
            <Users size={14} />{doc.groupName ? t('booking.groupRooms', { name: doc.groupName, count: doc.rooms.length }) : t('booking.bookingRooms', { count: doc.rooms.length })}
          </p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
            {doc.rooms.map((room) => (
              <li key={room.reservationId} className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${room.reservationId === reservation.id ? 'bg-primary-50/60' : ''}`}>
                <span className="min-w-0 truncate">
                  <strong className="text-telivity-navy">{room.roomNumber ?? '—'}</strong> · {room.roomType} · {compactParty(room.adults, room.children, room.childAges)}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={`chip ${CHIP_CLASSES[statusTone(room.status)]}`}>{t(`reservations.statuses.${room.status}`, { defaultValue: room.status })}</span>
                  <span className="tabular-nums">{formatMoney(room.totalAmount, currency)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
