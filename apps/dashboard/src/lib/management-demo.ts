/** Deterministic presentation ledger. No API or database writes. Amounts are KZT. */
export type DemoPropertyId = 'les_borovoe' | 'les_astana' | 'les_alakol';
export type ReportKind = 'revenue' | 'expense';
export type ReportFilters = { year: 2025 | 2026; month: number | null; day: number | null; propertyId: DemoPropertyId | 'all' };
export type Metrics = { plan: number; planToDate: number; actual: number; ly: number; lytd: number; forecast: number; remaining: number; requiredPerDay: number };
export type ReportRow = { id: string; label: string; kind: ReportKind; depth: number; account?: string; metrics: Metrics; children?: ReportRow[] };

export const DEMO_AS_OF = new Date(2026, 8, 18);
export const DEMO_PROPERTIES: { id: DemoPropertyId; name: string; shortName: string }[] = [
  { id: 'les_borovoe', name: 'ЛЕС Боровое', shortName: 'Боровое' },
  { id: 'les_astana', name: 'ЛЕС Астана', shortName: 'Астана' },
  { id: 'les_alakol', name: 'ЛЕС Алаколь', shortName: 'Алаколь' },
];

type DemoLine = { id: string; label: string; group: string; annual: number; shares: [number, number, number]; season: 'leisure' | 'city' | 'steady' | 'banquet'; account?: string; actualFactor?: number };
const million = (value: number) => value * 1_000_000;

export const REVENUE_GROUPS = [
  { id: 'accommodation', label: 'Проживание', note: 'Номера, пакеты и дополнительные места' },
  { id: 'fnb', label: 'F&B', note: 'Рестораны, банкеты и бары' },
  { id: 'other', label: 'Прочие доходы', note: 'SPA, баня, активности и сервисы' },
];
export const EXPENSE_GROUPS = [
  { id: 'direct', label: 'Себестоимость услуг', note: 'Операционные затраты', account: '7010' },
  { id: 'selling', label: 'Продажи и маркетинг', note: 'Привлечение и удержание гостей', account: '7110' },
  { id: 'administrative', label: 'Административные', note: 'Управление и инфраструктура', account: '7210' },
  { id: 'finance', label: 'Финансирование', note: 'Проценты по займам', account: '7310' },
];

const revenue: DemoLine[] = [
  { id: 'rooms', label: 'Номерной фонд', group: 'accommodation', annual: million(305), shares: [55, 35, 10], season: 'leisure', actualFactor: 0.98 },
  { id: 'packages', label: 'Пакеты и доп. места', group: 'accommodation', annual: million(25), shares: [62, 25, 13], season: 'leisure', actualFactor: 1.03 },
  { id: 'restaurant', label: 'Рестораны', group: 'fnb', annual: million(85), shares: [55, 35, 10], season: 'leisure', actualFactor: 1.04 },
  { id: 'banquets', label: 'Банкеты и мероприятия', group: 'fnb', annual: million(50), shares: [50, 45, 5], season: 'banquet', actualFactor: 1.08 },
  { id: 'bar', label: 'Бары', group: 'fnb', annual: million(22), shares: [55, 40, 5], season: 'leisure', actualFactor: 0.99 },
  { id: 'room_service', label: 'Room service', group: 'fnb', annual: million(12), shares: [55, 40, 5], season: 'steady', actualFactor: 1.01 },
  { id: 'minibar', label: 'Минибар', group: 'fnb', annual: million(6), shares: [55, 35, 10], season: 'steady', actualFactor: 0.96 },
  { id: 'hookah', label: 'Кальян', group: 'fnb', annual: million(5), shares: [60, 35, 5], season: 'leisure', actualFactor: 0.94 },
  { id: 'spa', label: 'SPA и процедуры', group: 'other', annual: million(28), shares: [70, 20, 10], season: 'leisure', actualFactor: 1.06 },
  { id: 'bath', label: 'Баня и сауна', group: 'other', annual: million(20), shares: [70, 10, 20], season: 'leisure', actualFactor: 1.02 },
  { id: 'equipment', label: 'Аренда инвентаря', group: 'other', annual: million(12), shares: [60, 10, 30], season: 'leisure', actualFactor: 0.96 },
  { id: 'transfer', label: 'Трансферы', group: 'other', annual: million(9), shares: [50, 40, 10], season: 'steady', actualFactor: 1.01 },
  { id: 'activities', label: 'Активности', group: 'other', annual: million(10), shares: [60, 10, 30], season: 'leisure', actualFactor: 1.04 },
  { id: 'parking', label: 'Парковка', group: 'other', annual: million(5), shares: [40, 55, 5], season: 'city', actualFactor: 0.98 },
  { id: 'laundry', label: 'Прачечная и прочее', group: 'other', annual: million(6), shares: [60, 35, 5], season: 'steady', actualFactor: 0.97 },
];

const expense: DemoLine[] = [
  { id: 'ops_payroll', label: 'ФОТ службы размещения и сервиса', group: 'direct', annual: million(126), shares: [55, 35, 10], season: 'steady', account: '7010', actualFactor: 1.02 },
  { id: 'food_cost', label: 'Продукты и напитки', group: 'direct', annual: million(61), shares: [55, 36, 9], season: 'leisure', account: '7010', actualFactor: 1.06 },
  { id: 'utilities', label: 'Коммунальные услуги', group: 'direct', annual: million(34), shares: [53, 39, 8], season: 'steady', account: '7010', actualFactor: 1.08 },
  { id: 'housekeeping', label: 'Бельё, химия, уборка', group: 'direct', annual: million(17), shares: [56, 35, 9], season: 'leisure', account: '7010', actualFactor: 0.98 },
  { id: 'maintenance', label: 'Ремонт и обслуживание', group: 'direct', annual: million(21), shares: [57, 34, 9], season: 'steady', account: '7010', actualFactor: 1.03 },
  { id: 'depreciation', label: 'Амортизация ОС', group: 'direct', annual: million(14), shares: [55, 37, 8], season: 'steady', account: '7010', actualFactor: 1 },
  { id: 'amenities', label: 'Гостевые принадлежности', group: 'direct', annual: million(9), shares: [58, 32, 10], season: 'leisure', account: '7010', actualFactor: 1.01 },
  { id: 'ota', label: 'Комиссии OTA и эквайринг', group: 'selling', annual: million(29), shares: [55, 37, 8], season: 'leisure', account: '7110', actualFactor: 1.04 },
  { id: 'marketing', label: 'Маркетинг и продвижение', group: 'selling', annual: million(20), shares: [50, 40, 10], season: 'steady', account: '7110', actualFactor: 0.95 },
  { id: 'loyalty', label: 'Использованные бонусы', group: 'selling', annual: million(6), shares: [60, 32, 8], season: 'leisure', account: '7110*', actualFactor: 1.08 },
  { id: 'admin_payroll', label: 'ФОТ администрации', group: 'administrative', annual: million(34), shares: [49, 43, 8], season: 'steady', account: '7210', actualFactor: 1.01 },
  { id: 'it_security', label: 'IT, связь и охрана', group: 'administrative', annual: million(22), shares: [47, 45, 8], season: 'steady', account: '7210', actualFactor: 1.02 },
  { id: 'rent_insurance', label: 'Аренда, страхование, офис', group: 'administrative', annual: million(17), shares: [44, 48, 8], season: 'steady', account: '7210', actualFactor: 1.03 },
  { id: 'interest', label: 'Проценты по займам', group: 'finance', annual: million(10), shares: [55, 38, 7], season: 'steady', account: '7310', actualFactor: 1.01 },
];

const seasonality: Record<DemoLine['season'], number[]> = {
  leisure: [6, 6, 7, 8, 8, 10, 13, 13, 10, 7, 6, 6],
  city: [8, 8, 9, 9, 9, 8, 7, 7, 9, 9, 9, 8],
  steady: [8, 8, 8, 8, 8, 8, 9, 9, 9, 9, 8, 8],
  banquet: [5, 6, 8, 9, 10, 11, 10, 9, 10, 10, 7, 5],
};

function allocate(total: number, weights: number[]): number[] {
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  let assigned = 0;
  return weights.map((weight, index) => {
    const value = index === weights.length - 1 ? total - assigned : Math.floor(total * weight / denominator);
    assigned += value;
    return value;
  });
}

const empty = (): Metrics => ({ plan: 0, planToDate: 0, actual: 0, ly: 0, lytd: 0, forecast: 0, remaining: 0, requiredPerDay: 0 });
function aggregate(metrics: Metrics[]): Metrics {
  const result = empty();
  for (const metric of metrics) for (const key of Object.keys(result) as (keyof Metrics)[]) result[key] += metric[key];
  return result;
}
const dateNumber = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const dayCount = (start: Date, end: Date) => Math.max(0, Math.round((dateNumber(end) - dateNumber(start)) / 86_400_000) + 1);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function annualFor(line: DemoLine, propertyIndex: number, year: number, mode: 'plan' | 'actual'): number {
  const share = allocate(line.annual, line.shares)[propertyIndex];
  const factor = mode === 'plan' ? (year === 2025 ? 0.9 : 1) : year === 2024 ? 0.84 : year === 2025 ? 0.92 : (line.actualFactor ?? 1);
  return Math.round(share * factor);
}

function between(line: DemoLine, propertyIndex: number, year: number, mode: 'plan' | 'actual', start: Date, end: Date): number {
  if (dateNumber(end) < dateNumber(start)) return 0;
  const months = allocate(annualFor(line, propertyIndex, year, mode), seasonality[line.season]);
  let total = 0;
  for (let month = 0; month < 12; month++) {
    const days = new Date(year, month + 1, 0).getDate();
    const first = Math.max(1, month === start.getMonth() ? start.getDate() : month < start.getMonth() ? days + 1 : 1);
    const last = Math.min(days, month === end.getMonth() ? end.getDate() : month > end.getMonth() ? 0 : days);
    if (first > last) continue;
    const weights = Array.from({ length: days }, (_, index) => {
      const weekday = new Date(year, month, index + 1).getDay();
      return mode === 'actual' && line.season !== 'steady' && (weekday === 0 || weekday === 6) ? 135 : 100;
    });
    const daily = allocate(months[month], weights);
    for (let day = first; day <= last; day++) total += daily[day - 1];
  }
  return total;
}

function period(filters: ReportFilters) {
  const { year, month, day } = filters;
  const start = new Date(year, month ? month - 1 : 0, 1);
  const end = month ? new Date(year, month, 0) : new Date(year, 11, 31);
  const selected = day && month ? new Date(year, month - 1, clamp(day, 1, end.getDate())) : end;
  const cutoff = new Date(Math.min(dateNumber(selected), dateNumber(DEMO_AS_OF)));
  const elapsed = dateNumber(cutoff) < dateNumber(start) ? 0 : dayCount(start, cutoff);
  const remainingDays = dateNumber(cutoff) < dateNumber(start) ? dayCount(start, end) : Math.max(0, dayCount(start, end) - elapsed);
  return { start, end, cutoff, elapsed, remainingDays };
}

function lineMetrics(line: DemoLine, propertyIndex: number, filters: ReportFilters): Metrics {
  const { year } = filters;
  const { start, end, cutoff, remainingDays } = period(filters);
  const priorStart = new Date(year - 1, start.getMonth(), start.getDate());
  const priorEnd = new Date(year - 1, end.getMonth() + 1, 0);
  const priorCutoff = new Date(year - 1, cutoff.getMonth(), cutoff.getDate());
  const plan = between(line, propertyIndex, year, 'plan', start, end);
  const planToDate = dateNumber(cutoff) < dateNumber(start) ? 0 : between(line, propertyIndex, year, 'plan', start, cutoff);
  const actual = dateNumber(cutoff) < dateNumber(start) ? 0 : between(line, propertyIndex, year, 'actual', start, cutoff);
  const ly = between(line, propertyIndex, year - 1, 'actual', priorStart, priorEnd);
  const lytd = dateNumber(cutoff) < dateNumber(start) ? 0 : between(line, propertyIndex, year - 1, 'actual', priorStart, priorCutoff);
  const pace = planToDate > 0 ? clamp(actual / planToDate, 0.75, 1.25) : 1;
  const forecast = remainingDays === 0 ? actual : Math.round(actual + (plan - planToDate) * pace);
  return { plan, planToDate, actual, ly, lytd, forecast, remaining: Math.max(0, plan - actual), requiredPerDay: remainingDays ? Math.ceil(Math.max(0, plan - actual) / remainingDays) : 0 };
}

function rowsFor(kind: ReportKind, filters: ReportFilters): ReportRow[] {
  const definitions = kind === 'revenue' ? revenue : expense;
  const groups = kind === 'revenue' ? REVENUE_GROUPS : EXPENSE_GROUPS;
  const propertyList = filters.propertyId === 'all' ? DEMO_PROPERTIES : DEMO_PROPERTIES.filter((p) => p.id === filters.propertyId);
  return propertyList.map((property) => {
    const propertyIndex = DEMO_PROPERTIES.findIndex((item) => item.id === property.id);
    const children: ReportRow[] = groups.map((group) => {
      const leaves: ReportRow[] = definitions.filter((line) => line.group === group.id).map((line) => ({
        id: `${property.id}:${line.id}`, label: line.label, kind, depth: 2, account: line.account,
        metrics: lineMetrics(line, propertyIndex, filters),
      }));
      return { id: `${property.id}:${group.id}`, label: group.label, kind, depth: 1, account: ('account' in group ? group.account : undefined) as string | undefined, metrics: aggregate(leaves.map((leaf) => leaf.metrics)), children: leaves };
    });
    return { id: property.id, label: property.name, kind, depth: 0, metrics: aggregate(children.map((group) => group.metrics)), children };
  });
}

export function buildManagementReport(filters: ReportFilters) {
  const revenueRows = rowsFor('revenue', filters);
  const expenseRows = rowsFor('expense', filters);
  const revenueTotal = aggregate(revenueRows.map((row) => row.metrics));
  const expenseTotal = aggregate(expenseRows.map((row) => row.metrics));
  const { start, end, cutoff, remainingDays } = period(filters);
  const monthly = Array.from({ length: 12 }, (_, index) => {
    const data = rowsFor('revenue', { ...filters, month: index + 1, day: null });
    const metrics = aggregate(data.map((row) => row.metrics));
    return { month: index + 1, plan: metrics.plan, actual: metrics.actual, available: dateNumber(new Date(filters.year, index, 1)) <= dateNumber(DEMO_AS_OF) };
  });
  return { filters, start, end, cutoff, remainingDays, revenueRows, expenseRows, revenueTotal, expenseTotal, monthly };
}

export const formatKzt = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value))} ₸`;
export const formatCompactKzt = (value: number) => value === 0 ? '0 ₸' : Math.abs(value) < 1_000_000
  ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value / 1_000)} тыс ₸`
  : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1_000_000)} млн ₸`;
export const formatPct = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)}%`;
