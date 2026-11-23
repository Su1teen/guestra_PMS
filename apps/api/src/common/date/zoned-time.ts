/** UTC instant of a wall-clock time in an IANA zone. */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time.length === 5 ? time : '15:00'}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(guess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}
