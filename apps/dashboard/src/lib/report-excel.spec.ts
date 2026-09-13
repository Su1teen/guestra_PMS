import { describe, expect, it } from 'vitest';
import { buildReportWorkbook } from './report-excel';

describe('report Excel workbook', () => {
  it('creates a styled summary and filterable detail sheet in property currency', () => {
    const workbook = buildReportWorkbook({
      title: 'Daily Revenue Report',
      reportType: 'daily-revenue',
      propertyName: 'Demo property',
      currencyCode: 'KZT',
      generatedAt: new Date('2026-09-13T12:00:00.000Z'),
      parameters: { date: '2026-09-13' },
      data: {
        totalRevenue: 195000,
        daily: [
          {
            date: '2026-09-13',
            revenue: 195000,
            occupancyRate: 62.5,
            untrustedValue: '=SUM(A1:A2)',
          },
        ],
      },
    });

    const summary = workbook.getWorksheet('Summary');
    const daily = workbook.getWorksheet('Daily');

    expect(summary?.getCell('A1').value).toBe('Daily Revenue Report');
    expect(summary?.getCell('A1').fill).toMatchObject({ fgColor: { argb: '0B1F3A' } });
    expect(daily?.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
    expect(daily?.autoFilter).toBeTruthy();
    expect(daily?.getCell('B4').numFmt).toContain('₸');
    expect(daily?.getCell('D4').value).toBe("'=SUM(A1:A2)");
  });
});
