import { describe, expect, it } from 'vitest';
import { fitsServiceSchedule, serviceInterval, validateServiceSchedule } from './service-schedule';
describe('service schedule', () => {
  it('requires a bounded positive interval and an explicit timezone', () => {
    for (const [a, b] of [['2027-01-01T09:00', '2027-01-01T10:00'], ['2027-01-01T10:00Z', '2027-01-01T09:00Z'], ['2027-01-01T09:00Z', '2027-01-09T09:00Z']]) expect(() => serviceInterval(a!, b!)).toThrow();
    expect(serviceInterval('2027-01-01T14:00:00+05:00', '2027-01-01T15:00:00+05:00').start.toISOString()).toBe('2027-01-01T09:00:00.000Z');
  });
  it('includes the exact closing boundary and excludes preparation outside working hours', () => {
    const schedule = { timeZone: 'Asia/Almaty', windows: [{ day: 5, start: '14:00', end: '15:00' }] };
    expect(fitsServiceSchedule(schedule, new Date('2027-01-01T09:00Z'), new Date('2027-01-01T10:00Z'))).toBe(true);
    expect(fitsServiceSchedule(schedule, new Date('2027-01-01T08:59Z'), new Date('2027-01-01T10:00Z'))).toBe(false);
    expect(fitsServiceSchedule(schedule, new Date('2027-01-01T09:00Z'), new Date('2027-01-01T10:01Z'))).toBe(false);
  });
  it('handles midnight closing and rejects a window crossing two local working dates', () => {
    const schedule = { timeZone: 'UTC', windows: [{ day: 5, start: '23:00', end: '24:00' }] };
    expect(fitsServiceSchedule(schedule, new Date('2027-01-01T23:00Z'), new Date('2027-01-02T00:00Z'))).toBe(true);
    expect(fitsServiceSchedule(schedule, new Date('2027-01-01T23:00Z'), new Date('2027-01-02T00:01Z'))).toBe(false);
  });
  it('uses actual instants across a daylight saving change', () => {
    const schedule = { timeZone: 'Europe/Berlin', windows: [{ day: 0, start: '01:00', end: '04:00' }] };
    expect(fitsServiceSchedule(schedule, new Date('2027-03-28T00:00Z'), new Date('2027-03-28T02:00Z'))).toBe(true);
  });
  it('allows continuous overnight/adjacent windows and refuses an actual break between them', () => {
    const overnight = { timeZone: 'UTC', windows: [{ day: 5, start: '23:00', end: '24:00' }, { day: 6, start: '00:00', end: '02:00' }] };
    expect(fitsServiceSchedule(overnight, new Date('2027-01-01T23:30Z'), new Date('2027-01-02T01:00Z'))).toBe(true);
    overnight.windows[1]!.start = '00:15';
    expect(fitsServiceSchedule(overnight, new Date('2027-01-01T23:30Z'), new Date('2027-01-02T01:00Z'))).toBe(false);
    const adjacent = { timeZone: 'UTC', windows: [{ day: 5, start: '09:00', end: '10:00' }, { day: 5, start: '10:00', end: '11:00' }] };
    expect(fitsServiceSchedule(adjacent, new Date('2027-01-01T09:30Z'), new Date('2027-01-01T10:30Z'))).toBe(true);
  });
  it('does not sell through a closed interval hidden by a repeated daylight-saving hour', () => {
    const schedule = { timeZone: 'America/New_York', windows: [{ day: 0, start: '01:00', end: '01:30' }] };
    expect(fitsServiceSchedule(schedule, new Date('2027-11-07T05:15Z'), new Date('2027-11-07T06:15Z'))).toBe(false);
    schedule.windows[0]!.end = '02:00';
    expect(fitsServiceSchedule(schedule, new Date('2027-11-07T05:15Z'), new Date('2027-11-07T06:15Z'))).toBe(true);
  });
  it('rejects unknown zones, malformed days and reversed windows', () => {
    expect(() => validateServiceSchedule({ timeZone: 'invalid', windows: [] })).toThrow();
    expect(() => validateServiceSchedule({ timeZone: 'UTC', windows: [{ day: 7, start: '10:00', end: '09:00' }] })).toThrow();
    expect(() => validateServiceSchedule({ windows: [] } as any)).toThrow();
    expect(() => validateServiceSchedule({ timeZone: 'UTC', windows: [null] } as any)).toThrow();
    expect(validateServiceSchedule(null)).toBeNull();
  });
});
