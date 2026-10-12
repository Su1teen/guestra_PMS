import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { propertyHref } from '../../lib/navigation';
import { pricingError, ratioValue, realisedMoney, unwrap, type ManagementSummary } from '../../lib/live-revenue';

export default function RevenueFinancialOverview({ propertyId, canRead, date }: { propertyId: string; canRead: boolean; date?: string }) {
  const { i18n } = useTranslation();
  const ru = i18n.language.startsWith('ru');
  const text = (r: string, e: string) => ru ? r : e;
  const summary = useQuery<ManagementSummary>({
    queryKey: ['reports', 'management-summary', propertyId, date || 'operational'],
    queryFn: ({ signal }) => api.get('/v1/reports/management-summary', { params: { propertyId, date: date || undefined }, signal }).then(r => unwrap(r.data)),
    enabled: canRead,
  });
  if (!canRead) return <p>{text('Для KPI требуется reports.view.', 'KPIs require reports.view.')}</p>;
  if (summary.isPending) return <p role="status">{text('Загрузка финансовых показателей…', 'Loading financial KPIs…')}</p>;
  if (summary.isError) return <p role="alert" className="rounded-lg bg-red-50 p-4">{pricingError(summary.error, ru)} <button type="button" onClick={() => void summary.refetch()}>{text('Повторить KPI', 'Retry KPIs')}</button></p>;
  const data = summary.data;
  const f = data.financial;
  const k = f.kpis;
  const money = (value: number | null) => realisedMoney(value, f.actual, data.currencyCode, i18n.language);
  const rawMoney = (value: number | null) => formatMoney(value, data.currencyCode, i18n.language);
  const actualLabel = `${f.actual.status} · ${f.actual.closedDays}/${f.actual.expectedDays}`;
  const metrics = [
    ['OCC', k.occ === null ? '—' : `${(k.occ * 100).toFixed(1)}%`, text('Проданные ночи / доступный инвентарь с OOO/OOS', 'Consumed room nights / available inventory excluding OOO/OOS')],
    ['ADR', money(ratioValue(k, 'adr')), text('Чистая room revenue / проданные ночи', 'Net room revenue / consumed room nights')],
    ['RevPAR', money(ratioValue(k, 'revpar')), text('Чистая room revenue / доступные номера', 'Net room revenue / available rooms')],
    ['TRevPAR', money(ratioValue(k, 'trevpar')), text('Вся earned revenue / доступные номера', 'Total earned revenue / available rooms')],
    ['Room Revenue', money(k.roomRevenue), text('Проведённые room начисления с корректировками и сторно', 'Posted room charges including signed corrections and reversals')],
    ['F&B Revenue', money(k.foodBeverageRevenue), text('Проведённые food_beverage начисления', 'Posted food_beverage charges')],
    ['Ancillary Revenue', money(k.ancillaryRevenue), text('Прочие начисления, исключая room, tax и F&B', 'Other charges excluding room, tax and F&B')],
    ['Total Revenue / Actual', money(k.totalRevenue), text('Room + F&B + ancillary; отдельно проведённый налог исключён', 'Room + F&B + ancillary; separately posted tax excluded')],
    [text('Налог', 'Tax'), money(k.separatelyPostedTax), text('Отдельно проведённые налоги; не earned revenue', 'Separately posted tax; not earned revenue')],
    [text('Поступления нетто', 'Net receipts'), rawMoney(f.cash.net), text('Платежи минус возвраты, исключая city-ledger transfers; не выручка', 'Captured payments minus refunds, excluding city-ledger transfers; not revenue')],
    [text('Депозиты', 'Deposits'), rawMoney(f.deposits.held), text('Текущее held обязательство; не выручка', 'Current held deposit liability; not revenue')],
    [text('Остатки к оплате', 'Outstanding balances'), rawMoney(f.outstandingBalances.totalBalanceDue), text('Текущие положительные остатки открытых фолио', 'Current positive open-folio balances')],
    ['A/R', rawMoney(f.outstandingBalances.accountsReceivableDue), text('Текущая дебиторская задолженность отдельно от фолио', 'Current receivables separately from guest folios')],
    [text('Окно бронирования', 'Booking window'), data.bookingWindow.value === null ? '—' : `${data.bookingWindow.value.toFixed(1)} ${text('дн.', 'days')}`, text('Дата заезда минус локальная дата создания, среднее по выборке', 'Arrival minus local creation date, sample average') + ` · n=${data.bookingWindow.sampleSize}`],
    ['ALOS', data.averageLengthOfStay.value === null ? '—' : `${data.averageLengthOfStay.value.toFixed(1)} ${text('ночей', 'nights')}`, text('Выезд минус заезд, среднее по выборке', 'Departure minus arrival, sample average') + ` · n=${data.averageLengthOfStay.sampleSize}`],
    ...(['mtd', 'ytd', 'ly', 'lytd'] as const).map(period => [period.toUpperCase(), data.periods[period] ? realisedMoney(data.periods[period].value, data.periods[period], data.currencyCode, i18n.language) : '—', data.periods[period] ? `${data.periods[period].start} — ${data.periods[period].end} · ${data.periods[period].status}` : text('Нет данных', 'Missing data')]),
  ];
  return <section className="rounded-xl bg-white p-4 shadow-sm">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold text-telivity-navy">{text('Финансовый обзор', 'Financial overview')}</h2><p className="text-xs text-telivity-mid-grey">ReportsService · {text('Объект целиком, операционная дата', 'Whole property, operational date')}: {data.date} · {data.currencyCode}</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{actualLabel}</span></div>
    {f.actual.status !== 'COMPLETE' && <p role="status" className="mb-3 rounded-lg bg-amber-50 p-3 text-xs">{text('Данные неполные. Отсутствие проводок не означает нулевую выручку; незакрытые дни отображаются как PARTIAL.', 'Data is incomplete. Missing postings are not zero revenue; unclosed days are PARTIAL.')}</p>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{metrics.map(([label, value, method]) => <div key={label} className="min-w-0 rounded-lg bg-slate-50 p-3"><p className="text-xs text-telivity-mid-grey">{label}</p><p className="mt-1 whitespace-nowrap text-lg font-semibold tabular-nums text-telivity-navy">{value}</p><p className="mt-1 text-[11px] text-telivity-mid-grey">{method}</p></div>)}</div>
    <div className="mt-3 grid gap-3 sm:grid-cols-3">{([['Forecast', data.forecast], ['Plan to Date', data.planToDate], ['GOP', data.gop]] as const).map(([label, metric]) => <div key={label} className="rounded-lg border p-3 text-xs"><p className="font-semibold">{label} · {metric.status}</p><p className="mt-1">— · {metric.reason}</p></div>)}</div>
    <p className="mt-3 text-xs text-telivity-mid-grey">{text('Источник Actual: ledger, по service/business date; налоги, сторно и сервисные начисления учитываются ReportsService один раз. Quotes, депозиты и cash не подменяют earned revenue. DRR — ежедневный отчёт, не процент.', 'Actual source: ledger by service/business date; ReportsService counts taxes, reversals and service charges once. Quotes, deposits and cash are not earned revenue. DRR is a daily report, not a ratio.')}</p>
    <Link className="mt-3 inline-block text-sm font-semibold text-telivity-teal" to={propertyHref('/reports?report=daily-revenue', propertyId)}>{text('Открыть DRR и сверку', 'Open DRR & reconciliation')}</Link>
  </section>;
}
