import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHILD_AGE_BANDS,
  bedOccupants,
  composeParty,
  normaliseBands,
  occupancySupplementDetail,
  planHasSupplements,
  validateChildSupplements,
  type ChildAgeBand,
} from './child-pricing';

const bands: ChildAgeBand[] = [
  { code: 'infant', label: '0–5', minAge: 0, maxAge: 5, occupiesBed: false },
  { code: 'child', label: '6–12', minAge: 6, maxAge: 12, occupiesBed: true },
];
const plan = {
  extraAdultAmount: '5000.00',
  extraChildAmount: '2500.00',
  childSupplements: { infant: ['0', '1500'], child: ['3000', '4000'] },
};

describe('child age bands', () => {
  it('falls back to the interview defaults for missing or broken settings', () => {
    expect(normaliseBands(undefined)).toEqual(DEFAULT_CHILD_AGE_BANDS);
    expect(normaliseBands([{ code: 'a', label: 'a', minAge: 0, maxAge: 6, occupiesBed: true },
      { code: 'b', label: 'b', minAge: 5, maxAge: 12, occupiesBed: true }])).toEqual(DEFAULT_CHILD_AGE_BANDS);
    expect(normaliseBands([{ code: 'x', label: 'x', minAge: 3, maxAge: 1, occupiesBed: true }])).toEqual(DEFAULT_CHILD_AGE_BANDS);
  });

  it('sorts valid bands by age', () => {
    expect(normaliseBands([...bands].reverse()).map((b) => b.code)).toEqual(['infant', 'child']);
  });

  it('counts a child older than every band as an adult and orders children oldest first', () => {
    const party = composeParty(2, [3, 14, 9], bands);
    expect(party.adults).toBe(3);
    expect(party.children.map((c) => c.age)).toEqual([9, 3]);
    expect(party.bedOccupants).toBe(4); // infant takes no place
  });

  it('keeps the head-count capacity rule when ages are unknown', () => {
    expect(bedOccupants(2, 2, null, bands)).toBe(4);
    expect(bedOccupants(2, 2, [1, 4], bands)).toBe(2);
  });
});

describe('occupancySupplementDetail', () => {
  it('keeps the previous count-based result without ages', () => {
    const detail = occupancySupplementDetail(plan, 2, 2, 1, null, bands);
    expect(detail.amount).toBe('2500.00');
    expect(detail.lines).toEqual([{ kind: 'child', band: null, bandLabel: null, age: null, ordinal: 1, amountPerNight: '2500.00' }]);
  });

  it('prices each child by band and position in the band', () => {
    // 2 adults fill the 2 included places; two 6–12 children pay 3000 + 4000, two infants 0 + 1500.
    const detail = occupancySupplementDetail(plan, 2, 2, 4, [8, 2, 10, 4], bands);
    expect(detail.amount).toBe('8500.00');
    expect(detail.lines.map((l) => [l.band, l.age, l.ordinal, l.amountPerNight])).toEqual([
      ['child', 10, 1, '3000.00'],
      ['child', 8, 2, '4000.00'],
      ['infant', 4, 1, '0.00'],
      ['infant', 2, 2, '1500.00'],
    ]);
  });

  it('repeats the last amount for further children of a band', () => {
    expect(occupancySupplementDetail(plan, 2, 2, 3, [7, 8, 9], bands).amount).toBe('11000.00');
  });

  it('lets children that take a place use free included places, oldest first', () => {
    // One adult, three places included: the 11- and 9-year-old are covered, the 6-year-old is the 3rd child of the band.
    const detail = occupancySupplementDetail(plan, 3, 1, 3, [6, 11, 9], bands);
    expect(detail.amount).toBe('4000.00');
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({ band: 'child', age: 6, ordinal: 3 });
  });

  it('charges a teenager above every band as an extra adult', () => {
    expect(occupancySupplementDetail(plan, 2, 2, 1, [15], bands).amount).toBe('5000.00');
  });

  it('uses the flat child amount for a band the plan does not price', () => {
    const flat = { extraAdultAmount: null, extraChildAmount: '2500.00', childSupplements: null };
    expect(occupancySupplementDetail(flat, 2, 2, 2, [8, 3], bands).amount).toBe('2500.00'); // infant takes no place → free
  });

  it('charges nothing when the plan defines no supplements', () => {
    const none = { extraAdultAmount: null, extraChildAmount: null, childSupplements: null };
    expect(planHasSupplements(none)).toBe(false);
    expect(occupancySupplementDetail(none, 1, 3, 2, [3, 9], bands).amount).toBe('0.00');
  });
});

describe('validateChildSupplements', () => {
  it('accepts known bands with money amounts', () => {
    expect(validateChildSupplements({ infant: ['0', '1500.50'] }, bands)).toBeNull();
    expect(validateChildSupplements(null, bands)).toBeNull();
  });

  it('rejects unknown bands and bad amounts', () => {
    expect(validateChildSupplements({ teen: ['100'] }, bands)).toMatch(/Unknown/);
    expect(validateChildSupplements({ infant: ['-1'] }, bands)).toMatch(/money/);
    expect(validateChildSupplements({ infant: 'x' }, bands)).toMatch(/list/);
    expect(validateChildSupplements(['x'], bands)).toMatch(/object/);
  });
});
