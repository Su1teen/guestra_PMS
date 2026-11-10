import Decimal from 'decimal.js';

/**
 * Party composition and per-night occupancy supplements.
 *
 * The hotel configures child age bands (property setting) and, per rate plan, an amount per night for
 * the 1st, 2nd, … child of each band. Everything here is pure so quotes, bookings, documents and the
 * staff UI get the same answer. Nothing is charged unless the rate plan defines supplements.
 */

export interface ChildAgeBand {
  code: string;
  label: string;
  minAge: number;
  maxAge: number;
  /** Takes a place counted against the room capacity and the included occupancy. */
  occupiesBed: boolean;
}

/** Bands used until the property configures its own: ages from the pilot interview, both taking a place. */
export const DEFAULT_CHILD_AGE_BANDS: ChildAgeBand[] = [
  { code: 'child_0_5', label: '0–5', minAge: 0, maxAge: 5, occupiesBed: true },
  { code: 'child_6_12', label: '6–12', minAge: 6, maxAge: 12, occupiesBed: true },
];

export interface SupplementPlan {
  extraAdultAmount?: string | null;
  extraChildAmount?: string | null;
  childSupplements?: Record<string, string[]> | null;
}

export interface SupplementLine {
  kind: 'adult' | 'child';
  /** Band code for children priced by age; null for adults and for children priced without ages. */
  band: string | null;
  bandLabel: string | null;
  age: number | null;
  /** 1-based position among the guests of the same kind/band. */
  ordinal: number;
  amountPerNight: string;
}

export interface OccupancySupplement {
  amount: string;
  lines: SupplementLine[];
}

export interface PartyComposition {
  /** Adults plus children older than every band. */
  adults: number;
  /** Children within a band, oldest first. */
  children: Array<{ age: number; band: ChildAgeBand }>;
  /** Guests that take a place (capacity check). */
  bedOccupants: number;
}

/** Valid, non-overlapping bands sorted by age; falls back to the defaults when the setting is unusable. */
export function normaliseBands(bands: ChildAgeBand[] | null | undefined): ChildAgeBand[] {
  const valid = (bands ?? []).filter((b) => b && typeof b.code === 'string' && b.code.trim()
    && Number.isInteger(b.minAge) && Number.isInteger(b.maxAge) && b.minAge >= 0 && b.maxAge >= b.minAge && b.maxAge < 18);
  const sorted = [...valid].sort((a, b) => a.minAge - b.minAge);
  const overlaps = sorted.some((b, i) => i > 0 && b.minAge <= sorted[i - 1]!.maxAge);
  return sorted.length && !overlaps ? sorted.map((b) => ({ ...b, occupiesBed: b.occupiesBed !== false })) : DEFAULT_CHILD_AGE_BANDS;
}

export function bandForAge(age: number, bands: ChildAgeBand[]): ChildAgeBand | null {
  return bands.find((b) => age >= b.minAge && age <= b.maxAge) ?? null;
}

/** Splits the party by age; a child older than every band counts as an adult. */
export function composeParty(adults: number, childAges: number[], bands: ChildAgeBand[]): PartyComposition {
  let grownUps = adults;
  const children: PartyComposition['children'] = [];
  for (const age of childAges) {
    const band = bandForAge(age, bands);
    if (band) children.push({ age, band });
    else grownUps += 1;
  }
  children.sort((a, b) => b.age - a.age);
  return { adults: grownUps, children, bedOccupants: grownUps + children.filter((c) => c.band.occupiesBed).length };
}

/** Guests counted against room capacity: without ages every child takes a place (previous behaviour). */
export function bedOccupants(adults: number, children: number, childAges: number[] | null | undefined, bands: ChildAgeBand[]) {
  return childAges?.length ? composeParty(adults, childAges, bands).bedOccupants : adults + children;
}

function nth(amounts: string[] | undefined, ordinal: number): Decimal | null {
  if (!amounts?.length) return null;
  const value = amounts[Math.min(ordinal, amounts.length) - 1];
  return value == null || value === '' ? null : new Decimal(value);
}

/**
 * Supplement per night.
 *
 * - Adults fill the included places first; every further adult pays `extraAdultAmount`.
 * - Children that take a place fill the remaining included places, oldest first, and pay nothing there.
 * - Every other child pays the plan amount for its band and position in that band (the last amount repeats);
 *   without band amounts it pays `extraChildAmount` when it takes a place, nothing otherwise.
 * - Without ages the previous count-based rule applies unchanged.
 */
export function occupancySupplementDetail(
  plan: SupplementPlan,
  includedOccupancy: number,
  adults: number,
  children: number,
  childAges: number[] | null | undefined,
  bandsSetting: ChildAgeBand[] | null | undefined,
): OccupancySupplement {
  const lines: SupplementLine[] = [];
  const adultRate = new Decimal(plan.extraAdultAmount ?? 0);
  const flatChild = new Decimal(plan.extraChildAmount ?? 0);

  if (!childAges?.length) {
    const extraAdults = Math.max(0, adults - includedOccupancy);
    const extraChildren = Math.max(0, Math.min(children, adults + children - includedOccupancy));
    for (let i = 1; i <= extraAdults; i++) lines.push({ kind: 'adult', band: null, bandLabel: null, age: null, ordinal: i, amountPerNight: adultRate.toFixed(2) });
    for (let i = 1; i <= extraChildren; i++) lines.push({ kind: 'child', band: null, bandLabel: null, age: null, ordinal: i, amountPerNight: flatChild.toFixed(2) });
    return finish(lines);
  }

  const bands = normaliseBands(bandsSetting);
  const party = composeParty(adults, childAges, bands);
  let freePlaces = Math.max(0, includedOccupancy - party.adults);
  for (let i = 1; i <= Math.max(0, party.adults - includedOccupancy); i++) {
    lines.push({ kind: 'adult', band: null, bandLabel: null, age: null, ordinal: i, amountPerNight: adultRate.toFixed(2) });
  }
  const ordinals = new Map<string, number>();
  for (const child of party.children) {
    const ordinal = (ordinals.get(child.band.code) ?? 0) + 1;
    ordinals.set(child.band.code, ordinal);
    if (child.band.occupiesBed && freePlaces > 0) { freePlaces -= 1; continue; }
    const byBand = nth(plan.childSupplements?.[child.band.code], ordinal);
    const amount = byBand ?? (child.band.occupiesBed ? flatChild : new Decimal(0));
    lines.push({ kind: 'child', band: child.band.code, bandLabel: child.band.label, age: child.age, ordinal, amountPerNight: amount.toFixed(2) });
  }
  return finish(lines);
}

function finish(lines: SupplementLine[]): OccupancySupplement {
  const amount = lines.reduce((sum, line) => sum.plus(line.amountPerNight), new Decimal(0));
  // Free children priced by age stay visible ("0–5, free"); other zero lines are noise.
  return { amount: amount.toFixed(2), lines: lines.filter((line) => line.band != null || !new Decimal(line.amountPerNight).isZero()) };
}

/** True when the plan charges anything for extra guests. */
export function planHasSupplements(plan: SupplementPlan) {
  return plan.extraAdultAmount != null || plan.extraChildAmount != null
    || Object.values(plan.childSupplements ?? {}).some((amounts) => amounts?.some((a) => a !== '' && a != null));
}

/** Validates a `childSupplements` payload: known band codes, non-negative money amounts. */
export function validateChildSupplements(value: unknown, bands: ChildAgeBand[]): string | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'childSupplements must be an object keyed by age band';
  const codes = new Set(bands.map((b) => b.code));
  for (const [code, amounts] of Object.entries(value as Record<string, unknown>)) {
    if (!codes.has(code)) return `Unknown child age band: ${code}`;
    if (!Array.isArray(amounts) || amounts.length > 10) return `childSupplements.${code} must be a list of up to 10 amounts`;
    if (amounts.some((a) => typeof a !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(a))) return `childSupplements.${code} amounts must be non-negative money strings`;
  }
  return null;
}
