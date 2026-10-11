import type { ServiceBooking, ServiceCalendar } from '../components/services/types';
import { serviceLocalInput } from './service-time';
export function indexServiceCalendar(data: ServiceCalendar | undefined, days: string[], timeZone: string) {
  const bookings = new Map<string, ServiceBooking[]>();
  const blocks = new Map<string, ServiceCalendar['blocks']>();
  const byId = new Map(data?.bookings.map(b => [b.id, b]) ?? []);
  const dateRange = (startAt: string, endAt: string) => [serviceLocalInput(startAt, timeZone).slice(0,10), serviceLocalInput(new Date(Date.parse(endAt) - 1), timeZone).slice(0,10)];
  for (const allocation of data?.allocations ?? []) {
    const booking = byId.get(allocation.serviceBookingId); if (!booking) continue;
    const [start, end] = dateRange(booking.startAt, booking.endAt);
    for (const day of days) if (day >= start! && day <= end!) { const key = allocation.resourceId + ':' + day; const rows = bookings.get(key) ?? []; rows.push(booking); bookings.set(key, rows); }
  }
  for (const block of data?.blocks ?? []) {
    const [start, end] = dateRange(block.startAt, block.endAt);
    for (const day of days) if (day >= start! && day <= end!) { const key = block.resourceId + ':' + day; const rows = blocks.get(key) ?? []; rows.push(block); blocks.set(key, rows); }
  }
  return { bookings, blocks };
}
