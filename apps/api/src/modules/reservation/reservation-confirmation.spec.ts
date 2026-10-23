import { describe, expect, it } from 'vitest';
import { confirmationText, renderConfirmation, type ReservationConfirmation } from './reservation-confirmation.service';

const base: ReservationConfirmation = {
  confirmationNumber: 'HTL-ABC123',
  status: 'confirmed',
  guest: { name: 'Айгерим <Test>', email: 'guest@example.com', phone: null },
  property: { name: 'Test Hotel', address: 'Main st 1, Almaty', phone: '+7 700 000 00 00', email: 'hotel@example.com', website: null,
    checkInTime: '14:00', checkOutTime: '12:00', language: 'ru' },
  stay: { arrivalDate: '2027-03-01', departureDate: '2027-03-03', nights: 2, adults: 2, children: 1,
    roomType: 'Skyhouse', ratePlan: 'BAR', mealPlan: 'Завтрак включён' },
  rooms: [{ roomType: 'Skyhouse', adults: 2, children: 1, totalAmount: '90000.00' }],
  services: [{ name: 'Трансфер', quantity: 1, amount: '10000.00' }],
  price: { currencyCode: 'KZT', roomTotal: '80000.00', taxTotal: '0.00', servicesTotal: '10000.00', adjustment: '-5000.00', total: '85000.00' },
  payment: { paid: '20000.00', balance: '65000.00' },
  cancellationPolicy: 'Бесплатная отмена за 24 часа до заезда',
  specialRequests: null,
};

describe('booking confirmation document', () => {
  it('contains every element requested by the property', () => {
    const html = renderConfirmation(base);
    for (const expected of ['HTL-ABC123', 'Test Hotel', 'Skyhouse', '14:00', '12:00', 'Завтрак включён', 'Трансфер',
      'Бесплатная отмена', '+7 700 000 00 00', 'hotel@example.com', 'Main st 1', '2 взр., 1 дет.', 'Скидка'])
      expect(html).toContain(expected);
    expect(html).toContain('85');
  });

  it('escapes guest supplied text', () => {
    expect(renderConfirmation(base)).not.toContain('<Test>');
    expect(renderConfirmation(base)).toContain('&lt;Test&gt;');
  });

  it('lists every room of a multi-room booking and renders English for English properties', () => {
    const html = renderConfirmation({ ...base, property: { ...base.property, language: 'en' },
      rooms: [...base.rooms, { roomType: 'Standard', adults: 1, children: 0, totalAmount: '40000.00' }] });
    expect(html).toContain('Booking confirmation');
    expect(html).toContain('Standard');
    expect(confirmationText(base)).toContain('HTL-ABC123');
  });
});
