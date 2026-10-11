import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { serviceDays, serviceInstant, serviceLocalInput } from '../../lib/service-time';
import { QueryError } from '../ui/ErrorBoundary';
export default function ServiceSlots({ propertyId, resourceId, date, timeZone, canWrite, onChoose }: {
  propertyId: string; resourceId: string; date: string; timeZone: string; canWrite: boolean; onChoose: (start: string) => void;
}) {
  const query = useQuery<{ capacity: number; slots: { startAt: string; endAt: string; availableUnits: number }[] }>({
    queryKey: ['service-calendar', 'slots', propertyId, resourceId, date], staleTime: 10000,
    queryFn: () => api.get(`/v1/services/resources/${resourceId}/slots`, { params: { propertyId, startAt: serviceInstant(date + 'T00:00', timeZone), endAt: serviceInstant(serviceDays(date,2)[1] + 'T00:00', timeZone) }, skipErrorToast: true }).then(r => r.data),
  });
  if (query.isError) return <QueryError onRetry={() => void query.refetch()}/>;
  if (!query.data) return <p role="status" className="text-xs">Проверка интервалов…</p>;
  return <div><p className="my-2 text-xs text-gray-500">Свободные места на момент проверки. Перед записью сервер проверит их ещё раз.</p><div className="grid grid-cols-2 gap-1">{query.data.slots.map(slot => <button key={slot.startAt} type="button" disabled={!canWrite || !slot.availableUnits} onClick={() => onChoose(serviceLocalInput(slot.startAt,timeZone))} className={`rounded border p-2 text-left text-xs ${slot.availableUnits ? 'border-teal-100 bg-teal-50' : 'border-gray-100 bg-gray-50 text-gray-400'}`}><span className="font-medium">{serviceLocalInput(slot.startAt,timeZone).slice(11)}–{serviceLocalInput(slot.endAt,timeZone).slice(11)}</span><span className="mt-1 block">{slot.availableUnits} из {query.data!.capacity} мест</span></button>)}</div></div>;
}
