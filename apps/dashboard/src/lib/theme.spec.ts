import { describe, expect, it } from 'vitest';
import { actionColorTokens, contrastWithWhite, parseHex, ACTION_TOKEN_NAMES } from './theme';

describe('staff theme tokens', () => {
  it('parses short and long hex colours', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('3657E8')).toEqual([54, 87, 232]);
    expect(parseHex('teal')).toBeNull();
    expect(parseHex(undefined)).toBeNull();
  });

  it('keeps the default action colour readable', () => {
    expect(contrastWithWhite([54, 87, 232])).toBeGreaterThanOrEqual(4.5);
  });

  it('derives the full ramp for a dark brand colour', () => {
    const tokens = actionColorTokens('#7A1F5C');
    expect(tokens?.['--color-primary']).toBe('122 31 92');
    expect(Object.keys(tokens ?? {})).toEqual(ACTION_TOKEN_NAMES);
  });

  it('refuses a pale brand colour that would make white labels unreadable', () => {
    expect(actionColorTokens('#9BE7E0')).toBeNull();
    expect(actionColorTokens('not-a-colour')).toBeNull();
  });
});
