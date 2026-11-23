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
});
