import { describe, expect, it } from 'vitest';
import { indexServiceCalendar } from './service-calendar';
import type { ServiceCalendar } from '../components/services/types';
describe('service resource calendar indexing', () => {
  it('places a midnight-spanning booking on both hotel dates and ignores a foreign allocation', () => {
    const data = { bookings: [{ id: 'a', startAt: '2027-01-01T18:30:00Z', endAt: '2027-01-01T20:00:00Z' }], allocations: [{ serviceBookingId: 'a', resourceId: 'r' }, { serviceBookingId: 'foreign', resourceId: 'r' }], blocks: [] } as unknown as ServiceCalendar;
    const index = indexServiceCalendar(data, ['2027-01-01','2027-01-02'], 'Asia/Almaty');
    expect(index.bookings.get('r:2027-01-01')).toHaveLength(1); expect(index.bookings.get('r:2027-01-02')).toHaveLength(1);
  });
  it('keeps 5000 bookings over 300 resources complete without a resource-by-booking scan', () => {
    const data = { bookings: Array.from({ length: 5000 }, (_, i) => ({ id: String(i), startAt: '2027-01-01T09:00:00Z', endAt: '2027-01-01T10:00:00Z' })), allocations: Array.from({ length: 5000 }, (_, i) => ({ serviceBookingId: String(i), resourceId: 'r' + (i % 300) })), blocks: [] } as unknown as ServiceCalendar;
    const index = indexServiceCalendar(data, ['2027-01-01'], 'UTC');
    expect(index.bookings.size).toBe(300); expect([...index.bookings.values()].reduce((n, rows) => n + rows.length, 0)).toBe(5000);
  });
});
