import { describe, expect, it } from 'vitest';
import { activeNavigationItem, NAVIGATION, propertyHref, visibleNavigation } from './navigation';

describe('product navigation', () => {
  it('preserves property and target filters without copying unrelated source context', () => {
    expect(propertyHref('/reports?report=daily-revenue', 'property-a')).toBe('/reports?report=daily-revenue&propertyId=property-a');
    expect(propertyHref('/housekeeping?tab=shifts', 'portfolio')).toBe('/housekeeping?tab=shifts&propertyId=portfolio');
    expect(propertyHref('/guests', null)).toBe('/guests');
    expect(propertyHref('/guests?propertyId=explicit', 'other')).toBe('/guests?propertyId=explicit');
  });
  it('selects exactly one destination for report, staff and settings tabs', () => {
    expect(activeNavigationItem('/housekeeping', '?propertyId=p&tab=shifts')).toBe('/housekeeping?tab=shifts');
    expect(activeNavigationItem('/housekeeping', '?tab=tasks')).toBe('/housekeeping');
    expect(activeNavigationItem('/reports', '?report=daily-revenue')).toBe('/reports?report=daily-revenue');
    expect(activeNavigationItem('/reports', '?report=pickup')).toBe('/reports');
    expect(activeNavigationItem('/reports/management', '?propertyId=p')).toBe('/reports/management');
    expect(activeNavigationItem('/settings', '?tab=users')).toBe('/settings?tab=users');
    expect(activeNavigationItem('/guests/person', '')).toBe('/guests');
    expect(activeNavigationItem('/reports-unknown', '')).toBeUndefined();
  });
  it('does not duplicate destinations and filters every section by its permissions', () => {
    const items = NAVIGATION.flatMap(section => section.items);
    expect(new Set(items.map(item => item.to)).size).toBe(items.length);
    expect(visibleNavigation(() => false)).toEqual([]);
    expect(visibleNavigation(permission => permission === 'reports.view').flatMap(s => s.items).map(i => i.to)).toEqual([
      '/reports/management', '/reports?report=daily-revenue', '/reports',
    ]);
  });
});
