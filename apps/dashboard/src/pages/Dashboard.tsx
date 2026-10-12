import { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Percent,
  DollarSign,
  TrendingUp,
  BedDouble,
  LogIn,
  LogOut,
  Users,
  DoorOpen,
  Brain,
  Building2,
  AlertTriangle,
  WalletCards,
  CalendarCheck,
  Download,
} from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { format } from 'date-fns';
import { api } from '../lib/api';
import { formatOccupancyPercent } from '../lib/api-helpers';
import { getDateLocale } from '../lib/date-locale';
import { useProperty } from '../context/PropertyContext';
import { getSocket } from '../lib/socket';
import KpiCard from '../components/ui/KpiCard';
import { formatMoney } from '../lib/money';
import { useTranslation } from 'react-i18next';
import WorkspaceCanvas from '../components/dashboard/WorkspaceCanvas';
import { isWorkspaceLayout } from '@telivityhaip/shared';
import { hotelDate } from '../lib/hotel-date';
import { errorMessage } from '../lib/error-message';
import WorkspaceSettings from '../components/dashboard/WorkspaceSettings';
import { layoutKey, parseLayout, visibleWidgets, type DashboardLayout } from '../lib/dashboard-layout';
import { useAuth } from '../context/AuthContext';
import { useOperationalDate } from '../hooks/useOperationalDate';
import { reportedKpis } from '../lib/financial-presentation';
import PortfolioRevenue from '../components/revenue/PortfolioRevenue';

const ROOM_STATUS_COLORS: Record<string, string> = {
  occupied: '#06bdb4',
  vacant_clean: '#00a692',
  vacant_dirty: '#f2641b',
  out_of_order: '#eec517',
  out_of_service: '#bbbbc4',
  clean: '#00a692',
  inspected: '#016491',
  guest_ready: '#2cd1b9',
};

interface ActivityEvent {
  id: string;
  event: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export default function Dashboard() {
  const { user } = useAuth();
  const { propertyId } = useProperty();
  return <PropertyDashboard key={layoutKey(user?.sub ?? 'demo', propertyId ?? '')} />;
}

function PropertyDashboard() {
  const { t, i18n } = useTranslation();
  const { propertyId, setPropertyId, isPortfolioMode, properties, currencyCode } = useProperty();
  const { hasPermission, user } = useAuth();
  const storageKey = layoutKey(user?.sub ?? 'demo', propertyId ?? '');
  const [layout, setLayout] = useState<DashboardLayout>(() => {
    try { return parseLayout(localStorage.getItem(storageKey)); } catch { return parseLayout(null); }
  });
  const [storageError, setStorageError] = useState(false);
  const [pageId, setPageId] = useState(layout.startPageId);
  const [dirty, setDirty] = useState(false); const [saving, setSaving] = useState(false); const [saveError, setSaveError] = useState('');
  const [revision, setRevision] = useState(0);
  const workspaceQuery = useQuery({ queryKey: ['workspace', storageKey], enabled: !!propertyId && !isPortfolioMode,
    queryFn: () => api.get('/v1/admin/me/workspace', { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data) });
  const hydrated = useRef(false);
  useEffect(() => {
    if (!workspaceQuery.data || dirty) return;
    if (isWorkspaceLayout(workspaceQuery.data.layout)) { setLayout(workspaceQuery.data.layout); if (!hydrated.current) setPageId(workspaceQuery.data.layout.startPageId); else setPageId(current => workspaceQuery.data.layout.pages.some((p: { id: string }) => p.id === current) ? current : workspaceQuery.data.layout.startPageId); hydrated.current = true; }
    setRevision(workspaceQuery.data.revision ?? 0);
  }, [workspaceQuery.data, dirty]);
  const persistLayout = async () => {
    if (!isWorkspaceLayout(layout)) { setSaveError(t('workspace.invalid')); return; }
    setSaving(true); setSaveError('');
    try {
      if (workspaceQuery.data?.persistent === false) { localStorage.setItem(storageKey, JSON.stringify(layout)); setDirty(false); return; }
      const response = await api.patch('/v1/admin/me/workspace', { propertyId, expectedRevision: revision, layout }, { skipErrorToast: true });
      const saved = response.data?.data ?? response.data; setRevision(saved.revision); queryClient.setQueryData(['workspace', storageKey], saved); setDirty(false);
    } catch (error) { setSaveError(errorMessage(error)); } finally { setSaving(false); }
  };
  const widgets = visibleWidgets(layout, hasPermission, pageId);
  const saveLayout = (next: DashboardLayout) => {
    setLayout(next); setDirty(true);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setStorageError(false); } catch { setStorageError(true); }
  };
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const now = new Date();
  const dateLocale = getDateLocale(i18n.resolvedLanguage);
  const businessDate = useOperationalDate(propertyId, !isPortfolioMode && hasPermission('reports.view'));
  const today = businessDate.data?.date ?? hotelDate(properties.find(p => p.id === propertyId)?.timezone, now);
  const formattedToday = businessDate.data?.date ?? (i18n.language.startsWith('ru') ? 'Операционная дата · загрузка' : 'Operational date · loading');

  const activeProperty = isPortfolioMode
    ? null
    : properties.find((p) => p.id === propertyId);
  const thr = activeProperty?.settings?.kpiThresholds ?? {};

  const { data: portfolioFinancial } = useQuery({
    queryKey: ['reports', 'portfolio', 'financial-summary', today],
    queryFn: () => api.get('/v1/reports/portfolio/financial-summary').then((r) => r.data),
    enabled: isPortfolioMode && hasPermission('reports.view'),
  });

  const { data: portfolioOccupancy } = useQuery({
    queryKey: ['reports', 'portfolio', 'occupancy', today],
    queryFn: () => api.get('/v1/reports/portfolio/occupancy').then((r) => r.data),
    enabled: isPortfolioMode && hasPermission('reports.view'),
  });

  const financialQuery = useQuery({
    queryKey: ['reports', 'financial-summary', propertyId, today],
    queryFn: () => api.get('/v1/reports/financial-summary', { params: { propertyId } }).then((r) => r.data),
    enabled: ["metrics"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('reports.view'),
  });

  const financial = financialQuery.data;
  const occupancyQuery = useQuery({
    queryKey: ['reports', 'occupancy', propertyId, today],
    queryFn: () => api.get('/v1/reports/occupancy', { params: { propertyId } }).then((r) => r.data),
    enabled: ["metrics","rooms"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('reports.view'),
  });

  const occupancy = occupancyQuery.data;
  const roomSummaryQuery = useQuery({
    queryKey: ['rooms', 'status-summary', propertyId],
    queryFn: () => api.get('/v1/rooms/status-summary', { params: { propertyId } }).then((r) => r.data),
    enabled: ["rooms"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('rooms.read'),
  });

  const roomSummary = roomSummaryQuery.data;
  const arrivalsQuery = useQuery({
    queryKey: ['reservations', 'arrivals', propertyId, today],
    queryFn: () => api.get('/v1/reservations', { params: { propertyId, status: 'confirmed', arrivalDateFrom: today, arrivalDateTo: today } }).then((r) => r.data),
    enabled: ["rooms"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('reservations.read'),
  });

  const arrivals = arrivalsQuery.data;
  const departuresQuery = useQuery({
    queryKey: ['reservations', 'departures', propertyId, today],
    queryFn: () => api.get('/v1/reservations', { params: { propertyId, status: 'checked_in', departureDateFrom: today, departureDateTo: today } }).then((r) => r.data),
    enabled: ["rooms"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('reservations.read'),
  });

  const departures = departuresQuery.data;
  const inHouseQuery = useQuery({
    queryKey: ['reservations', 'in-house', propertyId],
    queryFn: () => api.get('/v1/reservations', { params: { propertyId, status: 'checked_in' } }).then((r) => r.data),
    enabled: ["rooms"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('reservations.read'),
  });

  const inHouse = inHouseQuery.data;
  const agentStatusesQuery = useQuery({
    queryKey: ['agents', propertyId],
    queryFn: () => api.get(`/v1/agents/${propertyId}`).then((r) => r.data?.data ?? r.data ?? []),
    enabled: ["revenue"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('revenue.manage'),
  });

  const agentStatuses = agentStatusesQuery.data;
  const managementQuery = useQuery({
    queryKey: ['reports', 'management-summary', propertyId, today],
    queryFn: () => api.get('/v1/reports/management-summary', { params: { propertyId } }).then((r) => r.data),
    enabled: ["drr","operations"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('management_dashboard.view'),
  });

  const management = managementQuery.data;
  const attentionQuery = useQuery({
    queryKey: ['operations', 'attention', propertyId, today],
    queryFn: () => api.get('/v1/operations/attention', { params: { propertyId, date: today } }).then((r) => r.data),
    enabled: ["operations"].some(id => widgets.includes(id as typeof widgets[number])) && !!propertyId && !isPortfolioMode && hasPermission('ops.read'),
  });

  const attention = attentionQuery.data;
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [isExportingDrr, setIsExportingDrr] = useState(false);

  const handleEvent = useCallback((payload: ActivityEvent) => {
    setActivities((prev) => [payload, ...prev].slice(0, 10));
    if (/^(maintenance\.|operations\.|guest_request\.|housekeeping\.|reservation\.|payment\.)/.test(payload.event)) {
      void queryClient.invalidateQueries({ queryKey: ['operations'] });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'management-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['rooms', 'status-summary'] });
    }
  }, [queryClient]);

  useEffect(() => {
    if (isPortfolioMode || !hasPermission('dashboard.view')) return;
    const socket = getSocket();
    socket.on('pmsEvent', handleEvent);
    return () => { socket.off('pmsEvent', handleEvent); };
  }, [handleEvent, isPortfolioMode, hasPermission, propertyId]);

  if (!propertyId) {
    return (
      <div className="flex items-center justify-center h-64 text-telivity-mid-grey">
        {t('dashboard.selectProperty')}
      </div>
    );
  }

  // Portfolio mode dashboard
  if (isPortfolioMode) {
    const fin = portfolioFinancial?.data ?? portfolioFinancial ?? {};
    const occ = portfolioOccupancy?.data ?? portfolioOccupancy ?? {};
    const kpis = reportedKpis(fin);
    const byProperty = fin.byProperty ?? [];
    const propertyNameMap = new Map(properties.map((p) => [p.id, p.name]));

    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <Building2 size={24} className="text-telivity-teal" />
          <h1 className="text-2xl font-semibold text-telivity-navy">{t('dashboard.portfolio.title')}</h1>
          <span className="text-sm text-telivity-mid-grey ml-auto">
            {t('dashboard.portfolio.propertyCount', { count: fin.propertyCount ?? properties.length })} · {formattedToday}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <KpiCard
            title={t('dashboard.portfolio.occupancy')}
            value={formatOccupancyPercent(kpis.occupancyRate)}
            subtitle={t('dashboard.occupiedOfRooms', { occupied: occ.occupiedRooms ?? 0, total: occ.availableRooms ?? 0 })}
            icon={Percent}
          />
          <KpiCard
            title={t('dashboard.portfolio.adr')}
            value={formatMoney(kpis.adr, fin.currencyCode)}
            subtitle={t('dashboard.portfolio.weightedAverage')}
            icon={DollarSign}
          />
          <KpiCard
            title={t('dashboard.portfolio.revpar')}
            value={formatMoney(kpis.revpar, fin.currencyCode)}
            subtitle={t('dashboard.portfolio.acrossAllProperties')}
            icon={TrendingUp}
          />
          <KpiCard
            title={t('dashboard.portfolio.totalRevenueToday')}
            value={formatMoney(kpis.totalRevenue, fin.currencyCode)}
            subtitle={t('dashboard.portfolio.arrivalsAndDepartures', { arrivals: occ.arrivals ?? 0, departures: occ.departures ?? 0 })}
            icon={BedDouble}
          />
        </div>

        <PortfolioRevenue data={fin} names={propertyNameMap} />

        <div className="bg-white rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-telivity-navy mb-4">{t('dashboard.portfolio.propertyBreakdown')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-telivity-mid-grey border-b border-gray-100">
                  <th className="pb-2 font-medium">{t('dashboard.portfolio.property')}</th>
                  <th className="pb-2 font-medium">{t('dashboard.occupancy')}</th>
                  <th className="pb-2 font-medium">{t('dashboard.adr')}</th>
                  <th className="pb-2 font-medium">{t('dashboard.revpar')}</th>
                  <th className="pb-2 font-medium">{t('dashboard.portfolio.revenue')}</th>
                </tr>
              </thead>
              <tbody>
                {byProperty.map((row: any) => (
                  <tr key={row.propertyId} className="border-b border-gray-50 last:border-0">
                    <td className="py-2.5 font-medium text-telivity-navy">
                      <button
                        className="hover:text-telivity-teal"
                        onClick={() => setPropertyId(row.propertyId)}
                      >
                        {propertyNameMap.get(row.propertyId) ?? row.propertyId}
                      </button>
                    </td>
                    <td className="py-2.5">{formatOccupancyPercent(row.occupancyRate)}</td>
                    <td className="py-2.5 whitespace-nowrap">{formatMoney(reportedKpis(row).adr, row.currencyCode)}</td>
                    <td className="py-2.5 whitespace-nowrap">{formatMoney(reportedKpis(row).revpar, row.currencyCode)}</td>
                    <td className="py-2.5 whitespace-nowrap">{formatMoney(reportedKpis(row).totalRevenue, row.currencyCode)} · {row.actual?.status} · {row.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  const occ = occupancy?.data ?? occupancy ?? {};
  const fin = financial?.data ?? financial ?? {};
  const kpis = reportedKpis(fin);
  const arrList = arrivals?.data ?? arrivals ?? [];
  const depList = departures?.data ?? departures ?? [];
  const ihList = inHouse?.data ?? inHouse ?? [];

  const roomData = roomSummary?.data ?? roomSummary ?? [];
  const chartData = Array.isArray(roomData)
    ? roomData.map((r: { status: string; count: number }) => ({
        name: t(`dashboard.roomStatuses.${r.status}`, { defaultValue: r.status.replace(/_/g, ' ') }),
        status: r.status,
        value: Number(r.count),
        color: ROOM_STATUS_COLORS[r.status] ?? '#bbbbc4',
      }))
    : [];

  const totalRooms = chartData.reduce((sum: number, d: { value: number }) => sum + d.value, 0);
  const occupiedCount = chartData.find((d: { status: string }) => d.status === 'occupied')?.value ?? 0;
  const managementData = management?.data ?? management;
  const drr = managementData?.drr;
  const todayOps = managementData?.today;
  const attentionItems = (attention?.data ?? attention)?.items ?? [];
  const ru = i18n.language.startsWith('ru');

  async function exportDrr(): Promise<void> {
    if (!drr) return;
    setIsExportingDrr(true);
    try {
      const { downloadReportWorkbook } = await import('../lib/report-excel');
      await downloadReportWorkbook({
        title: ru ? 'Ежедневный отчёт по выручке (DRR)' : 'Daily Revenue Report (DRR)',
        reportType: `drr-${today}`,
        propertyName: activeProperty?.name ?? propertyId ?? 'Property',
        currencyCode: currencyCode ?? 'KZT',
        parameters: { date: today },
        data: drr,
      });
    } catch (error) {
      console.error('Failed to export DRR workbook', error);
    } finally {
      setIsExportingDrr(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 mb-6" style={{ order: -3 }}>
        <LayoutDashboard size={24} className="text-telivity-teal" />
        <h1 className="text-2xl font-semibold text-telivity-navy">{t('nav.dashboard')}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-3"><span className="text-sm text-telivity-mid-grey">{formattedToday}</span><WorkspaceSettings layout={layout} pageId={pageId} onChange={saveLayout} onSelectPage={setPageId} hasPermission={hasPermission} /><button disabled={!dirty || saving || workspaceQuery.isPending || workspaceQuery.isError} onClick={() => void persistLayout()} className="rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving ? t('common.saving') : t('workspace.save')}</button></div>
      </div>

      {storageError && <p role="status" style={{ order: -2 }} className="mb-3 text-sm text-amber-700">{t('workspace.storageError')}</p>}
      {workspaceQuery.data?.persistent === false && <p className="mb-3 text-xs text-gray-500">{t('workspace.demo')}</p>}
      {(saveError || workspaceQuery.isError) && <div role="alert" className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{saveError || t('workspace.loadError')}<button className="ml-3 underline" onClick={() => { setDirty(false); setSaveError(''); void workspaceQuery.refetch(); }}>{t('workspace.reload')}</button></div>}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">{layout.pages.map(page => <button key={page.id} role="tab" aria-selected={pageId === page.id} onClick={() => setPageId(page.id)} className={pageId === page.id ? 'rounded-lg bg-telivity-navy px-4 py-2 text-sm text-white' : 'rounded-lg border bg-white px-4 py-2 text-sm'}>{page.name}{layout.startPageId === page.id ? ' · ★' : ''}</button>)}</div>
      <nav style={{ order: -1 }} className="mb-5 flex flex-wrap gap-2">
        {hasPermission('frontdesk.access') && <button className="rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white" onClick={() => navigate('/front-desk')}>{t('workspace.frontdesk')}</button>}
        {hasPermission('reservations.read') && <button className="rounded-lg border bg-white px-4 py-2 text-sm font-semibold text-telivity-slate" onClick={() => navigate('/reservations/calendar')}>{t('workspace.calendar')}</button>}
      </nav>
      {widgets.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-telivity-mid-grey">{t('workspace.empty')}</p>}
      <p role="status" className="mb-3 text-xs">{fin.date ?? businessDate.data?.date} · {fin.actual?.status ?? 'UNKNOWN'} · {fin.actual?.closedDays}/{fin.actual?.expectedDays} · charges.serviceDate · Signed earned revenue; cash, deposits and separately posted tax are not actual revenue.</p>
      <WorkspaceCanvas layout={layout} pageId={pageId} onChange={saveLayout} queryStates={{ metrics: [financialQuery, occupancyQuery], rooms: [roomSummaryQuery, arrivalsQuery, departuresQuery, inHouseQuery], drr: [managementQuery], operations: [attentionQuery], revenue: [agentStatusesQuery] }}>
      {drr && (
        <section className="bg-white rounded-xl shadow-sm p-5 mb-6" data-widget="drr">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <CalendarCheck size={20} className="text-telivity-teal" />
            <div><h2 className="text-base font-semibold text-telivity-navy">{ru ? 'Ежедневный отчёт по выручке (DRR)' : 'Daily Revenue Report (DRR)'}</h2><p className="text-xs text-telivity-mid-grey">{ru ? 'Единые показатели главной и отчётов' : 'One source of truth for Dashboard and Reports'}</p></div>
            <div className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => void exportDrr()}
                disabled={isExportingDrr}
                className="inline-flex items-center gap-1.5 rounded-lg border border-telivity-teal px-3 py-1.5 text-xs font-semibold text-telivity-teal hover:bg-telivity-teal/5 disabled:opacity-50"
              >
                <Download size={14} />
                {isExportingDrr ? (ru ? 'Создание…' : 'Creating…') : 'Excel'}
              </button>
              <button onClick={() => navigate('/reports')} className="text-xs font-semibold text-telivity-teal">{ru ? 'Открыть отчёты →' : 'Open reports →'}</button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <ManagementMetric label={ru ? 'Брони в работе' : 'On books'} value={drr.onBooks} />
            <ManagementMetric label={ru ? 'Прирост ночей' : 'Pickup'} value={drr.pickup?.roomNights ?? 0} />
            <ManagementMetric label={ru ? 'Новые брони' : 'Pace'} value={drr.pace?.newBookings ?? 0} />
            <ManagementMetric label={ru ? 'Предоплаты' : 'Deposits'} value={formatMoney(drr.deposits, currencyCode)} />
            <ManagementMetric label={ru ? 'Отмены' : 'Cancellations'} value={drr.cancellations} />
            <ManagementMetric label={ru ? 'Выручка MTD' : 'MTD revenue'} value={formatMoney(drr.mtdRevenue, currencyCode)} />
            <ManagementMetric label={ru ? 'Прогноз' : 'Forecast'} value={formatMoney(drr.forecastRevenue, currencyCode)} />
            <ManagementMetric label={ru ? 'Изменение к вчера' : 'vs yesterday'} value={formatDelta(drr.comparisons?.previousDay?.revenue?.percent)} />
          </div>
          {Array.isArray(drr.channelMix) && drr.channelMix.length > 0 && <div className="mt-4 flex flex-wrap gap-2"><span className="text-xs text-telivity-mid-grey">{ru ? 'Каналы:' : 'Channel mix:'}</span>{drr.channelMix.map((channel: any) => <span key={channel.source} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-telivity-slate">{channel.source}: {channel.bookings}</span>)}</div>}
        </section>
      )}

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6" data-widget="operations">
        <div className="xl:col-span-2 bg-white rounded-xl shadow-sm p-5">
          <div className="flex items-center gap-2 mb-4"><AlertTriangle size={18} className="text-amber-600"/><h2 className="text-sm font-semibold text-telivity-navy">{ru ? 'Требует внимания' : 'Requires attention'}</h2><span className="rounded-full bg-amber-100 text-amber-900 px-2 py-0.5 text-xs font-semibold">{attentionItems.length}</span><button onClick={() => navigate('/operations')} className="ml-auto text-xs font-semibold text-telivity-teal">{ru ? 'Все операции →' : 'All operations →'}</button></div>
          <div className="space-y-2">
            {attentionItems.slice(0, 6).map((item: any) => <button key={`${item.type}-${item.id}`} onClick={() => navigate(item.href)} className="w-full text-left flex items-center gap-3 rounded-lg border border-gray-100 p-3 hover:border-telivity-teal/40"><span className={`h-2 h-2 rounded-full ${item.priority === 'critical' ? 'bg-red-500' : item.priority === 'high' ? 'bg-amber-500' : 'bg-blue-400'}`} /><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-telivity-navy truncate">{item.title}</p><p className="text-xs text-telivity-mid-grey truncate">{item.description}</p></div><span className="text-xs text-telivity-teal">→</span></button>)}
            {attentionItems.length === 0 && <p className="py-6 text-center text-sm text-telivity-mid-grey">{ru ? 'Критичных отклонений нет' : 'No actionable exceptions'}</p>}
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-5">
          <div className="flex items-center gap-2 mb-4"><WalletCards size={18} className="text-telivity-teal"/><h2 className="text-sm font-semibold text-telivity-navy">{ru ? 'Операционная сводка' : 'Operations summary'}</h2></div>
          <div className="grid grid-cols-2 gap-3">
            <ManagementMetric label={ru ? 'Подтверждено' : 'Confirmed'} value={todayOps?.confirmed ?? 0} />
            <ManagementMetric label={ru ? 'Неявки' : 'No-shows'} value={todayOps?.noShows ?? 0} />
            <ManagementMetric label={ru ? 'Ожидает оплаты' : 'Pending'} value={formatMoney(todayOps?.pendingPayments ?? 0, currencyCode)} />
            <ManagementMetric label={ru ? 'Предоплат получено' : 'Deposits received'} value={formatMoney(todayOps?.receivedDeposits ?? 0, currencyCode)} />
            <ManagementMetric label={ru ? 'Готовые номера' : 'Ready rooms'} value={(todayOps?.rooms?.guest_ready ?? 0) + (todayOps?.rooms?.vacant_clean ?? 0)} />
            <ManagementMetric label={ru ? 'Грязные номера' : 'Dirty rooms'} value={todayOps?.rooms?.vacant_dirty ?? 0} />
            <ManagementMetric label={ru ? 'В уборке' : 'Cleaning'} value={todayOps?.rooms?.clean ?? 0} />
            <ManagementMetric label={ru ? 'В ремонте' : 'Out of Order'} value={todayOps?.rooms?.out_of_order ?? 0} />
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6" data-widget="metrics">
        <KpiCard
          title={t('dashboard.occupancy')}
          value={formatOccupancyPercent(occ.occupancyRate)}
          subtitle={t('dashboard.occupiedOfRooms', {
            occupied: occ.occupiedRooms ?? occupiedCount,
            total: occ.availableRooms ?? totalRooms,
          })}
          icon={Percent}
          numericValue={occ.occupancyRate != null ? Number(occ.occupancyRate) : undefined}
          threshold={thr.occupancyRate}
        />
        <KpiCard
          title={t('dashboard.adr')}
          value={kpis.adr != null ? formatMoney(kpis.adr, currencyCode) : '—'}
          subtitle={t('dashboard.averageDailyRate')}
          icon={DollarSign}
          numericValue={kpis.adr != null ? Number(kpis.adr) : undefined}
          threshold={thr.adr}
        />
        <KpiCard
          title={t('dashboard.revpar')}
          value={kpis.revpar != null ? formatMoney(kpis.revpar, currencyCode) : '—'}
          subtitle={t('dashboard.revenuePerAvailableRoom')}
          icon={TrendingUp}
          numericValue={kpis.revpar != null ? Number(kpis.revpar) : undefined}
          threshold={thr.revpar}
        />
        <KpiCard
          title={t('dashboard.revenueToday')}
          value={kpis.totalRevenue != null ? formatMoney(kpis.totalRevenue, currencyCode) : '—'}
          subtitle={t('dashboard.revenueBreakdown')}
          icon={BedDouble}
          numericValue={kpis.totalRevenue != null ? Number(kpis.totalRevenue) : undefined}
          threshold={thr.totalRevenue}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6" data-widget="rooms">
        <div className="bg-white rounded-xl shadow-sm p-5">
          <h2 className="text-sm font-semibold text-telivity-navy mb-4">{ru ? 'Сегодня' : "Today's activity"}</h2>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-telivity-teal/10 rounded-lg">
                <LogIn size={16} className="text-telivity-teal" />
              </div>
              <div>
                <p className="text-sm font-medium text-telivity-navy">{Array.isArray(arrList) ? arrList.length : 0}</p>
                <p className="text-xs text-telivity-mid-grey">{t('dashboard.arrivals')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-telivity-deep-blue/10 rounded-lg">
                <Users size={16} className="text-telivity-deep-blue" />
              </div>
              <div>
                <p className="text-sm font-medium text-telivity-navy">{Array.isArray(ihList) ? ihList.length : 0}</p>
                <p className="text-xs text-telivity-mid-grey">{t('dashboard.inHouse')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-telivity-orange/10 rounded-lg">
                <LogOut size={16} className="text-telivity-orange" />
              </div>
              <div>
                <p className="text-sm font-medium text-telivity-navy">{Array.isArray(depList) ? depList.length : 0}</p>
                <p className="text-xs text-telivity-mid-grey">{t('dashboard.departures')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="p-2 bg-telivity-dark-teal/10 rounded-lg">
                <DoorOpen size={16} className="text-telivity-dark-teal" />
              </div>
              <div>
                <p className="text-sm font-medium text-telivity-navy">{chartData.filter((d: { status: string }) => ['vacant_clean', 'guest_ready', 'inspected'].includes(d.status)).reduce((sum: number, d: { value: number }) => sum + d.value, 0)}</p>
                <p className="text-xs text-telivity-mid-grey">{t('workspace.readyRooms')}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-telivity-navy mb-4">{t('dashboard.roomStatus')}</h2>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={95}
                  dataKey="value"
                  nameKey="name"
                  paddingAngle={2}
                >
                  {chartData.map((entry: { name: string; color: string }, i: number) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-60 text-telivity-mid-grey text-sm">
              {t('workspace.noRoomData')}
            </div>
          )}
        </div>
      </div>

      {Array.isArray(agentStatuses) && agentStatuses.length > 0 && (
        <div
          data-widget="revenue"
          className="bg-white rounded-xl shadow-sm p-5 mb-6 cursor-pointer hover:ring-2 hover:ring-telivity-teal/30 transition-all"
          onClick={() => navigate('/revenue')}
        >
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-telivity-teal/10 rounded-lg">
              <Brain size={20} className="text-telivity-teal" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-telivity-navy">{t('dashboard.revenueIntelligence')}</h2>
              <p className="text-xs text-telivity-mid-grey mt-0.5">
                {t('dashboard.activeAgents', { count: agentStatuses.filter((a: { isEnabled: boolean }) => a.isEnabled).length })}
                {' | '}
                {t('dashboard.pendingDecisions', { count: agentStatuses.reduce((s: number, a: { pendingDecisions?: number }) => s + (a.pendingDecisions ?? 0), 0) })}
              </p>
            </div>
            <span className="text-xs text-telivity-teal font-medium">{t('dashboard.viewRevenueManagement')} &rarr;</span>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm p-5" data-widget="activity">
        <h2 className="text-sm font-semibold text-telivity-navy mb-4">{t('dashboard.recentActivityLive')}</h2>
        {activities.length > 0 ? (
          <div className="space-y-2">
            {activities.map((a, i) => (
              <div key={`${a.timestamp}-${i}`} className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
                <div className="w-2 h-2 rounded-full bg-telivity-teal flex-shrink-0" />
                <span className="text-sm font-medium text-telivity-navy">{t(`hotelEvents.${a.event}`, { defaultValue: t('workspace.event') })}</span>
                <span className="text-xs text-telivity-mid-grey ml-auto">
                  {format(new Date(a.timestamp), 'pp', { locale: dateLocale })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-telivity-mid-grey">{t('dashboard.waitingForEvents')}</p>
        )}
      </div>
      </WorkspaceCanvas>
    </div>
  );
}

function ManagementMetric({ label, value }: { label: string; value: string | number }) {
  return <div className="rounded-lg bg-gray-50 p-3 min-w-0"><p className="text-[11px] text-telivity-mid-grey truncate">{label}</p><p className="mt-1 text-sm font-semibold text-telivity-navy truncate">{value}</p></div>;
}

function formatDelta(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}
