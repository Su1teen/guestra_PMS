import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Settings2 } from 'lucide-react';
import { useProperty } from '../context/PropertyContext';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import { hotelDate } from '../lib/hotel-date';
import { serviceDays, serviceInstant, serviceLocalInput } from '../lib/service-time';
import { formatMoney } from '../lib/money';
import { errorMessage } from '../lib/error-message';
import Modal from '../components/ui/Modal';
import { QueryError } from '../components/ui/ErrorBoundary';
import ServiceBookingForm from '../components/services/ServiceBookingForm';
import ServiceBookingDetail from '../components/services/ServiceBookingDetail';
import type { ServiceCalendar, Service } from '../components/services/types';
import { serviceStatus } from '../components/services/types';
import ServiceResourceEditor from '../components/services/ServiceResourceEditor';
import ServiceSlots from '../components/services/ServiceSlots';
import { indexServiceCalendar } from '../lib/service-calendar';
import { clearStaffRequest, serviceRecoveryKey, usePendingStaffRequest } from '../lib/staff-booking-recovery';

const field = 'w-full rounded-lg border px-3 py-2 text-sm';
export default function Services() {
  const { propertyId, properties, currencyCode } = useProperty(); const { hasPermission, user } = useAuth();
  const property = properties.find(p => p.id === propertyId); const timeZone = property?.timezone;
  const client = useQueryClient(); const [params, setParams] = useSearchParams();
  const recoveryKey = serviceRecoveryKey(user?.sub ?? 'demo', propertyId ?? '');
  const pending = usePendingStaffRequest(recoveryKey);
  const [recoveryError, setRecoveryError] = useState(''); const [consumptionFolio, setConsumptionFolio] = useState<string | null>(null);
  const [date, setDate] = useState(params.get('date') ?? hotelDate(timeZone)); const [view, setView] = useState<'day'|'week'>(params.get('view') === 'week' ? 'week' : 'day');
  const dateInitialized = useRef(!!timeZone || !!params.get('date'));
  const [filter, setFilter] = useState(params.get('serviceId') ?? ''); const [resourceFilter, setResourceFilter] = useState(params.get('resourceId') ?? '');
  const [modal, setModal] = useState<string | null>(params.get('bookingId') ?? (params.get('action') === 'book' ? 'book' : null));
  const [busy, setBusy] = useState(false); const [slot, setSlot] = useState<{ resourceId?: string; start: string; startAt?: string }>({ start: date + 'T09:00' });
  const [resourceLimit, setResourceLimit] = useState(50);
  const [expandedSlots, setExpandedSlots] = useState('');
  const scope = propertyId + ':' + user?.sub; const previousScope = useRef(scope);
  useEffect(() => { if (timeZone && !dateInitialized.current) { const today = hotelDate(timeZone); setDate(today); setSlot({ start: today + 'T09:00' }); dateInitialized.current = true; } }, [timeZone]);
  useEffect(() => { if (previousScope.current !== scope) { setModal(null); setConsumptionFolio(null); setBusy(false); setFilter(''); setResourceFilter(''); setExpandedSlots(''); setResourceLimit(50); setDate(hotelDate(timeZone)); previousScope.current = scope; } }, [scope, timeZone]);
  useEffect(() => {
    setParams(prev => {
      if (prev.get('date') === date && prev.get('view') === view && (prev.get('serviceId') ?? '') === filter && (prev.get('resourceId') ?? '') === resourceFilter) return prev;
      const next = new URLSearchParams(prev); next.set('date', date); next.set('view', view);
      if (filter) next.set('serviceId', filter); else next.delete('serviceId');
      if (resourceFilter) next.set('resourceId', resourceFilter); else next.delete('resourceId');
      return next;
    }, { replace: true });
  }, [date, view, filter, resourceFilter, setParams]);
  const canRead = !!propertyId && propertyId !== 'portfolio' && hasPermission('services.read');
  const canSchedule = canRead && hasPermission('reservations.write'); const canWrite = canSchedule || (canRead && hasPermission('folios.manage')); const canManage = canRead && hasPermission('services.manage');
  const days = serviceDays(date, view === 'day' ? 1 : 7);
  const range = timeZone ? { startAt: serviceInstant(date + 'T00:00', timeZone), endAt: serviceInstant(serviceDays(date, days.length + 1).at(-1)! + 'T00:00', timeZone) } : null;
  const calendar = useQuery<ServiceCalendar>({ queryKey: ['service-calendar', propertyId, range?.startAt, range?.endAt, user?.sub], queryFn: () => api.get('/v1/services/calendar', { params: { propertyId, ...range }, skipErrorToast: true }).then(r => r.data), enabled: canRead && !!range });
  const dayKey = days.join(',');
  const index = useMemo(() => indexServiceCalendar(calendar.data, dayKey.split(','), timeZone ?? 'UTC'), [calendar.data, dayKey, timeZone]);
  function clearBookingContext() { setModal(null); setParams(prev => { const next = new URLSearchParams(prev); next.delete('bookingId'); next.delete('action'); next.delete('guestId'); next.delete('reservationId'); return next; }, { replace: true }); }
  function close() { if (!busy) clearBookingContext(); }
  function openBooking(id: string) { setModal(id); setParams(prev => { const next = new URLSearchParams(prev); next.set('bookingId', id); next.delete('action'); next.delete('guestId'); next.delete('reservationId'); return next; }, { replace: true }); }
  async function refresh() { for (const key of ['service-calendar','service-bookings','guest-360','folios']) await client.invalidateQueries({ queryKey: [key] }); }
  async function recoverRequest(closeAttempt: boolean) {
    if (!pending) return;
    setBusy(true); setRecoveryError('');
    try {
      const { data } = closeAttempt
        ? await api.post(canSchedule ? '/v1/services/booking-request/close' : '/v1/services/consumption/booking-request/close', { propertyId, idempotencyKey: pending }, { skipErrorToast: true })
        : await api.get(canSchedule ? '/v1/services/booking-request' : '/v1/services/consumption/booking-request', { params: { propertyId, idempotencyKey: pending }, skipErrorToast: true });
      clearStaffRequest(recoveryKey, pending);
      if (data.kind === 'consumption') { clearBookingContext(); setConsumptionFolio(data.folioId); } else if (data.status === 'closed') clearBookingContext(); else openBooking(data.serviceBookingId ?? data.id);
      await refresh();
    } catch (e) { setRecoveryError(errorMessage(e)); } finally { setBusy(false); }
  }
  if (!propertyId || propertyId === 'portfolio') return <p className="p-8">Выберите объект для работы с услугами.</p>;
  if (!canRead) return <p role="alert" className="p-8">Нет доступа к услугам этого объекта.</p>;
  if (!timeZone) return <p role="alert" className="p-8">Укажите часовой пояс объекта в настройках.</p>;
  const data = calendar.data; const catalog = data?.services ?? []; const resources = data?.resources ?? [];
  const filteredResources = resources.filter(r => (!filter || r.serviceId === filter) && (!resourceFilter || r.id === resourceFilter));
  const visibleResources = filteredResources.slice(0, resourceLimit);
  return <div className="space-y-5">
    {consumptionFolio && <div role="status" className="rounded-xl bg-teal-50 p-4 text-sm">Услуга начислена в фолио. Оплата не подтверждалась. {hasPermission('folios.read') && <Link className="ml-2 underline" to={'/folios/' + consumptionFolio + '?propertyId=' + propertyId}>Открыть фолио</Link>}</div>}
    <label className="block text-sm">Ресурс или сотрудник <select aria-label="Фильтр ресурсов" className="ml-2 rounded-lg border bg-white px-2 py-1" value={resourceFilter} onChange={e => setResourceFilter(e.target.value)}><option value="">Все ресурсы</option>{resources.filter(r => !filter || r.serviceId === filter).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
    {canWrite && pending && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"><p>Есть незавершённый запрос записи. Проверка доступна после перезагрузки этой вкладки. Данные гостя в браузере не сохраняются.</p><div className="mt-3 flex flex-wrap gap-2"><button disabled={busy} className="rounded-lg border bg-white px-3 py-2" onClick={() => void recoverRequest(false)}>Найти принятую запись</button><button disabled={busy} className="rounded-lg border bg-white px-3 py-2" onClick={() => void recoverRequest(true)}>Закрыть непринятый запрос</button></div><p className="mt-2 text-xs">Если сервер уже принял запрос, откроется его карточка. Закрытие запроса не отменяет принятую запись.</p>{recoveryError && <p role="alert" className="mt-2 text-red-700">{recoveryError}</p>}</div>}
    <header className="flex flex-wrap items-center gap-3"><CalendarDays className="text-telivity-teal"/><div><h1 className="text-2xl font-semibold text-telivity-navy">Услуги и ресурсы</h1><p className="mt-1 text-xs text-gray-500">Записи, доступность и оказание услуг · {timeZone}</p></div><div className="ml-auto flex gap-2">{canManage && <button className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" onClick={() => setModal('settings')}><Settings2 size={16}/>Настроить</button>}{canWrite && <button disabled={!data} className="flex items-center gap-2 rounded-lg bg-telivity-teal px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" onClick={() => { setSlot({ start: date + 'T09:00' }); setModal('book'); }}><Plus size={16}/>{canSchedule ? 'Записать на услугу' : 'Добавить услугу'}</button>}</div></header>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-white p-3"><button aria-label="Предыдущий период" className="rounded-lg border p-2" onClick={() => setDate(serviceDays(new Date(Date.parse(date + 'T12:00Z') - days.length * 86400000).toISOString().slice(0,10), 1)[0]!)}><ChevronLeft size={16}/></button><label className="text-sm">Дата <input aria-label="Дата календаря" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} className="rounded-lg border px-2 py-1"/></label><button aria-label="Следующий период" className="rounded-lg border p-2" onClick={() => setDate(serviceDays(date, days.length + 1).at(-1)!)}><ChevronRight size={16}/></button><div className="flex rounded-lg border p-1">{(['day','week'] as const).map(v => <button aria-pressed={view === v} key={v} onClick={() => setView(v)} className={`rounded-md px-3 py-1 text-sm ${view === v ? 'bg-telivity-navy text-white' : ''}`}>{v === 'day' ? 'День' : 'Неделя'}</button>)}</div><label className="ml-auto text-sm">Услуга <select aria-label="Фильтр услуг" value={filter} onChange={e => setFilter(e.target.value)} className="rounded-lg border px-2 py-1"><option value="">Все услуги</option>{catalog.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></div>
    {calendar.isError ? <QueryError onRetry={() => void calendar.refetch()}/> : calendar.isPending ? <p role="status">Загрузка календаря…</p> : !visibleResources.length ? <div className="rounded-xl border border-dashed bg-white p-10 text-center"><h2 className="font-semibold">Ресурсы ещё не настроены</h2><p className="mt-2 text-sm text-gray-500">Добавьте ресурс к услуге и задайте её налоговый режим и продолжительность.</p></div> : <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full border-collapse text-left text-sm" style={{ minWidth: view === 'week' ? 1250 : 550 }}><caption className="sr-only">Календарь услуг по ресурсам</caption><thead className="bg-gray-50"><tr><th scope="col" className="sticky left-0 z-10 w-48 bg-gray-50 p-4">Ресурс</th>{days.map(d => <th scope="col" key={d} className="min-w-36 border-l p-3">{new Date(d + 'T12:00Z').toLocaleDateString('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })}</th>)}</tr></thead><tbody>{visibleResources.map(r => <tr key={r.id}><th scope="row" className="sticky left-0 z-10 border-t bg-white p-4 align-top"><p className="font-semibold">{r.name}</p><p className="mt-1 text-xs font-normal text-gray-500">{catalog.find(s => s.id === r.serviceId)?.name} · {r.capacity} мест</p><p className="mt-1 text-xs font-normal text-gray-500">Буферы {r.bufferBeforeMinutes}/{r.bufferAfterMinutes} мин.</p>{!r.isActive && <p className="mt-1 text-xs text-amber-700">Ресурс выключен</p>}</th>{days.map(d => {
      const rows = index.bookings.get(r.id + ':' + d) ?? [];
      const blocks = index.blocks.get(r.id + ':' + d) ?? [];
      return <td key={d} className="border-l border-t p-2 align-top"><div className="space-y-2">{blocks.map(b => <div key={b.id} className="rounded-lg bg-gray-100 p-2 text-xs"><p>Заблокировано · {b.reason || 'Без причины'}</p><p>{serviceLocalInput(b.startAt, timeZone).slice(11)}–{serviceLocalInput(b.endAt, timeZone).slice(11)}</p>{canManage && <RemoveBlock id={b.id} propertyId={propertyId} onSaved={refresh}/>}</div>)}{rows.map(b => <button key={b.id} className={`block w-full rounded-lg border p-3 text-left ${b.status === 'cancelled' ? 'border-gray-200 bg-gray-50 text-gray-500' : b.status === 'completed' ? 'border-teal-100 bg-teal-50' : 'border-sky-100 bg-sky-50'}`} onClick={() => openBooking(b.id)}><p className="font-semibold">{serviceLocalInput(b.startAt, timeZone).slice(11)}–{serviceLocalInput(b.endAt, timeZone).slice(11)}</p><p className="mt-1 truncate">{b.guestName || 'Клиент услуги'}</p><p className="mt-1 text-xs">{serviceStatus(b.status)} · {b.participants} участн.</p><p className="mt-1 text-xs">{formatMoney(b.totalAmount, b.currencyCode)}</p></button>)}<button className="w-full rounded-lg border px-3 py-2 text-xs" aria-expanded={expandedSlots === r.id + ':' + d} onClick={() => setExpandedSlots(value => value === r.id + ':' + d ? '' : r.id + ':' + d)}>Время и свободные места</button>{expandedSlots === r.id + ':' + d && <ServiceSlots propertyId={propertyId} resourceId={r.id} date={d} timeZone={timeZone} canWrite={canSchedule} onChoose={(start, startAt) => { setSlot({ start, startAt, resourceId: r.id }); setModal('book'); }}/>} {canSchedule && r.isActive && <button className="w-full rounded-lg border border-dashed px-3 py-2 text-xs text-gray-600" onClick={() => { setSlot({ start: d + 'T09:00', resourceId: r.id }); setModal('book'); }}>+ Записать</button>}</div></td>;
    })}</tr>)}</tbody></table></div>}
    {filteredResources.length > resourceLimit && <button className="rounded-lg border px-4 py-2 text-sm" onClick={() => setResourceLimit(n => n + 50)}>Показать ещё ресурсы ({resourceLimit} из {filteredResources.length})</button>}
    <Modal open={modal !== null && !!data} onClose={close} closeDisabled={busy} wide title={modal === 'settings' ? 'Настройки услуг и ресурсов' : modal === 'book' ? (canSchedule ? 'Запись на услугу' : 'Оформить услугу') : 'Карточка услуги'}>
      {data && modal === 'book' && canWrite ? <ServiceBookingForm key={`${propertyId}:${user?.sub}:${slot.start}:${slot.resourceId}`} propertyId={propertyId} recoveryKey={recoveryKey} canConsume={hasPermission('folios.manage')} canSchedule={canSchedule} timeZone={timeZone} services={catalog} resources={resources} initial={{ ...slot, guestId: params.get('guestId') ?? undefined, reservationId: params.get('reservationId') ?? undefined }} onBusy={setBusy} onSaved={(id, kind) => { setBusy(false); if (kind === 'consumption') { clearBookingContext(); setConsumptionFolio(id); } else openBooking(id); void refresh(); }}/>
      : data && modal === 'settings' && canManage ? <ServiceSettings propertyId={propertyId} currencyCode={currencyCode} timeZone={timeZone} services={catalog} resources={resources} onSaved={refresh} onBusy={setBusy}/>
      : modal && !['book','settings'].includes(modal) && data ? <ServiceBookingDetail key={`${propertyId}:${modal}`} id={modal} propertyId={propertyId} timeZone={timeZone} resources={resources} canWrite={canSchedule} canReadFolio={hasPermission('folios.read')} onBusy={setBusy}/> : null}
    </Modal>
  </div>;
}

function RemoveBlock({ id, propertyId, onSaved }: { id: string; propertyId: string; onSaved: () => Promise<void> }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [key] = useState(() => crypto.randomUUID());
  return <><button disabled={busy} className="mt-2 underline" onClick={async () => { setBusy(true); try { await api.post(`/v1/services/resource-blocks/${id}/remove`, { propertyId, idempotencyKey: key }, { skipErrorToast: true }); await onSaved(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); } }}>Снять блокировку</button>{error && <p role="alert">{error}</p>}</>;
}

function ServiceSettings({ propertyId, currencyCode, timeZone, services, resources, onSaved, onBusy }: {
  propertyId: string; currencyCode: string | null; timeZone: string; services: Service[]; resources: ServiceCalendar['resources']; onSaved: () => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const [kind, setKind] = useState('catalog'); const [serviceId, setServiceId] = useState(services[0]?.id ?? ''); const selected = services.find(s => s.id === serviceId);
  const [form, setForm] = useState({ name: '', code: '', price: '', duration: 60, taxMode: '', chargeType: 'spa', bookingMode: 'disabled' });
  const [saved, setSaved] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [key, setKey] = useState(() => crypto.randomUUID());
  const [block, setBlock] = useState({ resourceId: resources[0]?.id ?? '', start: '', end: '', reason: '' });
  useEffect(() => { setForm(f => ({ ...f, name: selected?.name ?? '', code: selected?.code ?? '', price: selected?.price ?? '', duration: selected?.durationMinutes ?? 60, taxMode: selected?.taxMode ?? '', chargeType: selected?.chargeType ?? 'spa', bookingMode: selected?.agentBookingMode ?? 'disabled' })); setSaved(false); }, [selected?.id]);
  const update = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); setKey(crypto.randomUUID()); };
  async function save() {
    setBusy(true); onBusy(true); setError('');
    try {
      if (kind === 'catalog') {
        if (!form.taxMode) throw new Error('Выберите налоговый режим явно.');
        if (selected) await api.patch(`/v1/ancillary/services/${selected.id}`, { name: form.name, code: form.code, price: form.price, chargeType: form.chargeType, taxMode: form.taxMode, durationMinutes: form.bookingMode === 'live_booking' ? form.duration : null, agentBookingMode: form.bookingMode }, { params: { propertyId }, skipErrorToast: true });
        else { if (!currencyCode) throw new Error('Валюта объекта не задана.'); await api.post('/v1/ancillary/services', { propertyId, code: form.code, name: form.name, chargeType: form.chargeType, price: form.price, currencyCode, postingRule: 'on_consumption', taxMode: form.taxMode, durationMinutes: form.bookingMode === 'live_booking' ? form.duration : undefined, agentBookingMode: form.bookingMode }, { skipErrorToast: true }); }
      } else await api.post('/v1/services/resource-blocks', { propertyId, resourceId: block.resourceId, startAt: serviceInstant(block.start, timeZone), endAt: serviceInstant(block.end, timeZone), reason: block.reason, idempotencyKey: key }, { skipErrorToast: true });
      setKey(crypto.randomUUID()); await onSaved(); setSaved(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); onBusy(false); }
  }
  return <div className="space-y-4"><div className="flex flex-wrap gap-2">{[['catalog','Каталог'],['resources','Ресурсы'],['block','Блокировка']].map(([id,label]) => <button key={id} type="button" disabled={busy} aria-pressed={kind === id} className={`rounded-lg border px-3 py-2 text-sm ${kind === id ? 'bg-telivity-navy text-white' : ''}`} onClick={() => { setKind(id!); setError(''); setSaved(false); setKey(crypto.randomUUID()); }}>{label}</button>)}</div>{kind === 'resources' ? <ServiceResourceEditor propertyId={propertyId} timeZone={timeZone} services={services} resources={resources} onSaved={onSaved} onBusy={onBusy}/> : <form onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={busy} className="space-y-3">
    {kind !== 'block' && <label className="block text-sm">Услуга<select className={field} value={serviceId} onChange={e => { setServiceId(e.target.value); setKey(crypto.randomUUID()); }}>{kind === 'catalog' && <option value="">Создать новую услугу</option>}{services.map(s => <option key={s.id} value={s.id}>{s.name} · {s.taxMode ? 'налоги заданы' : 'налоги не настроены'}</option>)}</select></label>}
    {kind === 'catalog' && <><label className="block text-sm">Название<input required className={field} value={form.name} onChange={e => update({ name: e.target.value })}/></label><label className="block text-sm">Код<input required className={field} value={form.code} onChange={e => update({ code: e.target.value })}/></label></>}
    {kind === 'catalog' && <>{selected && <p className="text-xs text-gray-500">Текущие настройки: {selected.durationMinutes ?? '—'} мин. · {selected.taxMode === 'none' ? 'Без налога' : selected.taxMode === 'inclusive' ? 'Включён в цену' : selected.taxMode === 'exclusive' ? 'Сверху цены' : 'Режим не задан'}. Цена {formatMoney(selected.price, selected.currencyCode)}. Новые настройки не меняют принятые записи.</p>}{<><label className="block text-sm">Цена<input required inputMode="decimal" className={field} value={form.price} onChange={e => update({ price: e.target.value })}/></label><label className="block text-sm">Тип начисления<select className={field} value={form.chargeType} onChange={e => update({ chargeType: e.target.value })}>{[['spa','СПА'],['food_beverage','Питание'],['minibar','Мини-бар'],['phone','Телефон'],['parking','Парковка'],['laundry','Прачечная'],['incidental','Дополнительная услуга'],['fee','Сбор'],['package','Пакет'],['adjustment','Корректировка']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label></>}<label className="block text-sm">Доступность записи<select className={field} value={form.bookingMode} onChange={e => update({ bookingMode: e.target.value })}><option value="disabled">Без записи на время</option><option value="live_booking">Запись на время и ресурс</option><option value="request_only">Только заявка</option><option value="info_only">Только информация</option></select></label><label className="block text-sm">Продолжительность, мин.<input disabled={form.bookingMode !== 'live_booking'} required={form.bookingMode === 'live_booking'} min="1" type="number" className={field} value={form.duration} onChange={e => update({ duration: Number(e.target.value) })}/></label><label className="block text-sm">Налоговый режим<select required className={field} value={form.taxMode} onChange={e => update({ taxMode: e.target.value })}><option value="">Выберите режим</option><option value="none">Без налога</option><option value="exclusive">Налог добавляется сверху</option><option value="inclusive">Налог включён в цену</option></select></label></>}
    {kind === 'block' && <><label className="block text-sm">Ресурс<select className={field} value={block.resourceId} onChange={e => { setBlock(b => ({ ...b, resourceId: e.target.value })); setKey(crypto.randomUUID()); }}>{resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>{(['start','end'] as const).map((v,i) => <label key={v} className="block text-sm">{i ? 'Окончание' : 'Начало'}<input type="datetime-local" required className={field} value={block[v]} onChange={e => { setBlock(b => ({ ...b, [v]: e.target.value })); setKey(crypto.randomUUID()); }}/></label>)}<label className="block text-sm">Причина<input className={field} value={block.reason} onChange={e => { setBlock(b => ({ ...b, reason: e.target.value })); setKey(crypto.randomUUID()); }}/></label><p className="text-xs text-gray-500">Занятые интервалы не блокируются. Сначала перенесите существующие записи.</p></>}
    </fieldset>{saved && <p role="status" className="mt-3 text-sm text-teal-700">Настройки сохранены</p>}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<button disabled={busy} className="rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white" type="submit">Сохранить</button></form>}</div>;
}
