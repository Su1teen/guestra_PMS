import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { hotelDate } from '../../lib/hotel-date';
import { serviceDays, serviceInstant } from '../../lib/service-time';
import { serviceRecoveryKey } from '../../lib/staff-booking-recovery';
import Modal from '../ui/Modal';
import { QueryError } from '../ui/ErrorBoundary';
import FolioDocumentButton from '../folios/FolioDocumentButton';
import ServiceBookingForm from './ServiceBookingForm';
import ServiceBookingDetail from './ServiceBookingDetail';
import { serviceStatus, type ServiceCalendar } from './types';

const RESERVATION_SERVICE_STATUSES: Record<string, string> = { quoted: 'Предложена', confirmed: 'Подтверждена', posted: 'Начислена', cancelled: 'Отменена' };

/**
 * Services of one stay, managed without leaving the reservation card:
 * scheduled bookings, package/stay services, adding a new one and the folio receipt.
 */
export default function ReservationServicesPanel({ reservation, propertyId, readOnly }: {
  reservation: { id: string; guestId?: string | null; arrivalDate?: string; departureDate?: string; status?: string; currencyCode?: string | null };
  propertyId: string; readOnly?: boolean;
}) {
  const { hasPermission, user } = useAuth();
  const { properties, currencyCode } = useProperty();
  const timeZone = properties.find(p => p.id === propertyId)?.timezone;
  const client = useQueryClient();
  const [modal, setModal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const canRead = hasPermission('services.read');
  const canSchedule = canRead && hasPermission('reservations.write');
  const canConsume = canRead && hasPermission('folios.manage');
  const canAdd = !readOnly && !!reservation.guestId && (canSchedule || canConsume);
  const today = hotelDate(timeZone);
  const from = reservation.arrivalDate && reservation.arrivalDate > today ? reservation.arrivalDate : today;
  const until = reservation.departureDate && reservation.departureDate > from ? reservation.departureDate : serviceDays(from, 2)[1]!;
  const range = timeZone ? { startAt: serviceInstant(from + 'T00:00', timeZone), endAt: serviceInstant(serviceDays(until, 2)[1]! + 'T00:00', timeZone) } : null;

  const stayServices = useQuery({ queryKey: ['reservation-services', propertyId, reservation.id],
    queryFn: () => api.get('/v1/ancillary/reservations/' + reservation.id + '/services', { params: { propertyId }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: hasPermission('reservations.read') });
  const bookings = useQuery({ queryKey: ['reservation-service-bookings', propertyId, reservation.id],
    queryFn: () => api.get('/v1/services/bookings', { params: { propertyId, reservationId: reservation.id }, skipErrorToast: true }).then(r => r.data?.data ?? r.data),
    enabled: canRead });
  const calendar = useQuery<ServiceCalendar>({ queryKey: ['service-calendar', propertyId, range?.startAt, range?.endAt, user?.sub],
    queryFn: () => api.get('/v1/services/calendar', { params: { propertyId, ...range }, skipErrorToast: true }).then(r => r.data),
    enabled: canRead && !!range && (modal !== null) });

  async function refresh() {
    for (const key of ['reservation-service-bookings', 'reservation-services', 'service-calendar', 'service-bookings', 'guest-360', 'folios', 'folio-charges-preview'])
      await client.invalidateQueries({ queryKey: [key] });
  }
  if (!canRead) return <p className="text-sm text-gray-500">Нет доступа к услугам.</p>;
  const scheduled: any[] = Array.isArray(bookings.data) ? bookings.data : [];
  const stay: any[] = Array.isArray(stayServices.data) ? stayServices.data : [];
  const open = scheduled.filter(row => row.status === 'scheduled').length;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      {canAdd && <button className="flex items-center gap-2 rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white" onClick={() => { setNotice(''); setModal('book'); }}><Plus size={14}/>Добавить услугу</button>}
      <FolioDocumentButton propertyId={propertyId} reservationId={reservation.id}/>
      {open > 0 && <span className="text-xs text-amber-800">Незавершённых услуг: {open}</span>}
    </div>
    {notice && <p role="status" className="rounded-lg bg-teal-50 p-3 text-sm">{notice}</p>}
    <section><h3 className="mb-2 text-sm font-semibold">Записи на услуги</h3>
      {bookings.isError ? <QueryError onRetry={() => void bookings.refetch()}/> : bookings.isPending ? <p role="status" className="text-xs text-gray-500">Загрузка…</p>
        : scheduled.length ? <div className="space-y-2">{scheduled.map(row => <button key={row.id} className="flex w-full flex-wrap justify-between gap-3 rounded-lg border p-3 text-left text-sm hover:bg-gray-50" onClick={() => setModal(row.id)}>
          <span><span className="font-medium">{row.name}</span> · {serviceStatus(row.status)}<span className="mt-1 block text-xs text-gray-500">{new Date(row.startAt).toLocaleString('ru-RU', { timeZone: timeZone ?? undefined, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} · {row.participants} участн.</span></span>
          <span>{formatMoney(row.totalAmount, row.currencyCode)}</span></button>)}</div>
        : <p className="py-2 text-xs text-gray-500">Записей на услуги нет.</p>}
    </section>
    <section><h3 className="mb-2 text-sm font-semibold">Пакеты и услуги проживания</h3>
      {stayServices.isError ? <QueryError onRetry={() => void stayServices.refetch()}/> : stayServices.isPending ? <p role="status" className="text-xs text-gray-500">Загрузка…</p>
        : stay.length ? <div className="space-y-2">{stay.map(row => <div key={row.id} className="flex justify-between gap-3 rounded-lg border p-3 text-sm"><span>{row.service?.name ?? row.serviceName ?? row.name ?? 'Услуга'} · {RESERVATION_SERVICE_STATUSES[row.status] ?? row.status}</span><span>{formatMoney(row.totalAmount ?? row.lineTotal ?? row.unitPrice, row.currencyCode ?? reservation.currencyCode ?? currencyCode)}</span></div>)}</div>
        : <p className="py-2 text-xs text-gray-500">Нет услуг в составе проживания.</p>}
    </section>
    <Modal open={modal !== null} onClose={() => { if (!busy) setModal(null); }} closeDisabled={busy} wide title={modal === 'book' ? 'Услуга для гостя брони' : 'Карточка услуги'}>
      {!timeZone ? <p role="alert">Укажите часовой пояс объекта в настройках.</p>
        : calendar.isError ? <QueryError onRetry={() => void calendar.refetch()}/>
        : !calendar.data ? <p role="status">Загрузка каталога услуг…</p>
        : modal === 'book' ? <ServiceBookingForm key={reservation.id} propertyId={propertyId} recoveryKey={serviceRecoveryKey(user?.sub ?? 'demo', propertyId)}
            timeZone={timeZone} services={calendar.data.services} resources={calendar.data.resources} canConsume={canConsume} canSchedule={canSchedule}
            initial={{ guestId: reservation.guestId ?? undefined, reservationId: reservation.id, start: from + 'T10:00' }} onBusy={setBusy}
            onSaved={(id, kind) => { setBusy(false); void refresh(); if (kind === 'consumption') { setModal(null); setNotice('Услуга начислена в фолио проживания.'); } else setModal(id); }}/>
        : modal ? <ServiceBookingDetail key={modal} id={modal} propertyId={propertyId} timeZone={timeZone} resources={calendar.data.resources} canWrite={canSchedule && !readOnly} canReadFolio={hasPermission('folios.read')} onBusy={setBusy}/> : null}
    </Modal>
  </div>;
}
