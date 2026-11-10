/**
 * Booking lifecycle presentation shared by the tape chart, reservation drawer and lists:
 * one colour language for statuses so a receptionist reads the chart at a glance.
 */

export interface ChildAgeBand { code: string; label: string; minAge: number; maxAge: number; occupiesBed: boolean }

export interface BookingPolicy {
  childAgeBands: ChildAgeBand[];
  childAgeBandsConfigured: boolean;
  optionHoldHours: number | null;
  optionExpiryAction: 'cancel' | 'notify' | null;
  depositPercentage: number | null;
  autoSendConfirmation: boolean;
  /** Platform defaults applied when the hotel has not chosen (50% prepayment, remind on expiry). */
  defaults?: { depositPercentage: number; optionExpiryAction: 'cancel' | 'notify' };
}

export const GUARANTEE_TYPES = ['deposit', 'card', 'company', 'none'] as const;
export type GuaranteeType = (typeof GUARANTEE_TYPES)[number];

export interface Party { adults: number; children: number; childAges: number[] }

export interface SupplementLine { kind: 'adult' | 'child'; band: string | null; bandLabel: string | null; age: number | null; ordinal: number; amountPerNight: string }

export interface QuoteResult {
  currency: string;
  totalAmount: string;
  roomTotal?: string;
  taxTotal: string;
  lineItems: Array<{ date: string; rate: string; tax: string }>;
  occupancySupplement?: { amount: string; lines: SupplementLine[] };
}

export type StatusTone = 'tentative' | 'confirmed' | 'inhouse' | 'departing' | 'closed';

/** Visual tone of a reservation status (tape chart bars, chips). */
export function statusTone(status: string): StatusTone {
  if (status === 'pending') return 'tentative';
  if (status === 'checked_in' || status === 'stayover') return 'inhouse';
  if (status === 'due_out') return 'departing';
  if (status === 'checked_out' || status === 'cancelled' || status === 'no_show') return 'closed';
  return 'confirmed';
}

/** Tape chart bar classes per tone: solid, high-contrast, status readable without the legend. */
export const BAR_CLASSES: Record<StatusTone, string> = {
  tentative: 'border-amber-400 bg-amber-50 text-amber-950 bar-hatched',
  confirmed: 'border-primary-300 bg-primary-50 text-telivity-navy',
  inhouse: 'border-emerald-400 bg-emerald-50 text-emerald-950',
  departing: 'border-violet-300 bg-violet-50 text-violet-950',
  closed: 'border-gray-300 bg-gray-100 text-gray-600',
};

/** Left accent stripe per tone. */
export const BAR_ACCENT: Record<StatusTone, string> = {
  tentative: 'bg-amber-500',
  confirmed: 'bg-telivity-teal',
  inhouse: 'bg-emerald-600',
  departing: 'bg-violet-600',
  closed: 'bg-gray-400',
};

export const CHIP_CLASSES: Record<StatusTone, string> = {
  tentative: 'bg-amber-100 text-amber-900',
  confirmed: 'bg-primary-100 text-primary-800',
  inhouse: 'bg-emerald-100 text-emerald-900',
  departing: 'bg-violet-100 text-violet-900',
  closed: 'bg-gray-100 text-gray-700',
};

/** "2 + 2 (4, 9)" compact party label used on bars and cards. */
export function compactParty(adults: number, children: number, childAges?: number[] | null) {
  if (!children) return String(adults);
  return `${adults} + ${children}${childAges?.length ? ` (${childAges.join(', ')})` : ''}`;
}

/** Is the option deadline in the past (or within `soonHours`)? */
export function optionState(optionUntil: string | null | undefined, now = Date.now(), soonHours = 24): 'none' | 'ok' | 'soon' | 'expired' {
  if (!optionUntil) return 'none';
  const at = new Date(optionUntil).getTime();
  if (Number.isNaN(at)) return 'none';
  if (at < now) return 'expired';
  return at - now < soonHours * 3_600_000 ? 'soon' : 'ok';
}

/** Default option deadline for the form: now + policy hours, as a datetime-local value. */
export function defaultOptionUntil(policy: BookingPolicy | undefined, now = new Date()): string {
  if (!policy?.optionHoldHours) return '';
  return toLocalInput(new Date(now.getTime() + policy.optionHoldHours * 3_600_000));
}

export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Required guarantee from the policy percentage, as a money string (or '' when the hotel set none). */
export function defaultDeposit(policy: BookingPolicy | undefined, total: string | undefined): string {
  if (policy?.depositPercentage == null || !total) return '';
  const cents = Math.round(Number(total) * 100 * Math.min(policy.depositPercentage, 100) / 100);
  return (cents / 100).toFixed(2);
}

/** Validates a party against the child ages: every child needs an age before pricing. */
export function partyComplete(party: Party) {
  return party.childAges.length === party.children && party.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17);
}
