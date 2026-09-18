import { describe, expect, it } from 'vitest';
import { buildManagementReport } from './management-demo';
import { buildManagementWorkbook } from './management-excel';

describe('management workbook', () => {
  it('exports one reconciled multi-sheet book for the entire hotel portfolio', async () => {
    const model = buildManagementReport({ year: 2026, month: null, day: null, propertyId: 'all' });
    const book = buildManagementWorkbook(model);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual([
      'Сводка', 'Доходы', 'Расходы', 'Объекты', 'Динамика', 'Методика',
    ]);
    const summary = book.getWorksheet('Сводка')!;
    expect(summary.getCell('D5').value).toBe(600_000_000);
    expect(summary.getCell('D6').value).toBe(420_000_000);
    expect(summary.getCell('D7').value).toBe(180_000_000);
    expect(book.getWorksheet('Объекты')!.rowCount).toBe(7);
    expect(book.getWorksheet('Доходы')!.autoFilter).toBeTruthy();
    expect((await book.xlsx.writeBuffer()).byteLength).toBeGreaterThan(10_000);
  });
});
