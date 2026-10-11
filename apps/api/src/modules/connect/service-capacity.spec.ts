import { describe, expect, it } from 'vitest';
import { peakAllocatedUnits, stableServicePayload } from './service-capacity';
const at = (hour: number) => new Date(Date.UTC(2027, 0, 1, hour));
describe('service capacity', () => {
  it('counts peak concurrent units rather than adding disjoint appointments', () => {
    expect(peakAllocatedUnits(at(9), at(12), [{ startAt: at(9), endAt: at(10), units: 1 }, { startAt: at(11), endAt: at(12), units: 1 }])).toBe(1);
  });
  it('releases the old slot at the start of an adjacent appointment', () => {
    expect(peakAllocatedUnits(at(9), at(12), [{ startAt: at(9), endAt: at(10), units: 2 }, { startAt: at(10), endAt: at(11), units: 2 }])).toBe(2);
  });
  it('clips intervals and preserves the actual group-capacity peak', () => {
    expect(peakAllocatedUnits(at(9), at(12), [{ startAt: at(8), endAt: at(10), units: 2 }, { startAt: at(9), endAt: at(11), units: 3 }, { startAt: at(12), endAt: at(13), units: 9 }])).toBe(5);
  });
  it('canonicalizes nested object field order while preserving meaningful differences', () => {
    expect(stableServicePayload({ a: 1, context: { z: 'x', a: 2 }, absent: undefined })).toBe(stableServicePayload({ context: { a: 2, z: 'x' }, a: 1 }));
    expect(stableServicePayload({ a: ['x','y'] })).not.toBe(stableServicePayload({ a: ['y','x'] }));
  });
});
