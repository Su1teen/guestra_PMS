export function notificationAction(notification: { sourceEvent?: string; sourceEntityType?: string; sourceEntityId?: string }, hasPermission: (...keys: string[]) => boolean): string | null {
  const id = notification.sourceEntityId;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (notification.sourceEntityType === 'reservation' && hasPermission('reservations.read')) return '/reservations/' + id;
  if (notification.sourceEntityType === 'room' && hasPermission('rooms.read')) return '/rooms';
  if (['service_request','guest_request'].includes(notification.sourceEntityType ?? '') && hasPermission('ops.read')) return '/operations?tab=tasks&taskId=' + id;
  if (notification.sourceEntityType === 'maintenance_ticket' && hasPermission('ops.read')) return '/operations?tab=maintenance&ticketId=' + id;
  if (notification.sourceEntityType === 'payment' && hasPermission('cashier.access')) return '/cashier';
  if (notification.sourceEntityType === 'webhook_delivery' && hasPermission('settings.manage')) return '/integrations';
  if (notification.sourceEntityType === 'audit_run' && hasPermission('nightaudit.run')) return '/night-audit';
  if (notification.sourceEntityType === 'agent_decision' && hasPermission('revenue.manage')) return '/revenue';
  return null;
}
