import { useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { hotelDate } from '../../lib/hotel-date';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import type { WorkspaceWidget } from '../../lib/dashboard-layout';
import { QueryError } from '../ui/ErrorBoundary';

/** Read existing reports; never calculate a second revenue or occupancy model. */
export default function WorkspaceReportWidget({ widget }: { widget: WorkspaceWidget }) {
  const { t, i18n } = useTranslation(); const { user, hasPermission } = useAuth();
  const { propertyId: current, properties } = useProperty();
  const propertyId = widget.settings.propertyId ?? current;
  const property = properties.find(p => p.id === propertyId);
  const today = hotelDate(property?.timezone);
  const count = widget.settings.period.endsWith('28') ? 28 : widget.settings.period.endsWith('7') ? 7 : 1;
  const future = widget.type === 'bookingPace' && widget.settings.period.startsWith('next');
  const start = future ? today : format(addDays(new Date(today + 'T00:00:00'), 1 - count), 'yyyy-MM-dd');
  const end = future ? format(addDays(new Date(today + 'T00:00:00'), count - 1), 'yyyy-MM-dd') : today;
  const report = widget.type === 'pickup' ? 'pickup' : widget.type === 'bookingPace' ? 'booking-pace' : 'occupancy-trend';
  const query = useQuery({ queryKey: ['workspace-report', report, user?.sub, propertyId, start, end, today],
    enabled: !!property && hasPermission('reports.view'),
    queryFn: () => api.get('/v1/reports/' + report, { params: report === 'pickup'
      ? { propertyId, stayDate: today, from: start, to: end }
      : { propertyId, startDate: start, endDate: end }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
  });
  if (!property || !hasPermission('reports.view')) return <p className="p-4 text-sm">{t('guestQuickView.noAccess')}</p>;
  if (query.isError) return <QueryError onRetry={() => void query.refetch()}/>;
  if (query.isPending) return <p role="status" className="p-4 text-sm">{t('common.loading')}</p>;
  const data = query.data;
  const value = widget.type === 'occupancy' ? data?.summary?.avgOccupancy : widget.type === 'adr' ? data?.summary?.avgAdr
    : widget.type === 'revpar' ? data?.summary?.avgRevpar : widget.type === 'pickup' ? data?.pickup?.roomNights : data?.summary?.avgRoomsOnBooks;
  const number = Number(value);
  const money = ['adr','revpar'].includes(widget.type);
  const currency = property.currencyCode ?? undefined;
  const formatted = value == null || !Number.isFinite(number) || (money && !currency) ? '—' : new Intl.NumberFormat(i18n.resolvedLanguage, widget.type === 'occupancy'
    ? { style: 'percent', maximumFractionDigits: 1 } : ['adr','revpar'].includes(widget.type)
    ? { style: 'currency', currency, maximumFractionDigits: 2 } : { maximumFractionDigits: 2, signDisplay: widget.type === 'pickup' ? 'exceptZero' : 'auto' }).format(number);
  return <div className={widget.settings.density === 'compact' ? 'p-3' : 'p-5'}>
    <p className="text-xs text-gray-500">{property.name} · {start}{end !== start && ' — ' + end}</p>
    <p className="my-3 text-3xl font-semibold text-telivity-navy">{formatted}</p>
    <p className="text-xs text-gray-500">{t('workspace.reportBasis.' + widget.type, { date: today })}</p>
    {widget.type === 'bookingPace' && <ul className="mt-3 space-y-1 text-xs">{(data?.daily ?? []).map((row: { date: string; roomsOnBooks: number }) => <li key={row.date} className="flex justify-between"><span>{row.date}</span><span>{row.roomsOnBooks}</span></li>)}</ul>}
  </div>;
}
