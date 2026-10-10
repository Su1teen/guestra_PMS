import i18n from '../i18n';
export function staffNotificationText(notification: { type: string; title: string; message: string }) {
  if (!i18n.resolvedLanguage?.startsWith('ru')) return notification;
  const key: Record<string, string> = { audit_completed: 'audit', audit_error: 'auditError', anomaly: 'anomaly', agent_decision: 'agent', webhook_delivery_failed: 'webhook' };
  if (!key[notification.type]) return notification; // Preserve operator-authored text.
  return {
    title: /[А-Яа-яЁё]/.test(notification.title) ? notification.title : i18n.t(`staffNotifications.${key[notification.type]}`),
    message: /[А-Яа-яЁё]/.test(notification.message) ? notification.message : i18n.t('staffNotifications.legacyHint'),
  };
}
