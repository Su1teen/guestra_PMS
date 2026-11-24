import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { MoneyReportsService } from './money-reports.service';

const stay = (over: Record<string, unknown> = {}) => ({ id: 'r1', bookingId: 'b1', status: 'confirmed', arrivalDate: '2027-02-20', departureDate: '2027-02-21',
  totalAmount: '100000.00', confirmationNumber: 'LES-1', source: 'direct', createdAt: new Date('2027-02-13T05:00:00Z'), guestName: 'Дана Серикова',
  crmReservationId: 'reservation_crm_1', ...over });
const split = new Map([['r1', { accommodation: { amount: new Decimal(92000), cost: new Decimal(0) }, fnb: { amount: new Decimal(8000), cost: new Decimal(8000) } }]]);

function service(facts: any) {
  const svc = new MoneyReportsService({} as any);
  vi.spyOn(svc as any, 'facts').mockResolvedValue({ tz: 'Asia/Almaty', property: { name: 'LES Borovoe', currencyCode: 'KZT', settings: {} }, splits: split,
    penalties: [], newBookings: [], ...facts });
  vi.spyOn(svc as any, 'freeStays').mockResolvedValue({ rows: [], nights: 0, stays: 0, cost: new Decimal(0) });
  vi.spyOn(svc as any, 'outletCharges').mockResolvedValue(facts.outlet ?? []);
  vi.spyOn(svc as any, 'inputs').mockResolvedValue(facts.inputs ?? { budget: null, expenses: null });
  return svc;
}

describe('MoneyReportsService', () => {
  it('puts a payment on the day it was paid and separates prepayments from stay payments', async () => {
    const r1 = stay();
    const svc = service({ days: ['2027-02-13', '2027-02-14'], newBookings: [r1], items: [
      { id: 'p1', date: '2027-02-14', amount: new Decimal(50000), refund: false, stay: r1, method: 'bank_transfer' },
    ] });
    const report = await svc.dayByDay('p', '2027-02-13', '2027-02-14');
    expect(report.rows).toEqual([
      { date: '2027-02-13', newBookings: 1, prepayments: 0, stayPayments: 0, penalties: 0, refunds: 0, total: 0 },
      { date: '2027-02-14', newBookings: 0, prepayments: 50000, stayPayments: 0, penalties: 0, refunds: 0, total: 50000 },
    ]);
    expect(report.details[0]).toMatchObject({ kind: 'prepayment', accommodation: 46000, fnb: 4000, crmReservationId: 'reservation_crm_1' });
  });

  it('leaves cancelled bookings out except the retained prepayment, which counts as a penalty', async () => {
    const cancelled = stay({ status: 'cancelled' });
    const svc = service({ days: ['2027-02-19'], items: [{ id: 'p1', date: '2027-02-19', amount: new Decimal(50000), refund: false, stay: cancelled, method: 'cash' }],
      penalties: [{ date: '2027-02-19', amount: new Decimal(50000), stay: cancelled, reason: 'Отмена за 12 часов' }] });
    const report = await svc.dayByDay('p', '2027-02-19', '2027-02-19');
    expect(report.rows[0]).toMatchObject({ prepayments: 0, penalties: 50000, total: 50000 });
  });

  it('subtracts refunds and counts payments on or after arrival as stay payments', async () => {
    const r1 = stay();
    const svc = service({ days: ['2027-02-20'], items: [
      { id: 'p2', date: '2027-02-20', amount: new Decimal(50000), refund: false, stay: r1, method: 'card' },
      { id: 'p3', date: '2027-02-20', amount: new Decimal(10000), refund: true, stay: r1, method: 'card' },
    ] });
    const report = await svc.dayByDay('p', '2027-02-20', '2027-02-20');
    expect(report.totals).toMatchObject({ stayPayments: 50000, refunds: 10000, total: 40000 });
  });

  it('pays commission on accommodation only: a fully paid 100 000 package gives 9 200', async () => {
    const r1 = stay();
    const svc = service({ days: ['2027-02-14'], items: [
      { id: 'p1', date: '2027-02-14', amount: new Decimal(50000), refund: false, stay: r1, method: 'cash' },
      { id: 'p2', date: '2027-02-14', amount: new Decimal(50000), refund: false, stay: r1, method: 'cash' },
      { id: 'p9', date: '2027-02-14', amount: new Decimal(70000), refund: false, stay: stay({ id: 'r9', status: 'no_show' }), method: 'cash' },
    ] });
    const report = await svc.commissionBase('p', '2027-02-14', '2027-02-14');
    expect(report.ratePercent).toBe(10);
    expect(report.rows).toEqual([expect.objectContaining({ reservationId: 'r1', paid: 100000, accommodationPaid: 92000, commission: 9200 })]);
  });

  it('reports cost of included food and "not filled" expenses as null', async () => {
    const r1 = stay();
    const svc = service({ days: ['2027-02-14'], items: [{ id: 'p1', date: '2027-02-14', amount: new Decimal(100000), refund: false, stay: r1, method: 'cash' }] });
    vi.spyOn(svc as any, 'inputs').mockResolvedValue({ budget: null, expenses: null });
    const report = await svc.management('p', '2027-02-14', '2027-02-14');
    expect(report.revenue.find((l) => l.key === 'accommodation')?.fact).toBe(92000);
    expect(report.revenue.find((l) => l.key === 'fnb')?.fact).toBe(8000);
    expect(report.cost.fact).toBe(8000);
    expect(report.result.fact).toBeNull();
    expect(report.expensesFilled).toBe(false);
  });

  it('complimentary and barter stays: no revenue and no commission, but nights and cost count', async () => {
    const comp = stay({ id: 'r1', priceType: 'complimentary' });
    const svc = service({ days: ['2027-02-14'], items: [{ id: 'p1', date: '2027-02-14', amount: new Decimal(100000), refund: false, stay: comp, method: 'cash' }] });
    expect((await svc.commissionBase('p', '2027-02-14', '2027-02-14')).rows).toEqual([]);
    vi.mocked((svc as any).freeStays).mockResolvedValue({ rows: [{ id: 'r1', priceType: 'complimentary', nights: 1, cost: new Decimal(8000) }], nights: 1, stays: 1, cost: new Decimal(8000) });
    vi.spyOn(svc as any, 'inputs').mockResolvedValue({ budget: null, expenses: null });
    const report = await svc.management('p', '2027-02-14', '2027-02-14');
    expect(report.complimentary).toEqual({ stays: 1, nights: 1, cost: 8000, previousNights: 1 });
    expect(report.cost.fact).toBe(16000);
  });

  it('counts a folio payment as stay money only up to the stay price; the rest settles outlet charges', async () => {
    const r1 = stay({ arrivalDate: '2027-02-10' });
    const svc = service({ days: ['2027-02-14'], items: [
      { id: 'p1', date: '2027-02-14', amount: new Decimal(130000), stayAmount: new Decimal(100000), refund: false, stay: r1, method: 'card' },
    ] });
    const report = await svc.dayByDay('p', '2027-02-14', '2027-02-14');
    expect(report.totals.total).toBe(130000);
    expect(report.details[0]).toMatchObject({ accommodation: 92000, fnb: 8000, services: 30000 });
    const commission = await svc.commissionBase('p', '2027-02-14', '2027-02-14');
    expect(commission.rows[0]).toMatchObject({ accommodationPaid: 92000, commission: 9200 });
  });

  it('adds outlet revenue by department and reads the revenue plan entered per charge type', async () => {
    const r1 = stay();
    const svc = service({ days: ['2027-02-14'], items: [{ id: 'p1', date: '2027-02-14', amount: new Decimal(100000), refund: false, stay: r1, method: 'card' }],
      outlet: [{ type: 'spa', amount: '15000.00' }, { type: 'entertainment', amount: '20000.00' }, { type: 'food_beverage', amount: '12000.00' }, { type: 'bath', amount: '25000.00' }],
      inputs: { budget: { accommodation: new Decimal(90000), spa: new Decimal(10000) }, expenses: null } });
    const report = await svc.management('p', '2027-02-14', '2027-02-14');
    const by = Object.fromEntries(report.revenue.map((l: any) => [l.key, l]));
    expect(by.accommodation).toMatchObject({ fact: 92000, plan: 90000, variance: 2000 });
    expect(by.fnb.fact).toBe(20000);
    expect(by.spa).toMatchObject({ fact: 15000, plan: 10000 });
    expect(by.bath.fact).toBe(25000);
    expect(by.entertainment.fact).toBe(20000);
    expect(report.revenueTotal.fact).toBe(172000);
    expect(report.expenses).toEqual([]);
  });
});
