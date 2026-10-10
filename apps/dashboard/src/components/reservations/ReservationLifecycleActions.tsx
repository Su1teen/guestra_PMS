import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import type { Reservation } from './types';

/** Existing lifecycle APIs and Front Desk forms remain the only operation handlers. */
export default function ReservationLifecycleActions({ reservation, propertyId, onWorkflow }: {
  reservation: Reservation; propertyId: string; onWorkflow: (url: string) => void;
}) {
  const { t } = useTranslation(); const { hasPermission } = useAuth(); const client = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'no-show' | null>(null);
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: (action: string) => api.patch(`/v1/reservations/${reservation.id}/${action}`,
      action === 'cancel' ? { cancellationReason: reason.trim() } : {}, { params: { propertyId }, skipErrorToast: true }),
    onSuccess: () => {
      setConfirmAction(null); setReason('');
      for (const key of ['reservations', 'rooms', 'guest-360', 'folios', 'operations']) void client.invalidateQueries({ queryKey: [key] });
    },
  });
  if (!hasPermission('reservations.write')) return null;
  const preArrival = ['pending', 'confirmed', 'assigned'].includes(reservation.status);
  const inHouse = ['checked_in', 'stayover', 'due_out'].includes(reservation.status);
  const workflow = (action: string) => onWorkflow(`/front-desk?reservationId=${reservation.id}&action=${action}`);
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
        <button className="rounded-lg border px-3 py-2 text-sm" disabled={mutation.isPending} onClick={() => setConfirmAction('no-show')}>{t('reservations.markNoShow')}</button>
        <button className="rounded-lg border px-3 py-2 text-sm text-red-700" disabled={mutation.isPending} onClick={() => setConfirmAction('cancel')}>{t('common.cancel')}</button>
      </>}
    </div>
    {confirmAction && <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-sm">
      <p>{t(confirmAction === 'cancel' ? 'reservations.confirmCancellation' : 'reservations.confirmNoShow')}</p>
      {confirmAction === 'cancel' && <label className="block">{t('reservationActions.reason')}<textarea className="mt-1 w-full rounded-lg border p-2" maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label>}
      <div className="flex gap-3"><button className="font-semibold text-red-700" disabled={mutation.isPending || (confirmAction === 'cancel' && !reason.trim())} onClick={() => mutation.mutate(confirmAction)}>{t('common.confirm')}</button>
        <button disabled={mutation.isPending} onClick={() => setConfirmAction(null)}>{t('reservationActions.back')}</button></div>
    </div>}
    {mutation.isError && <p role="alert" className="text-sm text-red-700">{errorMessage(mutation.error)}</p>}
  </section>;
}
