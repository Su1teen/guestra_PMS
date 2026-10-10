/** Property calendar date; never infer hotel business day from a remote browser's timezone. */
export function hotelDate(timezone?: string | null, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}
