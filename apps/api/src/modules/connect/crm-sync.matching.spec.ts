import { describe, it, expect } from 'vitest';
import { matchCategory, parseCategoryOverrides } from './crm-sync.matching';

const pms = [
  { id: 'sky', code: 'SKY', name: 'Sky House', maxOccupancy: 2 },
  { id: 'afr', code: 'AFR', name: 'A-Frame', maxOccupancy: 4 },
  { id: 'for2', code: 'FOR2', name: 'Forest House — 2 guests', maxOccupancy: 2 },
  { id: 'for6', code: 'FOR6', name: 'Forest House — 6 guests', maxOccupancy: 6 },
];

describe('matchCategory', () => {
  it('matches identical names', () => {
    expect(matchCategory('Sky House', pms)?.id).toBe('sky');
    expect(matchCategory('A-Frame', pms)?.id).toBe('afr');
  });
  it('matches the same category written differently by capacity', () => {
    expect(matchCategory('Forest House · 2-местный номер', pms)?.id).toBe('for2');
    expect(matchCategory('Forest House · 6-местный номер', pms)?.id).toBe('for6');
  });
  it('refuses an ambiguous or unknown category instead of guessing', () => {
    expect(matchCategory('Forest House', pms)).toBeNull();
    expect(matchCategory('Glass House', pms)).toBeNull();
    expect(matchCategory('Nest House', pms)).toBeNull();
  });
  it('honours an explicit operator mapping', () => {
    expect(matchCategory('Glass House', pms, parseCategoryOverrides('{"Glass House":"SKY"}'))?.id).toBe('sky');
    expect(parseCategoryOverrides('not json')).toEqual({});
  });
});
