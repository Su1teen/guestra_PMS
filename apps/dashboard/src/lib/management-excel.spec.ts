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
    expect(book.getWorksheet('Доходы')!.getCell('G5').value).toBe(600_000_000);
    expect(book.getWorksheet('Расходы')!.getCell('G5').value).toBe(420_000_000);
    expect((await book.xlsx.writeBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  it('mirrors the on-screen hierarchy in flat sheets and reconciles every level', () => {
    const model = buildManagementReport({ year: 2026, month: 9, day: 18, propertyId: 'all' });
    const book = buildManagementWorkbook(model);
    const revenue = book.getWorksheet('Доходы')!;

    expect(revenue.getCell('A4').value).toBe('Объект');
    expect(revenue.getCell('B4').value).toBe('Направление');
    expect(revenue.getCell('C4').value).toBe('Статья');
    expect(revenue.getCell('D4').value).toBe('Счёт 1С*');
    expect(revenue.getCell('E4').value).toBe('LY факт');
    expect(revenue.getCell('F4').value).toBe('LY к дате');
    expect(revenue.getCell('G4').value).toBe('План');
    expect(revenue.getCell('H4').value).toBe('План к дате');
    expect(revenue.getCell('I4').value).toBe('Факт');
    expect(revenue.getCell('J4').value).toBe('Выполнение плана, %');
    expect(revenue.getCell('L4').value).toBe('Остаток');
    expect(revenue.getCell('M4').value).toBe('Прогноз');

    let network: number | undefined;
    let hotels = 0;
    let directions = 0;
    let articles = 0;
    let hotelPlan = 0;
    let directionPlan = 0;
    let articlePlan = 0;
    for (let row = 5; row <= revenue.rowCount; row += 1) {
      const kind = String(revenue.getCell(`C${row}`).value);
      const plan = Number(revenue.getCell(`G${row}`).value ?? 0);
      if (kind === 'ИТОГО ПО СЕТИ') network = plan;
      else if (kind === 'Итого по объекту') {
        hotels += 1;
        hotelPlan += plan;
      } else if (kind === 'Итого по направлению') {
        directions += 1;
        directionPlan += plan;
      } else {
        articles += 1;
        articlePlan += plan;
      }
    }
    expect(hotels).toBe(3);
    expect(directions).toBe(9);
    expect(articles).toBe(45);
    expect(network).toBe(model.revenueTotal.plan);
    expect(hotelPlan).toBe(network);
    expect(directionPlan).toBe(network);
    expect(articlePlan).toBe(network);
    expect(revenue.getCell('G5').value).toBe(model.revenueTotal.plan);

    const expense = book.getWorksheet('Расходы')!;
    expect(expense.getCell('G5').value).toBe(model.expenseTotal.plan);
    expect(expense.rowCount).toBe(4 + 1 + 3 * 19);

    const view = revenue.views[0] as { xSplit?: number; ySplit?: number };
    expect(view.xSplit).toBe(4);
    expect(view.ySplit).toBe(4);
    expect(revenue.getRow(5).outlineLevel).toBe(0);
    expect(revenue.getRow(7).outlineLevel).toBe(1);
    expect(revenue.getRow(8).outlineLevel).toBe(2);
  });

  it('keeps a single-property sheet without the network total row', () => {
    const model = buildManagementReport({ year: 2026, month: null, day: null, propertyId: 'les_borovoe' });
    const book = buildManagementWorkbook(model);
    const revenue = book.getWorksheet('Доходы')!;
    expect(revenue.getCell('B5').value).toBe('Итого по объекту');
    expect(revenue.rowCount).toBe(4 + 19);
  });
});
