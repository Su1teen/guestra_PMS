import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { api } from '../../lib/api';
import { QueryError } from '../ui/ErrorBoundary';
import type { Guest } from '../../types/guest';
import type { Guest360 } from './Guest360Panel';

/** Read-only context from the existing profile and Guest 360 API; no second history store. */
export default function GuestContextSummary({ guest, data, propertyId, excludeReservationId, onNavigate }: {
  guest: Guest; data?: Guest360; propertyId: string; excludeReservationId?: string; onNavigate?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { user, hasPermission } = useAuth();
  const { setPropertyId } = useProperty();
  const [expanded, setExpanded] = useState(false);
  const query = useQuery<Guest360>({
    queryKey: ['guest-360', guest.id, propertyId, user?.sub],
    queryFn: () => api.get(`/v1/guests/${guest.id}/360`, { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !data && !!guest.id && !!propertyId && hasPermission('guests.read'),
  });
  if (!hasPermission('guests.read')) return null;
  const profile = data?.guest ?? query.data?.guest ?? guest;
  const history = data ?? query.data;
  const stays = history?.stays?.filter(stay => stay.id !== excludeReservationId) ?? [];
  return <section className="space-y-3 rounded-xl border border-teal-100 bg-teal-50/40 p-4" aria-label={t('guestContext.title')}>
    <div><h3 className="text-xs font-semibold text-telivity-dark-teal">{t('guestContext.notes')}</h3>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-telivity-navy">{profile.notes?.trim() || t(query.isPending && !data ? 'common.loading' : 'guestContext.noNotes')}</p>
      {profile.isDnr && <p className="mt-2 text-sm font-semibold text-red-700">{t('guestQuickView.dnr')}{profile.dnrReason ? ': ' + profile.dnrReason : ''}</p>}
    </div>
    <button type="button" className="text-sm font-semibold text-telivity-dark-teal hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? t('guestContext.hideHistory') : t('guestContext.showHistory')}{history ? ` (${stays.length})` : ''}
    </button>
    {query.isError && !data && <QueryError onRetry={() => void query.refetch()}/>}
    {expanded && (history ? <div className="space-y-2">
      {stays.length === 0 ? <p className="text-xs text-gray-500">{t('guestContext.noHistory')}</p> : stays.map(stay => hasPermission('reservations.read') ? <Link key={stay.id}
        to={`/reservations/${stay.id}?propertyId=${stay.propertyId}`} onClick={() => { setPropertyId(stay.propertyId); onNavigate?.(); }}
        className="block rounded-lg border bg-white p-3 text-sm hover:border-telivity-teal">
        <p className="font-semibold">{stay.arrivalDate} — {stay.departureDate}</p>
        <p className="mt-1 text-xs text-gray-600">{stay.propertyName} · {stay.roomNumber ?? stay.roomType ?? t('reservations.unassigned')} · {t('reservations.statuses.' + stay.status, { defaultValue: t('reservationWorkspace.unknownStatus') })}</p>
      </Link> : <div key={stay.id} className="rounded-lg border bg-white p-3 text-sm">{stay.arrivalDate} — {stay.departureDate} · {stay.propertyName} · {t('reservations.statuses.' + stay.status, { defaultValue: t('reservationWorkspace.unknownStatus') })}</div>)}
      {!!history.bookedServices?.length && <div><h4 className="text-xs font-semibold">{t('guestContext.services')}</h4>{history.bookedServices.map(service => <p key={service.id} className="mt-1 text-xs text-gray-600">{service.serviceName} · {new Date(service.scheduledAt).toLocaleDateString(i18n.resolvedLanguage)} · {t('reservationWorkspace.serviceStatuses.' + service.status, { defaultValue: t('reservationWorkspace.unknownStatus') })}</p>)}</div>}
    </div> : <p role="status" className="text-xs text-gray-500">{t('common.loading')}</p>)}
  </section>;
}
