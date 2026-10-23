import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText, Send, Users, Percent, ArrowUpCircle, BedDouble } from 'lucide-react';
import { api } from '../../lib/api';
import { formatMoney } from '../../lib/money';
import { errorMessage } from '../../lib/error-message';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import FindGuest from '../guests/FindGuest';
import type { Guest } from '../../types/guest';
import type { Reservation } from './types';

type Dialog = null | 'occupancy' | 'price' | 'upgrade' | 'room' | 'send';
interface RoomType { id: string; name: string; maxOccupancy?: number; isActive?: boolean }
interface RatePlan { id: string; name: string; roomTypeId: string; isActive?: boolean }
interface Quote { totalAmount: string; currency: string; lineItems: unknown[] }

const field = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:border-telivity-teal';
const label = 'mb-1 block text-xs font-medium text-telivity-mid-grey';
const primary = 'w-full rounded-lg bg-telivity-teal px-4 py-2 text-sm font-semibold text-white disabled:opacity-50';
const chip = 'inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-semibold';
const CLOSED = ['checked_out', 'no_show', 'cancelled'];
const PRE_ARRIVAL = ['pending', 'confirmed', 'assigned'];

/** Confirmation, party size, manual price, upgrade and extra rooms for one reservation. */
export default function ReservationCommercialActions({ reservation, propertyId, canWrite }: {
  reservation: Reservation; propertyId: string; canWrite: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const params = { params: { propertyId }, skipErrorToast: true };
  const writable = canWrite && !CLOSED.includes(reservation.status);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['reservations'] });
    void queryClient.invalidateQueries({ queryKey: ['reservation-guests', reservation.id] });
    void queryClient.invalidateQueries({ queryKey: ['booking-siblings', reservation.id] });
    void queryClient.invalidateQueries({ queryKey: ['folios'] });
  };
  const done = (message: string) => { toast('success', message); setDialog(null); refresh(); };
  const fail = (error: unknown) => toast('error', errorMessage(error));

  // --- Confirmation ---
  const openConfirmation = async () => {
    try {
      const html = await api.get(`/v1/reservations/${reservation.id}/confirmation/document`, { ...params, responseType: 'text' }).then(r => r.data as string);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { fail(error); }
  };
  const [email, setEmail] = useState(reservation.guest?.email ?? '');
  const send = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservation.id}/confirmation/send`, email.trim() ? { email: email.trim() } : {}, params).then(r => r.data),
    onSuccess: (result: { sent: boolean; to: string }) => result.sent
      ? done(t('reservationActions.confirmationSent', { to: result.to, defaultValue: 'Подтверждение отправлено на {{to}}' }))
      : (toast('error', t('reservationActions.confirmationNotSent', { defaultValue: 'Почта не настроена: письмо не отправлено. Откройте подтверждение и отправьте его вручную.' })), setDialog(null)),
    onError: fail,
  });

  // --- Occupancy ---
  const [adults, setAdults] = useState(reservation.adults ?? 1);
  const [children, setChildren] = useState(reservation.children ?? 0);
  const occupancy = useMutation({
    mutationFn: () => api.patch(`/v1/reservations/${reservation.id}/occupancy`, { adults, children }, params).then(r => r.data),
    onSuccess: (result: { pricing: { repriced: boolean; reason?: string; totalAmount?: string } }) => done(result.pricing.repriced
      ? t('reservationActions.repriced', { total: formatMoney(result.pricing.totalAmount, reservation.currencyCode), defaultValue: 'Состав изменён, новая стоимость {{total}}' })
      : t(`reservationActions.notRepriced.${result.pricing.reason}`, { defaultValue: 'Состав изменён, стоимость не изменилась' })),
    onError: fail,
  });

  // --- Manual price / discount ---
  const [mode, setMode] = useState<'discount_percent' | 'discount_amount' | 'total' | 'reset'>('discount_percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const price = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservation.id}/pricing`, { mode, ...(mode === 'reset' ? {} : { value: value.trim() }), reason: reason.trim() }, params).then(r => r.data),
    onSuccess: (result: { totalAmount: string }) => done(t('reservationActions.priceChanged', { total: formatMoney(result.totalAmount, reservation.currencyCode), defaultValue: 'Новая стоимость: {{total}}' })),
    onError: fail,
  });

  // --- Upgrade and extra room share catalogue data ---
  const catalogue = dialog === 'upgrade' || dialog === 'room';
  const { data: roomTypes = [] } = useQuery<RoomType[]>({ queryKey: ['room-types', propertyId], enabled: catalogue,
    queryFn: () => api.get('/v1/rooms/types', { params: { propertyId } }).then(r => r.data?.data ?? r.data ?? []) });
  const { data: ratePlans = [] } = useQuery<RatePlan[]>({ queryKey: ['rate-plans', propertyId], enabled: catalogue,
    queryFn: () => api.get('/v1/rate-plans', { params: { propertyId } }).then(r => r.data?.data ?? r.data ?? []) });
  const [roomTypeId, setRoomTypeId] = useState('');
  const [ratePlanId, setRatePlanId] = useState('');
  const plansFor = ratePlans.filter(p => p.roomTypeId === roomTypeId && p.isActive !== false);
  const planId = ratePlanId || plansFor[0]?.id || '';
  const [pricing, setPricing] = useState<'keep' | 'reprice' | 'custom'>('keep');
  const [customTotal, setCustomTotal] = useState('');
  const [roomAdults, setRoomAdults] = useState(1);
  const [roomChildren, setRoomChildren] = useState(0);
  const [roomGuest, setRoomGuest] = useState<Guest | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const quoteParty = dialog === 'room' ? { adults: roomAdults, children: roomChildren } : { adults: reservation.adults ?? 1, children: reservation.children ?? 0 };
  const quote = useQuery<Quote>({
    queryKey: ['reservation-quote', propertyId, roomTypeId, planId, reservation.arrivalDate, reservation.departureDate, quoteParty.adults, quoteParty.children],
    enabled: catalogue && !!roomTypeId && !!planId,
    queryFn: () => api.post('/v1/reservations/quote', { propertyId, roomTypeId, ratePlanId: planId, checkIn: reservation.arrivalDate,
      checkOut: reservation.departureDate, ...quoteParty }, { skipErrorToast: true }).then(r => r.data?.data ?? r.data),
  });
  const upgrade = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservation.id}/upgrade`, { roomTypeId, ratePlanId: planId, pricing,
      ...(pricing === 'custom' ? { customTotal: customTotal.trim() } : {}), reason: reason.trim() }, params).then(r => r.data),
    onSuccess: (result: { totalAmount: string; roomId: string | null }) => done(t('reservationActions.upgraded', {
      total: formatMoney(result.totalAmount, reservation.currencyCode), defaultValue: 'Категория изменена, стоимость {{total}}' })
      + (result.roomId ? '' : ' · ' + t('reservationActions.reassignRoom', { defaultValue: 'назначьте номер новой категории' }))),
    onError: fail,
  });
  const addRoom = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservation.id}/rooms`, { requestId, roomTypeId, ratePlanId: planId, adults: roomAdults,
      children: roomChildren, expectedTotal: quote.data?.totalAmount, currencyCode: quote.data?.currency,
      ...(roomGuest ? { guestId: roomGuest.id } : {}) }, params).then(r => r.data),
    onSuccess: () => done(t('reservationActions.roomAdded', { defaultValue: 'Номер добавлен в бронирование' })),
    onError: fail,
  });

  const openDialog = (next: Dialog) => {
    setReason(''); setValue(''); setCustomTotal(''); setRoomTypeId(next === 'room' ? reservation.roomTypeId ?? '' : ''); setRatePlanId('');
    setAdults(reservation.adults ?? 1); setChildren(reservation.children ?? 0); setRoomAdults(1); setRoomChildren(0); setRoomGuest(null);
    setPricing('keep'); setDialog(next);
  };

  return <div className="space-y-2 border-t border-gray-100 pt-4">
    <h3 className="text-sm font-semibold text-telivity-navy">{t('reservationActions.title', { defaultValue: 'Бронирование' })}</h3>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={chip} onClick={() => void openConfirmation()}><FileText size={14}/>{t('reservationActions.confirmation', { defaultValue: 'Подтверждение' })}</button>
      {canWrite && <button type="button" className={chip} onClick={() => openDialog('send')}><Send size={14}/>{t('reservationActions.sendConfirmation', { defaultValue: 'Отправить гостю' })}</button>}
      {writable && <button type="button" className={chip} onClick={() => openDialog('occupancy')}><Users size={14}/>{t('reservationActions.occupancy', { defaultValue: 'Гостей: {{adults}} + {{children}}', adults: reservation.adults ?? 1, children: reservation.children ?? 0 })}</button>}
      {writable && <button type="button" className={chip} onClick={() => openDialog('price')}><Percent size={14}/>{t('reservationActions.price', { defaultValue: 'Цена / скидка' })}</button>}
      {writable && <button type="button" className={chip} onClick={() => openDialog('upgrade')}><ArrowUpCircle size={14}/>{t('reservationActions.upgrade', { defaultValue: 'Апгрейд номера' })}</button>}
      {canWrite && PRE_ARRIVAL.includes(reservation.status) && <button type="button" className={chip} onClick={() => openDialog('room')}><BedDouble size={14}/>{t('reservationActions.addRoom', { defaultValue: 'Добавить номер' })}</button>}
    </div>

    <Modal open={dialog === 'send'} onClose={() => setDialog(null)} title={t('reservationActions.sendConfirmation', { defaultValue: 'Отправить гостю' })}>
      <div className="space-y-3">
        <label className="block"><span className={label}>Email</span><input type="email" className={field} value={email} onChange={e => setEmail(e.target.value)}/></label>
        <button type="button" className={primary} disabled={!email.trim() || send.isPending} onClick={() => send.mutate()}>{send.isPending ? t('common.saving') : t('reservationActions.send', { defaultValue: 'Отправить подтверждение' })}</button>
      </div>
    </Modal>

    <Modal open={dialog === 'occupancy'} onClose={() => setDialog(null)} title={t('reservationActions.occupancyTitle', { defaultValue: 'Количество гостей' })}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>{t('reservations.adults')}</span><input type="number" min={1} className={field} value={adults} onChange={e => setAdults(Math.max(1, Number(e.target.value)))}/></label>
          <label><span className={label}>{t('reservations.children')}</span><input type="number" min={0} className={field} value={children} onChange={e => setChildren(Math.max(0, Number(e.target.value)))}/></label>
        </div>
        <p className="text-xs text-telivity-mid-grey">{t('reservationActions.occupancyHint', { defaultValue: 'До заезда стоимость пересчитывается по тарифу, если цена не была изменена вручную.' })}</p>
        <button type="button" className={primary} disabled={occupancy.isPending} onClick={() => occupancy.mutate()}>{occupancy.isPending ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>

    <Modal open={dialog === 'price'} onClose={() => setDialog(null)} title={t('reservationActions.priceTitle', { defaultValue: 'Изменить стоимость' })}>
      <div className="space-y-3">
        <p className="text-sm">{t('reservationActions.currentTotal', { defaultValue: 'Сейчас' })}: <strong>{formatMoney(reservation.totalAmount, reservation.currencyCode)}</strong></p>
        <label className="block"><span className={label}>{t('reservationActions.mode', { defaultValue: 'Что изменить' })}</span>
          <select className={field} value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
            <option value="discount_percent">{t('reservationActions.modes.discount_percent', { defaultValue: 'Скидка, % от тарифа' })}</option>
            <option value="discount_amount">{t('reservationActions.modes.discount_amount', { defaultValue: 'Скидка, сумма' })}</option>
            <option value="total">{t('reservationActions.modes.total', { defaultValue: 'Новая итоговая стоимость' })}</option>
            <option value="reset">{t('reservationActions.modes.reset', { defaultValue: 'Вернуть цену по тарифу' })}</option>
          </select></label>
        {mode !== 'reset' && <label className="block"><span className={label}>{mode === 'discount_percent' ? '%' : reservation.currencyCode ?? ''}</span>
          <input inputMode="decimal" className={field} value={value} onChange={e => setValue(e.target.value.replace(',', '.'))}/></label>}
        <label className="block"><span className={label}>{t('reservationActions.reason', { defaultValue: 'Причина (обязательно, попадёт в журнал)' })}</span>
          <input className={field} value={reason} onChange={e => setReason(e.target.value)}/></label>
        <button type="button" className={primary} disabled={price.isPending || reason.trim().length < 3 || (mode !== 'reset' && !value.trim())} onClick={() => price.mutate()}>{price.isPending ? t('common.saving') : t('common.save')}</button>
      </div>
    </Modal>

    <Modal open={dialog === 'upgrade' || dialog === 'room'} onClose={() => setDialog(null)} wide
      title={dialog === 'room' ? t('reservationActions.addRoomTitle', { defaultValue: 'Добавить номер в бронирование' }) : t('reservationActions.upgradeTitle', { defaultValue: 'Апгрейд номера' })}>
      <div className="space-y-3">
        <p className="text-xs text-telivity-mid-grey">{reservation.arrivalDate} → {reservation.departureDate}</p>
        <div className="grid grid-cols-2 gap-3">
          <label><span className={label}>{t('reservations.roomType')}</span>
            <select className={field} value={roomTypeId} onChange={e => { setRoomTypeId(e.target.value); setRatePlanId(''); }}>
              <option value="">{t('common.select', { defaultValue: 'Выберите' })}</option>
              {roomTypes.filter(rt => rt.isActive !== false && (dialog === 'room' || rt.id !== reservation.roomTypeId)).map(rt => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
            </select></label>
          <label><span className={label}>{t('reservations.ratePlan')}</span>
            <select className={field} value={planId} onChange={e => setRatePlanId(e.target.value)}>
              {plansFor.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        </div>
        {dialog === 'room' && <>
          <div className="grid grid-cols-2 gap-3">
            <label><span className={label}>{t('reservations.adults')}</span><input type="number" min={1} className={field} value={roomAdults} onChange={e => setRoomAdults(Math.max(1, Number(e.target.value)))}/></label>
            <label><span className={label}>{t('reservations.children')}</span><input type="number" min={0} className={field} value={roomChildren} onChange={e => setRoomChildren(Math.max(0, Number(e.target.value)))}/></label>
          </div>
          <p className="text-xs text-telivity-mid-grey">{t('reservationActions.roomGuestHint', { defaultValue: 'Гость номера (необязательно — по умолчанию заказчик бронирования)' })}</p>
          <FindGuest selectedGuest={roomGuest} onSelectGuest={setRoomGuest}/>
        </>}
        {roomTypeId && <p className="rounded-lg bg-gray-50 p-3 text-sm">
          {quote.isFetching ? t('reservationWorkspace.quoteLoading') : quote.isError ? errorMessage(quote.error)
            : quote.data && <>{t('reservationActions.tariff', { defaultValue: 'По тарифу' })}: <strong>{formatMoney(quote.data.totalAmount, quote.data.currency)}</strong></>}
        </p>}
        {dialog === 'upgrade' && <>
          <div className="space-y-1 text-sm">
            {(['keep', 'reprice', 'custom'] as const).map(option => <label key={option} className="flex items-center gap-2">
              <input type="radio" checked={pricing === option} onChange={() => setPricing(option)}/>
              {t(`reservationActions.upgradePricing.${option}`, { defaultValue: { keep: 'Бесплатно — стоимость не меняется', reprice: 'По тарифу новой категории', custom: 'Своя стоимость' }[option] })}
            </label>)}
          </div>
          {pricing === 'custom' && <input inputMode="decimal" className={field} placeholder={reservation.currencyCode ?? ''} value={customTotal} onChange={e => setCustomTotal(e.target.value.replace(',', '.'))}/>}
          <label className="block"><span className={label}>{t('reservationActions.reason', { defaultValue: 'Причина (обязательно, попадёт в журнал)' })}</span>
            <input className={field} value={reason} onChange={e => setReason(e.target.value)}/></label>
          <button type="button" className={primary} disabled={upgrade.isPending || !roomTypeId || !planId || reason.trim().length < 3 || (pricing === 'custom' && !customTotal.trim())} onClick={() => upgrade.mutate()}>{upgrade.isPending ? t('common.saving') : t('reservationActions.applyUpgrade', { defaultValue: 'Выполнить апгрейд' })}</button>
        </>}
        {dialog === 'room' && <button type="button" className={primary} disabled={addRoom.isPending || !quote.data || quote.isFetching} onClick={() => addRoom.mutate()}>
          {addRoom.isPending ? t('common.saving') : t('reservationActions.addRoomConfirm', { total: formatMoney(quote.data?.totalAmount, quote.data?.currency ?? reservation.currencyCode), defaultValue: 'Добавить номер · {{total}}' })}</button>}
      </div>
    </Modal>
  </div>;
}
