import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProperty } from '../context/PropertyContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import { propertyHref } from '../lib/navigation';
import { addDaysKey, propertyClock } from '../lib/dynamic-pricing';
import { formatMoney } from '../lib/money';
import { liveRateKey, pricingError, unwrap, validCalendarRange, type LiveCalendar, type RatePlanRecord, type LiveRate } from '../lib/live-revenue';
import RevenueWorkspaceNav from '../components/revenue/RevenueWorkspaceNav';
import RevenueFinancialOverview from '../components/revenue/RevenueFinancialOverview';
import LiveRateWorkflow from '../components/revenue/LiveRateWorkflow';
import RevenueAdvanced from './RevenueAdvanced';

const field = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm';
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

export default function Revenue() {
  const { propertyId, isPortfolioMode } = useProperty();
  const [params] = useSearchParams();
  if (!propertyId || isPortfolioMode) return <p className="py-16 text-center text-telivity-mid-grey">Выберите объект / Select a property</p>;
  if (params.get('section') === 'agents') return <RevenueAdvanced key={propertyId} />;
  return <RevenueLive key={propertyId} propertyId={propertyId} />;
}

function RevenueLive({ propertyId }: { propertyId: string }) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const text = (r: string, e: string) => ru ? r : e;
  const { hasPermission } = useAuth();
  const { properties } = useProperty();
  const [params, setParams] = useSearchParams();
  const requestedSection = params.get('section');
  const section = requestedSection === 'queue' || requestedSection === 'history' ? requestedSection : 'overview';
  const today = propertyClock(new Date(), properties.find(p => p.id === propertyId)?.timezone).today;
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDaysKey(today, 29));
  const [roomTypeId, setRoomTypeId] = useState('');
  const [ratePlanId, setRatePlanId] = useState(params.get('ratePlanId') ?? '');
  const [nights, setNights] = useState(1);
  const [selection, setSelection] = useState('');
  const [editRate, setEditRate] = useState<LiveRate | null>(null);
  const canRead = hasPermission('rateplans.read', 'reports.view');
  const canManage = hasPermission('rateplans.manage');
  const rangeValid = validCalendarRange(startDate, endDate) && Number.isInteger(nights) && nights >= 1 && nights <= 366;
  const categories = useQuery<{ id: string; name: string }[]>({
    queryKey: ['revenue', 'categories', propertyId],
    queryFn: ({ signal }) => api.get('/v1/rooms/types', { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: hasPermission('rooms.read'),
  });
  const plans = useQuery<RatePlanRecord[]>({
    queryKey: ['rate-plans', propertyId],
    queryFn: ({ signal }) => api.get('/v1/rate-plans', { params: { propertyId }, signal }).then(r => unwrap(r.data)),
    enabled: hasPermission('rateplans.read'),
  });
  const calendar = useQuery<LiveCalendar>({
    queryKey: ['rate-plans', 'live-calendar', propertyId, startDate, endDate, roomTypeId, ratePlanId, nights],
    queryFn: ({ signal }) => api.get('/v1/rate-plans/live-calendar', {
      params: { propertyId, startDate, endDate, roomTypeId: roomTypeId || undefined, ratePlanId: ratePlanId || undefined, nights }, signal,
    }).then(r => unwrap(r.data)),
    enabled: canRead && rangeValid,
  });
  const data = calendar.data;
  const selected = data?.rates.find(rate => liveRateKey(rate) === selection) ?? data?.rates[0];
  const changeTab = (next: string) => setParams(prev => { const p = new URLSearchParams(prev); p.set('section', next); return p; });
  const filterChanged = () => { setSelection(''); setEditRate(null); };
  const categoryOptions = categories.data ?? [...new Set(plans.data?.map(p => p.roomTypeId) ?? [])].map(id => ({ id, name: id }));

  return <div className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3"><TrendingUp className="text-telivity-teal" size={24} /><div><h1 className="text-2xl font-semibold text-telivity-navy">Revenue Management</h1><p className="text-xs text-telivity-mid-grey">{text('Live · реальные данные PMS, без автопилота', 'Live · real PMS data, no autopilot')}</p></div></div>
      <Link className="rounded-lg border px-3 py-2 text-sm" to={propertyHref('/dynamic-pricing', propertyId)}>{text('Открыть симуляцию', 'Open simulation')}</Link>
    </header>
    <RevenueWorkspaceNav />
    <nav aria-label={text('Разделы Revenue', 'Revenue sections')} className="flex flex-wrap gap-2">
      {(['overview', 'queue', 'history'] as const).map((tab, index) => <button key={tab} type="button" aria-pressed={section === tab} onClick={() => changeTab(tab)} className={`rounded-lg px-3 py-2 text-sm ${section === tab ? 'bg-telivity-navy text-white' : 'border bg-white'}`}>{[text('Обзор и тарифы', 'Overview & rates'), text('Согласование', 'Approval queue'), text('История', 'History')][index]}</button>)}
    </nav>
    {section === 'overview' && <>
      <RevenueFinancialOverview propertyId={propertyId} canRead={hasPermission('reports.view')} />
      {!canRead ? <p role="alert" className="rounded-lg border p-4">{text('Для календаря требуются rateplans.read и reports.view.', 'Calendar requires rateplans.read and reports.view.')}</p> : <>
        <section className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{text('Календарь продаваемых тарифов', 'Live selling-rate calendar')}</h2><button type="button" aria-label={text('Обновить календарь', 'Refresh calendar')} disabled={calendar.isFetching} onClick={() => void calendar.refetch()}><RefreshCw size={16} /></button></div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="text-xs">{text('С даты', 'From')}<input className={field} type="date" value={startDate} onChange={e => { setStartDate(e.target.value); filterChanged(); }} /></label>
            <label className="text-xs">{text('По дату', 'To')}<input className={field} type="date" value={endDate} onChange={e => { setEndDate(e.target.value); filterChanged(); }} /></label>
            <label className="text-xs">{text('Категория', 'Category')}<select className={field} value={roomTypeId} onChange={e => { setRoomTypeId(e.target.value); setRatePlanId(''); filterChanged(); }}><option value="">{text('Все категории', 'All categories')}</option>{categoryOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label className="text-xs">{text('Тарифный план', 'Rate plan')}<select className={field} value={ratePlanId} onChange={e => { setRatePlanId(e.target.value); filterChanged(); }}><option value="">{text('Все тарифы', 'All rates')}</option>{plans.data?.filter(p => !roomTypeId || p.roomTypeId === roomTypeId).map(p => <option key={p.id} value={p.id}>{p.name} · {p.code}</option>)}</select></label>
            <label className="text-xs">{text('Ночей в котировке', 'Quote nights')}<input className={field} type="number" min={1} max={366} value={nights} onChange={e => { setNights(Number(e.target.value)); filterChanged(); }} /></label>
          </div>
          {!rangeValid && <p role="alert" className="mt-3 text-sm text-red-700">{text('Выберите интервал до 93 дней и 1–366 ночей.', 'Choose a range of up to 93 days and 1–366 nights.')}</p>}
          {(plans.isError || categories.isError) && <p role="alert" className="mt-2 text-sm">{text('Не удалось загрузить фильтры.', 'Could not load filters.')} <button type="button" onClick={() => { void plans.refetch(); void categories.refetch(); }}>{text('Повторить', 'Retry')}</button></p>}
        </section>
        {rangeValid && calendar.isPending && <p role="status">{text('Загрузка тарифов и продаж…', 'Loading live rates and sales…')}</p>}
        {calendar.isError && <p role="alert" className="rounded-lg bg-red-50 p-4">{pricingError(calendar.error, ru)} <button type="button" onClick={() => void calendar.refetch()}>{text('Повторить', 'Retry')}</button></p>}
        {data && rangeValid && <>
          <section className="rounded-xl bg-white p-4 shadow-sm"><h2 className="font-semibold">{text('Продажи, загрузка и pickup', 'Sales, occupancy & pickup')}</h2><p className="my-2 text-xs text-telivity-mid-grey">ReportsService · {text('Категория влияет только на коммерческие сигналы. Pickup по датам создания/отмены; поправки брони не реконструированы. Исторический инвентарь: текущий состав + OOO/OOS блоки.', 'Category scopes commercial signals only. Pickup uses creation/cancellation timestamps; amendments are not reconstructed. Inventory history: current roster + dated OOO/OOS blocks.')}</p>
            <p className="mb-3 text-sm tabular-nums">{text('Темп продаж', 'Booking pace')}: {data.signals.pace.summary.totalNewBookings} {text('новых броней за выбранный интервал; среднее ночей на книгах', 'new bookings in the selected range; average on-books nights')}: {data.signals.pace.summary.avgRoomsOnBooks.toFixed(1)}</p>
            <div className="max-h-64 overflow-auto"><table className="w-full whitespace-nowrap text-left text-xs tabular-nums"><thead className="sticky top-0 bg-gray-50"><tr>{[text('Дата', 'Date'), 'On books', text('Загрузка on books', 'On-books OCC'), text('Фактическая OCC', 'Realised OCC'), 'Pickup', 'OOO / OOS', text('Доступно', 'Available')].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{data.signals.daily.map(day => <tr key={day.date} className="border-t"><td className="p-2">{day.date}</td><td className="p-2">{day.roomsOnBooks}</td><td className="p-2">{percent(day.onBooksOccupancy)}</td><td className="p-2">{percent(day.realisedOccupancy)}</td><td className="p-2" title={`${day.pickupPeriod.from} — ${day.pickupPeriod.to}`}>{day.pickup.roomNights}</td><td className="p-2">{day.outOfOrder} / {day.outOfService}</td><td className="p-2">{day.availableRooms}</td></tr>)}</tbody></table></div>
          </section>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <section className="min-w-0 rounded-xl bg-white p-4 shadow-sm"><p className="mb-3 text-xs">{text('Сумма котировки включает налоги и все ночи. Это не выручка. Выберите строку для правил и ограничений.', 'Quote total includes tax and all nights. It is not revenue. Select a row for rules and restrictions.')}</p><div className="max-h-96 overflow-auto"><table className="w-full whitespace-nowrap text-left text-sm tabular-nums"><thead className="sticky top-0 bg-gray-50"><tr>{[text('Дата / тариф', 'Date / plan'), text('За ночь', 'Nightly'), text('Котировка', 'Quote total'), text('Продажи', 'Sales')].map(h => <th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{data.rates.map(rate => <tr key={liveRateKey(rate)} className={`border-t ${selected && liveRateKey(selected) === liveRateKey(rate) ? 'bg-telivity-teal/10' : ''}`}><td className="p-2"><button type="button" onClick={() => setSelection(liveRateKey(rate))} aria-pressed={selected && liveRateKey(selected) === liveRateKey(rate)} className="text-left font-medium">{rate.date}<span className="block text-xs font-normal">{rate.name} · {rate.code}</span></button></td><td className="p-2">{formatMoney(rate.price.effectiveRate, rate.currencyCode, i18n.language)}</td><td className="p-2">{formatMoney(rate.quote.totalAmount, rate.quote.currency, i18n.language)}</td><td className="p-2">{rate.sellable ? text('Открыты', 'Open') : text('Закрыты', 'Closed')}</td></tr>)}</tbody></table></div>{data.rates.length === 0 && <p className="py-6 text-sm">{text('Нет активных тарифов для фильтра. Измените фильтр или создайте тариф в «Тарифы и ограничения».', 'No active rates match. Change filters or create a plan in Rates & restrictions.')}</p>}</section>
            {selected && <section className="min-w-0 space-y-3 rounded-xl bg-white p-4 shadow-sm"><h2 className="font-semibold">{selected.date} · {selected.name}</h2><p className="text-2xl font-semibold tabular-nums whitespace-nowrap">{formatMoney(selected.price.effectiveRate, selected.currencyCode, i18n.language)}</p><p className="text-xs">{text('База', 'Base')}: {formatMoney(selected.price.baseRate, selected.currencyCode, i18n.language)} · {selected.price.isTaxInclusive ? text('Налог включён', 'Tax inclusive') : text('Налог сверху', 'Tax exclusive')} · revision {selected.planRevision}</p>
              <dl className="space-y-2 text-xs"><dt className="font-semibold">{text('Правила цены', 'Pricing rules')}</dt><dd>LOS: {selected.price.losAdjustment ? `${selected.price.losAdjustment.minNights}+ / ${selected.price.losAdjustment.adjustmentValue} ${selected.price.losAdjustment.adjustmentType}` : '—'}</dd><dd>OCC: {selected.price.occupancyAdjustment ? `${selected.price.occupancyAdjustment.occupancyPctMin}–${selected.price.occupancyAdjustment.occupancyPctMax}% / ${selected.price.occupancyAdjustment.adjustmentValue} ${selected.price.occupancyAdjustment.adjustmentType}` : '—'}</dd><dd>{selected.price.override?.reason}</dd><dt className="font-semibold">{text('Ограничения продаж', 'Sales restrictions')}</dt><dd>{selected.restrictionReason ?? text('Продажи открыты', 'Sales open')}</dd>{selected.restrictions.map(r => <dd key={r.id} className="rounded-lg border p-2">{r.startDate} — {r.endDate} · LOS {r.minLos ?? '—'} / {r.maxLos ?? '—'} · CTA {String(r.closedToArrival)} · CTD {String(r.closedToDeparture)} · STOP {String(r.isClosed)}<br />{formatMoney(r.rateOverride, selected.currencyCode, i18n.language)} · {r.overrideReason}</dd>)}</dl>
              <div className="rounded-lg bg-slate-50 p-3 text-xs"><h3 className="font-semibold">{text('Рекомендация по настроенным правилам', 'Configured-rule recommendation')}</h3><p className="my-1 whitespace-nowrap tabular-nums">{formatMoney(selected.recommendation.value, selected.currencyCode, i18n.language)}</p><p>{selected.recommendation.reason}</p><p className="mt-2">{text('Не оптимальная цена модели. Требуется ручная проверка.', 'Not a model-validated optimal price. Human review required.')}</p></div>
              <div className="rounded-lg bg-amber-50 p-3 text-xs"><h3 className="font-semibold">Forecast · {selected.forecast.status}</h3><p>{selected.forecast.reason}</p><p>{text('Демонстрационный спрос доступен только в симуляции и не применяется к Live.', 'Demo demand is simulation-only and cannot be applied to Live.')}</p></div>
              {canManage && <button type="button" onClick={() => setEditRate(selected)} className="w-full rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white">{text('Изменить Live тариф / ограничение', 'Change live rate / restriction')}</button>}
            </section>}
          </div>
        </>}
      </>}
    </>}
    <LiveRateWorkflow propertyId={propertyId} section={section} editRate={editRate} initialKind={params.get('kind') === 'plan' ? 'plan' : undefined} onCloseEditor={() => setEditRate(null)} plans={plans.data ?? []} />
  </div>;
}
