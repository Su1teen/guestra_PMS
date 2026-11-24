import { describe, expect, it } from 'vitest';
import { INVOICE_DESCRIPTION_LIMIT, invoiceDescription } from './invoice-description';

describe('invoiceDescription', () => {
  it('names the booking and the hotel when both fit', () => {
    expect(invoiceDescription('HAIP-8KQ2', 'LES Боровое')).toBe('Предоплата брони HAIP-8KQ2, LES Боровое');
  });
  it('drops the hotel name instead of cutting it mid-word', () => {
    const text = invoiceDescription('HAIP-T4C300E7R1P7X034D5Q3J105Q355P3T2', 'Guestra Sandbox LES');
    expect(text).toBe('Предоплата брони HAIP-T4C300E7R1P7X034D5Q3J105Q355P3T2');
  });
  it('keeps the tail of a number that is too long on its own', () => {
    const text = invoiceDescription('X'.repeat(80), 'LES');
    expect(text.length).toBeLessThanOrEqual(INVOICE_DESCRIPTION_LIMIT);
    expect(text).toBe('Предоплата брони …XXXXXXXXXX, LES');
  });
  it('works without a number', () => {
    expect(invoiceDescription(null, 'LES Боровое')).toBe('Предоплата брони, LES Боровое');
    expect(invoiceDescription(undefined, null)).toBe('Предоплата брони');
  });
  it('never exceeds the limit', () => {
    for (const name of ['', 'A'.repeat(70)]) for (const n of ['', 'N'.repeat(10), 'N'.repeat(60)])
      expect(invoiceDescription(n, name).length).toBeLessThanOrEqual(INVOICE_DESCRIPTION_LIMIT);
  });
});
