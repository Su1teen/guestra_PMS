import { describe, expect, it } from 'vitest';
import {
  confirmationText,
  documentNights,
  partyLabel,
  renderConfirmation,
  smsText,
  type ReservationConfirmation,
  type ReservationDocumentRoom,
} from './reservation-confirmation.service';

const room: ReservationDocumentRoom = {
  reservationId: 'r1', status: 'confirmed', roomType: 'Skyhouse', roomNumber: '204', ratePlan: 'BAR', mealPlan: 'Завтрак включён',
  adults: 2, children: 2, childAges: [4, 9], totalAmount: '90000.00',
  nights: [
    { date: '2027-03-01', roomAmount: '45000.00', taxAmount: '0.00', total: '45000.00' },
    { date: '2027-03-02', roomAmount: '45000.00', taxAmount: '0.00', total: '45000.00' },
  ],
  supplement: { amountPerNight: '3000.00', lines: [
    { kind: 'child', bandLabel: '6–12', age: 9, ordinal: 1, amountPerNight: '3000.00' },
    { kind: 'child', bandLabel: '0–5', age: 4, ordinal: 1, amountPerNight: '0.00' },
  ] },
};

const base: ReservationConfirmation = {
  kind: 'confirmation',
  confirmationNumber: 'HTL-ABC123',
  status: 'confirmed',
  groupName: null,
  guest: { name: 'Айгерим <Test>', email: 'guest@example.com', phone: '+77000000000' },
  property: { name: 'Test Hotel', address: 'Main st 1, Almaty', phone: '+7 700 000 00 00', email: 'hotel@example.com', website: null,
    checkInTime: '14:00', checkOutTime: '12:00', language: 'ru' },
  stay: { arrivalDate: '2027-03-01', departureDate: '2027-03-03', nights: 2, adults: 2, children: 2, childAges: [4, 9],
    roomType: 'Skyhouse', ratePlan: 'BAR', mealPlan: 'Завтрак включён' },
  rooms: [room],
  services: [{ name: 'Трансфер', quantity: 1, amount: '10000.00' }],
  price: { currencyCode: 'KZT', roomTotal: '80000.00', taxTotal: '0.00', servicesTotal: '10000.00', adjustment: '-5000.00', total: '85000.00' },
  payment: { paid: '20000.00', balance: '65000.00' },
  guarantee: { optionUntil: null, requiredDeposit: null, depositDue: null, guaranteeType: 'deposit' },
  sent: { proposalAt: null, confirmationAt: null },
  cancellationPolicy: 'Бесплатная отмена за 24 часа до заезда',
  specialRequests: null,
};

describe('booking confirmation document', () => {
  it('contains every element requested by the property', () => {
    const html = renderConfirmation(base);
    for (const expected of ['HTL-ABC123', 'Test Hotel', 'Skyhouse', '14:00', '12:00', 'Завтрак включён', 'Трансфер',
      'Бесплатная отмена', '+7 700 000 00 00', 'hotel@example.com', 'Main st 1', '2 взр., 2 дет. (4, 9 лет)', 'Скидка'])
      expect(html).toContain(expected);
    expect(html).toContain('85');
  });

  it('shows the price of every night and the guests of every room', () => {
    const html = renderConfirmation(base);
    expect(html).toContain('Стоимость по ночам');
    expect(html.match(/45\s000,00 KZT/g)?.length).toBeGreaterThanOrEqual(4); // two nights × room and amount columns
    expect(html).toContain('Номер 204');
    expect(html).toContain('Ребёнок 6–12 (9 лет), 1-й — 3');
    expect(html).toContain('Ребёнок 0–5 (4 лет), 1-й — бесплатно');
  });

  it('escapes guest supplied text', () => {
    expect(renderConfirmation(base)).not.toContain('<Test>');
    expect(renderConfirmation(base)).toContain('&lt;Test&gt;');
  });

  it('renders a proposal with guarantee and deadline for a tentative booking', () => {
    const proposal = { ...base, kind: 'proposal' as const, status: 'pending',
      guarantee: { optionUntil: '2027-02-20T12:00:00.000Z', requiredDeposit: '30000.00', depositDue: '10000.00', guaranteeType: null } };
    const html = renderConfirmation(proposal);
    expect(html).toContain('Предложение по бронированию');
    expect(html).toContain('Гарантийный платёж');
    expect(html).toContain('Осталось внести');
    expect(confirmationText(proposal)).toContain('Гарантийный платёж: 30000.00 KZT');
    expect(smsText(proposal)).toContain('Предложение по бронированию HTL-ABC123');
    expect(smsText(proposal)).toContain('10000.00 KZT');
  });

  it('marks a resent proposal as a reminder in the document, text and SMS', () => {
    const reminder = { ...base, kind: 'proposal' as const, status: 'pending', reminder: true,
      guarantee: { optionUntil: '2027-02-20T12:00:00.000Z', requiredDeposit: '30000.00', depositDue: '30000.00', guaranteeType: null } };
    expect(renderConfirmation(reminder)).toContain('Напоминаем: бронь ещё не подтверждена');
    expect(confirmationText(reminder).startsWith('Напоминание. Предложение по бронированию')).toBe(true);
    expect(smsText(reminder)).toContain('Напоминание. Предложение по бронированию HTL-ABC123');
  });

  it('lists every room of a multi-room booking and renders English for English properties', () => {
    const html = renderConfirmation({ ...base, property: { ...base.property, language: 'en' },
      rooms: [...base.rooms, { ...room, reservationId: 'r2', roomType: 'Standard', roomNumber: null, adults: 1, children: 0, childAges: [], supplement: null }] });
    expect(html).toContain('Booking confirmation');
    expect(html).toContain('Standard');
    expect(html).toContain('Price by night');
    expect(confirmationText(base)).toContain('HTL-ABC123');
    expect(confirmationText(base)).toContain('2027-03-02: 45000.00 KZT');
  });
});

describe('document helpers', () => {
  it('formats the party with child ages', () => {
    expect(partyLabel(2, 0, [], 'ru')).toBe('2 взр.');
    expect(partyLabel(1, 2, [3, 7], 'en')).toBe('1 adults, 2 children (3, 7 y.o.)');
  });

  it('uses snapshot nights and spreads legacy totals without losing cents', () => {
    expect(documentNights({ arrivalDate: '2027-01-01', nights: 1, totalAmount: '100.00',
      acceptedPricingSnapshot: { nights: [{ date: '2027-01-01', roomAmount: '90.00', taxAmount: '10.00' }] } as any }))
      .toEqual([{ date: '2027-01-01', roomAmount: '90.00', taxAmount: '10.00', total: '100.00' }]);
    const legacy = documentNights({ arrivalDate: '2027-01-30', nights: 3, totalAmount: '100.00' });
    expect(legacy.map((n) => n.date)).toEqual(['2027-01-30', '2027-01-31', '2027-02-01']);
    expect(legacy.map((n) => n.total)).toEqual(['33.33', '33.33', '33.34']);
  });
});
