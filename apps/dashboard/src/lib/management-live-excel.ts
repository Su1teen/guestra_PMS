import ExcelJS from "exceljs";
import type {
  ManagementReportData,
  ManagementRow,
  ManagementMetrics,
} from "@telivityhaip/shared";
import { currencyTotals, MANAGEMENT_STATUS_LABELS } from "./management-live";
const headers = [
  "Объект / направление / статья",
  "Валюта",
  "LY факт",
  "LY к дате",
  "План",
  "План к дате",
  "Факт",
  "Выполнение плана, %",
  "Остаток",
  "Прогноз",
  "Отклонение к плану к дате",
];
const keys: (keyof ManagementMetrics)[] = [
  "ly",
  "lytd",
  "plan",
  "planToDate",
  "actual",
  "attainment",
  "remaining",
  "forecast",
  "toDateVariance",
];
const safe = (text: string) => (/^[=+\-@]/.test(text) ? `'${text}` : text);
/** Export this exact response snapshot: no extra fetch, formulas or alternative financial model. */
export function buildLiveManagementWorkbook(reports: ManagementReportData[]) {
  const book = new ExcelJS.Workbook();
  book.creator = "Guestra";
  for (const kind of ["revenue", "expenses"] as const) {
    const ws = book.addWorksheet(kind === "revenue" ? "Доходы" : "Расходы", {
      views: [{ state: "frozen", xSplit: 2, ySplit: 1 }],
    });
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFF" } };
    ws.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "173B3B" },
    };
    ws.columns = headers.map((_, i) => ({ width: i === 0 ? 40 : 21 }));
    const add = (
      label: string,
      currency: string,
      m: ManagementMetrics,
      depth = 0,
    ) => {
      const row = ws.addRow([safe(label), currency, ...keys.map((k) => m[k])]);
      row.outlineLevel = depth;
      row.getCell(1).alignment = { indent: depth };
      if (depth < 2) row.font = { bold: true };
      keys.forEach((k, i) => {
        row.getCell(i + 3).numFmt =
          k === "attainment" ? '0.00"%"' : "#,##0.00;[Red]-#,##0.00";
      });
    };
    const visit = (row: ManagementRow, currency: string) => {
      add(row.label, currency, row.metrics, row.depth);
      row.children?.forEach((c) => visit(c, currency));
    };
    reports.forEach((r) =>
      (kind === "revenue" ? r.revenueRows : r.expenseRows).forEach((row) =>
        visit(row, r.currencyCode),
      ),
    );
    currencyTotals(reports, kind).forEach((m, c) => add(`Итого · ${c}`, c, m));
    ws.autoFilter = { from: "A1", to: `K${ws.rowCount}` };
    ws.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    };
  }
  const summary = book.addWorksheet("Сводка");
  summary.addRow([
    "Объект",
    "Валюта",
    "Начало",
    "Конец",
    "Срез",
    "Факт",
    "Расходы",
    "Операционный результат",
    "MTD",
    "YTD",
    "LYTD",
  ]);
  reports.forEach((r) =>
    summary.addRow([
      safe(r.propertyName),
      r.currencyCode,
      r.period.start,
      r.period.end,
      r.period.cutoff,
      r.totals.revenue.actual,
      r.totals.expenses.actual,
      r.totals.operatingResult,
      r.periods.mtd?.value,
      r.periods.ytd?.value,
      r.periods.lytd?.value,
    ]),
  );
  const daily = book.addWorksheet("Динамика");
  daily.addRow(["Объект", "Валюта", "Дата", "Факт доходов", "План доходов", "Факт расходов", "План расходов"]);
  reports.forEach((r) =>
    r.daily.forEach((d) =>
      daily.addRow([
        safe(r.propertyName),
        r.currencyCode,
        d.date,
        d.actual,
        d.plan,
        d.expenses,
        d.expensePlan,
      ]),
    ),
  );
  const executive = book.addWorksheet("DRR · срез");
  executive.addRow([
    "Объект",
    "Валюта",
    "Дата",
    "OCC",
    "ADR",
    "RevPAR",
    "Заезды",
    "Выезды",
    "Отмены",
    "Неявки",
    "Pickup",
    "Pace",
    "Оплаты",
    "Возвраты оплат",
    "Депозиты · остаток",
    "Налоги",
  ]);
  reports.forEach((r) => {
    const e = r.executive;
    executive.addRow([
      safe(r.propertyName),
      r.currencyCode,
      e?.date ?? null,
      e?.occupancy ?? null,
      e?.adr ?? null,
      e?.revpar ?? null,
      e?.arrivals ?? null,
      e?.departures ?? null,
      e?.cancellations ?? null,
      e?.noShows ?? null,
      e?.pickup ?? null,
      e?.pace ?? null,
      e?.receivedPayments ?? null,
      e?.refunds ?? null,
      e?.heldDeposits ?? null,
      e?.separatelyPostedTax ?? null,
    ]);
  });
  const sources = book.addWorksheet("Источники");
  sources.addRow([
    "Объект",
    "Показатель",
    "Статус",
    "Версия бюджета",
    "Версия расходов",
  ]);
  reports.forEach((r) =>
    Object.entries(r.sources).forEach(([k, v]) =>
      sources.addRow([
        safe(r.propertyName),
        ({actual:"Факт",history:"История",budget:"Бюджет",expenses:"Расходы",forecast:"Прогноз",operatingResult:"Операционный результат"} as Record<string,string>)[k] ?? k,
        MANAGEMENT_STATUS_LABELS[v] ?? v,
        r.inputs.budget?.revision ?? null,
        r.inputs.expenses?.revision ?? null,
      ]),
    ),
  );
  sources.addRow([
    "Методика",
    "Факт: signed charges.serviceDate; налоги и deposit_credit исключены. План: явные дневные суммы. Валюты не складываются. Пустая ячейка означает отсутствие источника. Операционный результат: только полный факт и подтверждённые расходы.",
  ]);
  return book;
}
export async function downloadLiveManagementWorkbook(
  reports: ManagementReportData[],
) {
  const buffer = await buildLiveManagementWorkbook(reports).xlsx.writeBuffer();
  const url = URL.createObjectURL(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `Guestra-Management-${reports[0]?.period.start ?? "report"}.xlsx`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
