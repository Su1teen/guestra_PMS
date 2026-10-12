import { useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { hotelDate } from '../../lib/hotel-date';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import type { WorkspaceWidget } from '../../lib/dashboard-layout';
import { QueryError } from '../ui/ErrorBoundary';
import { useOperationalDate } from '../../hooks/useOperationalDate';

/** Read existing reports; never calculate a second revenue or occupancy model. */
export default function WorkspaceReportWidget({ widget }: { widget: WorkspaceWidget }) {
  const { t, i18n } = useTranslation(); const { user, hasPermission } = useAuth();
  const { propertyId: current, properties } = useProperty();
  const propertyId = widget.settings.propertyId ?? current;
  const property = properties.find(p => p.id === propertyId);
  const business = useOperationalDate(propertyId,!!property && hasPermission('reports.view'));
  const today = business.data?.date ?? hotelDate(property?.timezone);
  const count = widget.settings.period.endsWith('28') ? 28 : widget.settings.period.endsWith('7') ? 7 : 1;
  const future = widget.type === 'bookingPace' && widget.settings.period.startsWith('next');
  const start = future ? today : format(addDays(new Date(today + 'T00:00:00'), widget.type === 'pickup' && count === 1 ? -1 : 1 - count), 'yyyy-MM-dd');
  const end = future ? format(addDays(new Date(today + 'T00:00:00'), count - 1), 'yyyy-MM-dd') : today;
  const report = widget.type === 'financialSummary' ? 'financial-summary' : widget.type === 'pickup' ? 'pickup' : widget.type === 'bookingPace' ? 'booking-pace' : 'occupancy-trend';
  const query = useQuery({ queryKey: ['workspace-report', report, user?.sub, propertyId, start, end, today],
    enabled: !!property && hasPermission('reports.view'),
    queryFn: () => api.get('/v1/reports/' + report, { params: report === 'pickup'
      ? { propertyId, stayDate: today, from: start, to: end }
      : report === 'financial-summary' ? {propertyId,date:today}
      : { propertyId, startDate: start, endDate: end }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
  });
  if (!property || !hasPermission('reports.view')) return <p className="p-4 text-sm">{t('guestQuickView.noAccess')}</p>;
  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()}/>;
  if (query.isPending) return <p role="status" className="p-4 text-sm">{t('common.loading')}</p>;
  const data = query.data;
  if (widget.type === 'financialSummary') {
    const items = [['Заработанная выручка',data.actual?.value],['Получено оплат',data.cash?.received],['Возвраты оплат',data.cash?.refunds],['Депозиты · остаток',data.deposits?.held],['Задолженность гостей',data.outstandingBalances?.totalBalanceDue],['Отдельно проведённые налоги',data.kpis?.separatelyPostedTax]] as const;
    return <div className="p-4"><p className="text-xs text-gray-500 mb-3">{property.name} · {today}</p><div className="workspace-financial-grid">{items.map(([label,v])=><div key={label}><p className="text-xs text-gray-500">{label}</p><strong className="workspace-kpi-value">{v==null||!(data.currencyCode??property.currencyCode)?'—':new Intl.NumberFormat('ru-RU',{style:'currency',currency:data.currencyCode??property.currencyCode,maximumFractionDigits:2}).format(v)}</strong></div>)}</div><p className="mt-3 text-xs text-gray-500">Оплаты и депозиты отделены от заработанной выручки. Остатки — текущий срез.</p></div>;
  }
  const rawValue = widget.type === 'occupancy' ? data?.summary?.avgOccupancy : widget.type === 'adr' ? data?.summary?.avgAdr
    : widget.type === 'revpar' ? data?.summary?.avgRevpar : widget.type === 'earnedRevenue' ? data?.actual?.value : widget.type === 'pickup' ? data?.pickup?.roomNights : data?.summary?.avgRoomsOnBooks;
  const unavailable = widget.type === 'adr' ? data?.summary?.totalRoomNights === 0 || data?.actual?.status === 'NO_POSTINGS' : ['revpar','occupancy'].includes(widget.type) ? data?.summary?.availableRoomNights === 0 || (widget.type === 'revpar' && data?.actual?.status === 'NO_POSTINGS') : false;
  const value=unavailable ? null : rawValue;
  const number = Number(value);
  const money = ['adr','revpar','earnedRevenue'].includes(widget.type);
  const currency = property.currencyCode ?? undefined;
  const locale = i18n.language.startsWith('ru') ? 'ru-RU' : i18n.resolvedLanguage;
  const formatted = value == null || !Number.isFinite(number) || (money && !currency) ? '—' : new Intl.NumberFormat(locale, widget.type === 'occupancy'
    ? { style: 'percent', maximumFractionDigits: 1 } : money
    ? { style: 'currency', currency, maximumFractionDigits: 2 } : { maximumFractionDigits: 2, signDisplay: widget.type === 'pickup' ? 'exceptZero' : 'auto' }).format(number);
  return <div className={widget.settings.density === 'compact' ? 'p-3' : 'p-5'}>
    <p className="text-xs text-gray-500 truncate" title={`${property.name} · ${start}${end !== start ? ' — '+end : ''}`}>{start}{end !== start && ' — ' + end} · {property.name}</p>
    <p className="my-2 workspace-kpi-value text-telivity-navy">{formatted}</p>
    <p className="text-[10px] text-gray-500 line-clamp-1" title={widget.type==='earnedRevenue'?'Подписанные проводки по дате услуги; налоги и депозиты исключены.':t('workspace.reportBasis.' + widget.type, { date: today })}>{widget.type==='earnedRevenue'?'Подписанные проводки по дате услуги; налоги и депозиты исключены.':t('workspace.reportBasis.' + widget.type, { date: today })}</p>
    {widget.type === 'bookingPace' && <ul className="mt-3 space-y-1 text-xs">{(data?.daily ?? []).map((row: { date: string; roomsOnBooks: number }) => <li key={row.date} className="flex justify-between"><span>{row.date}</span><span>{row.roomsOnBooks}</span></li>)}</ul>}
  </div>;
}
