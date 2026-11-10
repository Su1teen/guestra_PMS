import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/error-message';
import { useBookingPolicy } from '../../hooks/useBookingPolicy';
import type { ChildAgeBand } from '../../lib/booking';
import { useToast } from '../ui/Toast';

/**
 * Hotel policy for tentative bookings and child pricing: how long an option is held, what happens when it
 * expires, the guarantee share that confirms automatically, auto-sending the confirmation, and child age bands.
 * Everything is the hotel's decision; unset values fall back to the platform defaults (50% prepayment, remind on expiry).
 */
export default function BookingPolicySettings({ propertyId }: { propertyId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const policyQuery = useBookingPolicy(propertyId);
  const [holdHours, setHoldHours] = useState('');
  const [expiry, setExpiry] = useState<'notify' | 'cancel'>('notify');
  const [deposit, setDeposit] = useState('');
  const [autoSend, setAutoSend] = useState(true);
  const [bands, setBands] = useState<ChildAgeBand[]>([]);

  useEffect(() => {
    const p = policyQuery.data;
    if (!p) return;
    setHoldHours(p.optionHoldHours != null ? String(p.optionHoldHours) : '');
    setExpiry(p.optionExpiryAction ?? 'notify');
    setDeposit(p.depositPercentage != null ? String(p.depositPercentage) : '');
    setAutoSend(p.autoSendConfirmation);
    setBands(p.childAgeBands);
  }, [policyQuery.data]);

  const bandsError = (() => {
    const sorted = [...bands].sort((a, b) => a.minAge - b.minAge);
    if (sorted.some((b) => !b.label.trim() || b.maxAge < b.minAge || b.minAge < 0 || b.maxAge > 17)) return t('policy.bandsInvalid');
    if (sorted.some((b, i) => i > 0 && b.minAge <= sorted[i - 1]!.maxAge)) return t('policy.bandsOverlap');
    return null;
  })();

  const save = useMutation({
    mutationFn: () => api.patch(`/v1/properties/${propertyId}/booking-policy`, {
      optionHoldHours: holdHours.trim() ? Number(holdHours) : null,
      optionExpiryAction: expiry,
      depositPercentage: deposit.trim() ? Number(deposit) : null,
      autoSendConfirmation: autoSend,
      childAgeBands: bands.map((b) => ({ ...b, label: b.label.trim(), code: b.code || `child_${b.minAge}_${b.maxAge}` })),
    }).then((r) => r.data?.data ?? r.data),
    onSuccess: (policy) => {
      queryClient.setQueryData(['booking-policy', propertyId], policy);
      toast('success', t('policy.saved'));
    },
    onError: (error) => toast('error', errorMessage(error)),
  });

  const updateBand = (index: number, patch: Partial<ChildAgeBand>) =>
    setBands((all) => all.map((b, i) => (i === index ? { ...b, ...patch, code: patch.minAge != null || patch.maxAge != null ? '' : b.code } : b)));

  return (
    <div className="space-y-4">
      <section className="card space-y-4 p-6">
        <div>
          <h2 className="text-base font-semibold text-telivity-navy">{t('policy.optionTitle')}</h2>
          <p className="mt-1 text-sm text-telivity-mid-grey">{t('policy.optionHint')}</p>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="block">
            <span className="label">{t('policy.holdHours')}</span>
            <input className="field tabular-nums" inputMode="numeric" value={holdHours} placeholder={t('policy.noAutoDeadline')}
              onChange={(e) => setHoldHours(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="block">
            <span className="label">{t('policy.expiry')}</span>
            <select className="field" value={expiry} onChange={(e) => setExpiry(e.target.value as 'notify' | 'cancel')}>
              <option value="notify">{t('policy.expiryNotify')}</option>
              <option value="cancel">{t('policy.expiryCancel')}</option>
            </select>
          </label>
          <label className="block">
            <span className="label">{t('policy.deposit')}</span>
            <input className="field tabular-nums" inputMode="decimal" value={deposit} placeholder={t('policy.manualOnly')}
              onChange={(e) => setDeposit(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))} />
            <span className="mt-1 block text-xs text-telivity-mid-grey">{t('policy.depositHint')}</span>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-telivity-slate">
          <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />{t('policy.autoSend')}
        </label>
        <p className="text-xs text-telivity-mid-grey">{t('policy.sweepHint')}</p>
      </section>

      <section className="card space-y-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-telivity-navy">{t('policy.bandsTitle')}</h2>
            <p className="mt-1 text-sm text-telivity-mid-grey">{t('policy.bandsHint')}</p>
          </div>
          <button type="button" className="btn-secondary" disabled={bands.length >= 6}
            onClick={() => { const last = bands[bands.length - 1]; const min = last ? Math.min(17, last.maxAge + 1) : 0;
              setBands([...bands, { code: '', label: `${min}–${Math.min(17, min + 5)}`, minAge: min, maxAge: Math.min(17, min + 5), occupiesBed: true }]); }}>
            <Plus size={16} />{t('policy.addBand')}
          </button>
        </div>
        <div className="space-y-2">
          {bands.map((band, index) => (
            <div key={index} className="grid grid-cols-2 items-end gap-3 rounded-lg border border-gray-200 p-3 sm:grid-cols-[1.2fr_0.7fr_0.7fr_1.4fr_auto]">
              <label className="block"><span className="label">{t('policy.bandLabel')}</span>
                <input className="field" value={band.label} onChange={(e) => updateBand(index, { label: e.target.value })} /></label>
              <label className="block"><span className="label">{t('policy.fromAge')}</span>
                <input className="field tabular-nums" type="number" min={0} max={17} value={band.minAge} onChange={(e) => updateBand(index, { minAge: Number(e.target.value) })} /></label>
              <label className="block"><span className="label">{t('policy.toAge')}</span>
                <input className="field tabular-nums" type="number" min={0} max={17} value={band.maxAge} onChange={(e) => updateBand(index, { maxAge: Number(e.target.value) })} /></label>
              <label className="flex h-10 items-center gap-2 text-sm text-telivity-slate">
                <input type="checkbox" checked={band.occupiesBed} onChange={(e) => updateBand(index, { occupiesBed: e.target.checked })} />{t('policy.takesPlace')}
              </label>
              <button type="button" className="btn-ghost px-3" aria-label={t('policy.removeBand')} onClick={() => setBands(bands.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
            </div>
          ))}
          {bandsError && <p role="alert" className="text-sm text-red-700">{bandsError}</p>}
          <p className="text-xs text-telivity-mid-grey">{t('policy.olderAdult')}</p>
          <p className="text-xs text-amber-800">{t('policy.codeChangeWarning')}</p>
        </div>
      </section>

      <div className="flex justify-end">
        <button type="button" className="btn-primary btn-lg" disabled={!!bandsError || save.isPending || policyQuery.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  );
}
