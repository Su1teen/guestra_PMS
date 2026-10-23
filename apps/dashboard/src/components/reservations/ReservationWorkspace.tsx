import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import { formatMoney } from '../../lib/money';
import StatusBadge from '../ui/StatusBadge';
import { QueryError } from '../ui/ErrorBoundary';
import { useGuestQuickView } from '../guests/GuestQuickView';
import Guest360Panel from '../guests/Guest360Panel';
import GuestContextSummary from '../guests/GuestContextSummary';
import ReservationPartyPanel from './ReservationPartyPanel';
import ReservationCommercialActions from './ReservationCommercialActions';
import { ReservationOpsNotes, ReservationMessageCompose } from './ReservationCommunication';
import type { Reservation } from './types';
import ReservationLifecycleActions from './ReservationLifecycleActions';
import { serviceStatus } from '../services/types';

export default function ReservationWorkspace({ reservationId, initial, onClose, mode = 'drawer', actions, doorPin }: {
  reservationId: string; initial?: Reservation; onClose: () => void; mode?: 'drawer' | 'page'; actions?: React.ReactNode; doorPin?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const { hasPermission, user } = useAuth();
  const [suspended, setSuspended] = useState(false);
  const navigate = useNavigate();
  const [localTab, setLocalTab] = useState('overview');
  const [params, setParams] = useSearchParams();
  const tab = mode === 'page' ? params.get('tab') ?? 'overview' : localTab;
  const setTab = (next: string) => { if (mode === 'page') setParams(prev => { prev.set('tab', next); return prev; }, { replace: true }); else setLocalTab(next); };
  const { openGuest } = useGuestQuickView();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const scrollPosition = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const query = useQuery({
    queryKey: ['reservations', 'detail', propertyId, reservationId, user?.sub],
    queryFn: () => api.get(`/v1/reservations/${reservationId}`, { params: { propertyId }, skipErrorToast: true }).then((r) => r.data),
    enabled: !!propertyId && hasPermission('reservations.read'),
  });
  const envelope = query.data?.data ?? query.data;
  const reservation: Reservation | undefined = envelope?.reservation ? {
    ...envelope.reservation, confirmationNumber: envelope.confirmationNumber, source: envelope.source,
    guest: envelope.guest, roomNumber: envelope.room?.number,
    roomTypeName: envelope.roomType?.name, ratePlanName: envelope.ratePlan?.name,
  } : envelope?.id ? envelope : initial;
  const guestId = reservation?.guestId ?? reservation?.guest?.id;
  const guestQuery = useQuery({
    queryKey: ['guest-360', guestId, propertyId, user?.sub],
    queryFn: () => api.get(`/v1/guests/${guestId}/360`, { params: { propertyId }, skipErrorToast: true }).then((r) => r.data?.data ?? r.data),
    enabled: !!guestId && !!propertyId && hasPermission('guests.read'),
  });

  const folioQuery = useQuery({ queryKey: ['folios', 'reservation', propertyId, reservationId],
    queryFn: () => api.get('/v1/folios', { params: { propertyId, reservationId, limit: 100 }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !!propertyId && hasPermission('folios.read') });
  const readinessQuery = useQuery({ queryKey: ['operations', 'readiness', propertyId, reservationId, reservation?.arrivalDate],
    queryFn: () => api.get('/v1/operations/pre-arrivals', { params: { propertyId, startDate: reservation?.arrivalDate, endDate: reservation?.arrivalDate }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !!propertyId && !!reservation?.arrivalDate && ['pending','confirmed','assigned'].includes(reservation.status) && hasPermission('ops.read') });
  const readiness = (Array.isArray(readinessQuery.data) ? readinessQuery.data : []).find((r: any) => r.reservationId === reservationId);
  const servicesQuery = useQuery({ queryKey: ['reservation-services', propertyId, reservationId],
    queryFn: () => api.get('/v1/ancillary/reservations/' + reservationId + '/services', { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: tab === 'services' && !!propertyId && hasPermission('reservations.read') });
  const scheduledServicesQuery = useQuery({ queryKey: ['reservation-service-bookings', propertyId, reservationId],
    queryFn: () => api.get('/v1/services/bookings', { params: { propertyId, reservationId }, skipErrorToast: true }).then(r => r.data),
    enabled: tab === 'services' && !!propertyId && hasPermission('services.read', 'reservations.read') });
  const tasksQuery = useQuery({ queryKey: ['service-requests', 'reservation', propertyId, reservationId],
    queryFn: () => api.get('/v1/service-requests', { params: { propertyId }, skipErrorToast: true }).then(r => (r.data?.data ?? r.data).filter((task: any) => task.reservationId === reservationId)),
    enabled: tab === 'tasks' && !!propertyId && hasPermission('ops.read') });
  const historyQuery = useQuery({ queryKey: ['reservation-audit', propertyId, reservationId],
    queryFn: () => api.get('/v1/reservations/' + reservationId + '/audit-history', { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: tab === 'history' && !!propertyId && hasPermission('reservations.read') });
  const folios: any[] = Array.isArray(folioQuery.data) ? folioQuery.data : [];
  const previewFolio = folios[0];
  const chargesQuery = useQuery({ queryKey: ['folio-charges-preview', propertyId, previewFolio?.id],
    queryFn: () => api.get('/v1/folios/' + previewFolio.id + '/charges', { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !!previewFolio?.id && hasPermission('folios.read') });
  const paymentsQuery = useQuery({ queryKey: ['folio-payments-preview', propertyId, previewFolio?.id],
    queryFn: () => api.get('/v1/payments', { params: { propertyId, folioId: previewFolio.id, limit: 100 }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: !!previewFolio?.id && hasPermission('folios.read') });

  useEffect(() => {
    if (mode === 'page' || suspended) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    if (panel.current) panel.current.scrollTop = scrollPosition.current;
    const onKey = (event: KeyboardEvent) => {
      // Nested dialogs (for example merge confirmation) own their keyboard events.
      if ((event.target as HTMLElement)?.closest('[role="dialog"]') !== panel.current) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [mode, suspended]);
  useEffect(() => { setSuspended(false); }, [propertyId, user?.sub]);

  const go = (url: string) => { onClose(); navigate(url + (url.includes('?') ? '&' : '?') + 'propertyId=' + propertyId); };
  const name = reservation?.guestName ?? (reservation?.guest ? `${reservation.guest.firstName} ${reservation.guest.lastName}` : t('reservationWorkspace.missingGuest'));
  const viewGuest = () => {
    if (!guestId || !propertyId) return;
    scrollPosition.current = panel.current?.scrollTop ?? 0;
    if (openGuest(guestId, propertyId, { onReturn: () => setSuspended(false) }) && mode === 'drawer') setSuspended(true);
  };
  const tabs = (mode === 'page' ? ['overview','accommodation','guests','services','folios','tasks','notes','history'] : ['overview','guests','history'])
    .filter(id => id !== 'guests' || (!!guestId && hasPermission('guests.read')))
    .filter(id => id !== 'folios' || hasPermission('folios.read'))
    .filter(id => id !== 'tasks' || hasPermission('ops.read'));
  if (suspended || !hasPermission('reservations.read')) return null;
  return <div className={mode === 'page' ? 'mx-auto max-w-7xl' : 'fixed inset-0 z-50 flex justify-end'}>
{mode === 'drawer' && <button className="absolute inset-0 bg-black/30" tabIndex={-1} aria-label={t('common.close')} onClick={onClose}/> }
    <aside ref={panel} tabIndex={-1} role={mode === 'drawer' ? 'dialog' : undefined} aria-modal={mode === 'drawer' ? true : undefined} aria-labelledby={titleId} className={mode === 'page' ? 'rounded-xl border bg-white focus:outline-none' : 'relative h-full w-full max-w-2xl overflow-y-auto bg-white shadow-xl focus:outline-none'}>
      <header className="sticky top-0 z-10 border-b border-gray-100 bg-white px-6 py-4">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs text-telivity-mid-grey">{t('reservations.details')}</p><h2 id={titleId} className="mt-1 text-lg font-semibold text-telivity-navy">{guestId && hasPermission('guests.read') ? <button onClick={viewGuest} className="text-left hover:text-telivity-teal hover:underline">{name}</button> : name}</h2><p className="mt-1 text-xs text-telivity-mid-grey">{reservation?.confirmationNumber ?? reservationId}</p></div><button className="rounded-lg p-2 hover:bg-gray-100" aria-label={t('common.close')} onClick={onClose}><X size={18}/></button></div>
        <div className="mt-4 flex gap-2 overflow-x-auto" role="tablist">
          {tabs.map((id) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === id ? 'bg-telivity-teal/10 text-telivity-dark-teal' : 'text-telivity-slate hover:bg-gray-50'}`}>{t(`reservationWorkspace.${id}`)}</button>)}
        </div>
      </header>
      <div className="p-6" role="tabpanel">
        {query.isError ? <QueryError onRetry={() => void query.refetch()}/> : !reservation ? <p role="status">{t('reservationWorkspace.loading')}</p> : tab === 'guests' ? (
          guestQuery.isError ? <QueryError onRetry={() => void guestQuery.refetch()}/> : guestQuery.data && propertyId ? <Guest360Panel data={guestQuery.data} propertyId={propertyId}/> : <p role="status">{t('reservationWorkspace.loading')}</p>
        ) : tab === 'notes' ? propertyId && <><ReservationOpsNotes reservationId={reservationId} propertyId={propertyId}/>{hasPermission('reservations.write') && <ReservationMessageCompose reservationId={reservationId} propertyId={propertyId}/>}</> : tab === 'services' ? <><h3 className="mb-2 text-sm font-semibold">Пакеты и услуги проживания</h3><QueryRows query={servicesQuery}>{(rows: any[]) => rows.map((row: any) => <div key={row.id} className="flex justify-between gap-3 rounded-lg border p-3 text-sm"><span>{row.service?.name ?? row.serviceName ?? row.name ?? t('reservationWorkspace.services')} · {t('reservationWorkspace.serviceStatuses.' + row.status, { defaultValue: t('reservationWorkspace.unknownStatus') })}</span><span>{formatMoney(row.totalAmount ?? row.lineTotal, row.currencyCode ?? currencyCode)}</span></div>)}</QueryRows>{hasPermission('services.read') && <><h3 className="mb-2 mt-5 text-sm font-semibold">Записи на услуги</h3><QueryRows query={scheduledServicesQuery}>{(rows: any[]) => rows.map(row => <button key={row.id} className="mb-2 flex w-full flex-wrap justify-between gap-3 rounded-lg border p-3 text-left text-sm" onClick={() => go('/services?bookingId=' + row.id + '&date=' + String(row.startAt).slice(0,10))}><span>{row.name} · {serviceStatus(row.status)}<span className="mt-1 block text-xs text-gray-500">{new Date(row.startAt).toLocaleString(i18n.resolvedLanguage)}</span></span><span>{formatMoney(row.totalAmount,row.currencyCode)}</span></button>)}</QueryRows></>}</> : tab === 'folios' ? <QueryRows query={folioQuery}>{(rows: any[]) => rows.map((f: any) => <button key={f.id} className="flex w-full justify-between rounded-lg border p-4 text-sm" onClick={() => go('/folios/' + f.id)}><span>{t('reservationWorkspace.folios')} · {t('reservationWorkspace.folioStatuses.' + f.status, { defaultValue: t('reservationWorkspace.unknownStatus') })}</span><strong>{t('frontDesk.balance')}: {formatMoney(f.balance, f.currencyCode ?? currencyCode)}</strong></button>)}</QueryRows> : tab === 'tasks' ? <QueryRows query={tasksQuery}>
              {(rows: any[]) =>
                rows.map((task: any) => (
                  <button
                    key={task.id}
                    className="block w-full rounded-lg border p-3 text-left text-sm"
                    onClick={() =>
                      go(
                        task.linkedOperation?.href ??
                          '/operations?tab=tasks&taskId=' + task.id,
                      )
                    }
                  >
                    {task.title}
                    <span className="mt-1 block text-xs text-telivity-mid-grey">
                      {(
                        {
                          open: 'Открыт',
                          assigned: 'Назначен',
                          in_progress: 'В работе',
                          done: 'Выполнен',
                          completed: 'Выполнен',
                          cancelled: 'Отменён',
                        } as Record<string, string>
                      )[task.status] ?? 'Статус уточняется'}
                    </span>
                    {task.coordinationWarning && (
                      <span className="mt-1 block text-xs text-amber-800">
                        {task.coordinationWarning}
                      </span>
                    )}
                  </button>
                ))
              }
            </QueryRows> : tab === 'history' ? <QueryRows query={historyQuery}>{(rows: any[]) => rows.map((event: any) => <div key={event.id} className="rounded-lg border p-3 text-sm"><p>{t('reservationWorkspace.auditActions.' + event.action, { defaultValue: t('reservationWorkspace.historyEvent') })}</p><p className="mt-1 text-xs text-gray-500">{new Date(event.occurredAt).toLocaleString(i18n.resolvedLanguage)} · {event.userEmail ?? t('reservationWorkspace.system')}</p></div>)}</QueryRows> : <div className="space-y-5">
          {hasPermission('guests.read') && envelope?.guest && <div className="rounded-xl bg-gray-50 p-4 text-sm"><p>{envelope.guest.email ?? '—'}</p><p className="mt-1">{envelope.guest.phone ?? '—'}</p></div>}
          <StatusBadge status={reservation.status} label={t(`reservations.statuses.${reservation.status}`, { defaultValue: t('reservationWorkspace.unknownStatus') })}/>
          <div className="grid grid-cols-2 gap-4">
            <Detail label={t('reservations.arrival')} value={reservation.arrivalDate}/><Detail label={t('reservations.departure')} value={reservation.departureDate}/>
            <Detail label={t('reservations.room')} value={reservation.roomNumber ?? t('reservations.unassigned')}/><Detail label={t('reservations.roomType')} value={reservation.roomTypeName ?? '—'}/>
            <Detail label={t('reservations.ratePlan')} value={reservation.ratePlanName ?? '—'}/><Detail label={t('reservations.total')} value={reservation.totalAmount != null ? formatMoney(reservation.totalAmount, reservation.currencyCode ?? currencyCode) : '—'}/>
            <Detail label={t('reservations.adults')} value={String(reservation.adults ?? '—')}/><Detail label={t('reservations.children')} value={String(reservation.children ?? 0)}/>
            <Detail label={t('reservations.source')} value={t('reservationWorkspace.sources.' + (reservation.source ?? 'unknown'), { defaultValue: t('reservationWorkspace.unknownStatus') })}/>
          </div>
          {doorPin && <Detail label={t('frontDesk.doorPin')} value={doorPin}/>}
          {guestId && propertyId && hasPermission('guests.read') && <GuestContextSummary key={propertyId + guestId}
            guest={guestQuery.data?.guest ?? { ...reservation.guest, id: guestId, firstName: reservation.guest?.firstName ?? '', lastName: reservation.guest?.lastName ?? '' }}
            data={guestQuery.data} propertyId={propertyId} excludeReservationId={reservationId} onNavigate={onClose}/>}
          {reservation.specialRequests && <Detail label={t('reservations.tape.specialRequests')} value={reservation.specialRequests}/>}
          {reservation.notes && <div className="rounded-lg bg-gray-50 p-3 text-sm"><p className="mb-1 text-xs text-telivity-mid-grey">{t('reservations.notes')}</p><p className="whitespace-pre-wrap">{reservation.notes}</p></div>}
          {propertyId && <ReservationOpsNotes reservationId={reservation.id} propertyId={propertyId} readOnly={mode === 'drawer'}/>}
          {mode === 'page' && propertyId && <ReservationLifecycleActions reservation={reservation} propertyId={propertyId} onWorkflow={go}/>}
          {hasPermission('folios.read') && <div className="rounded-xl border p-4"><p className="mb-2 text-xs font-semibold text-gray-500">{t('frontDesk.accountSummary')}</p><QueryRows query={folioQuery}>{(rows: any[]) => rows.map(f => <div key={f.id} className="flex justify-between text-sm"><span>{t('frontDesk.balance')}</span><strong>{formatMoney(f.balance, f.currencyCode ?? currencyCode)}</strong></div>)}</QueryRows>
            {previewFolio && <div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><p>{t('folios.charges')}</p><QueryRows query={chargesQuery}>{(rows: any[]) => rows.slice(-3).reverse().map(c => <p key={c.id} className="mt-1 flex justify-between gap-2"><span className="truncate">{c.description}</span><span>{formatMoney(c.amount, c.currencyCode ?? currencyCode)}</span></p>)}</QueryRows></div>{hasPermission('folios.read') && <div><p>{t('folios.payments')}</p><QueryRows query={paymentsQuery}>{(rows: any[]) => rows.slice(0,3).map(p => <p key={p.id} className="mt-1">{formatMoney(p.amount, p.currencyCode ?? currencyCode)}</p>)}</QueryRows></div>}</div>}
          </div>}
          {readinessQuery.isError ? <QueryError onRetry={() => void readinessQuery.refetch()}/> : readiness && <div className="rounded-xl border p-4"><p className="mb-2 text-sm font-semibold">{t('reservationWorkspace.readiness')}</p><div className="flex flex-wrap gap-2">{['roomAssigned','roomOperational','housekeepingReady','depositReceived','guestInformationComplete','operationalTasksComplete'].map(key => <span key={key} className={'rounded-lg px-3 py-2 text-xs ' + (readiness.checks[key] ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-900')}>{t('workspace.' + (readiness.checks[key] ? 'checks.' : 'checksMissing.') + key)}</span>)}</div>{readiness.notes && <p className="mt-3 text-sm">{readiness.notes}</p>}</div>}
          {propertyId && <>
            {<ReservationPartyPanel readOnly={!hasPermission('reservations.write') || CLOSED_STATUSES.includes(reservation.status)} readOnlyReason={hasPermission('reservations.write') ? t('reservations.guestsLockedClosed', { defaultValue: 'Состав гостей нельзя менять у закрытой брони' }) : t('reservations.guestsLockedPermission', { defaultValue: 'Нет права изменять бронь' })} reservationId={reservation.id} propertyId={propertyId} roomTypeId={reservation.roomTypeId} ratePlanId={reservation.ratePlanId} totalAmount={reservation.totalAmount != null ? String(reservation.totalAmount) : undefined} currencyCode={reservation.currencyCode ?? null}/>}
            <ReservationCommercialActions key={reservation.id + ':' + String(reservation.totalAmount)} reservation={reservation} propertyId={propertyId} canWrite={hasPermission('reservations.write')}/>
          </>}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {guestId && hasPermission('guests.read') && <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={viewGuest}>{t('guestQuickView.title')}</button>}
            {mode === 'drawer' && <button className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold" onClick={() => go('/reservations/' + reservationId)}><ExternalLink size={14}/>{t('reservationWorkspace.fullPage')}</button>}
            {actions}
            {guestId && (hasPermission('services.read') && (hasPermission('reservations.write') || hasPermission('folios.manage'))) && <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={() => go('/services?action=book&guestId=' + guestId + '&reservationId=' + reservationId)}>Записать на услугу</button>}
            {hasPermission('ops.manage') && <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={() => go('/operations?tab=tasks&action=create-task&reservationId=' + reservationId)}>{i18n.language.startsWith('ru') ? 'Создать задачу' : 'Create task'}</button>}
            {hasPermission('folios.read') && <button className="rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white" onClick={() => go(`/folios?reservationId=${reservation.id}`)}>{t('reservations.viewFolio')}</button>}
            {hasPermission('frontdesk.access') && <button className="rounded-lg border px-3 py-2 text-sm font-semibold" onClick={() => go('/front-desk?reservationId=' + reservationId)}>{t('workspace.frontdesk')}</button>}
          </div>
        </div>}
      </div>
    </aside>
  </div>;
}
const CLOSED_STATUSES = ['checked_out', 'no_show', 'cancelled'];
function Detail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-telivity-mid-grey">{label}</p><p className="mt-1 break-words text-sm font-medium text-telivity-navy">{value}</p></div>; }

function QueryRows({ query, children }: { query: { isError: boolean; isPending: boolean; data?: any; refetch: () => Promise<any> }; children: (rows: any[]) => React.ReactNode }) {
  const { t } = useTranslation();
  if (query.isError) return <QueryError onRetry={() => void query.refetch()}/>;
  if (query.isPending) return <p role="status" className="text-xs text-gray-500">{t('common.loading')}</p>;
  const rows = Array.isArray(query.data) ? query.data : query.data?.data ?? [];
  return rows.length ? <div className="space-y-2">{children(rows)}</div> : <p className="py-3 text-xs text-gray-500">{t('workspace.noData')}</p>;
}
