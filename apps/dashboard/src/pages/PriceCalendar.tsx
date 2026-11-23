import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addMonths, endOfMonth, format, getISODay, startOfMonth } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { formatMoney } from '../lib/money';
import { getDateLocale } from '../lib/date-locale';
import { useProperty } from '../context/PropertyContext';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/ui/Modal';
import { QueryError } from '../components/ui/ErrorBoundary';
import RevenueWorkspaceNav from '../components/revenue/RevenueWorkspaceNav';

type Kind = 'season' | 'holiday' | 'promo';
interface Step { step: string; label: string; amount: number }
interface Day { date: string; ratePlanId: string; roomTypeId: string | null; price: number; currencyCode: string; steps: Step[] }
interface RoomType { id: string; name: string; minPrice: string | null; maxPrice: string | null }
interface Rule { id: string; kind: Kind; name: string; startDate: string; endDate: string; roomTypeIds: string[]; adjustmentType: 'percent' | 'fixed_price'; value: string; isActive: boolean; reason: string; revision: number }
interface Calendar { roomTypes: RoomType[]; ratePlans: Array<{ id: string; name: string; roomTypeId: string | null }>; days: Day[]; rules: Rule[] }
interface Draft { kind: Kind; name: string; startDate: string; endDate: string; roomTypeIds: string[]; adjustmentType: 'percent' | 'fixed_price'; value: string; reason: string }

const KIND = { season: 'Сезон', holiday: 'Праздник', promo: 'Акция' } as const;
const KIND_STYLE: Record<string, string> = { holiday: 'bg-rose-50 text-rose-800', season: 'bg-sky-50 text-sky-800', promo: 'bg-emerald-50 text-emerald-800',
  manual: 'bg-amber-50 text-amber-800', min: 'bg-gray-100 text-gray-700', max: 'bg-gray-100 text-gray-700' };
const errorText = (error: any) => error?.response?.data?.message ? [error.response.data.message].flat().join('; ') : 'Не удалось выполнить действие';

/** «Календарь цен»: final nightly price with the reasons, seasons / holidays / promos with preview, min / max and the change log. */
export default function PriceCalendar() {
  const { i18n } = useTranslation();
  const { propertyId, currencyCode } = useProperty();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('rateplans.manage');
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [roomTypeId, setRoomTypeId] = useState('');
  const [planId, setPlanId] = useState('');
  const [selected, setSelected] = useState<Day | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const from = format(month, 'yyyy-MM-dd'); const to = format(endOfMonth(month), 'yyyy-MM-dd');

  const calendar = useQuery<Calendar>({ queryKey: ['price-calendar', propertyId, from, to], enabled: !!propertyId,
    queryFn: () => api.get('/v1/price-calendar', { params: { propertyId, from, to }, skipErrorToast: true }).then((r) => r.data) });
  const history = useQuery<any[]>({ queryKey: ['price-calendar-history', propertyId], enabled: !!propertyId,
    queryFn: () => api.get('/v1/price-calendar/history', { params: { propertyId }, skipErrorToast: true }).then((r) => r.data) });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['price-calendar'] }); void queryClient.invalidateQueries({ queryKey: ['price-calendar-history'] }); };

  const data = calendar.data;
  const plans = (data?.ratePlans ?? []).filter((p) => !roomTypeId || p.roomTypeId === roomTypeId);
  const plan = plans.find((p) => p.id === planId) ?? plans[0];
  const days = useMemo(() => new Map((data?.days ?? []).filter((d) => d.ratePlanId === plan?.id).map((d) => [d.date, d])), [data, plan?.id]);
  const monthDays = useMemo(() => { const out: string[] = []; for (let d = new Date(month); d <= endOfMonth(month); d.setDate(d.getDate() + 1)) out.push(format(d, 'yyyy-MM-dd')); return out; }, [month]);
  const lead = (getISODay(month) + 6) % 7;
  const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  if (!propertyId) return <p className="p-6 text-sm text-telivity-mid-grey">Выберите объект</p>;
  return (
    <div>
      <RevenueWorkspaceNav />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-telivity-navy">Календарь цен</h1>
          <p className="text-xs text-telivity-mid-grey">Порядок: ручная цена на день → праздник → сезон → база → одна акция → мин./макс. Подтверждённые брони не пересчитываются.</p>
        </div>
        {canManage && <div className="ml-auto flex flex-wrap gap-2">
          {(['season', 'holiday', 'promo'] as Kind[]).map((kind) => <button key={kind} className="btn-secondary" onClick={() => setDraft({ kind, name: '', startDate: from, endDate: from,
            roomTypeIds: roomTypeId ? [roomTypeId] : [], adjustmentType: kind === 'promo' ? 'percent' : 'percent', value: '', reason: '' })}><Plus size={14}/>{KIND[kind]}</button>)}
        </div>}
      </div>

      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-gray-300 bg-white">
          <button aria-label="Предыдущий месяц" className="flex h-9 w-10 items-center justify-center hover:bg-telivity-light-grey" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={16}/></button>
          <span className="flex h-9 items-center border-x border-gray-300 px-4 text-sm font-semibold capitalize">{format(month, 'LLLL yyyy', { locale: getDateLocale(i18n.resolvedLanguage) })}</span>
          <button aria-label="Следующий месяц" className="flex h-9 w-10 items-center justify-center hover:bg-telivity-light-grey" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={16}/></button>
        </div>
        <select aria-label="Тип номера" className="field w-auto" value={roomTypeId} onChange={(e) => { setRoomTypeId(e.target.value); setPlanId(''); }}>
          <option value="">Все типы номеров</option>{(data?.roomTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select aria-label="Тариф" className="field w-auto" value={plan?.id ?? ''} onChange={(e) => setPlanId(e.target.value)}>
          {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {calendar.isError && <QueryError error={calendar.error} onRetry={() => void calendar.refetch()}/>}
      {calendar.isPending && <p role="status" className="text-sm">Загрузка…</p>}
      {data && !plan && <p className="card p-6 text-sm text-telivity-mid-grey">Нет активных базовых тарифов для выбранного типа номера.</p>}
      {data && plan && <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="card overflow-x-auto p-3">
          <div className="grid min-w-[640px] grid-cols-7 gap-1 text-center text-xs">
            {weekdays.map((d) => <div key={d} className="py-1 font-semibold text-telivity-slate">{d}</div>)}
            {Array.from({ length: lead }, (_, i) => <div key={'pad' + i}/>)}
            {monthDays.map((date) => {
              const day = days.get(date); const top = day?.steps.filter((s) => s.step !== 'base').at(-1);
              return <button key={date} onClick={() => day && setSelected(day)} title={day?.steps.map((s) => `${s.label}: ${formatMoney(s.amount, day.currencyCode)}`).join('\n')}
                className={'min-h-[76px] rounded-lg border p-1.5 text-left hover:border-telivity-teal ' + (selected?.date === date ? 'border-telivity-teal ring-1 ring-telivity-teal' : 'border-gray-100')}>
                <span className="block text-[11px] text-telivity-mid-grey">{Number(date.slice(8))}</span>
                <strong className="block text-sm tabular-nums text-telivity-navy">{day ? formatMoney(day.price, day.currencyCode) : '—'}</strong>
                {top && <span className={'mt-1 block truncate rounded px-1 text-[10px] ' + (KIND_STYLE[top.step] ?? 'bg-gray-50')}>{top.label}</span>}
              </button>;
            })}
          </div>
        </div>
        <aside className="card p-4 text-sm">
          <h2 className="mb-2 font-semibold text-telivity-navy">Почему такая цена</h2>
          {selected ? <>
            <p className="mb-2 text-xs text-telivity-mid-grey">{selected.date}</p>
            <ol className="space-y-1">{selected.steps.map((s, i) => <li key={i} className="flex justify-between gap-3"><span>{s.label}</span><span className="tabular-nums">{formatMoney(s.amount, selected.currencyCode)}</span></li>)}</ol>
            <p className="mt-3 flex justify-between border-t pt-2 font-semibold"><span>Итог за ночь</span><span className="tabular-nums">{formatMoney(selected.price, selected.currencyCode)}</span></p>
          </> : <p className="text-xs text-telivity-mid-grey">Нажмите на день, чтобы увидеть, из чего сложилась цена.</p>}
        </aside>
      </div>}

      {data && <RulesTable rules={data.rules} roomTypes={data.roomTypes} canManage={canManage} propertyId={propertyId} onChanged={refresh}/>}
      {data && <BoundsTable roomTypes={data.roomTypes} canManage={canManage} propertyId={propertyId} currencyCode={currencyCode} onChanged={refresh}/>}
      <section className="card mt-4 p-4">
        <h2 className="mb-2 text-sm font-semibold text-telivity-navy">Журнал изменений</h2>
        {history.isError ? <QueryError error={history.error} onRetry={() => void history.refetch()}/> : !history.data?.length ? <p className="text-xs text-telivity-mid-grey">Изменений пока нет.</p> :
          <ul className="divide-y text-xs">{history.data.map((row) => <li key={row.id} className="flex flex-wrap gap-x-3 py-1.5"><span className="text-telivity-mid-grey">{new Date(row.occurredAt).toLocaleString('ru-RU')}</span><span>{row.description}</span><span className="text-telivity-mid-grey">{row.userEmail ?? ''}</span></li>)}</ul>}
      </section>

      {draft && <RuleModal draft={draft} setDraft={setDraft} roomTypes={data?.roomTypes ?? []} propertyId={propertyId} currencyCode={currencyCode} onSaved={() => { setDraft(null); refresh(); }}/>}
    </div>
  );
}

function RuleModal({ draft, setDraft, roomTypes, propertyId, currencyCode, onSaved }: { draft: Draft; setDraft: (d: Draft | null) => void; roomTypes: RoomType[];
  propertyId: string; currencyCode: string | null; onSaved: () => void }) {
  const [error, setError] = useState('');
  const preview = useMutation({ mutationFn: () => api.post('/v1/price-calendar/rules/preview', draft, { params: { propertyId }, skipErrorToast: true }).then((r) => r.data),
    onError: (e) => setError(errorText(e)), onSuccess: () => setError('') });
  const save = useMutation({ mutationFn: () => api.post('/v1/price-calendar/rules', draft, { params: { propertyId }, skipErrorToast: true }),
    onError: (e) => setError(errorText(e)), onSuccess: onSaved });
  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); preview.reset(); };
  const ready = draft.name.trim().length >= 2 && draft.reason.trim().length >= 3 && /^-?\d+(\.\d{1,2})?$/.test(draft.value) && draft.endDate >= draft.startDate;
  return (
    <Modal open onClose={() => setDraft(null)} title={`Новое правило: ${KIND[draft.kind].toLowerCase()}`}>
      <div className="grid gap-3 text-sm">
        <label className="grid gap-1">Название<input className="field" value={draft.name} onChange={(e) => set({ name: e.target.value })}/></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">С<input type="date" className="field" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })}/></label>
          <label className="grid gap-1">По (включительно)<input type="date" className="field" value={draft.endDate} onChange={(e) => set({ endDate: e.target.value })}/></label>
        </div>
        <fieldset className="grid gap-1"><legend className="mb-1">Типы номеров (ничего не выбрано — все)</legend>
          <div className="flex flex-wrap gap-3">{roomTypes.map((t) => <label key={t.id} className="flex items-center gap-1.5"><input type="checkbox" checked={draft.roomTypeIds.includes(t.id)}
            onChange={(e) => set({ roomTypeIds: e.target.checked ? [...draft.roomTypeIds, t.id] : draft.roomTypeIds.filter((id) => id !== t.id) })}/>{t.name}</label>)}</div>
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">Как меняем<select className="field" value={draft.adjustmentType} onChange={(e) => set({ adjustmentType: e.target.value as Draft['adjustmentType'] })}>
            <option value="percent">Процент к базе (например 20 или -10)</option><option value="fixed_price">Фиксированная цена за ночь</option></select></label>
          <label className="grid gap-1">{draft.adjustmentType === 'percent' ? 'Процент' : `Цена${currencyCode ? ', ' + currencyCode : ''}`}<input inputMode="decimal" className="field tabular-nums" value={draft.value} onChange={(e) => set({ value: e.target.value.replace(',', '.') })}/></label>
        </div>
        <label className="grid gap-1">Причина<input className="field" value={draft.reason} onChange={(e) => set({ reason: e.target.value })}/></label>
        {error && <p role="alert" className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
        {preview.data && <div className="max-h-60 overflow-auto rounded border"><table className="w-full text-xs"><thead className="sticky top-0 bg-gray-50"><tr><th className="p-1.5 text-left">Дата</th><th className="p-1.5 text-right">Было</th><th className="p-1.5 text-right">Станет</th></tr></thead>
          <tbody>{preview.data.days.map((d: any) => <tr key={d.date + d.ratePlanId} className="border-t"><td className="p-1.5">{d.date}</td><td className="p-1.5 text-right tabular-nums">{formatMoney(d.before, currencyCode)}</td><td className="p-1.5 text-right font-semibold tabular-nums">{formatMoney(d.after, currencyCode)}</td></tr>)}</tbody></table>
          {preview.data.truncated && <p className="p-1.5 text-xs text-telivity-mid-grey">Показаны первые 62 дня.</p>}</div>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={!ready || preview.isPending} onClick={() => preview.mutate()}>Предпросмотр</button>
          <button className="btn-primary" disabled={!ready || !preview.data || save.isPending} onClick={() => save.mutate()}>Сохранить</button>
        </div>
      </div>
    </Modal>
  );
}

function RulesTable({ rules, roomTypes, canManage, propertyId, onChanged }: { rules: Rule[]; roomTypes: RoomType[]; canManage: boolean; propertyId: string; onChanged: () => void }) {
  const [error, setError] = useState('');
  const toggle = useMutation({ mutationFn: ({ rule, reason }: { rule: Rule; reason: string }) => api.patch(`/v1/price-calendar/rules/${rule.id}`,
    { isActive: !rule.isActive, reason, expectedRevision: rule.revision }, { params: { propertyId }, skipErrorToast: true }),
    onError: (e) => setError(errorText(e)), onSuccess: () => { setError(''); onChanged(); } });
  const names = new Map(roomTypes.map((t) => [t.id, t.name]));
  return <section className="card mt-4 p-4">
    <h2 className="mb-2 text-sm font-semibold text-telivity-navy">Сезоны, праздники и акции</h2>
    {error && <p role="alert" className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    {!rules.length ? <p className="text-xs text-telivity-mid-grey">Правил пока нет — действует базовая цена тарифа.</p> :
      <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-telivity-slate">{['Тип', 'Название', 'Даты', 'Типы номеров', 'Изменение', 'Причина', ''].map((h) => <th key={h} className="p-1.5">{h}</th>)}</tr></thead>
        <tbody>{rules.map((rule) => <tr key={rule.id} className={'border-t ' + (rule.isActive ? '' : 'opacity-50')}>
          <td className="p-1.5"><span className={'rounded px-1.5 py-0.5 ' + KIND_STYLE[rule.kind]}>{KIND[rule.kind]}</span></td>
          <td className="p-1.5 font-medium">{rule.name}</td><td className="p-1.5 whitespace-nowrap">{rule.startDate} – {rule.endDate}</td>
          <td className="p-1.5">{rule.roomTypeIds.length ? rule.roomTypeIds.map((id) => names.get(id) ?? id).join(', ') : 'Все'}</td>
          <td className="p-1.5 tabular-nums">{rule.adjustmentType === 'percent' ? `${Number(rule.value) > 0 ? '+' : ''}${Number(rule.value)}%` : `= ${rule.value}`}</td>
          <td className="p-1.5">{rule.reason}</td>
          <td className="p-1.5 text-right">{canManage && <button className="text-telivity-teal underline" onClick={() => {
            const reason = window.prompt(rule.isActive ? 'Причина отключения' : 'Причина включения'); if (reason && reason.trim().length >= 3) toggle.mutate({ rule, reason: reason.trim() });
          }}>{rule.isActive ? 'Отключить' : 'Включить'}</button>}</td>
        </tr>)}</tbody></table></div>}
  </section>;
}

function BoundsTable({ roomTypes, canManage, propertyId, currencyCode, onChanged }: { roomTypes: RoomType[]; canManage: boolean; propertyId: string; currencyCode: string | null; onChanged: () => void }) {
  const [edit, setEdit] = useState<Record<string, { min: string; max: string; reason: string }>>({});
  const [error, setError] = useState('');
  const save = useMutation({ mutationFn: (t: RoomType) => { const e = edit[t.id]!; return api.put(`/v1/price-calendar/bounds/${t.id}`, { minPrice: e.min || null, maxPrice: e.max || null, reason: e.reason },
    { params: { propertyId }, skipErrorToast: true }); }, onError: (e) => setError(errorText(e)), onSuccess: (_r, t) => { setError(''); setEdit(({ [t.id]: _x, ...rest }) => rest); onChanged(); } });
  return <section className="card mt-4 p-4">
    <h2 className="mb-2 text-sm font-semibold text-telivity-navy">Минимальная и максимальная цена</h2>
    {error && <p role="alert" className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}
    <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-telivity-slate">{['Тип номера', 'Минимум', 'Максимум', 'Причина', ''].map((h) => <th key={h} className="p-1.5">{h}</th>)}</tr></thead>
      <tbody>{roomTypes.map((t) => { const e = edit[t.id]; return <tr key={t.id} className="border-t">
        <td className="p-1.5 font-medium">{t.name}</td>
        {e ? <>
          <td className="p-1.5"><input aria-label={`Минимум ${t.name}`} inputMode="decimal" className="field w-28" value={e.min} onChange={(ev) => setEdit({ ...edit, [t.id]: { ...e, min: ev.target.value.replace(',', '.') } })}/></td>
          <td className="p-1.5"><input aria-label={`Максимум ${t.name}`} inputMode="decimal" className="field w-28" value={e.max} onChange={(ev) => setEdit({ ...edit, [t.id]: { ...e, max: ev.target.value.replace(',', '.') } })}/></td>
          <td className="p-1.5"><input aria-label={`Причина ${t.name}`} className="field" value={e.reason} onChange={(ev) => setEdit({ ...edit, [t.id]: { ...e, reason: ev.target.value } })}/></td>
          <td className="p-1.5 text-right"><button className="btn-primary" disabled={e.reason.trim().length < 3 || save.isPending} onClick={() => save.mutate(t)}>Сохранить</button></td>
        </> : <>
          <td className="p-1.5 tabular-nums">{t.minPrice != null ? formatMoney(t.minPrice, currencyCode) : 'не задан'}</td>
          <td className="p-1.5 tabular-nums">{t.maxPrice != null ? formatMoney(t.maxPrice, currencyCode) : 'не задан'}</td>
          <td className="p-1.5"/>
          <td className="p-1.5 text-right">{canManage && <button className="text-telivity-teal underline" onClick={() => setEdit({ ...edit, [t.id]: { min: t.minPrice ?? '', max: t.maxPrice ?? '', reason: '' } })}>Изменить</button>}</td>
        </>}
      </tr>; })}</tbody></table></div>
  </section>;
}
