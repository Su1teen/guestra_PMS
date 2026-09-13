import ExcelJS from 'exceljs';

type ReportValue = string | number | boolean | null | undefined;

export interface DownloadReportWorkbookOptions {
  title: string;
  reportType: string;
  propertyName: string;
  currencyCode: string;
  parameters: Record<string, string>;
  data: unknown;
  generatedAt?: Date;
}

interface TableSection {
  name: string;
  rows: Record<string, unknown>[];
}

const COLORS = {
  navy: '0B1F3A',
  teal: '06BDB4',
  paleTeal: 'E8F8F7',
  paleBlue: 'EEF4F8',
  white: 'FFFFFF',
  slate: '425466',
  muted: '6B7280',
  border: 'DCE4EA',
  negative: 'B42318',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeCellValue(value: unknown): ReportValue {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // Prevent exported API data from being interpreted as an Excel formula.
    return /^[=+\-@]/.test(value) ? `'${value}` : value;
  }
  return JSON.stringify(value);
}

function flattenRecord(
  value: Record<string, unknown>,
  prefix = '',
  result: Record<string, ReportValue> = {},
): Record<string, ReportValue> {
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(nested)) {
      flattenRecord(nested, path, result);
    } else if (!Array.isArray(nested)) {
      result[path] = safeCellValue(nested);
    }
  }
  return result;
}

function collectTableSections(value: unknown, prefix = 'Details'): TableSection[] {
  if (!isRecord(value)) return [];

  const sections: TableSection[] = [];
  for (const [key, nested] of Object.entries(value)) {
    const name = prefix === 'Details' ? humanize(key) : `${prefix} - ${humanize(key)}`;
    if (Array.isArray(nested) && nested.length > 0) {
      const rows = nested.map((row) => (isRecord(row) ? row : { value: row }));
      sections.push({ name, rows });
    } else if (isRecord(nested)) {
      sections.push(...collectTableSections(nested, name));
    }
  }
  return sections;
}

function uniqueSheetName(workbook: ExcelJS.Workbook, proposed: string): string {
  const base = proposed.replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31) || 'Data';
  let candidate = base;
  let suffix = 2;
  while (workbook.getWorksheet(candidate)) {
    const marker = ` ${suffix++}`;
    candidate = `${base.slice(0, 31 - marker.length)}${marker}`;
  }
  return candidate;
}

function currencyNumberFormat(currencyCode: string): string {
  const suffix = currencyCode.toUpperCase() === 'KZT' ? '₸' : currencyCode.toUpperCase();
  return `#,##0.00 "${suffix}";[Red]-#,##0.00 "${suffix}"`;
}

function numberFormatForKey(key: string, currencyCode: string): string | undefined {
  const normalized = key.toLowerCase();
  if (/occupancy|percent|percentage|ratio/.test(normalized)) return '0.00';
  if (/amount|revenue|adr|revpar|price|rate|deposit|payment|balance|forecast|total|tax|fee/.test(normalized)) {
    return currencyNumberFormat(currencyCode);
  }
  return undefined;
}

function styleSheetHeader(worksheet: ExcelJS.Worksheet, lastColumn: number): void {
  worksheet.mergeCells(1, 1, 1, Math.max(lastColumn, 2));
  const title = worksheet.getCell('A1');
  title.font = { bold: true, color: { argb: COLORS.white }, size: 16 };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.navy } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  worksheet.getRow(1).height = 32;
}

function addTableSheet(
  workbook: ExcelJS.Workbook,
  section: TableSection,
  currencyCode: string,
): void {
  const flattenedRows = section.rows.map((row) => flattenRecord(row));
  const columns = [...new Set(flattenedRows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) return;

  const worksheet = workbook.addWorksheet(uniqueSheetName(workbook, section.name), {
    views: [{ state: 'frozen', ySplit: 3 }],
    properties: { defaultRowHeight: 19 },
  });
  worksheet.getCell('A1').value = section.name;
  styleSheetHeader(worksheet, columns.length);

  const headerRow = worksheet.getRow(3);
  columns.forEach((key, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = humanize(key);
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.teal } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: COLORS.navy } } };
  });
  headerRow.height = 28;

  flattenedRows.forEach((row, rowIndex) => {
    const excelRow = worksheet.addRow(columns.map((key) => row[key] ?? ''));
    excelRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const key = columns[columnNumber - 1] ?? '';
      const numberFormat = numberFormatForKey(key, currencyCode);
      if (numberFormat && typeof cell.value === 'number') cell.numFmt = numberFormat;
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: { argb: COLORS.border } } };
      if (rowIndex % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleBlue } };
      }
      if (typeof cell.value === 'number' && cell.value < 0) {
        cell.font = { color: { argb: COLORS.negative } };
      }
    });
  });

  worksheet.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3, column: columns.length },
  };

  columns.forEach((key, index) => {
    const values = flattenedRows.map((row) => String(row[key] ?? ''));
    const contentWidth = Math.max(humanize(key).length, ...values.map((value) => value.length));
    worksheet.getColumn(index + 1).width = Math.min(Math.max(contentWidth + 2, 12), 42);
  });
}

function createSummarySheet(
  workbook: ExcelJS.Workbook,
  options: DownloadReportWorkbookOptions,
): void {
  const worksheet = workbook.addWorksheet('Summary', {
    views: [{ state: 'frozen', ySplit: 7 }],
    properties: { defaultRowHeight: 20 },
  });
  worksheet.getCell('A1').value = options.title;
  styleSheetHeader(worksheet, 4);

  const generatedAt = options.generatedAt ?? new Date();
  const metadata: [string, ReportValue][] = [
    ['Property', options.propertyName],
    ['Report type', humanize(options.reportType)],
    ['Currency', options.currencyCode.toUpperCase()],
    ['Generated at', generatedAt.toLocaleString()],
    ...Object.entries(options.parameters).map(([key, value]) => [humanize(key), value] as [string, string]),
  ];

  metadata.forEach(([label, value], index) => {
    const row = worksheet.getRow(index + 3);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true, color: { argb: COLORS.slate } };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleTeal } };
    row.getCell(2).value = value;
  });

  const flattened = isRecord(options.data) ? flattenRecord(options.data) : { value: safeCellValue(options.data) };
  const startRow = metadata.length + 5;
  const sectionHeader = worksheet.getRow(startRow);
  sectionHeader.getCell(1).value = 'Metric';
  sectionHeader.getCell(2).value = 'Value';
  sectionHeader.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: COLORS.white } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.teal } };
  });

  Object.entries(flattened).forEach(([key, value], index) => {
    const row = worksheet.getRow(startRow + index + 1);
    row.getCell(1).value = humanize(key);
    row.getCell(2).value = value;
    if (typeof value === 'number') {
      const numberFormat = numberFormatForKey(key, options.currencyCode);
      if (numberFormat) row.getCell(2).numFmt = numberFormat;
      if (value < 0) row.getCell(2).font = { color: { argb: COLORS.negative } };
    }
    if (index % 2 === 1) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.paleBlue } };
      });
    }
  });

  worksheet.getColumn(1).width = 34;
  worksheet.getColumn(2).width = 28;
  worksheet.getColumn(3).width = 4;
  worksheet.getColumn(4).width = 18;
  worksheet.autoFilter = {
    from: { row: startRow, column: 1 },
    to: { row: startRow, column: 2 },
  };
}

function safeFilename(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

export function buildReportWorkbook(options: DownloadReportWorkbookOptions): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'HAIP PMS';
  workbook.created = options.generatedAt ?? new Date();
  workbook.modified = workbook.created;
  workbook.calcProperties.fullCalcOnLoad = true;

  createSummarySheet(workbook, options);
  collectTableSections(options.data).forEach((section) => {
    addTableSheet(workbook, section, options.currencyCode);
  });

  return workbook;
}

export async function downloadReportWorkbook(options: DownloadReportWorkbookOptions): Promise<void> {
  const workbook = buildReportWorkbook(options);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFilename(`${options.reportType}-${options.propertyName}`)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
