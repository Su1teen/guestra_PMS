import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useProperty } from '../../context/PropertyContext';
import { hotelDate } from '../../lib/hotel-date';
import { serviceDays, serviceInstant } from '../../lib/service-time';
import { serviceRecoveryKey } from '../../lib/staff-booking-recovery';
import Modal from '../ui/Modal';
import { QueryError } from '../ui/ErrorBoundary';
import ServiceBookingForm from './ServiceBookingForm';
import ServiceBookingDetail from './ServiceBookingDetail';
import type { ServiceCalendar } from './types';

/** Books a service for a guest directly from the guest card (service-only or linked to a stay). */
export default function GuestServiceBookingButton({ propertyId, guestId, reservationId }: { propertyId: string; guestId: string; reservationId?: string }) {
  const { hasPermission, user } = useAuth();
  const { properties } = useProperty();
  const timeZone = properties.find(p => p.id === propertyId)?.timezone;
  const client = useQueryClient();
  const [modal, setModal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const canSchedule = hasPermission('services.read') && hasPermission('reservations.write');
  const canConsume = hasPermission('services.read') && hasPermission('folios.manage');
  const today = hotelDate(timeZone);
  const range = timeZone ? { startAt: serviceInstant(today + 'T00:00', timeZone), endAt: serviceInstant(serviceDays(today, 3)[2]! + 'T00:00', timeZone) } : null;
  const calendar = useQuery<ServiceCalendar>({ queryKey: ['service-calendar', propertyId, range?.startAt, range?.endAt, user?.sub],
    queryFn: () => api.get('/v1/services/calendar', { params: { propertyId, ...range }, skipErrorToast: true }).then(r => r.data),
    enabled: modal !== null && !!range });
  if (!canSchedule && !canConsume) return null;
  return <>
    <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" onClick={() => { setNotice(''); setModal('book'); }}><Plus size={14}/>Записать на услугу</button>
    {notice && <p role="status" className="text-sm text-teal-700">{notice}</p>}
    <Modal open={modal !== null} onClose={() => { if (!busy) setModal(null); }} closeDisabled={busy} wide title={modal === 'book' ? 'Услуга для гостя' : 'Карточка услуги'}>
      {!timeZone ? <p role="alert">Укажите часовой пояс объекта в настройках.</p>
        : calendar.isError ? <QueryError onRetry={() => void calendar.refetch()}/>
        : !calendar.data ? <p role="status">Загрузка каталога услуг…</p>
        : modal === 'book' ? <ServiceBookingForm propertyId={propertyId} recoveryKey={serviceRecoveryKey(user?.sub ?? 'demo', propertyId)} timeZone={timeZone}
            services={calendar.data.services} resources={calendar.data.resources} canConsume={canConsume} canSchedule={canSchedule}
            initial={{ guestId, reservationId, start: today + 'T10:00' }} onBusy={setBusy}
            onSaved={(id, kind) => {
              setBusy(false);
              for (const key of ['guest-360', 'service-calendar', 'service-bookings', 'reservation-service-bookings', 'folios']) void client.invalidateQueries({ queryKey: [key] });
              if (kind === 'consumption') { setModal(null); setNotice('Услуга начислена в фолио.'); } else setModal(id);
            }}/>
        : modal ? <ServiceBookingDetail key={modal} id={modal} propertyId={propertyId} timeZone={timeZone} resources={calendar.data.resources} canWrite={canSchedule} canReadFolio={hasPermission('folios.read')} onBusy={setBusy}/> : null}
    </Modal>
  </>;
}
