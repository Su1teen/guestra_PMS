import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChildAgeBand, Party } from '../../lib/booking';

interface PartyInputProps {
  value: Party;
  onChange: (party: Party) => void;
  bands?: ChildAgeBand[];
  maxGuests?: number;
  disabled?: boolean;
  compact?: boolean;
}

const AGES = Array.from({ length: 18 }, (_, age) => age);

/**
 * Adults and children with the age of every child. Ages drive the child supplements, so a child
 * without an age blocks pricing; the band of each age is shown next to the select.
 */
export default function PartyInput({ value, onChange, bands = [], maxGuests, disabled, compact }: PartyInputProps) {
  const { t } = useTranslation();
  const setAdults = (adults: number) => onChange({ ...value, adults: Math.max(1, Math.min(20, adults)) });
  const setChildren = (children: number) => {
    const count = Math.max(0, Math.min(10, children));
    const childAges = value.childAges.slice(0, count);
    onChange({ ...value, children: count, childAges });
  };
  const setAge = (index: number, age: number) => {
    const childAges = [...value.childAges];
    childAges[index] = age;
    onChange({ ...value, childAges });
  };
  const bandOf = (age: number | undefined) => (age == null ? null : bands.find((b) => age >= b.minAge && age <= b.maxAge) ?? null);
  // Children whose band takes no place (or not set yet) do not count until their age says so.
  const placed = value.adults + Array.from({ length: value.children }, (_, i) => bandOf(value.childAges[i])).filter((b) => !b || b.occupiesBed).length;
  const atCapacity = maxGuests != null && placed >= maxGuests;

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="grid grid-cols-2 gap-3">
        <Stepper label={t('booking.adults')} value={value.adults} min={1} onChange={setAdults} disabled={disabled} plusDisabled={atCapacity} />
        <Stepper label={t('booking.children')} value={value.children} min={0} onChange={setChildren} disabled={disabled} plusDisabled={atCapacity} />
      </div>
      {value.children > 0 && (
        <div className="rounded-lg border border-gray-200 bg-telivity-light-grey/60 p-3">
          <p className="mb-2 text-xs font-medium text-telivity-slate">{t('booking.childAgesHint')}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Array.from({ length: value.children }, (_, index) => {
              const age = value.childAges[index];
              const band = bandOf(age);
              return (
                <label key={index} className="block">
                  <span className="label">{t('booking.childN', { n: index + 1 })}</span>
                  <select
                    value={age ?? ''}
                    disabled={disabled}
                    onChange={(e) => setAge(index, Number(e.target.value))}
                    className={`field ${age == null ? 'border-amber-400 bg-amber-50' : ''}`}
                    aria-label={t('booking.childAgeLabel', { n: index + 1 })}
                  >
                    <option value="" disabled>{t('booking.selectAge')}</option>
                    {AGES.map((a) => <option key={a} value={a}>{t('booking.ageYears', { count: a })}</option>)}
                  </select>
                  <span className="mt-1 block text-xs text-telivity-mid-grey">
                    {age == null ? t('booking.ageRequired') : band ? t('booking.bandLabel', { label: band.label }) : t('booking.countsAsAdult')}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {maxGuests != null && <p className="text-xs text-telivity-mid-grey">{t('booking.maxGuests', { count: maxGuests })}</p>}
    </div>
  );
}

function Stepper({ label, value, min, onChange, disabled, plusDisabled }: {
  label: string; value: number; min: number; onChange: (v: number) => void; disabled?: boolean; plusDisabled?: boolean;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex h-10 items-center overflow-hidden rounded-lg border border-gray-300 bg-white">
        <button type="button" aria-label={`${label} −`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)}
          className="flex h-full w-10 items-center justify-center text-telivity-slate hover:bg-telivity-light-grey disabled:opacity-40">
          <Minus size={16} />
        </button>
        <span className="flex-1 text-center text-base font-semibold tabular-nums text-telivity-navy" aria-live="polite">{value}</span>
        <button type="button" aria-label={`${label} +`} disabled={disabled || plusDisabled} onClick={() => onChange(value + 1)}
          className="flex h-full w-10 items-center justify-center text-telivity-slate hover:bg-telivity-light-grey disabled:opacity-40">
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
