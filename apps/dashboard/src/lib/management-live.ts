import type {
  ManagementMetrics,
  ManagementReportData,
} from "@telivityhaip/shared";
export const MANAGEMENT_STATUS_LABELS: Record<string, string> = {
  COMPLETE: "Подтверждено",
  PARTIAL: "Неполные данные",
  NO_POSTINGS: "Нет проводок",
  NO_DATA: "Нет данных",
  NOT_CONFIGURED: "Не настроено",
  CONFIGURED: "Настроено",
  INSUFFICIENT_HISTORY: "Недостаточно истории",
  INSUFFICIENT_DATA: "Недостаточно данных",
};
export function currencyTotals(
  reports: ManagementReportData[],
  kind: "revenue" | "expenses",
): Map<string, ManagementMetrics> {
  const result = new Map<string, ManagementMetrics>();
  for (const currency of new Set(reports.map((r) => r.currencyCode))) {
    const rows = reports
      .filter((r) => r.currencyCode === currency)
      .map((r) => r.totals[kind]);
    const sum = (key: keyof ManagementMetrics) =>
      rows.some((r) => r[key] === null)
        ? null
        : rows.reduce((v, r) => v + Math.round(r[key]! * 100), 0) / 100;
    const actual = sum("actual"),
      plan = sum("plan"),
      planToDate = sum("planToDate");
    result.set(currency, {
      ly: sum("ly"),
      lytd: sum("lytd"),
      actual,
      plan,
      planToDate,
      forecast: sum("forecast"),
      remaining: sum("remaining"),
      attainment:
        actual === null || !plan
          ? null
          : Math.round((actual / plan) * 10000) / 100,
      toDateVariance:
        actual === null || planToDate === null
          ? null
          : (Math.round(actual * 100) - Math.round(planToDate * 100)) / 100,
    });
  }
  return result;
}
