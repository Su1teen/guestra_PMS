import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import type { Reservation } from './types';

export const PRICE_TYPE_LABELS: Record<string, string> = { standard: 'Стандартная цена', complimentary: 'Комплиментарное', barter: 'Бартер', chef: 'Для шефа', marketing: 'Маркетинг' };
const CLOSED = ['checked_out', 'cancelled', 'no_show'];

/**
 * Decisions only a person with a dedicated right takes: the price type of a stay (complimentary, barter, chef,
 * marketing — never by the AI) and the correction of a closed stay. Both need a reason and are audited.
 */
export default function ReservationPriceDecisions({ reservation, propertyId }: { reservation: Reservation & { priceType?: string | null; priceTypeReason?: string | null; priceTypeCounterparty?: string | null }; propertyId: string }) {
  const { hasPermission } = useAuth(); const client = useQueryClient();
  const [mode, setMode] = useState<'price' | 'correct' | null>(null);
  const [priceType, setPriceType] = useState(reservation.priceType ?? 'standard');
  const [counterparty, setCounterparty] = useState('');
  const [reason, setReason] = useState('');
  const [total, setTotal] = useState(''); const [adults, setAdults] = useState(''); const [children, setChildren] = useState('');
  const mutation = useMutation({
    mutationFn: () => mode === 'price'
      ? api.post(`/v1/reservations/${reservation.id}/price-type`, { priceType, reason: reason.trim(), ...(counterparty.trim() ? { counterparty: counterparty.trim() } : {}) }, { params: { propertyId }, skipErrorToast: true })
      : api.post(`/v1/reservations/${reservation.id}/correct-closed`, { reason: reason.trim(), ...(total.trim() ? { totalAmount: total.trim() } : {}),
        ...(adults.trim() ? { adults: Number(adults) } : {}), ...(children.trim() ? { children: Number(children) } : {}) }, { params: { propertyId }, skipErrorToast: true }),
    onSuccess: () => { setMode(null); setReason(''); for (const key of ['reservations', 'reservation', 'guest-360', 'stay-money']) void client.invalidateQueries({ queryKey: [key] }); },
  });
  const canPrice = hasPermission('reservations.price_type');
  const canCorrect = hasPermission('reservations.correct_closed') && CLOSED.includes(reservation.status);
  const current = reservation.priceType && reservation.priceType !== 'standard' ? reservation.priceType : null;
  if (!canPrice && !canCorrect && !current) return null;
  const ready = reason.trim().length >= 3 && (mode !== 'price' || priceType !== 'barter' || counterparty.trim().length > 0)
    && (mode !== 'correct' || Boolean(total.trim() || adults.trim() || children.trim()));
  return <section className="space-y-2 rounded-xl border p-4 text-sm" aria-label="Тип цены и исправления">
    {current && <p><span className="rounded bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-800">{PRICE_TYPE_LABELS[current] ?? current}</span>
      {reservation.priceTypeCounterparty && <span className="ml-2 text-gray-600">{reservation.priceTypeCounterparty}</span>}
      {reservation.priceTypeReason && <span className="ml-2 text-gray-600">· {reservation.priceTypeReason}</span>}</p>}
    <div className="flex flex-wrap gap-2">
      {canPrice && <button className="rounded-lg border px-3 py-2" onClick={() => { setMode('price'); setReason(''); }}>Тип цены</button>}
      {canCorrect && <button className="rounded-lg border px-3 py-2" onClick={() => { setMode('correct'); setReason(''); }}>Исправить закрытую бронь</button>}
    </div>
    {mode && <div className="space-y-2 rounded-lg bg-gray-50 p-3">
      {mode === 'price' ? <>
        <label className="block">Тип цены<select className="mt-1 w-full rounded-lg border p-2" value={priceType} onChange={(e) => setPriceType(e.target.value)}>
          {Object.entries(PRICE_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        {priceType !== 'standard' && <label className="block">Контрагент{priceType === 'barter' ? ' (обязательно)' : ''}<input className="mt-1 w-full rounded-lg border p-2" value={counterparty} onChange={(e) => setCounterparty(e.target.value)}/></label>}
        <p className="text-xs text-gray-600">Комплиментарное и бартер: в отчётах 0 дохода, ночь и себестоимость учитываются. Комплиментарное, бартер и «для шефа» не входят в процент менеджера. Начисления в фолио не меняются автоматически.</p>
      </> : <>
        <p className="text-xs text-gray-600">Завершённую бронь меняют только здесь: изменение сохраняется в журнале с причиной.</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="block">Сумма брони<input className="mt-1 w-full rounded-lg border p-2 tabular-nums" inputMode="decimal" placeholder={String(reservation.totalAmount ?? '')} value={total} onChange={(e) => setTotal(e.target.value.replace(',', '.'))}/></label>
          <label className="block">Взрослые<input className="mt-1 w-full rounded-lg border p-2" inputMode="numeric" placeholder={String(reservation.adults ?? '')} value={adults} onChange={(e) => setAdults(e.target.value.replace(/\D/g, ''))}/></label>
          <label className="block">Дети<input className="mt-1 w-full rounded-lg border p-2" inputMode="numeric" placeholder={String(reservation.children ?? '')} value={children} onChange={(e) => setChildren(e.target.value.replace(/\D/g, ''))}/></label>
        </div>
      </>}
      <label className="block">Причина<textarea className="mt-1 w-full rounded-lg border p-2" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}/></label>
      <div className="flex gap-3"><button className="font-semibold text-telivity-teal" disabled={!ready || mutation.isPending} onClick={() => mutation.mutate()}>Сохранить</button>
        <button onClick={() => setMode(null)}>Назад</button></div>
      {mutation.isError && <p role="alert" className="text-red-700">{errorMessage(mutation.error)}</p>}
    </div>}
  </section>;
}
