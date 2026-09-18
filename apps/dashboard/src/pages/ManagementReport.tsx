import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Info, Landmark, Wallet } from 'lucide-react';
import {
  buildManagementReport, DEMO_PROPERTIES, EXPENSE_GROUPS, formatCompactKzt,
  formatKzt, formatPct, REVENUE_GROUPS,
  type DemoPropertyId, type ReportFilters, type ReportRow,
} from '../lib/management-demo';
import './management-report.css';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const SHORT_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const dateLabel = (date: Date) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
const pct = (numerator: number, denominator: number) => denominator ? numerator / denominator * 100 : 0;
const signedPct = (actual: number, base: number) => base ? (actual / base - 1) * 100 : 0;

function MetricCard({ label, value, sub, emphasis }: { label: string; value: string; sub: string; emphasis?: boolean }) {
  return <div className={`mrr-metric ${emphasis ? 'mrr-metric--emphasis' : ''}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>;
}

function sumMetrics(rows: ReportRow[]): ReportRow['metrics'] {
  const keys: (keyof ReportRow['metrics'])[] = ['plan', 'planToDate', 'actual', 'ly', 'lytd', 'forecast', 'remaining', 'requiredPerDay'];
  const total = { plan: 0, planToDate: 0, actual: 0, ly: 0, lytd: 0, forecast: 0, remaining: 0, requiredPerDay: 0 };
  for (const row of rows) for (const key of keys) total[key] += row.metrics[key];
  return total;
}

function HierarchyTable({ rows, kind }: { rows: ReportRow[]; kind: 'revenue' | 'expense' }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(DEMO_PROPERTIES.map((item) => item.id)));
  const toggle = (id: string) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Плоский список видимых строк: родитель всегда выше детей, дети — только
  // когда раскрыты. Раньше рекурсивный рендер оборачивал каждую строку в свой
  // <tbody> (вложенные tbody) и браузер ломал структуру таблицы — строки
  // «съезжали» от заголовков. Теперь все строки лежат в одном <tbody>.
  const visible: ReportRow[] = [];
  const walk = (row: ReportRow) => {
    visible.push(row);
    if (row.children?.length && open.has(row.id)) row.children.forEach(walk);
  };
  rows.forEach(walk);
  const total = sumMetrics(rows);

  return <div className="mrr-table-scroll">
    <table className="mrr-table">
      <thead>
        <tr>
          <th scope="col" className="mrr-col-name">Объект / направление / статья</th>
          <th scope="col">LY факт</th>
          <th scope="col">LY к дате</th>
          <th scope="col">План</th>
          <th scope="col">План к дате</th>
          <th scope="col">Факт</th>
          <th scope="col">Выполнение плана</th>
          <th scope="col">Остаток</th>
          <th scope="col">Прогноз</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((row) => {
          const hasChildren = !!row.children?.length;
          const expanded = open.has(row.id);
          const m = row.metrics;
          const progress = Math.min(100, pct(m.actual, m.plan));
          const lytdDelta = signedPct(m.actual, m.lytd);
          const lytdFavorable = kind === 'expense' ? lytdDelta <= 0 : lytdDelta >= 0;
          return <tr className={`mrr-table-row mrr-row-${row.depth}`} key={row.id}>
            <th scope="row" className="mrr-name">
              <span className="mrr-name-inner">
                {hasChildren ? <button type="button" className="mrr-toggle" onClick={() => toggle(row.id)} aria-expanded={expanded} aria-label={`${expanded ? 'Свернуть' : 'Развернуть'} ${row.label}`}>
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button> : <span className="mrr-toggle-spacer" aria-hidden />}
                <span className="mrr-label">{row.label}</span>
                {row.account && <small className="mrr-account">{row.account}</small>}
              </span>
            </th>
            <td className="mrr-num">{formatCompactKzt(m.ly)}</td>
            <td className="mrr-num mrr-dim">{formatCompactKzt(m.lytd)}</td>
            <td className="mrr-num"><strong>{formatCompactKzt(m.plan)}</strong></td>
            <td className="mrr-num mrr-dim">{formatCompactKzt(m.planToDate)}</td>
            <td className="mrr-num">
              <strong>{formatCompactKzt(m.actual)}</strong>
              <small className={lytdFavorable ? 'mrr-sub good' : 'mrr-sub bad'}>
                {lytdDelta > 0 ? '+' : ''}{formatPct(lytdDelta)} к LYTD
              </small>
            </td>
            <td>
              <div className="mrr-percent"><span>{formatPct(pct(m.actual, m.plan))}</span><i><b style={{ width: `${progress}%` }} /></i></div>
            </td>
            <td className="mrr-num">{formatCompactKzt(m.remaining)}</td>
            <td className="mrr-num"><strong>{formatCompactKzt(m.forecast)}</strong></td>
          </tr>;
        })}
      </tbody>
      <tfoot>
        <tr className="mrr-table-row mrr-row-total">
          <th scope="row" className="mrr-name">Итого · {rows.length === 1 ? rows[0].label : `сеть, ${rows.length} объекта`}</th>
          <td className="mrr-num">{formatCompactKzt(total.ly)}</td>
          <td className="mrr-num">{formatCompactKzt(total.lytd)}</td>
          <td className="mrr-num"><strong>{formatCompactKzt(total.plan)}</strong></td>
          <td className="mrr-num">{formatCompactKzt(total.planToDate)}</td>
          <td className="mrr-num"><strong>{formatCompactKzt(total.actual)}</strong></td>
          <td><div className="mrr-percent"><span>{formatPct(pct(total.actual, total.plan))}</span><i><b style={{ width: `${Math.min(100, pct(total.actual, total.plan))}%` }} /></i></div></td>
          <td className="mrr-num">{formatCompactKzt(total.remaining)}</td>
          <td className="mrr-num"><strong>{formatCompactKzt(total.forecast)}</strong></td>
        </tr>
      </tfoot>
    </table>
  </div>;
}

export default function ManagementReport({ initialPropertyId = 'all' }: { initialPropertyId?: DemoPropertyId | 'all' }) {
  const [filters, setFilters] = useState<ReportFilters>({ year: 2026, month: 9, day: 18, propertyId: initialPropertyId });
  const [view, setView] = useState<'revenue' | 'expense'>('revenue');
  const [exportError, setExportError] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const model = useMemo(() => buildManagementReport(filters), [filters]);
  const update = (patch: Partial<ReportFilters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const daysInMonth = filters.month ? new Date(filters.year, filters.month, 0).getDate() : 31;
  const revenue = model.revenueTotal;
  const expense = model.expenseTotal;
  const operating = revenue.actual - expense.actual;
  const resultPlan = revenue.plan - expense.plan;
  const resultForecast = revenue.forecast - expense.forecast;
  const selectedRows = view === 'revenue' ? model.revenueRows : model.expenseRows;
  const selectedMetrics = view === 'revenue' ? revenue : expense;
  const groups = view === 'revenue' ? REVENUE_GROUPS : EXPENSE_GROUPS;
  const total = selectedMetrics.actual;
  const breakdown = groups.map((group) => {
    const children = selectedRows.map((property) => property.children?.find((row) => row.id.endsWith(`:${group.id}`))).filter((row): row is ReportRow => !!row);
    const metric = children.reduce((sum, row) => sum + row.metrics.actual, 0);
    return { ...group, metric };
  });
  const trendMax = Math.max(1, ...model.monthly.flatMap((month) => [month.plan, month.actual]));
  const periodLabel = filters.month ? `${MONTHS[filters.month - 1]} ${filters.year}` : `${filters.year} год`;
  const isFuture = model.cutoff.getTime() < model.start.getTime();
  const exportExcel = async () => {
    setExportError('');
    setIsExporting(true);
    try {
      const { downloadManagementWorkbook } = await import('../lib/management-excel');
      await downloadManagementWorkbook(model);
    } catch (error) {
      console.error('Management Excel export failed', error);
      setExportError('Не удалось создать Excel. Повторите попытку.');
    } finally {
      setIsExporting(false);
    }
  };

  return <div className="mrr">
    <header className="mrr-hero">
      <div><p className="mrr-eyebrow">GUESTRA / MANAGEMENT</p><h1>Управленческий отчёт</h1><p>Доходы, расходы и результат по каждому отелю и всей сети.</p></div>
      <div className="mrr-hero-side"><span className="mrr-demo-badge">ДЕМО · MOCK DATA</span><button type="button" onClick={() => void exportExcel()} disabled={isExporting}><Download size={16} /> {isExporting ? 'Создаём Excel…' : 'Excel · все разделы'}</button>{exportError && <small role="alert">{exportError}</small>}</div>
    </header>

    <div className="mrr-layout">
      <aside className="mrr-filters" aria-label="Фильтры отчёта">
        <div className="mrr-filter-head"><span>Период и объекты</span><small>Дата среза</small></div>
        <label>Год<select value={filters.year} onChange={(event) => update({ year: Number(event.target.value) as 2025 | 2026, day: null })}><option value={2026}>2026</option><option value={2025}>2025</option></select></label>
        <label>Месяц<select value={filters.month ?? 'all'} onChange={(event) => update({ month: event.target.value === 'all' ? null : Number(event.target.value), day: null })}><option value="all">Весь год</option>{MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></label>
        <label>День / срез<select value={filters.day ?? 'all'} disabled={!filters.month} onChange={(event) => update({ day: event.target.value === 'all' ? null : Number(event.target.value) })}><option value="all">Весь месяц</option>{Array.from({ length: daysInMonth }, (_, index) => <option key={index} value={index + 1}>{index + 1} число</option>)}</select></label>
        <div className="mrr-filter-divider" />
        <span className="mrr-filter-label">Объект</span>
        <div className="mrr-property-list"><button className={filters.propertyId === 'all' ? 'active' : ''} onClick={() => update({ propertyId: 'all' })}><Landmark size={16} /> Вся сеть <small>3 отеля</small></button>{DEMO_PROPERTIES.map((property) => <button key={property.id} className={filters.propertyId === property.id ? 'active' : ''} onClick={() => update({ propertyId: property.id })}><span className="mrr-property-dot" />{property.name}</button>)}</div>
        <div className="mrr-filter-note"><strong>Бюджет {filters.year} · v1</strong><span>Годовой план сети — {filters.year === 2026 ? '600' : '540'} млн ₸. Суммы показываются в тенге, без смешения с оплатами.</span></div>
      </aside>

      <main className="mrr-main">
        <div className="mrr-section-head"><div><p className="mrr-eyebrow">{periodLabel} · на {dateLabel(model.cutoff)}</p><h2>Финансовая картина</h2></div><span className="mrr-source"><Info size={15} /> Демо-модель по дате услуги и начисления</span></div>
        <div className="mrr-tabs" role="tablist" aria-label="Раздел отчёта"><button role="tab" aria-selected={view === 'revenue'} className={view === 'revenue' ? 'active' : ''} onClick={() => setView('revenue')}>Доходы</button><button role="tab" aria-selected={view === 'expense'} className={view === 'expense' ? 'active' : ''} onClick={() => setView('expense')}>Расходы и результат</button></div>

        {view === 'revenue' ? <>
          <div className="mrr-metrics">
            <MetricCard emphasis label="Факт к дате" value={formatCompactKzt(revenue.actual)} sub={isFuture ? 'Период ещё не начался' : `${signedPct(revenue.actual, revenue.lytd) > 0 ? '+' : ''}${formatPct(signedPct(revenue.actual, revenue.lytd))} к LYTD`} />
            <MetricCard label="План периода" value={formatCompactKzt(revenue.plan)} sub={`К дате ${formatCompactKzt(revenue.planToDate)}`} />
            <MetricCard label="Выполнение" value={formatPct(pct(revenue.actual, revenue.plan))} sub={`Осталось ${formatCompactKzt(revenue.remaining)}`} />
            <MetricCard label="Прогноз" value={formatCompactKzt(revenue.forecast)} sub={`${formatPct(pct(revenue.forecast, revenue.plan))} плана`} />
          </div>
          <div className="mrr-insight"><span className="mrr-insight-icon"><Wallet size={20} /></span><div><strong>Темп для выполнения плана</strong><p>{model.remainingDays ? `Нужно в среднем ${formatKzt(revenue.requiredPerDay)} в день до конца периода.` : 'Период завершён — сравните факт с планом.'} Факт прошлого года за весь период: {formatCompactKzt(revenue.ly)}.</p></div></div>
        </> : <>
          <div className="mrr-metrics">
            <MetricCard emphasis label="Доходы" value={formatCompactKzt(revenue.actual)} sub={`План ${formatCompactKzt(revenue.plan)}`} />
            <MetricCard label="Расходы" value={formatCompactKzt(expense.actual)} sub={`${formatPct(pct(expense.actual, revenue.actual))} от выручки`} />
            <MetricCard label="Результат до налога" value={formatCompactKzt(operating)} sub={`План ${formatCompactKzt(resultPlan)}`} />
            <MetricCard label="Прогноз результата" value={formatCompactKzt(resultForecast)} sub={`Маржа ${formatPct(pct(resultForecast, revenue.forecast))}`} />
          </div>
          <div className="mrr-insight"><span className="mrr-insight-icon"><Info size={20} /></span><div><strong>Как собран результат</strong><p>Выручка − себестоимость − продажи − административные − финансирование. НДС и налог на прибыль в демо-P&L не рассчитаны; сопоставление с 1С требует настроить статьи и метод распределения.</p></div></div>
        </>}

        <div className="mrr-visual-grid">
          <section className="mrr-card"><div className="mrr-card-head"><div><h3>{view === 'revenue' ? 'Структура выручки' : 'Структура расходов'}</h3><p>Доля направлений в факте к дате</p></div><strong>{formatCompactKzt(total)}</strong></div><div className="mrr-breakdown">{breakdown.map((group, index) => <div key={group.id} className="mrr-breakdown-row"><div><span className={`mrr-swatch swatch-${index}`} /><strong>{group.label}</strong><small>{formatPct(pct(group.metric, total))}</small></div><div className="mrr-track"><span className={`fill-${index}`} style={{ width: `${pct(group.metric, total)}%` }} /></div><b>{formatCompactKzt(group.metric)}</b></div>)}</div></section>
          <section className="mrr-card"><div className="mrr-card-head"><div><h3>Динамика выручки</h3><p>Помесячно · план и факт выбранных объектов</p></div><span className="mrr-chart-legend"><i /> План <i /> Факт</span></div><div className="mrr-chart">{model.monthly.map((month) => <div className="mrr-chart-month" key={month.month}><div className="mrr-chart-bars"><span className="plan" style={{ height: `${Math.max(3, pct(month.plan, trendMax))}%` }} title={`План: ${formatKzt(month.plan)}`} /><span className="actual" style={{ height: `${month.available ? Math.max(3, pct(month.actual, trendMax)) : 0}%` }} title={`Факт: ${formatKzt(month.actual)}`} /></div><small>{SHORT_MONTHS[month.month - 1]}</small></div>)}</div></section>
        </div>

        <section className="mrr-card mrr-detail"><div className="mrr-card-head"><div><h3>{view === 'revenue' ? 'Доходы по объектам и направлениям' : 'Расходы по объектам и статьям'}</h3><p>Раскройте отель и направление для деталей. «LY к дате» — аналогичный прошедший период прошлого года, «к LYTD» под фактом — отклонение от него.</p></div><span className="mrr-count">{selectedRows.length} {selectedRows.length === 1 ? 'объект' : 'объекта'}</span></div><HierarchyTable rows={selectedRows} kind={view} /><p className="mrr-table-hint">Таблица прокручивается по горизонтали, первый столбец закреплён.</p></section>
        {view === 'expense' && <p className="mrr-footnote">* Счета 7010, 7110, 7210, 7310 показаны как пример укрупнённого соответствия 1С Казахстана. Использованные бонусы требуют отдельной сверки с учётной политикой. Данные полностью демонстрационные.</p>}
        {view === 'revenue' && <p className="mrr-footnote">Cashback не включён в доходы. Начисленные бонусы относятся к обязательствам программы лояльности; использованные показаны в расходной модели отдельно.</p>}
      </main>
    </div>
  </div>;
}
