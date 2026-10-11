import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { errorMessage } from '../../lib/error-message';
import { serviceInstant, serviceLocalInput } from '../../lib/service-time';
import { QueryError } from '../ui/ErrorBoundary';
import type { Resource, ServiceBooking } from './types';
import { serviceStatus } from './types';
import { useAuth } from '../../context/AuthContext';

export default function ServiceBookingDetail({ id, propertyId, timeZone, resources, canWrite, canReadFolio, onBusy }: {
  id: string; propertyId: string; timeZone: string; resources: Resource[]; canWrite: boolean; canReadFolio: boolean; onBusy: (busy: boolean) => void;
}) {
  const client = useQueryClient(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const { hasPermission } = useAuth();
  const [start, setStart] = useState(''); const [resourceId, setResourceId] = useState(''); const [participants, setParticipants] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null); const receipt = useRef<{ fingerprint: string; key: string } | null>(null);
  const detail = useQuery<ServiceBooking>({ queryKey: ['service-bookings', propertyId, id], queryFn: () => api.get('/v1/services/bookings/' + id, { params: { propertyId }, skipErrorToast: true }).then(r => r.data) });
  const history = useQuery<any[]>({ queryKey: ['service-booking-history', propertyId, id], queryFn: () => api.get('/v1/services/bookings/' + id + '/history', { params: { propertyId }, skipErrorToast: true }).then(r => r.data) });
  const booking = detail.data;
  if (detail.isError) return <QueryError onRetry={() => void detail.refetch()}/>;
  if (!booking) return <p role="status">Загрузка записи…</p>;
  const localStart = start || serviceLocalInput(booking.startAt, timeZone);
  const selectedResource = resourceId || booking.allocations?.[0]?.resourceId || '';
  function changeBody() {
    const startAt = localStart === serviceLocalInput(booking!.startAt, timeZone) ? booking!.startAt : serviceInstant(localStart, timeZone);
    return { propertyId, expectedRevision: booking!.revision, startAt, endAt: new Date(Date.parse(startAt) + Date.parse(booking!.endAt) - Date.parse(booking!.startAt)).toISOString(), resourceId: selectedResource, participants: participants ?? booking!.participants };
  }
  async function act(kind: 'preview' | 'move' | 'cancel' | 'complete') {
    setBusy(true); onBusy(true); setError('');
    try {
      const body = kind === 'move' || kind === 'preview' ? changeBody() : { propertyId, expectedRevision: booking!.revision };
      const fingerprint = JSON.stringify({ kind, body });
      if (!receipt.current || receipt.current.fingerprint !== fingerprint) receipt.current = { fingerprint, key: crypto.randomUUID() };
      const request = { ...body, idempotencyKey: receipt.current.key };
      if (kind === 'preview') {
        const { data } = await api.post(`/v1/services/bookings/${id}/preview`, request, { skipErrorToast: true });
        if (!data.available) throw new Error('Новое время или ресурс заняты.');
        setPreview(JSON.stringify(changeBody()));
      } else {
        if (kind === 'move' && preview !== JSON.stringify(body)) throw new Error('Сначала проверьте перенос.');
        if (kind === 'move') await api.patch(`/v1/services/bookings/${id}`, request, { skipErrorToast: true });
        else await api.post(`/v1/services/bookings/${id}/${kind}`, request, { skipErrorToast: true });
        setPreview(null); receipt.current = null;
        for (const key of ['service-calendar','service-bookings','service-booking-history','reservation-service-bookings','guest-360','folios']) await client.invalidateQueries({ queryKey: [key] });
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); onBusy(false); }
  }
  const events: Record<string, string> = { 'service_booking.created': 'Запись создана', 'service_booking.rescheduled': 'Запись перенесена', 'service_booking.cancelled': 'Запись отменена', 'service_booking.completed': 'Услуга оказана' };
  return <div className="space-y-4">
    <div className="rounded-xl bg-gray-50 p-4"><p className="font-semibold">{serviceStatus(booking.status)} · {formatMoney(booking.totalAmount, booking.currencyCode)}</p><p className="mt-1 text-sm">{new Date(booking.startAt).toLocaleString('ru-RU', { timeZone })} — {new Date(booking.endAt).toLocaleTimeString('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' })}</p><p className="mt-1 text-xs">{booking.participants} участн. · {booking.quantity} услуг · {timeZone}</p>{booking.pricingSnapshot && <p className="mt-2 text-xs">Налоги: {formatMoney(booking.pricingSnapshot.taxAmount, booking.currencyCode)}. Согласованная стоимость сохранена.</p>}</div>
    {booking.notes && <p className="whitespace-pre-wrap text-sm">{booking.notes}</p>}
    {booking.financial?.requiresFinancialReview && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm">Запись отменена. Начисление требует ручной проверки в фолио. Возврат автоматически не выполнялся.</p>}
    {canReadFolio && booking.folioId && <Link className="inline-block rounded-lg border px-3 py-2 text-sm" to={`/folios/${booking.folioId}?propertyId=${propertyId}`}>Открыть фолио</Link>}
    <div className="flex flex-wrap gap-2">{hasPermission('guests.read') && booking.guestId && <Link className="rounded-lg border px-3 py-2 text-sm" to={`/guests/${booking.guestId}?propertyId=${propertyId}`}>Открыть гостя</Link>}{hasPermission('reservations.read') && booking.reservationId && <Link className="rounded-lg border px-3 py-2 text-sm" to={`/reservations/${booking.reservationId}?propertyId=${propertyId}&tab=services`}>Открыть проживание</Link>}</div>
    {canWrite && booking.status === 'scheduled' && <fieldset disabled={busy} className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-semibold">Перенести запись</h3>
      <label className="block text-sm">Новое начало<input type="datetime-local" className="mt-1 w-full rounded-lg border px-3 py-2" value={localStart} onChange={e => { setStart(e.target.value); setPreview(null); }}/></label>
      <label className="block text-sm">Ресурс<select className="mt-1 w-full rounded-lg border px-3 py-2" value={selectedResource} onChange={e => { setResourceId(e.target.value); setPreview(null); }}>{resources.filter(r => r.serviceId === booking.serviceId && (r.isActive || r.id === selectedResource)).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="block text-sm">Участники<input type="number" min="1" max="10000" className="mt-1 w-full rounded-lg border px-3 py-2" value={participants ?? booking.participants} onChange={e => { setParticipants(Number(e.target.value)); setPreview(null); }}/></label>
      {preview && <p role="status" className="text-sm text-teal-700">Перенос доступен. Стоимость сохраняется.</p>}
      <div className="flex flex-wrap gap-2"><button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void act('preview')}>Проверить перенос</button><button disabled={!preview} className="rounded-lg bg-telivity-teal px-3 py-2 text-sm text-white disabled:opacity-40" onClick={() => void act('move')}>Подтвердить перенос</button></div>
      <div className="flex flex-wrap gap-2 border-t pt-3"><button disabled={Date.parse(booking.startAt) > Date.now()} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40" onClick={() => void act('complete')}>Услуга оказана</button><button className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700" onClick={() => void act('cancel')}>Отменить запись</button></div>
    </fieldset>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="border-t pt-3"><h3 className="mb-2 text-sm font-semibold">История действий</h3>{history.isError ? <QueryError onRetry={() => void history.refetch()}/> : history.isPending ? <p>Загрузка…</p> : history.data?.map(e => <p key={e.id} className="mb-2 text-xs text-gray-600">{new Date(e.occurredAt).toLocaleString('ru-RU', { timeZone })} · {events[String(e.description).replace(/^Webhook event: /, '')] ?? 'Изменение записи'}</p>)}</div>
  </div>;
}
