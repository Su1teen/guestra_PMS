/**
 * Russian is the first locale shipped as a COMPLETE translation, so the
 * guarantee worth testing is not "some keys exist" but "no key falls back".
 *
 * English fallback is silent by design: a missing `ru` key renders the English
 * string, which looks like a rendering bug to a Russian-speaking receptionist
 * and is invisible to an English-speaking reviewer. These assertions are the
 * only thing standing between a new `en.json` key and that outcome.
 */
import { describe, expect, it } from 'vitest';

import en from './en.json';
import ru from './ru.json';
import { SUPPORTED_LANGUAGES } from '../i18n';

type Tree = Record<string, unknown>;

/**
 * Walk a locale tree and return every leaf as a pair of (key-path array, value).
 * Using a key array (not a dotted string) is essential because the `errors`
 * namespace uses keys that themselves contain dots (e.g.
 * "Network error. Please check your connection.") — flattening those to a
 * dotted path would make them indistinguishable from nested keys.
 */
function leaves(node: unknown, path: string[] = []): [string[], string][] {
  if (node == null || typeof node !== 'object') {
    return [[path, String(node)]];
  }
  return Object.entries(node as Tree).flatMap(([key, child]) =>
    leaves(child, [...path, key]),
  );
}

function read(tree: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (node, key) => (node && typeof node === 'object' ? (node as Tree)[key] : undefined),
    tree,
  );
}

function pathKey(path: string[]): string {
  return path.join('.');
}

/**
 * Tokens that are correctly identical in both languages: brands, payment-method
 * names, code samples and badge acronyms. Anything else matching English is an
 * untranslated string.
 */
const UNTRANSLATED_BY_DESIGN = new Set([
  'admin.keyPlaceholder',
  'bookingEngine.requestSettings.stripeKeyPlaceholder',
  'bookingRequests.audit.paymentDescription',
  'bookingRequests.methods.pix',
  'folios.paymentMethods.pix',
  'frontDesk.dnm',
  'guests.placeholders.email',
  'houseAccounts.paymentMethods.pix',
  'reservations.messageChannelSms',
  'reservations.siblingUnassignedLine',
  'reviews.sources.bookingCom',
  'reviews.sources.expedia',
  'reviews.sources.google',
  'reviews.sources.tripadvisor',
]);

const RU_PLURAL_EXTRAS = /_(few|many)$/;

describe('ru locale', () => {
  it('is offered in the language switcher', () => {
    expect(SUPPORTED_LANGUAGES.find((l) => l.code === 'ru')).toEqual({
      code: 'ru',
      label: 'Русский (RU)',
      flag: '🇷🇺',
    });
  });

  it('translates every English key — nothing falls back', () => {
    const missing: string[] = [];
    const blank: string[] = [];
    for (const [path] of leaves(en)) {
      const value = read(ru, path);
      if (typeof value !== 'string') missing.push(pathKey(path));
      else if (!value.trim()) blank.push(pathKey(path));
    }
    expect(missing, 'keys missing from ru.json').toEqual([]);
    expect(blank, 'keys left empty in ru.json (would fall back to English)').toEqual([]);
  });

  it('leaves no string in English', () => {
    const untranslated = leaves(en)
      .map(([path]) => path)
      .filter((path) => !UNTRANSLATED_BY_DESIGN.has(pathKey(path)))
      .filter((path) => {
        const english = read(en, path);
        return (
          typeof english === 'string' &&
          english === read(ru, path) &&
          // Pure punctuation / placeholder strings carry no words to translate.
          /[A-Za-z]{3}/.test(english.replace(/\{\{[^}]+\}\}/g, ''))
        );
      })
      .map(pathKey);
    expect(untranslated).toEqual([]);
  });

  it('keeps every interpolation placeholder', () => {
    const names = (value: string) =>
      [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim()).sort();
    const mismatched: string[] = [];
    for (const [path] of leaves(en)) {
      const english = read(en, path);
      const russian = read(ru, path);
      if (typeof english !== 'string' || typeof russian !== 'string') continue;
      if (names(english).join(',') !== names(russian).join(',')) mismatched.push(pathKey(path));
    }
    expect(mismatched).toEqual([]);
  });

  it('adds only Russian plural categories on top of the English key set', () => {
    const englishPaths = new Set(leaves(en).map(([path]) => pathKey(path)));
    const unexpected = leaves(ru)
      .map(([path]) => path)
      .filter((path) => !englishPaths.has(pathKey(path)) && !RU_PLURAL_EXTRAS.test(path[path.length - 1]))
      .map(pathKey);
    expect(unexpected).toEqual([]);
  });

  it('uses the hospitality glossary rather than literal translations', () => {
    expect(ru.reservations.availabilityCalendar).toContain('Календарь');
    expect(ru.nav.frontDesk).toContain('Ресепшен');
    expect(ru.nav.housekeeping).toContain('Служба уборки');
    expect(ru.nav.reservations).toBe('Бронирования');
    expect(ru.nav.dynamicPricing).toBe('Динамическое ценообразование');
    expect(ru.dashboard.adr).toContain('ADR');
    expect(ru.dashboard.revpar).toContain('RevPAR');
    expect(ru.dashboard.roomStatuses.out_of_order).toBe('Выведен из эксплуатации (Ремонт)');
    expect(ru.housekeeping.roomStatuses.out_of_order).toBe('Выведен из эксплуатации (Ремонт)');
  });
});
