/** Resolve hotel wall-clock input without using the browser's timezone. */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function serviceLocalInput(instant: string | Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(timeZone, formatter); }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function serviceInstant(local: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('Укажите дату и время.');
  const wall = Date.parse(local + ':00Z');
  if (!Number.isFinite(wall)) throw new Error('Некорректная дата.');
  const offsets = new Set<number>();
  for (const hours of [-24, 0, 24]) {
    const sample = new Date(wall + hours * 3600000);
    offsets.add(Date.parse(serviceLocalInput(sample, timeZone) + ':00Z') - sample.getTime());
  }
  const matches = [...offsets].map(offset => new Date(wall - offset)).filter(d => serviceLocalInput(d, timeZone) === local);
  if (matches.length !== 1) throw new Error('Время отсутствует или неоднозначно из-за перевода часов. Выберите другое время.');
  return matches[0]!.toISOString();
}
export function serviceDays(date: string, count: number) {
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(date + 'T12:00:00Z') + i * 86400000).toISOString().slice(0, 10));
}
