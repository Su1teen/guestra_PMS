import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
export type ServiceSchedule = { timeZone: string; windows: Array<{ day: number; start: string; end: string }> };
export function serviceInterval(startAt: string, endAt: string, maxDays = 7) {
  const offset = /T.+(?:Z|[+-]\d{2}:\d{2})$/i;
  const start = new Date(startAt); const end = new Date(endAt);
  if (!offset.test(startAt) || !offset.test(endAt) || !isISO8601(startAt, { strict: true }) || !isISO8601(endAt, { strict: true }) || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || end.getTime() - start.getTime() > maxDays * 86400000) {
    throw new BadRequestException({ code: 'INVALID_INTERVAL', message: 'Укажите начало и окончание с часовым поясом; интервал должен быть положительным и не больше недели.' });
  }
  return { start, end };
}
const minutes = (text: string) => { const [h = 0, m = 0] = text.split(':').map(Number); return h * 60 + m; };
export function validateServiceSchedule(input: ServiceSchedule | null | undefined) {
  if (input == null) return null;
  if (typeof input.timeZone !== 'string' || !input.timeZone.trim()) throw new BadRequestException({ code: 'INVALID_SCHEDULE', message: 'Укажите часовой пояс расписания.' });
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).format(); } catch { throw new BadRequestException({ code: 'INVALID_SCHEDULE', message: 'Неизвестный часовой пояс расписания.' }); }
  if (!Array.isArray(input.windows) || input.windows.length > 56 || input.windows.some(w => !w || !Number.isInteger(w.day) || w.day < 0 || w.day > 6 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(w.start) || !/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(w.end) || minutes(w.end) <= minutes(w.start))) {
    throw new BadRequestException({ code: 'INVALID_SCHEDULE', message: 'Проверьте дни недели и рабочие интервалы расписания.' });
  }
  return { timeZone: input.timeZone, windows: input.windows.map(w => ({ day: w.day, start: w.start, end: w.end })) };
}
const scheduleFormats = new Map<string, Intl.DateTimeFormat>();
export function fitsServiceSchedule(schedule: ServiceSchedule | null | undefined, start: Date, end: Date) {
  if (!schedule) return true;
  if (end <= start) return false;
  let format = scheduleFormats.get(schedule.timeZone);
  if (!format) { format = new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); scheduleFormats.set(schedule.timeZone, format); }
  const parts = (date: Date) => Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]));
  const last = new Date(end.getTime() - 1); const a = parts(start); const b = parts(last);
  const weekday = (p: Record<string,string>) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(p['weekday'] ?? '');
  const offset = (p: Record<string,string>, date: Date) => Date.UTC(Number(p['year']),Number(p['month'])-1,Number(p['day']),Number(p['hour']),Number(p['minute']),Number(p['second'])) - Math.floor(date.getTime()/1000)*1000;
  if (['year','month','day'].some(k => a[k] !== b[k]) || offset(a,start) !== offset(b,last)) {
    // Working windows have minute precision. Check every occupied UTC minute, including repeated DST minutes.
    for (let at = start.getTime(); at < end.getTime(); at = Math.floor(at/60000)*60000 + 60000) {
      const p = parts(new Date(at)); const minute = Number(p['hour'])*60 + Number(p['minute']);
      if (!schedule.windows.some(w => w.day === weekday(p) && minutes(w.start) <= minute && minute < minutes(w.end))) return false;
    }
    return true;
  }
  const day = weekday(a);
  const from = Number(a['hour']) * 60 + Number(a['minute']) + Number(a['second']) / 60;
  const to = Number(b['hour']) * 60 + Number(b['minute']) + (Number(b['second']) + 1) / 60;
  let covered = from;
  for (const w of schedule.windows.filter(w => w.day === day).sort((left,right) => minutes(left.start)-minutes(right.start))) {
    if (minutes(w.end) <= covered) continue;
    if (minutes(w.start) > covered) return false;
    covered = Math.max(covered, minutes(w.end)); if (covered >= to) return true;
  }
  return false;
}
