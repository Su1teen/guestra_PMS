/** Half-open intervals: releases at the same instant happen before arrivals. */
export function peakAllocatedUnits(start: Date, end: Date, intervals: Array<{ startAt: Date; endAt: Date; units: number }>) {
  const events: Array<{ at: number; units: number }> = [];
  for (const interval of intervals) {
    const from = Math.max(start.getTime(), interval.startAt.getTime());
    const to = Math.min(end.getTime(), interval.endAt.getTime());
    if (from < to) events.push({ at: from, units: interval.units }, { at: to, units: -interval.units });
  }
  events.sort((a, b) => a.at - b.at || a.units - b.units);
  let current = 0; let peak = 0;
  for (const event of events) { current += event.units; peak = Math.max(peak, current); }
  return peak;
}

export function stableServicePayload(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableServicePayload).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + stableServicePayload(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
