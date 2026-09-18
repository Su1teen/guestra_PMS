import { describe, expect, it } from 'vitest';
import { buildManagementReport, DEMO_PROPERTIES, type Metrics, type ReportFilters, type ReportRow } from './management-demo';

const all: ReportFilters = { year: 2026, month: null, day: null, propertyId: 'all' };
const metricKeys: (keyof Metrics)[] = ['plan', 'planToDate', 'actual', 'ly', 'lytd', 'forecast', 'remaining', 'requiredPerDay'];

function totalOf(rows: ReportRow[], key: keyof Metrics) { return rows.reduce((sum, row) => sum + row.metrics[key], 0); }

describe('management report demo ledger', () => {
  it('uses a 600m KZT annual revenue budget and reconciles both report hierarchies', () => {
    const report = buildManagementReport(all);
    expect(report.revenueTotal.plan).toBe(600_000_000);
    expect(report.expenseTotal.plan).toBe(420_000_000);
    expect(report.revenueRows).toHaveLength(DEMO_PROPERTIES.length);
    for (const [rows, total] of [[report.revenueRows, report.revenueTotal], [report.expenseRows, report.expenseTotal]] as const) {
      for (const key of metricKeys) expect(totalOf(rows, key)).toBe(total[key]);
      for (const property of rows) {
        for (const key of metricKeys) expect(totalOf(property.children ?? [], key)).toBe(property.metrics[key]);
        for (const group of property.children ?? []) for (const key of metricKeys) expect(totalOf(group.children ?? [], key)).toBe(group.metrics[key]);
      }
    }
  });

  it('uses matching dates for LYTD and keeps the full month plan at a midmonth cutoff', () => {
    const mid = buildManagementReport({ ...all, month: 9, day: 10 });
    const later = buildManagementReport({ ...all, month: 9, day: 18 });
    expect(mid.revenueTotal.plan).toBe(later.revenueTotal.plan);
    expect(mid.revenueTotal.actual).toBeLessThan(later.revenueTotal.actual);
    expect(mid.revenueTotal.lytd).toBeLessThan(later.revenueTotal.lytd);
    expect(later.revenueTotal.lytd).toBeLessThan(later.revenueTotal.ly);
    expect(later.revenueTotal.planToDate).toBeLessThan(later.revenueTotal.plan);
  });

  it('keeps future actuals empty while retaining the future budget', () => {
    const report = buildManagementReport({ ...all, month: 12, day: null });
    expect(report.revenueTotal.actual).toBe(0);
    expect(report.expenseTotal.actual).toBe(0);
    expect(report.revenueTotal.plan).toBeGreaterThan(0);
    expect(report.revenueTotal.forecast).toBe(report.revenueTotal.plan);
  });
});
