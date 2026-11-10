import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BellRing, CalendarClock, ShieldCheck, Wallet, XCircle } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { formatMoney } from '../../lib/money';
import { useToast } from '../ui/Toast';

export const PREPAYMENT_METHODS = ['bank_transfer', 'cash', 'credit_card', 'debit_card', 'other'] as const;
type Method = (typeof PREPAYMENT_METHODS)[number];
type Mode = null | 'prepayment' | 'extend' | 'remind' | 'release';

/** `datetime-local` value for now + hours, in the browser's time zone. */
export function localInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * What a receptionist does with an unconfirmed booking while no payment gateway is connected:
 * mark the prepayment as received (confirms once the guarantee is covered), extend the option,
 * remind the guest, or release the booking by hand. Nothing is released automatically by default.
 */
export default function OptionActions({ reservationId, propertyId, currency, due, optionUntil, multi, onConfirm }: {
  reservationId: string; propertyId: string; currency?: string;
  /** Guarantee still to receive, as a money string; prefilled into the prepayment form. */
  due: string | null; optionUntil: string | null; multi: boolean; onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(null);
  const [amount, setAmount] = useState(due ?? '');
  const [method, setMethod] = useState<Method>('bank_transfer');
  const [reference, setReference] = useState('');
  const base = optionUntil && new Date(optionUntil).getTime() > Date.now() ? new Date(optionUntil) : new Date();
  const [until, setUntil] = useState(localInputValue(new Date(base.getTime() + 24 * 3_600_000)));
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [reason, setReason] = useState('');

  const refresh = () => {
    for (const key of [['reservations'], ['reservation-document', propertyId, reservationId], ['reservation-calendar'], ['reservation-options'], ['folios']]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
  const done = (message: string) => { toast('success', message); setMode(null); refresh(); };
  const params = { params: { propertyId }, skipErrorToast: true };
  const unwrap = (r: { data: any }) => r.data?.data ?? r.data;

  const prepayment = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservationId}/prepayment`, {
      amount: Number(amount).toFixed(2), method, ...(reference.trim() ? { reference: reference.trim() } : {}) }, params).then(unwrap),
    onSuccess: (r: { confirmed: boolean; paid: string; required: string | null }) =>
      done(r.confirmed ? t('booking.optionActions.prepaidConfirmed')
        : r.required ? t('booking.optionActions.prepaidPartial', { paid: formatMoney(r.paid, currency), required: formatMoney(r.required, currency) })
          : t('booking.optionActions.prepaidRecorded')),
    onError: (e) => toast('error', errorMessage(e)),
  });
  const extend = useMutation({
    mutationFn: (value: string) => api.patch(`/v1/reservations/${reservationId}/option`,
      { optionUntil: new Date(value).toISOString(), wholeBooking: multi }, params).then(unwrap),
    onSuccess: () => done(t('booking.optionActions.extended')),
    onError: (e) => toast('error', errorMessage(e)),
  });
  const remind = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservationId}/option/remind`, { channel }, params).then(unwrap),
    onSuccess: (r: { sent: boolean; to: string }) => {
      if (r.sent) done(t('booking.optionActions.reminded', { to: r.to }));
      else { toast('error', t('booking.doc.notDelivered')); setMode(null); refresh(); }
    },
    onError: (e) => toast('error', errorMessage(e)),
  });
  const release = useMutation({
    mutationFn: () => api.post(`/v1/reservations/${reservationId}/option/release`,
      { wholeBooking: multi, ...(reason.trim() ? { reason: reason.trim() } : {}) }, params).then(unwrap),
    onSuccess: (r: { released: number }) => done(t('booking.optionActions.released', { count: r.released })),
    onError: (e) => toast('error', errorMessage(e)),
  });

  const amountValid = Number(amount) > 0;
  const tab = (key: Exclude<Mode, null>, icon: JSX.Element, label: string, tone = 'btn-secondary') => (
    <button type="button" className={`${tone} ${mode === key ? 'ring-2 ring-primary-200' : ''}`} aria-expanded={mode === key}
      onClick={() => setMode(mode === key ? null : key)}>{icon}{label}</button>
  );

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        {tab('prepayment', <Wallet size={16} />, t('booking.optionActions.prepaid'), 'btn-primary')}
        <button type="button" className="btn-secondary" onClick={onConfirm}><ShieldCheck size={16} />{t('booking.optionActions.confirmOther')}</button>
        {tab('extend', <CalendarClock size={16} />, t('booking.optionActions.extend'))}
        {tab('remind', <BellRing size={16} />, t('booking.optionActions.remind'))}
        {tab('release', <XCircle size={16} />, t('booking.optionActions.release'), 'btn-ghost text-red-700')}
      </div>

      {mode === 'prepayment' && (
        <form className="space-y-3 rounded-lg border border-gray-200 bg-white p-3" onSubmit={(e) => { e.preventDefault(); if (amountValid) prepayment.mutate(); }}>
          <p className="text-sm text-telivity-slate">{t('booking.optionActions.prepaidHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block"><span className="label">{t('booking.optionActions.amount', { currency: currency ?? '' })}</span>
              <input className="field tabular-nums" inputMode="decimal" value={amount} autoFocus
                onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} /></label>
            <label className="block"><span className="label">{t('booking.optionActions.method')}</span>
              <select className="field" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                {PREPAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`booking.optionActions.methods.${m}`)}</option>)}
              </select></label>
            <label className="block"><span className="label">{t('booking.optionActions.reference')}</span>
              <input className="field" value={reference} maxLength={200} placeholder={t('booking.optionActions.referencePlaceholder')} onChange={(e) => setReference(e.target.value)} /></label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setMode(null)}>{t('common.cancel')}</button>
            <button type="submit" className="btn-primary" disabled={!amountValid || prepayment.isPending}>
              {prepayment.isPending ? t('common.saving') : t('booking.optionActions.prepaidSubmit')}</button>
          </div>
        </form>
      )}

      {mode === 'extend' && (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-3">
          <div className="flex flex-wrap items-end gap-2">
            {[24, 48, 72].map((hours) => (
              <button key={hours} type="button" className="btn-secondary" disabled={extend.isPending}
                onClick={() => extend.mutate(localInputValue(new Date(base.getTime() + hours * 3_600_000)))}>+{hours} {t('booking.optionActions.hours')}</button>
            ))}
            <label className="block"><span className="label">{t('booking.optionActions.until')}</span>
              <input className="field" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
            <button type="button" className="btn-primary" disabled={!until || extend.isPending} onClick={() => extend.mutate(until)}>{t('booking.optionActions.extendSubmit')}</button>
          </div>
          {multi && <p className="text-xs text-telivity-mid-grey">{t('booking.optionActions.wholeBooking')}</p>}
        </div>
      )}

      {mode === 'remind' && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-3">
          <label className="block"><span className="label">{t('booking.doc.channel')}</span>
            <select className="field" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}>
              <option value="email">{t('booking.doc.email')}</option><option value="sms">{t('booking.doc.sms')}</option>
            </select></label>
          <p className="min-w-[12rem] flex-1 text-sm text-telivity-slate">{t('booking.optionActions.remindHint')}</p>
          <button type="button" className="btn-primary" disabled={remind.isPending} onClick={() => remind.mutate()}>
            {remind.isPending ? t('booking.doc.sending') : t('booking.optionActions.remindSubmit')}</button>
        </div>
      )}

      {mode === 'release' && (
        <div className="space-y-3 rounded-lg border border-red-200 bg-red-50/60 p-3">
          <p className="text-sm text-red-900">{t(multi ? 'booking.optionActions.releaseWarnAll' : 'booking.optionActions.releaseWarn')}</p>
          <input className="field" value={reason} maxLength={500} placeholder={t('booking.optionActions.releaseReason')} onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setMode(null)}>{t('common.cancel')}</button>
            <button type="button" className="btn-danger" disabled={release.isPending} onClick={() => release.mutate()}>{t('booking.optionActions.releaseSubmit')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
