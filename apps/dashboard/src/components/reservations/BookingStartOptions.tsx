import { useTranslation } from 'react-i18next';
import { Clock3, ShieldCheck } from 'lucide-react';
import { GUARANTEE_TYPES, type BookingPolicy, type GuaranteeType } from '../../lib/booking';

export interface StartOptions {
  confirmation: 'tentative' | 'confirmed';
  /** datetime-local value; '' = no deadline */
  optionUntil: string;
  /** money string; '' = manual confirmation only */
  requiredDeposit: string;
  guaranteeType: GuaranteeType | '';
  guaranteeReason: string;
  notifyGuest: boolean;
}

export const initialStartOptions = (): StartOptions => ({
  confirmation: 'tentative', optionUntil: '', requiredDeposit: '', guaranteeType: '', guaranteeReason: '', notifyGuest: true,
});

/** Request fields for staff-create / group-booking from the form state. */
export function startOptionsPayload(o: StartOptions) {
  if (o.confirmation === 'confirmed') {
    return { confirmation: 'confirmed' as const, ...(o.guaranteeType ? { guaranteeType: o.guaranteeType } : {}),
      ...(o.guaranteeReason.trim() ? { guaranteeReason: o.guaranteeReason.trim() } : {}), notifyGuest: o.notifyGuest };
  }
  return { confirmation: 'tentative' as const,
    optionUntil: o.optionUntil ? new Date(o.optionUntil).toISOString() : null,
    requiredDeposit: o.requiredDeposit.trim() ? Number(o.requiredDeposit).toFixed(2) : null };
}

export function startOptionsValid(o: StartOptions) {
  if (o.confirmation === 'confirmed') return o.guaranteeType !== 'none' || o.guaranteeReason.trim().length > 0;
  if (o.requiredDeposit && !/^\d+(\.\d{1,2})?$/.test(o.requiredDeposit.trim())) return false;
  if (o.optionUntil && new Date(o.optionUntil).getTime() <= Date.now()) return false;
  return true;
}

/**
 * How the booking starts: tentative option (deadline + guarantee that confirms automatically) or confirmed now.
 * Defaults come from the property policy; staff can change them per booking.
 */
export default function BookingStartOptions({ value, onChange, policy, currency, disabled, guestHasEmail }: {
  value: StartOptions; onChange: (v: StartOptions) => void; policy?: BookingPolicy; currency?: string | null;
  disabled?: boolean; guestHasEmail?: boolean;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<StartOptions>) => onChange({ ...value, ...patch });
  const deadlineInvalid = !!value.optionUntil && new Date(value.optionUntil).getTime() <= Date.now();

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="label">{t('booking.startTitle')}</legend>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
        <Choice active={value.confirmation === 'tentative'} onClick={() => set({ confirmation: 'tentative' })}
          icon={<Clock3 size={18} />} title={t('booking.tentative')} hint={t('booking.tentativeHint')} />
        <Choice active={value.confirmation === 'confirmed'} onClick={() => set({ confirmation: 'confirmed' })}
          icon={<ShieldCheck size={18} />} title={t('booking.confirmedNow')} hint={t('booking.confirmedNowHint')} />
      </div>

      {value.confirmation === 'tentative' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">{t('booking.optionUntil')}</span>
            <input type="datetime-local" value={value.optionUntil} onChange={(e) => set({ optionUntil: e.target.value })}
              className={`field ${deadlineInvalid ? 'border-red-400' : ''}`} />
            <span className={`mt-1 block text-xs ${deadlineInvalid ? 'text-red-700' : 'text-telivity-mid-grey'}`}>
              {deadlineInvalid ? t('booking.deadlinePast') : value.optionUntil
                ? t(policy?.optionExpiryAction === 'cancel' ? 'booking.expiryCancels' : 'booking.expiryNotifies') : t('booking.noDeadline')}
            </span>
          </label>
          <label className="block">
            <span className="label">{t('booking.requiredDeposit')}{currency ? ` (${currency})` : ''}</span>
            <input inputMode="decimal" value={value.requiredDeposit} placeholder="0.00"
              onChange={(e) => set({ requiredDeposit: e.target.value.replace(',', '.') })} className="field tabular-nums" />
            <span className="mt-1 block text-xs text-telivity-mid-grey">
              {value.requiredDeposit ? t('booking.depositAutoConfirms') : t('booking.depositManual')}
            </span>
          </label>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">{t('booking.guaranteeType')}</span>
            <select value={value.guaranteeType} onChange={(e) => set({ guaranteeType: e.target.value as GuaranteeType | '' })} className="field">
              <option value="">{t('booking.guaranteeUnspecified')}</option>
              {GUARANTEE_TYPES.map((g) => <option key={g} value={g}>{t(`booking.guarantee.${g}`)}</option>)}
            </select>
          </label>
          {value.guaranteeType === 'none' && (
            <label className="block">
              <span className="label">{t('booking.guaranteeReason')}</span>
              <input value={value.guaranteeReason} onChange={(e) => set({ guaranteeReason: e.target.value })} className="field" required />
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-telivity-slate sm:col-span-2">
            <input type="checkbox" checked={value.notifyGuest && !!guestHasEmail} disabled={!guestHasEmail}
              onChange={(e) => set({ notifyGuest: e.target.checked })} />
            {guestHasEmail ? t('booking.notifyGuest') : t('booking.noGuestEmail')}
          </label>
        </div>
      )}
    </fieldset>
  );
}

function Choice({ active, onClick, icon, title, hint }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; hint: string }) {
  return (
    <button type="button" role="radio" aria-checked={active} onClick={onClick}
      className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${active
        ? 'border-telivity-teal bg-primary-50 ring-1 ring-telivity-teal' : 'border-gray-300 bg-white hover:border-gray-400'}`}>
      <span className={`mt-0.5 ${active ? 'text-telivity-teal' : 'text-telivity-mid-grey'}`}>{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-telivity-navy">{title}</span>
        <span className="block text-xs text-telivity-mid-grey">{hint}</span>
      </span>
    </button>
  );
}
