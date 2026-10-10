import i18n from '../i18n';

/** UI text only. Preserve the original error for callers and diagnostics. */
export function errorMessage(error: unknown): string {
  const e = error as { response?: { status?: number; data?: { code?: string; message?: string | string[] } }; message?: string } | null;
  const messages = e?.response?.data?.message ?? e?.message ?? (typeof error === 'string' ? error : '');
  const list = Array.isArray(messages) ? messages : [messages];
  if (!i18n.resolvedLanguage?.startsWith('ru')) return list.join(', ') || i18n.t('errors.Request failed');
  const code = e?.response?.data?.code;
  if (code && i18n.exists('errorCodes.' + code)) return i18n.t('errorCodes.' + code);
  const translated = list.map((message) => {
    const dictionary = i18n.getResource('ru', 'translation', 'errors') as Record<string, string>;
    if (dictionary?.[message]) return dictionary[message];
    // Russian messages from domain/UI validations are already suitable for display.
    if (/[А-Яа-яЁё]/.test(message) && !/\b(SELECT|INSERT|UPDATE|DELETE|stack)\b/.test(message)) return message;
    if (/No availability|not available|overlap|already occupied/i.test(message)) return i18n.t('systemErrors.unavailable');
    if (/balance|outstanding/i.test(message)) return i18n.t('systemErrors.balance');
    if (/Invalid status transition|Cannot .*status/i.test(message)) return i18n.t('systemErrors.transition');
    if (/Do Not Rent/i.test(message)) return i18n.t('systemErrors.dnr');
    if (/must be|is required|should not|Invalid|validation/i.test(message)) return i18n.t('systemErrors.validation');
    return '';
  });
  if (translated.every(Boolean)) return [...new Set(translated)].join(' · ');
  const status = e?.response?.status;
  if (status === 401) return i18n.t('systemErrors.unauthorized');
  if (status === 403) return i18n.t('systemErrors.forbidden');
  if (status === 404) return i18n.t('systemErrors.notFound');
  if (status === 409) return i18n.t('systemErrors.conflict');
  if (status === 400 || status === 422) return i18n.t('systemErrors.validation');
  if (status && status >= 500) return i18n.t('systemErrors.server');
  return i18n.t('systemErrors.request');
}
