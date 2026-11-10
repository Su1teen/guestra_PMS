import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { renderFolioDocument, type FolioDocumentData } from './folio-document.renderer';
import { FolioController } from './folio.controller';
import { stayNights } from './folio-document.service';
import { PERMISSIONS_KEY } from '../auth/permissions.decorator';

const base: FolioDocumentData = {
  final: true,
  folioNumber: 'F-1001',
  issueDate: '2026-10-29T08:00:00.000Z',
  propertyName: 'ЛЕС Боровое',
  guestName: 'Айгерим Касымова',
  confirmationNumber: 'HAIP-1',
  roomNumber: '201',
  roomTypeName: 'A-Frame',
  arrivalDate: '2026-10-26',
  departureDate: '2026-10-29',
  guests: 2,
  currencyCode: 'KZT',
  timeZone: 'Asia/Almaty',
  lines: [
    { date: '2026-10-26T12:00:00.000Z', description: 'Проживание', amount: '50000.00', tax: '0' },
    { date: '2026-10-27T12:00:00.000Z', description: 'СПА', amount: '10000.00', tax: '1200.00' },
  ],
  payments: [{ date: '2026-10-29T07:00:00.000Z', method: 'Банковская карта', reference: '•••• 4242', amount: '60000.00' }],
  totalCharges: '60000.00',
  totalPayments: '60000.00',
  balance: '0.00',
};

describe('renderFolioDocument', () => {
  it('renders a final paid receipt with charges, payments and totals', () => {
    const html = renderFolioDocument(base);
    expect(html).toContain('Итоговое фолио · квитанция');
    expect(html).toContain('Оплачено</span>');
    expect(html).toContain('СПА');
    expect(html).toContain('•••• 4242');
    expect(html).toContain('Печать / Сохранить PDF');
    expect(html).toMatch(/60\s000 ₸/u);
  });

  it('marks an open folio as interim and never as paid', () => {
    const html = renderFolioDocument({ ...base, final: false, balance: '10000.00', totalPayments: '50000.00' });
    expect(html).toContain('Предварительное фолио');
    expect(html).not.toContain('class="paid"');
  });

  it('shows price per night with the head count and child ages', () => {
    const html = renderFolioDocument({ ...base, party: { adults: 2, children: 1, childAges: [7] }, guests: 3, nights: [
      { date: '2026-10-26', guests: 3, amount: '25000.00', tax: '0.00', posted: true },
      { date: '2026-10-27', guests: 3, amount: '25000.00', tax: '0.00', posted: false },
    ] });
    expect(html).toContain('Проживание по ночам');
    expect(html).toContain('Цена за ночь');
    expect(html).toContain('2 взр., 1 дет. (7 лет)');
    expect(html).toContain('по тарифу брони');
    expect(html).toContain('2 ночи');
  });

  it('builds nights from posted room charges and the tariff, netting reversals', () => {
    const nights = stayNights([
      { serviceDate: '2026-10-26T12:00:00.000Z', amount: '25000.00', taxAmount: '0' },
      { serviceDate: '2026-10-26T12:00:00.000Z', amount: '-5000.00', taxAmount: '0' },
    ], [{ date: '2026-10-26', roomAmount: '25000.00', taxAmount: '0.00' }, { date: '2026-10-27', roomAmount: '26000.00', taxAmount: '100.00' }], 3);
    expect(nights).toEqual([
      { date: '2026-10-26', guests: 3, posted: true, amount: '20000.00', tax: '0.00' },
      { date: '2026-10-27', guests: 3, posted: false, amount: '26000.00', tax: '100.00' },
    ]);
  });

  it('escapes guest supplied text', () => {
    const html = renderFolioDocument({ ...base, guestName: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('is gated by folios.read', () => {
    const perms = new Reflector().get<string[]>(PERMISSIONS_KEY, FolioController.prototype.getFolioDocument);
    expect(perms).toEqual(['folios.read']);
  });
});
