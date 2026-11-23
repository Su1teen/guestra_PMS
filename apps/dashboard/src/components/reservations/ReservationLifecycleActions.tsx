import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import type { Reservation } from './types';

type Decision = 'cancel' | 'no-show' | 'retain' | 'refund';
interface StayMoney {
  late: boolean; hoursBeforeArrival: number; lateCancellationHours: number; available: string; paid: string; refunded: string; retained: string;
  suggestion: 'retain_prepayment' | 'refund_or_keep' | 'nothing_to_settle';
  payments: { id: string; amount: string; method: string; processedAt: string | null }[];
}

/**
 * Manual decisions on a booking. Cancel and no-show need a reason; afterwards staff decide whether to
 * retain the prepayment as a penalty or refund it. A late cancellation suggests retaining; a person decides.
 */
export default function ReservationLifecycleActions({ reservation, propertyId, onWorkflow }: {
  reservation: Reservation; propertyId: string; onWorkflow: (url: string) => void;
}) {
  const { t } = useTranslation(); const { hasPermission } = useAuth(); const client = useQueryClient();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const closed = ['cancelled', 'no_show'].includes(reservation.status);
  const money = useQuery({
    queryKey: ['stay-money', reservation.id, reservation.status],
    queryFn: () => api.get(`/v1/reservations/${reservation.id}/money`, { params: { propertyId }, skipErrorToast: true }).then((r) => (r.data?.data ?? r.data) as StayMoney),
    enabled: Boolean(decision) || closed,
  });
  const mutation = useMutation({
    mutationFn: (action: Decision | 'confirm') => {
      const params = { params: { propertyId }, skipErrorToast: true };
      if (action === 'confirm') return api.patch(`/v1/reservations/${reservation.id}/confirm`, {}, params);
      const path = { cancel: 'manual-cancel', 'no-show': 'manual-no-show', retain: 'retain-prepayment', refund: 'refund' }[action];
      const body = action === 'retain' ? { reason: reason.trim(), ...(amount.trim() ? { amount: amount.trim() } : {}) }
        : action === 'refund' ? { reason: reason.trim(), paymentId, ...(amount.trim() ? { amount: amount.trim() } : {}) } : { reason: reason.trim() };
      return api.post(`/v1/reservations/${reservation.id}/${path}`, body, params);
    },
    onSuccess: () => {
      setDecision(null); setReason(''); setAmount(''); setPaymentId('');
      for (const key of ['reservations', 'rooms', 'guest-360', 'folios', 'operations', 'stay-money']) void client.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!hasPermission('reservations.write')) return null;
  const preArrival = ['pending', 'confirmed', 'assigned'].includes(reservation.status);
  const inHouse = ['checked_in', 'stayover', 'due_out'].includes(reservation.status);
  const canMoney = hasPermission('folios.manage');
  const available = Number(money.data?.available ?? 0);
  const workflow = (action: string) => onWorkflow(`/front-desk?reservationId=${reservation.id}&action=${action}`);
  const open = (next: Decision) => { setDecision(next); setReason(''); setAmount(''); setPaymentId(money.data?.payments[0]?.id ?? ''); };
  const needsPayment = decision === 'refund' && !paymentId;
  return <section className="space-y-3 rounded-xl border p-4" aria-label={t('reservations.actions')}>
    <h3 className="text-sm font-semibold">{t('reservations.actions')}</h3>
    <div className="flex flex-wrap gap-2">
      {reservation.status === 'pending' && <button className="rounded-lg border px-3 py-2 text-sm" disabled={mutation.isPending} onClick={() => mutation.mutate('confirm')}>{t('reservations.confirm')}</button>}
      {hasPermission('frontdesk.access') && <>
        {['confirmed', 'assigned'].includes(reservation.status) && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => workflow('check-in')}>{t('reservations.checkIn')}</button>}
        {(reservation.status === 'assigned' || inHouse) && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => workflow('move-room')}>{t('frontDesk.moveRoom')}</button>}
        {inHouse && <button className="rounded-lg border px-3 py-2 text-sm" onClick={() => workflow('check-out')}>{t('reservations.checkOut')}</button>}
      </>}
      {preArrival && <>
        {reservation.status !== 'pending' && <button className="rounded-lg border px-3 py-2 text-sm" disabled={mutation.isPending} onClick={() => open('no-show')}>{t('reservations.markNoShow')}</button>}
        <button className="rounded-lg border px-3 py-2 text-sm text-red-700" disabled={mutation.isPending} onClick={() => open('cancel')}>{t('common.cancel')}</button>
      </>}
      {canMoney && closed && available > 0 && <button className="rounded-lg border px-3 py-2 text-sm" disabled={mutation.isPending} onClick={() => open('retain')}>{t('stayMoney.retain')}</button>}
      {canMoney && (closed || preArrival || inHouse) && available > 0 && <button className="rounded-lg border px-3 py-2 text-sm" disabled={mutation.isPending} onClick={() => open('refund')}>{t('stayMoney.refund')}</button>}
    </div>
    {closed && money.data && <p className="text-xs text-gray-600">{t('stayMoney.summary', { paid: money.data.paid, refunded: money.data.refunded, retained: money.data.retained, available: money.data.available })}</p>}
    {decision && <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-sm">
      <p>{t(`stayMoney.confirm.${decision}`)}</p>
      {(decision === 'cancel' || decision === 'no-show') && money.data && money.data.suggestion !== 'nothing_to_settle' && <p className={money.data.late ? 'text-amber-800' : 'text-gray-600'}>
        {money.data.late ? t('stayMoney.lateHint', { hours: money.data.lateCancellationHours, available: money.data.available }) : t('stayMoney.earlyHint', { available: money.data.available })}</p>}
      {decision === 'refund' && <label className="block">{t('stayMoney.payment')}
        <select className="mt-1 w-full rounded-lg border p-2" value={paymentId} onChange={(e) => setPaymentId(e.target.value)}>
          {money.data?.payments.map((p) => <option key={p.id} value={p.id}>{p.amount} · {p.method}{p.processedAt ? ` · ${p.processedAt.slice(0, 10)}` : ''}</option>)}
        </select></label>}
      {(decision === 'retain' || decision === 'refund') && <label className="block">{t('stayMoney.amount')}
        <input className="mt-1 w-full rounded-lg border p-2 tabular-nums" inputMode="decimal" placeholder={money.data?.available ?? ''} value={amount}
          onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}/></label>}
      <label className="block">{t('stayMoney.reason')}<textarea className="mt-1 w-full rounded-lg border p-2" maxLength={500} value={reason} onChange={e => setReason(e.target.value)}/></label>
      <div className="flex gap-3"><button className="font-semibold text-red-700" disabled={mutation.isPending || !reason.trim() || needsPayment} onClick={() => mutation.mutate(decision)}>{t('common.confirm')}</button>
        <button disabled={mutation.isPending} onClick={() => setDecision(null)}>{t('reservationActions.back')}</button></div>
    </div>}
    {mutation.isError && <p role="alert" className="text-sm text-red-700">{errorMessage(mutation.error)}</p>}
  </section>;
}
