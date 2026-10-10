import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { WebhookPayload } from '../webhook/webhook.service';
import {
  WEBHOOK_DELIVERY_FAILED,
  type WebhookDeliveryFailedEvent,
} from '../webhook/webhook-delivery.service';
import { StaffNotificationService } from './staff-notification.service';

/**
 * Listens to domain events and creates staff-facing in-app notifications.
 */
@Injectable()
export class StaffNotificationListener {
  private readonly logger = new Logger(StaffNotificationListener.name);

  constructor(private readonly staffNotifications: StaffNotificationService) {}

  @OnEvent('reservation.created')
  @OnEvent('reservation.checked_in')
  @OnEvent('reservation.checked_out')
  @OnEvent('reservation.cancelled')
  @OnEvent('reservation.room_moved')
  @OnEvent('room.status_changed')
  @OnEvent('guest_request.created')
  @OnEvent('guest_request.completed')
  @OnEvent('maintenance.created')
  @OnEvent('maintenance.completed')
  @OnEvent('payment.failed')
  async onHotelEvent(payload: WebhookPayload) {
    if (!payload.propertyId) return;
    const titles: Record<string, string> = { 'reservation.created': 'Новая бронь', 'reservation.checked_in': 'Гость заселён',
      'reservation.checked_out': 'Выезд оформлен', 'reservation.cancelled': 'Бронь отменена', 'reservation.room_moved': 'Номер изменён',
      'room.status_changed': 'Обновлён статус номера', 'guest_request.created': 'Новый запрос гостя', 'guest_request.completed': 'Запрос гостя выполнен',
      'maintenance.created': 'Новая заявка на ремонт', 'maintenance.completed': 'Ремонт завершён', 'payment.failed': 'Не удалось принять оплату' };
    const permission = payload.event.startsWith('reservation.') ? 'reservations.read' : payload.event.startsWith('room.') ? 'rooms.read' : payload.event.startsWith('payment.') ? 'folios.read' : 'ops.read';
    const key = createHash('sha256').update(payload.logicalEventId ?? [payload.event, payload.entityId, payload.timestamp].join(':')).digest('hex');
    const title = titles[payload.event];
    if (!title) return;
    await this.staffNotifications.create({ propertyId: payload.propertyId, type: 'hotel_event', title,
      message: 'Откройте событие, чтобы проверить детали и дальнейшие действия.', severity: payload.event === 'payment.failed' ? 'warning' : 'info',
      sourceEvent: payload.event, sourceEntityType: payload.entityType, sourceEntityId: payload.entityId,
      requiredPermission: permission, deduplicationKey: key });
  }

  @OnEvent('agent.decision_created')
  async onAgentDecision(payload: WebhookPayload) {
    if (!payload.propertyId) return;

    const data = payload.data ?? {};
    const decisionType = String(data['decisionType'] ?? '');
    const agentType = String(data['agentType'] ?? '');
    const confidence = Number(data['confidence'] ?? 0);

    const isAnomaly =
      decisionType === 'night_audit_anomaly' ||
      agentType === 'night_audit';

    if (!isAnomaly && confidence < 0.7) return;

    const severity = decisionType === 'night_audit_anomaly' ? 'critical' : 'warning';
    const title =
      decisionType === 'night_audit_anomaly'
        ? 'Обнаружено отклонение ночного аудита'
        : 'Требуется проверка решения агента';

    await this.staffNotifications.create({
      propertyId: payload.propertyId,
      type: isAnomaly ? 'anomaly' : 'agent_decision',
      title,
      message: /[А-Яа-яЁё]/.test(String(data['summary'] ?? '')) ? String(data['summary']) : 'Проверьте решение агента в разделе управления выручкой.',
      severity,
      sourceEvent: 'agent.decision_created',
      requiredPermission: 'revenue.manage',
      deduplicationKey: 'agent:' + payload.entityId,
      sourceEntityType: 'agent_decision',
      sourceEntityId: payload.entityId,
    });
  }

  @OnEvent(WEBHOOK_DELIVERY_FAILED)
  async onWebhookDeliveryFailed(payload: WebhookDeliveryFailedEvent) {
    if (!payload?.propertyId) return;

    // Loop guard: creating a notification emits staff.notification_created,
    // which can itself be delivered to (and fail against) the same broken
    // endpoint — alerting on THAT failure would notify forever. Skip it; the
    // original failure already produced an alert.
    if (payload.eventType === 'staff.notification_created') return;

    const subscriber = payload.subscriberName ?? payload.subscriptionId;
    await this.staffNotifications.create({
      propertyId: payload.propertyId,
      type: 'webhook_delivery_failed',
      title: 'Не удалось доставить событие интеграции',
      message: `Подписчик «${subscriber}» не получил событие ${payload.eventType}. Число попыток: ${payload.attempts}. Проверьте интеграцию и повторите доставку события.`,
      severity: 'critical',
      sourceEvent: 'webhook.delivery_failed',
      requiredPermission: 'settings.manage',
      deduplicationKey: 'webhook:' + payload.deliveryId,
      sourceEntityType: 'webhook_delivery',
      sourceEntityId: payload.deliveryId,
    });
  }

  @OnEvent('audit.completed')
  async onAuditCompleted(payload: WebhookPayload) {
    if (!payload.propertyId) return;

    const data = payload.data ?? {};
    const summary = data['summary'] as Record<string, unknown> | undefined;
    const businessDate = String(data['businessDate'] ?? '');

    const errors = Array.isArray((data as any).errors) ? (data as any).errors : [];
    if (errors.length > 0) {
      await this.staffNotifications.create({
        propertyId: payload.propertyId,
        type: 'audit_error',
        title: `Ночной аудит завершён с ошибками: ${errors.length}`,
        message: `Операционная дата ${businessDate}: проверьте аудит перед закрытием дня.`,
        severity: 'warning',
        sourceEvent: 'audit.completed',
        requiredPermission: 'nightaudit.run',
        deduplicationKey: 'audit:' + payload.entityId,
        sourceEntityType: 'audit_run',
        sourceEntityId: payload.entityId,
      });
      return;
    }

    const netRevenue = summary?.['netRevenue'];
    if (netRevenue != null) {
      await this.staffNotifications.create({
        propertyId: payload.propertyId,
        type: 'audit_completed',
        title: 'Ночной аудит завершён',
        message: `Операционная дата ${businessDate} закрыта. Проверьте выручку в отчёте аудита.`,
        severity: 'info',
        sourceEvent: 'audit.completed',
        sourceEntityType: 'audit_run',
        sourceEntityId: payload.entityId,
      });
    }
  }
}
