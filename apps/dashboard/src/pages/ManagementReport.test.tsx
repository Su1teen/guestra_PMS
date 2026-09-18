import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ManagementReport from './ManagementReport';

// По умолчанию раскрыты отели (видны направления), статьи свёрнуты —
// как в исходной версии отчёта. Страница работает без API: это демо-модель.
describe('ManagementReport hierarchy table', () => {
  it('renders every visible row inside a single flat tbody (no nested tbody)', () => {
    const { container } = render(<ManagementReport />);
    const bodies = container.querySelectorAll('tbody');
    expect(bodies).toHaveLength(1);
    expect(container.querySelectorAll('tbody tbody')).toHaveLength(0);
    // 3 отеля + 9 направлений (статьи свёрнуты) = 12 строк
    expect(bodies[0].querySelectorAll('tr')).toHaveLength(12);
    expect(container.querySelector('tfoot tr')).toBeTruthy();
    expect(screen.getByText('Итого · сеть, 3 объекта')).toBeTruthy();
  });

  it('keeps the hotel → direction → article expansion working', () => {
    const { container } = render(<ManagementReport />);
    const rows = () => container.querySelectorAll('tbody tr').length;

    fireEvent.click(screen.getByRole('button', { name: 'Свернуть ЛЕС Боровое' }));
    expect(rows()).toBe(9);

    fireEvent.click(screen.getByRole('button', { name: 'Развернуть ЛЕС Боровое' }));
    expect(rows()).toBe(12);

    fireEvent.click(screen.getAllByRole('button', { name: 'Развернуть Проживание' })[0]);
    expect(rows()).toBe(14);

    fireEvent.click(screen.getAllByRole('button', { name: 'Свернуть Проживание' })[0]);
    expect(rows()).toBe(12);
  });

  it('keeps header, body rows and totals aligned to the same column layout', () => {
    const { container } = render(<ManagementReport />);
    const table = container.querySelector('table.mrr-table')!;
    expect(table.querySelectorAll('thead th')).toHaveLength(9);
    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.querySelectorAll('th')).toHaveLength(1);
      expect(row.querySelectorAll('td')).toHaveLength(8);
    }
    const totalRow = table.querySelector('tfoot tr')!;
    expect(totalRow.querySelectorAll('th, td')).toHaveLength(9);
    expect(totalRow.querySelectorAll('td strong').length).toBeGreaterThan(0);
  });
});
