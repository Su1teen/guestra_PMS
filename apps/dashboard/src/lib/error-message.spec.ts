import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { errorMessage } from './error-message';
import { staffNotificationText } from './staff-notification-text';
describe('Russian system text', () => {
  beforeEach(() => i18n.changeLanguage('ru'));
  afterEach(() => i18n.changeLanguage('en'));
  it('does not expose unknown server diagnostics or validation arrays', () => {
    expect(errorMessage({ response: { status: 500, data: { message: 'SQL SELECT credit_card FROM secret' } } })).toBe('Сервис временно недоступен. Повторите попытку позже.');
    expect(errorMessage({ response: { status: 400, data: { message: ['propertyId must be a UUID', 'adults must be an integer number'] } } })).toBe('Проверьте заполненные поля и выбранные даты.');
  });
  it('retains actionable domain explanations and already translated text', () => {
    expect(errorMessage(new Error('No availability for room type rt on 2026-10-10'))).toContain('Размещение недоступно');
    expect(errorMessage(new Error('Проверьте выбранный номер.'))).toBe('Проверьте выбранный номер.');
  });
  it('explains currency reconciliation without treating it as invalid date input', () => {
    expect(errorMessage({ response: { status: 400, data: { code: 'CURRENCY_MISMATCH', message: 'CURRENCY_MISMATCH: ledger requires explicit currency conversion' } } }))
      .toContain('Валюты финансовых записей');
    expect(errorMessage({ response: { status: 400, data: { message: 'CURRENCY_MISMATCH: ledger requires explicit currency conversion' } } }))
      .toContain('Валюты финансовых записей');
  });
  it('localizes legacy hotel notifications without rewriting custom messages', () => {
    expect(staffNotificationText({ type: 'audit_completed', title: 'Night audit completed', message: 'Business date closed.' }).title).toBe('Ночной аудит завершён');
    expect(staffNotificationText({ type: 'custom', title: 'VIP', message: 'Анна: подготовить номер' })).toEqual({ type: 'custom', title: 'VIP', message: 'Анна: подготовить номер' });
  });
});
