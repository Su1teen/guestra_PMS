import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ReservationPricingService } from './reservation-pricing.service';

const service = new ReservationPricingService(null, null as any, null as any, null as any, null as any, null as any, null as any) as any;
const previous = {
  version: 1, source: 'current', currencyCode: 'KZT', grandTotal: '100000.00', roomTotal: '100000.00', taxTotal: '0.00',
  nights: [{ date: '2027-03-01', roomAmount: '50000.00', taxAmount: '0.00' }, { date: '2027-03-02', roomAmount: '50000.00', taxAmount: '0.00' }],
  services: [], servicesTotal: '0.00', servicesTaxTotal: '0.00', customReason: null, adjustment: null,
};
const canonical = (night: string) => ({ currency: 'KZT', roomTotal: (Number(night) * 2).toFixed(2), taxTotal: '0.00',
  totalAmount: (Number(night) * 2).toFixed(2), lineItems: [{ date: '2027-03-01', rate: night, tax: '0.00' }, { date: '2027-03-02', rate: night, tax: '0.00' }] });

describe('reservation pricing', () => {
  it('computes discounts and manual totals from the tariff', () => {
    expect(service.targetTotal('100000.00', { mode: 'discount_percent', value: '10', reason: 'x' })).toBe('90000.00');
    expect(service.targetTotal('100000.00', { mode: 'discount_amount', value: '15000', reason: 'x' })).toBe('85000.00');
    expect(service.targetTotal('100000.00', { mode: 'total', value: '70000.5', reason: 'x' })).toBe('70000.50');
    expect(() => service.targetTotal('100000.00', { mode: 'discount_percent', value: '120', reason: 'x' })).toThrow(BadRequestException);
    expect(() => service.targetTotal('100000.00', { mode: 'discount_amount', value: '200000', reason: 'x' })).toThrow(BadRequestException);
  });

  it('reprices nights and keeps services when the tariff changes', () => {
    const next = service.snapshot({ ...previous, servicesTotal: '5000.00' }, canonical('60000.00'), null);
    expect(next.source).toBe('current');
    expect(next.grandTotal).toBe('125000.00');
    expect(next.nights.map((n: any) => n.roomAmount)).toEqual(['60000.00', '60000.00']);
    expect(next.adjustment).toBeNull();
  });

  it('records a manual price as an adjustment on the first remaining night', () => {
    const base = service.snapshot(previous, canonical('50000.00'), null);
    const custom = service.snapshot(previous, null, { total: '90000.00', reason: 'Corporate' }, base, '2027-03-02');
    expect(custom).toMatchObject({ source: 'custom', grandTotal: '90000.00', customReason: 'Corporate',
      adjustment: { amount: '-10000.00', serviceDate: '2027-03-02', reason: 'Corporate' } });
    expect(() => service.snapshot(previous, null, { total: '90000.00', reason: 'x' }, base, '2027-03-05')).toThrow(ConflictException);
  });

  it('keeps the total for a complimentary upgrade', () => {
    const upgraded = service.snapshot(previous, canonical('70000.00'), null);
    const keep = service.snapshot(previous, null, { total: previous.grandTotal, reason: 'Complimentary' }, upgraded, '2027-03-01');
    expect(keep.grandTotal).toBe('100000.00');
    expect(keep.nights[0].roomAmount).toBe('70000.00');
    expect(keep.adjustment.amount).toBe('-40000.00');
  });
});
