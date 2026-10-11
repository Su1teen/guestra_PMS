import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { errorMessage } from '../../lib/error-message';
import { serviceInstant } from '../../lib/service-time';
import { clearStaffRequest, readStaffRequest, saveStaffRequest } from '../../lib/staff-booking-recovery';
import type { Resource, Service } from './types';

const control = 'mt-1 w-full rounded-lg border px-3 py-2 text-sm';
export default function ServiceBookingForm({ propertyId, recoveryKey, timeZone, services, resources, initial, onSaved, onBusy }: {
  propertyId: string; recoveryKey: string; timeZone: string; services: Service[]; resources: Resource[]; initial: { guestId?: string; reservationId?: string; start: string; resourceId?: string }; onSaved: (id: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [form, setForm] = useState({ serviceId: resources.find(r => r.id === initial.resourceId)?.serviceId ?? services.find(s => s.isActive && s.agentBookingMode === 'live_booking')?.id ?? '', resourceId: initial.resourceId ?? '', start: initial.start, participants: 1, quantity: 1, guestId: initial.guestId ?? '', guestFirstName: '', guestLastName: '', guestPhone: '', notes: '' });
  const [quote, setQuote] = useState<{ fingerprint: string; total: string; currency: string; base: string; tax: string } | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const receipt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [guestSearch, setGuestSearch] = useState('');
  const guests = useQuery({ queryKey: ['guests', 'service-select', propertyId, guestSearch], queryFn: () => api.get('/v1/guests', { params: { propertyId, search: guestSearch, limit: 20 }, skipErrorToast: true }).then(r => r.data.data ?? r.data), enabled: guestSearch.trim().length >= 2 });
  const selected = services.find(s => s.id === form.serviceId);
  const update = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); setQuote(null); setError(''); };
  function payload() {
    if (!selected?.durationMinutes) throw new Error('Сначала настройте продолжительность услуги в каталоге.');
    if (!form.guestId && !form.guestFirstName.trim()) throw new Error('Выберите гостя или укажите имя нового клиента.');
    const startAt = serviceInstant(form.start, timeZone);
    return { propertyId, serviceId: form.serviceId, resourceId: form.resourceId || undefined, startAt, endAt: new Date(Date.parse(startAt) + selected.durationMinutes * 60000).toISOString(), participants: form.participants, quantity: form.quantity,
      guestId: form.guestId || undefined, guestFirstName: form.guestId ? undefined : form.guestFirstName.trim(), guestLastName: form.guestId ? undefined : form.guestLastName.trim() || undefined,
      guestPhone: form.guestId ? undefined : form.guestPhone.trim() || undefined, reservationId: initial.reservationId, notes: form.notes || undefined };
  }
  async function run(confirm: boolean) {
    setBusy(true); onBusy(true); setError('');
    try {
      const body = payload(); const fingerprint = JSON.stringify(body);
      if (!confirm) {
        const { data } = await api.post('/v1/services/availability', { propertyId, serviceId: body.serviceId, resourceId: body.resourceId, guestId: body.guestId, startAt: body.startAt, endAt: body.endAt, participants: body.participants, quantity: body.quantity }, { skipErrorToast: true });
        if (!data.available) throw new Error('Выбранное время недоступно. Измените время или ресурс.');
        setQuote({ fingerprint, total: data.pricing.totalAmount, currency: data.currencyCode, base: data.pricing.baseAmount, tax: data.pricing.taxAmount });
      } else {
        if (!quote || quote.fingerprint !== fingerprint) throw new Error('Сначала проверьте доступность и стоимость.');
        if (!receipt.current || receipt.current.fingerprint !== fingerprint) receipt.current = { fingerprint, key: crypto.randomUUID() };
        const pending = readStaffRequest(recoveryKey);
        if (pending && pending !== receipt.current.key) throw new Error('Сначала восстановите или закройте предыдущий запрос.');
        if (!saveStaffRequest(recoveryKey, receipt.current.key)) throw new Error('Не удалось сохранить ключ восстановления. Разрешите хранение данных для этой вкладки.');
        try {
          const { data } = await api.post('/v1/services/bookings', { ...body, expectedTotal: quote.total, idempotencyKey: receipt.current.key }, { skipErrorToast: true });
          clearStaffRequest(recoveryKey, receipt.current.key);
          setUncertain(false); onSaved(data.serviceBookingId);
        } catch (failure) {
          setUncertain(true);
          throw failure;
        }
      }
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); onBusy(false); }
  }
  async function recover() {
    if (!receipt.current) return;
    setBusy(true); onBusy(true);
    try { const { data } = await api.get('/v1/services/booking-request', { params: { propertyId, idempotencyKey: receipt.current.key }, skipErrorToast: true }); clearStaffRequest(recoveryKey, receipt.current.key); setUncertain(false); onSaved(data.id); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); onBusy(false); }
  }
  return <form onSubmit={e => { e.preventDefault(); void run(false); }} className="space-y-4">
    <p className="text-xs text-gray-500">Время объекта: {timeZone}. Запись создаёт начисление в существующем фолио.</p>
    <fieldset disabled={busy || uncertain} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Услуга<select className={control} value={form.serviceId} onChange={e => update({ serviceId: e.target.value, resourceId: '' })}><option value="">Выберите услугу</option>{services.filter(s => s.isActive && s.agentBookingMode === 'live_booking').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="text-sm">Ресурс<select className={control} value={form.resourceId} onChange={e => update({ resourceId: e.target.value })}><option value="">Подобрать доступный</option>{resources.filter(r => r.serviceId === form.serviceId && r.isActive).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="text-sm">Начало<input required type="datetime-local" className={control} value={form.start} onChange={e => update({ start: e.target.value })}/></label>
      <p className="self-center text-sm">Продолжительность: {selected?.durationMinutes ?? 'не задана'} мин.</p>
      <label className="text-sm">Участники<input type="number" min="1" max="10000" required className={control} value={form.participants} onChange={e => update({ participants: Number(e.target.value) })}/></label>
      <label className="text-sm">Количество услуг<input type="number" min="1" max="10000" required className={control} value={form.quantity} onChange={e => update({ quantity: Number(e.target.value) })}/></label>
      {!initial.guestId && <div className="sm:col-span-2"><label className="text-sm">Поиск существующего гостя<input className={control} value={guestSearch} onChange={e => setGuestSearch(e.target.value)} placeholder="Имя или телефон — от двух символов"/></label>{guests.isError && <p role="alert" className="text-sm text-red-700">Не удалось загрузить гостей</p>}{Array.isArray(guests.data) && <select aria-label="Существующий гость" className={control} value={form.guestId} onChange={e => update({ guestId: e.target.value })}><option value="">Новый клиент</option>{guests.data.map((g: any) => <option key={g.id} value={g.id}>{g.firstName} {g.lastName} · {g.phone ?? ''}</option>)}</select>}</div>}
      {!form.guestId && <><label className="text-sm">Имя клиента<input required className={control} value={form.guestFirstName} onChange={e => update({ guestFirstName: e.target.value })}/></label><label className="text-sm">Фамилия<input className={control} value={form.guestLastName} onChange={e => update({ guestLastName: e.target.value })}/></label><label className="text-sm">Телефон<input type="tel" className={control} value={form.guestPhone} onChange={e => update({ guestPhone: e.target.value })}/></label></>}
      <label className="text-sm sm:col-span-2">Комментарий<textarea className={control} value={form.notes} onChange={e => update({ notes: e.target.value })}/></label>
    </fieldset>
    {quote && <div className="rounded-xl bg-teal-50 p-4" aria-live="polite"><p className="font-semibold">Итого: {formatMoney(quote.total, quote.currency)}</p><p className="mt-1 text-xs">Основа: {formatMoney(quote.base, quote.currency)} · Налоги: {formatMoney(quote.tax, quote.currency)}</p></div>}
    {uncertain && <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm">Ответ не получен. Запрос мог быть принят. Проверьте результат или повторите его с сохранённым ключом.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="flex flex-wrap gap-2"><button disabled={busy || uncertain} className="rounded-lg border px-4 py-2 text-sm" type="submit">Проверить время и стоимость</button>{quote && <button disabled={busy} className="rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white" type="button" onClick={() => void run(true)}>{uncertain ? 'Повторить исходный запрос' : 'Подтвердить запись'}</button>}{uncertain && <button type="button" disabled={busy} className="rounded-lg border px-4 py-2 text-sm" onClick={() => void recover()}>Проверить результат</button>}</div>
  </form>;
}
