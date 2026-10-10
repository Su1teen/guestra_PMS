import { useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { hotelDate } from '../../lib/hotel-date';
import { useProperty } from '../../context/PropertyContext';
import { useAuth } from '../../context/AuthContext';
import { WIDGET_PERMISSIONS, type WorkspaceWidget } from '../../lib/dashboard-layout';
import { QueryError } from '../ui/ErrorBoundary';
import StatusBadge from '../ui/StatusBadge';
import { useGuestQuickView } from '../guests/GuestQuickView';
export default function WorkspaceDataWidget({ widget }: { widget: WorkspaceWidget }) {
  const { t } = useTranslation(); const { propertyId: current, properties, setPropertyId } = useProperty(); const { hasPermission } = useAuth();
  const navigate = useNavigate(); const { openGuest } = useGuestQuickView();
  const propertyId = widget.settings.propertyId ?? current;
  const property = properties.find(p => p.id === propertyId);
  const fixedPeriod = ['tasks', 'maintenance', 'requests', 'inhouse'].includes(widget.type);
  const start = hotelDate(property?.timezone); const nights = fixedPeriod ? 1 : widget.settings.period === 'next28' ? 28 : widget.settings.period === 'next7' ? 7 : 1;
  const end = format(addDays(new Date(start + 'T00:00:00'), nights - 1), 'yyyy-MM-dd');
  const query = useQuery({ queryKey: ['workspace-data', widget.type, propertyId, start, end],
    enabled: !!property && hasPermission(...WIDGET_PERMISSIONS[widget.type]),
    queryFn: async () => {
      if (widget.type === 'arrivals') return (await api.get('/v1/operations/pre-arrivals', { params: { propertyId, startDate: start, endDate: end }, skipErrorToast: true })).data;
      if (widget.type === 'maintenance') return (await api.get('/v1/maintenance', { params: { propertyId }, skipErrorToast: true })).data;
      if (['tasks','requests'].includes(widget.type)) return (await api.get('/v1/service-requests', { params: { propertyId }, skipErrorToast: true })).data;
      if (widget.type === 'availability') return (await api.get('/v1/reservations/calendar', { params: { propertyId, checkIn: start, checkOut: format(addDays(new Date(start + 'T00:00:00'), nights), 'yyyy-MM-dd') }, skipErrorToast: true })).data;
      if (widget.type === 'unassigned') return (await api.get('/v1/reservations/unassigned', { params: { propertyId, from: start, to: end }, skipErrorToast: true })).data;
      const params = widget.type === 'inhouse' ? { propertyId, statuses: 'checked_in,stayover,due_out', limit: 100 } : { propertyId, statuses: 'checked_in,stayover,due_out', departureDateFrom: start, departureDateTo: end, limit: 100 };
      return (await api.get('/v1/reservations', { params, skipErrorToast: true })).data;
    } });
  const data = query.data?.data ?? query.data;
  const go = (url: string) => { if (propertyId && propertyId !== current) setPropertyId(propertyId); navigate(url + (url.includes('?') ? '&' : '?') + 'propertyId=' + propertyId); };
  if (!property) return <p className="p-4 text-sm text-gray-500">{t('guestQuickView.noAccess')}</p>;
  if (query.isError) return <div className="p-4"><QueryError onRetry={() => void query.refetch()}/></div>;
  if (query.isPending) return <p role="status" className="p-4 text-sm text-gray-500">{t('common.loading')}</p>;
  let rows: any[] = Array.isArray(data) ? data : data?.items ?? data?.data ?? data?.reservations ?? [];
  if (widget.type === 'maintenance') rows = rows.map(r => ({ ...r.ticket, roomNumber: r.roomNumber, href: '/operations?tab=maintenance&ticketId=' + r.ticket.id })).filter(r => !['resolved','closed','cancelled'].includes(r.status));
  if (['tasks','requests'].includes(widget.type)) rows = rows.filter(r => !['done','completed','cancelled'].includes(r.status)).filter(r => widget.type !== 'requests' || !['turndown','deep_clean','checkout','stayover','inspection','housekeeping'].includes(r.type)).map(r => ({ ...r, href: '/operations?tab=tasks&taskId=' + r.id }));
  const compact = widget.settings.density === 'compact';
  return <div className="p-4"><p className="mb-3 text-xs text-gray-500">{property?.name} · {start}{end !== start ? ' — ' + end : ''}</p>
    {widget.type === 'availability' ? <div className="space-y-2">{(data?.availability ?? []).map((r: any) => <div key={r.roomTypeId + r.date} className="flex justify-between gap-2 rounded-lg bg-gray-50 p-2 text-xs"><span>{r.roomTypeName} · {r.date}</span><span className={r.available <= 0 ? 'font-semibold text-red-600' : 'font-semibold text-telivity-teal'}>{t('workspace.available', { count: r.available })}</span></div>)}<button className="mt-3 text-sm text-telivity-teal" onClick={() => go('/reservations/calendar')}>{t('workspace.calendar')} →</button></div> : <>
    <div className="space-y-2">{rows.map((r: any) => <div key={r.id ?? r.reservationId} className={'rounded-lg border border-gray-100 ' + (compact ? 'p-2' : 'p-3')}>
      <button className="w-full text-left text-sm font-semibold text-telivity-navy" onClick={() => go(r.href ?? '/reservations/' + (r.reservationId ?? r.id))}>{r.guestName ?? r.title ?? r.confirmationNumber}</button>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500"><span>{r.arrivalDate ?? r.dueAt?.slice(0,10)}{r.roomNumber ? ' · ' + r.roomNumber : ''}</span>{r.status && <StatusBadge status={r.status} label={t('reservations.statuses.' + r.status)}/>}</div>
      {r.checks && <div className="mt-2 flex flex-wrap gap-1">{['roomAssigned','housekeepingReady','depositReceived','guestInformationComplete','operationalTasksComplete'].map(key => <span key={key} className={'rounded px-2 py-1 text-[10px] ' + (r.checks[key] ? 'bg-teal-50 text-teal-700' : 'bg-amber-50 text-amber-800')}>{t('workspace.' + (r.checks[key] ? 'checks.' : 'checksMissing.') + key)}</span>)}</div>}
      {r.guestId && hasPermission('guests.read') && <button className="mt-2 text-xs font-semibold text-telivity-teal" onClick={() => { if (propertyId) openGuest(r.guestId, propertyId); }}>{t('guestQuickView.title')}</button>}
    </div>)}</div>
    {rows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">{t('workspace.noData')}</p>}
    {data?.hasMore && <p className="mt-3 text-xs text-amber-700">{t('workspace.moreResults')}</p>}
    </>}
  </div>;
}
