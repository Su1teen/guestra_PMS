import { serviceInstant } from '../../lib/service-time';
import type { Resource, ServiceBooking, ServiceCalendar } from './types';

const pad = (hour: number) => String(hour).padStart(2, '0') + ':00';

/** Working hours shown for a day: union of the resources' schedule windows for that weekday, 08–22 otherwise. */
export function gridHours(resources: Resource[], date: string): number[] {
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const windows = resources.flatMap(r => r.schedule?.windows ?? []).filter(w => w.day === weekday);
  const first = windows.length ? Math.min(...windows.map(w => Number(w.start.slice(0, 2)))) : 8;
  const last = windows.length ? Math.max(...windows.map(w => Math.ceil(Number(w.end.slice(0, 2)) + Number(w.end.slice(3, 5)) / 60))) : 22;
  return Array.from({ length: Math.max(1, last - first) }, (_, i) => first + i);
}

/** Hour × resource chessboard of service bookings for one property day. */
export default function ServiceHourGrid({ data, resources, date, timeZone, canSchedule, onBook, onOpen }: {
  data: ServiceCalendar; resources: Resource[]; date: string; timeZone: string; canSchedule: boolean;
  onBook: (resourceId: string, start: string, startAt: string) => void; onOpen: (bookingId: string) => void;
}) {
  const hours = gridHours(resources, date);
  const bookings = new Map(data.bookings.map(b => [b.id, b]));
  const cell = (resource: Resource, hour: number) => {
    const startAt = serviceInstant(`${date}T${pad(hour)}`, timeZone);
    const from = Date.parse(startAt), to = from + 3_600_000;
    const overlaps = (start: string, end: string) => Date.parse(start) < to && Date.parse(end) > from;
    const rows: ServiceBooking[] = data.allocations.filter(a => a.resourceId === resource.id)
      .map(a => bookings.get(a.serviceBookingId)).filter((b): b is ServiceBooking => !!b && b.status !== 'cancelled' && overlaps(b.startAt, b.endAt));
    const block = data.blocks.find(b => b.resourceId === resource.id && overlaps(b.startAt, b.endAt));
    const used = rows.reduce((sum, b) => sum + b.participants, 0);
    return { startAt, rows, block, used };
  };
  return <div className="overflow-x-auto rounded-xl border bg-white">
    <table className="w-full border-collapse text-left text-xs" style={{ minWidth: 180 + hours.length * 64 }}>
      <caption className="sr-only">Шахматка услуг по часам</caption>
      <thead className="bg-gray-50"><tr><th scope="col" className="sticky left-0 z-10 w-44 bg-gray-50 p-3 text-sm">Ресурс</th>
        {hours.map(h => <th scope="col" key={h} className="border-l p-2 text-center font-medium text-gray-500">{pad(h)}</th>)}</tr></thead>
      <tbody>{resources.map(resource => <tr key={resource.id}>
        <th scope="row" className="sticky left-0 z-10 border-t bg-white p-3 align-top text-sm font-semibold">{resource.name}
          <span className="block text-xs font-normal text-gray-500">до {resource.capacity} мест</span></th>
        {hours.map(hour => {
          const { startAt, rows, block, used } = cell(resource, hour);
          const booking = rows[0];
          const label = block ? 'Блок' : booking ? (resource.capacity > 1 ? `${used}/${resource.capacity}` : booking.guestName || 'Занято') : '·';
          const title = block ? `Заблокировано · ${block.reason || 'без причины'}` : booking ? `${booking.guestName || 'Гость'} · ${rows.length} запис.` : 'Свободно — нажмите, чтобы записать';
          return <td key={hour} className="border-l border-t p-1">
            <button type="button" title={title} aria-label={`${resource.name} ${pad(hour)}: ${title}`}
              disabled={!!block || (!booking && (!canSchedule || !resource.isActive))}
              onClick={() => booking ? onOpen(booking.id) : onBook(resource.id, `${date}T${pad(hour)}`, startAt)}
              className={`min-h-9 w-full truncate rounded border px-1 text-center ${block ? 'bg-gray-200 text-gray-600' : booking ? booking.status === 'completed' ? 'border-teal-200 bg-teal-50 text-teal-900' : 'border-sky-200 bg-sky-50 text-sky-900' : 'hover:bg-gray-50'}`}>
              {label}</button>
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}
