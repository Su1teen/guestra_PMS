import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { staffRecoveryKey, clearStaffRequest, usePendingStaffRequest } from '../../lib/staff-booking-recovery';

export default function StaffBookingRecovery() {
  const { t } = useTranslation(); const { user, hasPermission } = useAuth(); const { propertyId } = useProperty();
  const key = staffRecoveryKey(user?.sub ?? 'demo', propertyId ?? '');
  const requestId = usePendingStaffRequest(key);
  const queryClient = useQueryClient();
  type Result = { state: 'committed' | 'unconfirmed' | 'closed'; reservationId?: string };
  const queryKey = ['staff-create-result', user?.sub, propertyId, requestId];
  const query = useQuery<Result>({
    queryKey,
    queryFn: () => api.get(`/v1/reservations/staff-create/${requestId}`, { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !!propertyId && !!requestId && hasPermission('reservations.read', 'reservations.write'), retry: false,
  });
  const close = useMutation({
    mutationFn: (attempt: { key: string; requestId: string; propertyId: string; queryKey: typeof queryKey }) =>
      api.post(`/v1/reservations/staff-create/${attempt.requestId}/close`, undefined,
        { params: { propertyId: attempt.propertyId }, skipErrorToast: true }).then(r => (r.data?.data ?? r.data) as Result),
    onSuccess: (result, attempt) => {
      if (result.state === 'closed') clearStaffRequest(attempt.key, attempt.requestId);
      else queryClient.setQueryData(attempt.queryKey, result);
    },
  });
  if (!requestId || !propertyId || !hasPermission('reservations.read', 'reservations.write')) return null;
  const committed = query.data?.state === 'committed' && query.data.reservationId;
  return <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
    <p>{committed ? t('staffRecovery.committed') : t('staffRecovery.pending')}</p>
    {query.isError && <p className="mt-2">{errorMessage(query.error)}</p>}
    {close.isError && <p role="alert" className="mt-2">{errorMessage(close.error)}</p>}
    {query.data?.state === 'unconfirmed' && <p className="mt-2">{t('staffRecovery.unconfirmed')}</p>}
    {committed ? <Link className="mt-2 inline-block font-semibold underline" to={`/reservations/${committed}?propertyId=${propertyId}`}
      onClick={() => clearStaffRequest(key, requestId)}>{t('staffRecovery.open')}</Link>
      : <button className="mt-2 font-semibold underline disabled:opacity-50" disabled={query.isFetching || close.isPending} onClick={() => void query.refetch()}>{query.isFetching ? t('common.loading') : t('staffRecovery.check')}</button>}
    {query.data?.state === 'unconfirmed' && <button className="ml-4 mt-2 font-semibold underline disabled:opacity-50"
      disabled={query.isFetching || close.isPending} onClick={() => close.mutate({ key, requestId, propertyId, queryKey })}>{t('staffRecovery.close')}</button>}
    {query.data?.state === 'closed' && <button className="mt-2 font-semibold underline" onClick={() => clearStaffRequest(key, requestId)}>{t('staffRecovery.new')}</button>}
  </div>;
}
