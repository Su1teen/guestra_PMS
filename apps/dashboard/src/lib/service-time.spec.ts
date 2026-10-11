import { describe, expect, it } from 'vitest';
import { serviceDays, serviceInstant, serviceLocalInput } from './service-time';
describe('hotel service time', () => {
  it('resolves hotel time independently of browser timezone', () => {
    expect(serviceInstant('2027-01-01T14:00', 'Asia/Almaty')).toBe('2027-01-01T09:00:00.000Z');
    expect(serviceLocalInput('2027-01-01T09:00:00Z', 'Asia/Almaty')).toBe('2027-01-01T14:00');
  });
  it('rejects nonexistent and ambiguous times instead of silently shifting the booking', () => {
    expect(() => serviceInstant('2027-03-28T02:30', 'Europe/Berlin')).toThrow();
    expect(() => serviceInstant('2027-10-31T02:30', 'Europe/Berlin')).toThrow();
    expect(() => serviceInstant('2027-02-30T12:00', 'UTC')).toThrow();
  });
  it('builds calendar dates over month boundaries', () => {
    expect(serviceDays('2027-01-31', 2)).toEqual(['2027-01-31', '2027-02-01']);
  });
});
