import { describe, it, expect } from 'vitest';
import {
  shiftInterval,
  shiftWorkSegments,
  onDate,
} from './staff-shift.service';
describe('Explicit shift intervals and breaks', () => {
  it('requires offsets and rejects reversed or excessive intervals', () => {
    for (const [a, b] of [
      ['2026-10-12T09:00', '2026-10-12T18:00Z'],
      ['2026-10-12T09:00Z', '2026-10-12T08:00Z'],
      ['2026-10-12T09:00Z', '2026-10-13T11:00Z'],
      ['invalidZ', 'invalidZ'],
    ])
      expect(() => shiftInterval(a!, b!)).toThrow();
    expect(
      shiftInterval(
        '2026-10-12T09:00+05:00',
        '2026-10-12T18:00+05:00',
      ).start.toISOString(),
    ).toBe('2026-10-12T04:00:00.000Z');
  });
  it('subtracts explicit breaks without assuming a task duration', () => {
    const result = shiftWorkSegments({
      startAt: '2026-10-12T09:00Z',
      endAt: '2026-10-12T18:00Z',
      breaks: [
        { startAt: '2026-10-12T12:00Z', endAt: '2026-10-12T13:00Z' },
        { startAt: '2026-10-12T15:00Z', endAt: '2026-10-12T15:30Z' },
      ],
    });
    expect(
      result.map((v) => [v.start.toISOString(), v.end.toISOString()]),
    ).toEqual([
      ['2026-10-12T09:00:00.000Z', '2026-10-12T12:00:00.000Z'],
      ['2026-10-12T13:00:00.000Z', '2026-10-12T15:00:00.000Z'],
      ['2026-10-12T15:30:00.000Z', '2026-10-12T18:00:00.000Z'],
    ]);
  });
  it('does not count an all-break shift as available work', () =>
    expect(
      shiftWorkSegments({
        startAt: '2026-10-12T09:00Z',
        endAt: '2026-10-12T18:00Z',
        breaks: [{ startAt: '2026-10-12T09:00Z', endAt: '2026-10-12T18:00Z' }],
      }),
    ).toEqual([]));
  it('uses property dates for overnight and DST intervals', () => {
    expect(onDate(new Date('2026-10-12T21:00Z'), 'Asia/Almaty')).toBe(
      '2026-10-13',
    );
    expect(
      +shiftInterval('2026-10-25T01:00+02:00', '2026-10-25T04:00+01:00').end -
        +shiftInterval('2026-10-25T01:00+02:00', '2026-10-25T04:00+01:00')
          .start,
    ).toBe(4 * 3600000);
  });
});
