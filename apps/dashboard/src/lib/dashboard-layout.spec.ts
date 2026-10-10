import { describe, expect, it } from 'vitest';
import { layoutKey, parseLayout, visibleWidgets } from './dashboard-layout';
describe('workspace preferences', () => {
  it('isolates a user and a property without ambiguous delimiters', () => {
    expect(layoutKey('a:b', 'c')).not.toBe(layoutKey('a', 'b:c'));
    expect(layoutKey('alice', 'hotel-a')).not.toBe(layoutKey('alice', 'hotel-b'));
    expect(layoutKey('alice', 'hotel-a')).not.toBe(layoutKey('bob', 'hotel-a'));
  });
  it('recovers from malformed or unsupported persisted data', () => {
    for (const raw of ['{', null, JSON.stringify({ version: 2, preset: 'management', widgets: [] })]) {
      expect(parseLayout(raw).pages[0].widgets.map(w => w.type)).toContain('metrics');
    }
  });
  it('rejects unknown widgets and duplicates while preserving order and an empty selection', () => {
    expect(parseLayout(JSON.stringify({ version: 1, preset: 'frontdesk', widgets: ['rooms', 'arbitrary', 'rooms', 'activity'] })).pages[0].widgets.map(w => w.type)).toEqual(['rooms', 'activity']);
    expect(parseLayout(JSON.stringify({ version: 1, preset: 'frontdesk', widgets: [] })).pages[0].widgets.map(w => w.type)).toEqual([]);
  });
  it('does not grant access through a stored management preset', () => {
    const granted = ['dashboard.view'];
    expect(visibleWidgets(parseLayout(null), (...keys) => keys.every((key) => granted.includes(key)))).toEqual(['activity']);
  });
});
