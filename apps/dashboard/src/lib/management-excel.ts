import ExcelJS from 'exceljs';
import { DEMO_AS_OF, type buildManagementReport, type Metrics, type ReportRow } from './management-demo';

export type ManagementModel = ReturnType<typeof buildManagementReport>;
type CellValue = string | number;
type Column = { label: string; width: number; currency?: boolean; percent?: boolean };

const navy = '173B3B';
const teal = '0D766E';
const pale = 'E8F3EF';
const hotelFill = 'EAF3EE';
const totalFill = 'F5F1E3';
const moneyFormat = '#,##0 "₸";[Red]-#,##0 "₸"';
const percentFormat = '0.0"%"';

function sheetHeader(ws: ExcelJS.Workbook, name: string, title: string, note: string, columns: Column[], freeze: { xSplit?: number; ySplit?: number }) {
  const worksheet = ws.addWorksheet(name, { views: [{ state: 'frozen', ...freeze }] });
  worksheet.mergeCells(1, 1, 1, columns.length);
  worksheet.getCell(1, 1).value = title;
  worksheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
  worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  worksheet.getCell(1, 1).alignment = { vertical: 'middle', indent: 1 };
  worksheet.getRow(1).height = 34;
  worksheet.mergeCells(2, 1, 2, columns.length);
  worksheet.getCell(2, 1).value = note;
  worksheet.getCell(2, 1).font = { italic: true, color: { argb: '526865' }, size: 10 };
  worksheet.getRow(2).height = 28;
  columns.forEach((column, index) => {
    worksheet.getColumn(index + 1).width = column.width;
    const cell = worksheet.getCell(4, index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: teal } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  worksheet.getRow(4).height = 31;
  return worksheet;
}

function sheet(workbook: ExcelJS.Workbook, name: string, title: string, note: string, columns: Column[], rows: CellValue[][]) {
  const ws = sheetHeader(workbook, name, title, note, columns, { ySplit: 4 });
  rows.forEach((values, index) => {
    const row = ws.getRow(index + 5);
    values.forEach((value, columnIndex) => {
      const cell = row.getCell(columnIndex + 1);
      cell.value = typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
      const definition = columns[columnIndex];
      if (typeof value === 'number') {
        if (definition?.currency) cell.numFmt = moneyFormat;
        if (definition?.percent) cell.numFmt = percentFormat;
      }
      if (index % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pale } };
    });
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, rows.length + 4), column: columns.length } };
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape' };
  return ws;
}

const money = (label: string, width = 18): Column => ({ label, width, currency: true });
const percent = (label: string, width = 15): Column => ({ label, width, percent: true });
const ratio = (top: number, bottom: number) => bottom ? top / bottom * 100 : 0;
const delta = (actual: number, prior: number) => prior ? (actual / prior - 1) * 100 : 0;

type DetailLevel = 0 | 1 | 2 | 'network';
interface DetailRow {
  property: string;
  group: string;
  article: string;
  account: string;
  level: DetailLevel;
  metrics: Metrics;
}

/**
 * Плоский список строк «отель → направление → статья» с повторёнными
 * значениями Объект/Направление: так лист читается как таблица с экрана
 * (жирные строки отеля, вложенные направления и статьи) и одновременно
 * корректно работает автофильтр по любому столбцу.
 */
function detailRows(rows: ReportRow[], networkTotal: Metrics): DetailRow[] {
  const result: DetailRow[] = [];
  if (rows.length > 1) {
    result.push({ property: 'Вся сеть', group: 'ИТОГО ПО СЕТИ', article: 'ИТОГО ПО СЕТИ', account: '', level: 'network', metrics: networkTotal });
  }
  const visit = (row: ReportRow, property: string, group: string) => {
    const currentProperty = row.depth === 0 ? row.label : property;
    const currentGroup = row.depth === 1 ? row.label : group;
    if (row.depth === 0) {
      result.push({ property: row.label, group: 'Итого по объекту', article: 'Итого по объекту', account: '', level: 0, metrics: row.metrics });
    } else if (row.depth === 1) {
      result.push({ property: currentProperty, group: row.label, article: 'Итого по направлению', account: row.account ?? '', level: 1, metrics: row.metrics });
    } else {
      result.push({ property: currentProperty, group: currentGroup, article: row.label, account: row.account ?? '', level: 2, metrics: row.metrics });
    }
    row.children?.forEach((child) => visit(child, currentProperty, currentGroup));
  };
  rows.forEach((row) => visit(row, '', ''));
  return result;
}

function metricValues(m: Metrics): CellValue[] {
  return [m.ly, m.lytd, m.plan, m.planToDate, m.actual, ratio(m.actual, m.plan), delta(m.actual, m.lytd), m.remaining, m.forecast];
}

/**
 * Лист «Доходы»/«Расходы»: иерархическая таблица как на экране.
 * Уровни выделены заливкой и жирным, статьи сворачиваются штатной
 * группировкой Excel (outline), первые четыре столбца и шапка закреплены.
 */
function hierarchySheet(workbook: ExcelJS.Workbook, name: string, title: string, note: string, rows: ReportRow[], networkTotal: Metrics) {
  const columns: Column[] = [
    { label: 'Объект', width: 20 }, { label: 'Направление', width: 26 }, { label: 'Статья', width: 36 }, { label: 'Счёт 1С*', width: 12 },
    money('LY факт'), money('LY к дате'), money('План'), money('План к дате'), money('Факт'),
    percent('Выполнение плана, %'), percent('Δ LYTD, %'), money('Остаток'), money('Прогноз'),
  ];
  const ws = sheetHeader(workbook, name, title, note, columns, { xSplit: 4, ySplit: 4 });
  // Уровень листа выше максимального уровня строк: иначе ExcelJS помечает
  // сгруппированные строки атрибутом collapsed и они открываются «свёрнутыми».
  ws.properties.outlineLevelRow = 3;
  const data = detailRows(rows, networkTotal);
  data.forEach((detail, index) => {
    const excelRow = ws.getRow(index + 5);
    excelRow.outlineLevel = typeof detail.level === 'number' ? detail.level : 0;
    const values: CellValue[] = [detail.property, detail.group, detail.article, detail.account, ...metricValues(detail.metrics)];
    values.forEach((value, columnIndex) => {
      const cell = excelRow.getCell(columnIndex + 1);
      cell.value = typeof value === 'string' && /^[=+\-@]/.test(value) ? `'${value}` : value;
      const definition = columns[columnIndex];
      if (typeof value === 'number') {
        if (definition?.currency) cell.numFmt = moneyFormat;
        if (definition?.percent) cell.numFmt = percentFormat;
      }
      if (columnIndex >= 4) cell.alignment = { horizontal: 'right' };
      if (detail.level === 'network') {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: totalFill } };
        cell.border = { top: { style: 'medium', color: { argb: 'C9C2A4' } } };
      } else if (detail.level === 0) {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hotelFill } };
      } else if (detail.level === 1) {
        cell.font = { bold: true };
      } else if (columnIndex === 2) {
        cell.alignment = { horizontal: 'right', indent: 1 };
      }
    });
  });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: data.length + 4, column: columns.length } };
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'landscape' };
  return ws;
}

function metricRow(name: string, metric: Metrics): CellValue[] {
  return [name, metric.ly, metric.lytd, metric.plan, metric.planToDate, metric.actual, ratio(metric.actual, metric.plan), metric.remaining, metric.forecast];
}

export function buildManagementWorkbook(model: ManagementModel): ExcelJS.Workbook {
  const { filters, revenueTotal: revenue, expenseTotal: expense } = model;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Guestra Management Demo';
  workbook.created = DEMO_AS_OF;
  const period = filters.month ? `${String(filters.month).padStart(2, '0')}.${filters.year}` : String(filters.year);
  const selected = filters.propertyId === 'all' ? 'Вся сеть (3 отеля)' : model.revenueRows[0]?.label ?? 'Отель';
  const note = `Период: ${period}${filters.day ? `, срез на ${filters.day} число` : ''} · Объект: ${selected} · Суммы в тенге (KZT) · ДЕМО: моделируемые суммы`;

  sheet(workbook, 'Сводка', 'Управленческая картина', note, [
    { label: 'Показатель', width: 30 }, money('LY факт'), money('LY к дате'), money('План'), money('План к дате'), money('Факт'), percent('План, %'), money('Остаток'), money('Прогноз'),
  ], [
    metricRow('Выручка', revenue), metricRow('Расходы', expense),
    ['Результат до налога', revenue.ly - expense.ly, revenue.lytd - expense.lytd, revenue.plan - expense.plan,
      revenue.planToDate - expense.planToDate, revenue.actual - expense.actual,
      ratio(revenue.actual - expense.actual, revenue.plan - expense.plan),
      Math.max(0, revenue.plan - expense.plan - (revenue.actual - expense.actual)), revenue.forecast - expense.forecast],
  ]);

  hierarchySheet(workbook, 'Доходы', 'Доходы по отелям и направлениям', note, model.revenueRows, revenue);
  hierarchySheet(workbook, 'Расходы', 'Расходы по отелям и статьям', note, model.expenseRows, expense);

  const expenseById = new Map(model.expenseRows.map((row) => [row.id, row]));
  sheet(workbook, 'Объекты', 'Сравнение отелей', note, [
    { label: 'Отель', width: 26 }, money('План доходов'), money('Факт доходов'), money('План расходов'),
    money('Факт расходов'), money('Факт результата'), percent('Маржа, %'),
  ], model.revenueRows.map((row) => {
    const cost = expenseById.get(row.id)?.metrics;
    const actualCost = cost?.actual ?? 0;
    return [row.label, row.metrics.plan, row.metrics.actual, cost?.plan ?? 0, actualCost,
      row.metrics.actual - actualCost, ratio(row.metrics.actual - actualCost, row.metrics.actual)];
  }));

  sheet(workbook, 'Динамика', 'Помесячная выручка', `${selected} · ${filters.year} · будущие месяцы не содержат факта`, [
    { label: 'Месяц', width: 20 }, money('План'), money('Факт'), money('Отклонение'), percent('Выполнение, %'),
  ], model.monthly.map((month) => [
    new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(new Date(filters.year, month.month - 1, 1)),
    month.plan, month.actual, month.actual - month.plan, ratio(month.actual, month.plan),
  ]));

  sheet(workbook, 'Методика', 'Методика и границы данных', 'Показатели демонстрационные; для 1С потребуется согласованная учётная политика.', [
    { label: 'Показатель', width: 34 }, { label: 'Расчёт / назначение', width: 100 },
  ], [
    ['Факт', 'Моделируемые начисления на дату оказания услуги. Оплаты и брони не считаются выручкой.'],
    ['LY к дате', 'Аналогичный прошедший отрезок прошлого года.'],
    ['План к дате', 'Часть плана периода по сезонному и дневному распределению.'],
    ['Остаток', 'Максимум из нуля и разницы полного плана периода и факта.'],
    ['Прогноз', 'Факт к дате плюс ожидаемая часть будущих дней периода.'],
    ['Результат до налога', 'Выручка минус все показанные расходы; НДС и налог на прибыль не рассчитаны.'],
    ['Счета 1С*', 'Пример соответствия: 7010 себестоимость, 7110 продажи, 7210 администрация, 7310 финансовые расходы.'],
    ['Cashback', 'Начисление не включено в доходы; использованные бонусы показаны отдельно в модельных расходах.'],
  ]);
  return workbook;
}

export async function downloadManagementWorkbook(model: ManagementModel): Promise<void> {
  const workbook = buildManagementWorkbook(model);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `guestra-management-${model.filters.year}${model.filters.month ? `-${String(model.filters.month).padStart(2, '0')}` : ''}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
