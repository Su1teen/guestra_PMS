import '@testing-library/jest-dom';
// Initialise i18n (en is default + fallback) so components using useTranslation
// render real strings in tests instead of raw keys.
import '../i18n';

/**
 * Pin the default Intl locale to en-US for tests.
 *
 * `formatMoney` (and other Intl.NumberFormat callers) pass `undefined` as the
 * locale to pick up the runtime default. On a host whose system locale is not
 * en-US (e.g. a French-locale Windows machine), currency renders as
 * "150,00 $" instead of "$150.00", breaking assertions that were written
 * against en-US output. Tests are not the place to verify locale-aware
 * formatting — that belongs in dedicated locale tests — so we force a
 * deterministic en-US default here.
 */
const OriginalNumberFormat = Intl.NumberFormat;
class PinnedNumberFormat extends OriginalNumberFormat {
  constructor(
    locales?: string | string[] | undefined,
    options?: Intl.NumberFormatOptions | undefined,
  ) {
    super(locales ?? 'en-US', options);
  }
  // Preserve static methods (supportedLocalesOf, etc.)
  static supportedLocalesOf(
    locales?: string | string[],
    options?: Intl.NumberFormatOptions,
  ): string[] {
    return OriginalNumberFormat.supportedLocalesOf(locales, options);
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Intl as any).NumberFormat = PinnedNumberFormat;
