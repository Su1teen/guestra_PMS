import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { serviceDays, serviceInstant, serviceLocalInput } from '../../lib/service-time';
import { QueryError } from '../ui/ErrorBoundary';
export default function ServiceSlots({ propertyId, resourceId, date, timeZone, canWrite, onChoose }: {
  propertyId: string; resourceId: string; date: string; timeZone: string; canWrite: boolean; onChoose: (start: string, startAt: string) => void;
}) {
  const query = useQuery<{ capacity: number; slots: { startAt: string; endAt: string; inWorkingHours: boolean; availableUnits: number }[] }>({
    queryKey: ['service-calendar', 'slots', propertyId, resourceId, date], staleTime: 10000,
    queryFn: () => api.get(`/v1/services/resources/${resourceId}/slots`, { params: { propertyId, startAt: serviceInstant(date + 'T00:00', timeZone), endAt: serviceInstant(serviceDays(date,2)[1] + 'T00:00', timeZone) }, skipErrorToast: true }).then(r => r.data),
  });
  if (query.isError) return <QueryError onRetry={() => void query.refetch()}/>;
  if (!query.data) return <p role="status" className="text-xs">Проверка интервалов…</p>;
  const slots = query.data.slots.filter(s => s.inWorkingHours);
  return <div><p className="my-2 text-xs text-gray-500">Свободные места на момент проверки. Перед записью сервер проверит их ещё раз.</p>{!slots.length && <p className="text-xs">В этот день нет рабочих интервалов.</p>}<div className="grid max-h-80 grid-cols-2 gap-1 overflow-y-auto">{slots.map(slot => <button key={slot.startAt} type="button" disabled={!canWrite || !slot.availableUnits} onClick={() => onChoose(serviceLocalInput(slot.startAt,timeZone),slot.startAt)} className={`rounded border p-2 text-left text-xs ${slot.availableUnits ? 'border-teal-100 bg-teal-50' : 'border-gray-100 bg-gray-50 text-gray-400'}`}><span className="font-medium">{serviceLocalInput(slot.startAt,timeZone).slice(11)}–{serviceLocalInput(slot.endAt,timeZone).slice(11)}</span><span className="mt-1 block">{slot.availableUnits} из {query.data!.capacity} мест · {new Intl.DateTimeFormat('ru',{timeZone,timeZoneName:'shortOffset'}).formatToParts(new Date(slot.startAt)).find(p => p.type === 'timeZoneName')?.value}</span></button>)}</div></div>;
}
