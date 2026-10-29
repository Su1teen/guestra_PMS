/**
 * Category matching between CRM unit types and PMS room types.
 * The two systems name the same category differently
 * ("Forest House · 2-местный номер" / "Forest House — 2 guests"), so a match
 * requires the same base name and, when either name carries a capacity, the
 * same capacity. Anything else is reported as unmatched — never guessed.
 */
export interface CategoryCandidate { id: string; name: string; code?: string | null; maxOccupancy?: number | null }

const base = (name: string) => name.split(/\s[·—–-]\s|\s\(|,/)[0]!.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const capacity = (name: string) => {
  const match = name.match(/(\d+)\s*(?:-?\s*мест|guests?|гост|pax|чел)/iu);
  return match ? Number(match[1]) : null;
};

export function matchCategory<T extends CategoryCandidate>(name: string, candidates: T[], overrides: Record<string, string> = {}): T | null {
  const forced = overrides[name];
  if (forced) return candidates.find(c => c.code === forced || c.id === forced || c.name === forced) ?? null;
  const exact = candidates.filter(c => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (exact.length === 1) return exact[0]!;
  const wantedBase = base(name), wantedCapacity = capacity(name);
  const sameBase = candidates.filter(c => base(c.name) === wantedBase);
  const matches = sameBase.filter(c => {
    const own = capacity(c.name) ?? c.maxOccupancy ?? null;
    return wantedCapacity == null || own == null ? sameBase.length === 1 : own === wantedCapacity;
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function parseCategoryOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : {};
  } catch { return {}; }
}
