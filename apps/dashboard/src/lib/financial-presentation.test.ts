import { describe, expect, it } from 'vitest';
import { reportForPresentation, reportedKpis } from './financial-presentation';
import { buildReportWorkbook } from './report-excel';
import { actual, kpis } from '../test/revenue-fixtures';

describe('Shared signed financial presentation', () => {
  it('reconciles daily / Dashboard / Reports earned actuals, not gross or tax-inclusive aliases', () => {
    const daily = reportForPresentation('daily-revenue', { actual: { ...actual, value: 115 }, revenue: { total: 140 }, netRevenue: 124,
      netRevenueByCategory: { room: 75, foodBeverage: 25, other: 15, tax: 9 }, adjustments: 16 });
    const financial = reportedKpis({ actual: daily.actual, kpis: { ...kpis, totalRevenue: 140 } });
    expect(daily.netEarnedRevenue).toBe(115); expect(financial.totalRevenue).toBe(115);
    expect(daily.netRevenueByCategory.room + daily.netRevenueByCategory.foodBeverage + daily.netRevenueByCategory.other).toBe(115);
    expect(daily.netRevenueByCategory.tax).toBe(9); expect(daily.adjustments).toBe(16);
  });
  it('distinguishes absent postings, complete posted zero and unavailable ratios', () => {
    const missing = { actual: { ...actual, value: null, status: 'NO_POSTINGS' }, kpis: { ...kpis, adr: 0, totalRevenue: 0 } };
    expect(reportedKpis(missing)).toMatchObject({ totalRevenue: null, roomRevenue: null, adr: null });
    expect(reportedKpis({ actual: { ...actual, value: 0 }, kpis: { ...kpis, adr: 0, ratioStatus: { adr: 'NO_ROOMS_SOLD', revpar: 'NO_AVAILABLE_INVENTORY' } } })).toMatchObject({ totalRevenue: 0, adr: null, revpar: null });
  });
  it('keeps mixed currencies null and per-currency completeness and actuals intact', () => {
    const p = reportForPresentation('financial-summary', { currencyStatus: 'MIXED_CURRENCIES', currencyCode: null,
      actual: { ...actual, value: null, status: 'MIXED_CURRENCIES' }, kpis,
      byCurrency: [{ currencyCode: 'USD', actual: { ...actual, value: 115 }, totalRevenue: 115 }, { currencyCode: 'KZT', actual: { ...actual, value: 15000 }, totalRevenue: 15000 }] });
    expect(p.kpis.totalRevenue).toBeNull(); expect(p.byCurrency.map((r: any) => [r.currencyCode, r.totalRevenue])).toEqual([['USD', 115], ['KZT', 15000]]);
  });
  it('exports no invented portfolio currency and preserves row currencies and nulls', () => {
    const workbook = buildReportWorkbook({ title: 'Portfolio', reportType: 'financial-summary', propertyName: 'Network', currencyCode: null, parameters: {},
      data: { currencyStatus: 'MIXED_CURRENCIES', byProperty: [{ propertyId: 'a', currencyCode: 'USD', totalRevenue: 115 }, { propertyId: 'b', currencyCode: 'KZT', totalRevenue: null }] } });
    const serialized = JSON.stringify(workbook.model);
    expect(serialized).toContain('MIXED / UNKNOWN'); expect(serialized).toContain('USD'); expect(serialized).toContain('KZT');
    const sheet = workbook.getWorksheet('By Property')!;
    expect(sheet.getCell('C4').numFmt).not.toContain('₸'); expect(sheet.getCell('C5').value).toBe('');
  });
});
