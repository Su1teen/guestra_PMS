import { useState } from 'react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import type { Resource, Service } from './types';
const field = 'mt-1 w-full rounded-lg border px-3 py-2 text-sm';
export default function ServiceResourceEditor({ propertyId, timeZone, services, resources, onSaved, onBusy }: {
  propertyId: string; timeZone: string; services: Service[]; resources: Resource[]; onSaved: () => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const [resourceId, setResourceId] = useState('');
  const selected = resources.find(r => r.id === resourceId);
  const empty = { serviceId: services[0]?.id ?? '', code: '', name: '', capacity: 1, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, isActive: true,
    schedule: { timeZone, windows: [1,2,3,4,5].map(day => ({ day, start: '09:00', end: '18:00' })) } };
  const [form, setForm] = useState(empty); const [unrestricted, setUnrestricted] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const update = (patch: Partial<typeof form>) => { setForm(f => ({ ...f, ...patch })); setKey(crypto.randomUUID()); setSaved(false); };
  function choose(id: string) {
    const r = resources.find(row => row.id === id); setResourceId(id); setError(''); setSaved(false); setKey(crypto.randomUUID());
    setUnrestricted(!!r && !r.schedule);
    setForm(r ? { serviceId: r.serviceId, code: r.code, name: r.name, capacity: r.capacity, bufferBeforeMinutes: r.bufferBeforeMinutes, bufferAfterMinutes: r.bufferAfterMinutes,
      isActive: r.isActive, schedule: r.schedule ?? { timeZone, windows: [] } } : empty);
  }
  async function save() {
    setBusy(true); onBusy(true); setError(''); setSaved(false);
    try {
      const body = { ...form, schedule: unrestricted ? null : form.schedule, propertyId, idempotencyKey: key };
      if (selected) await api.patch(`/v1/services/resources/${selected.id}`, { ...body, expectedUpdatedAt: selected.updatedAt }, { skipErrorToast: true });
      else await api.post('/v1/services/resources', body, { skipErrorToast: true });
      await onSaved(); setKey(crypto.randomUUID()); setSaved(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); onBusy(false); }
  }
  function windowChange(index: number, patch: Partial<typeof form.schedule.windows[number]>) {
    update({ schedule: { ...form.schedule, windows: form.schedule.windows.map((w,i) => i === index ? { ...w, ...patch } : w) } });
  }
  return <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
    <fieldset disabled={busy} className="space-y-4">
      <label className="block text-sm">Ресурс<select className={field} value={resourceId} onChange={e => choose(e.target.value)}><option value="">Создать ресурс</option>{resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="block text-sm">Услуга<select required disabled={!!selected} className={field} value={form.serviceId} onChange={e => update({ serviceId: e.target.value })}>{services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Название<input required className={field} value={form.name} onChange={e => update({ name: e.target.value })}/></label><label className="text-sm">Код<input required className={field} value={form.code} onChange={e => update({ code: e.target.value })}/></label></div>
      <div className="grid gap-3 sm:grid-cols-3">{([['capacity','Вместимость'],['bufferBeforeMinutes','До, мин.'],['bufferAfterMinutes','После, мин.']] as const).map(([key,label]) => <label key={key} className="text-sm">{label}<input type="number" min={key === 'capacity' ? 1 : 0} max={key === 'capacity' ? 10000 : 1440} required className={field} value={form[key]} onChange={e => update({ [key]: Number(e.target.value) })}/></label>)}</div>
      <label className="block text-sm"><input type="checkbox" checked={form.isActive} onChange={e => update({ isActive: e.target.checked })}/> Ресурс доступен для новых записей</label>
      <label className="block text-sm"><input type="checkbox" checked={unrestricted} onChange={e => { setUnrestricted(e.target.checked); setKey(crypto.randomUUID()); setSaved(false); }}/> Без ограничений рабочего времени</label>
      {!unrestricted && <div className="space-y-2"><p className="text-sm">Рабочие интервалы · {form.schedule.timeZone}. Перерыв задаётся двумя отдельными интервалами.</p>{form.schedule.windows.map((w,i) => <div key={i} className="flex flex-wrap items-center gap-2"><select aria-label={`День интервала ${i+1}`} className="rounded-lg border p-2 text-sm" value={w.day} onChange={e => windowChange(i,{ day: Number(e.target.value) })}>{['Вс','Пн','Вт','Ср','Чт','Пт','Сб'].map((day,n) => <option key={n} value={n}>{day}</option>)}</select><input aria-label={`Начало интервала ${i+1}`} type="time" required className="rounded-lg border p-2 text-sm" value={w.start} onChange={e => windowChange(i,{ start: e.target.value })}/><input aria-label={`Конец интервала ${i+1}`} type="time" required className="rounded-lg border p-2 text-sm" value={w.end} onChange={e => windowChange(i,{ end: e.target.value })}/><button type="button" className="px-2 text-sm text-red-700" onClick={() => update({ schedule: { ...form.schedule, windows: form.schedule.windows.filter((_,n) => n !== i) } })}>Удалить интервал</button></div>)}<button type="button" disabled={form.schedule.windows.length >= 56} className="rounded-lg border px-3 py-2 text-sm" onClick={() => update({ schedule: { ...form.schedule, windows: [...form.schedule.windows, { day: 1, start: '09:00', end: '18:00' }] } })}>Добавить интервал</button></div>}
    </fieldset>
    <p className="text-xs text-gray-500">Принятые записи и их буферы сохраняются. Сокращение вместимости, рабочего времени или выключение занятого ресурса потребует переноса записей.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}{saved && <p role="status" className="text-sm text-teal-700">Настройки ресурса сохранены</p>}
    <button type="submit" disabled={busy || !form.serviceId} className="rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white">Сохранить ресурс</button>
  </form>;
}
