import { useNavigate } from 'react-router-dom';
import { notificationAction } from '../../lib/notification-action';
import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, X, CheckCheck } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../../lib/api';
import { useProperty } from '../../context/PropertyContext';
import { getSocket } from '../../lib/socket';

import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { getDateLocale } from '../../lib/date-locale';
import { staffNotificationText } from '../../lib/staff-notification-text';

interface StaffNotification {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  createdAt: string;
  isRead: boolean;
  sourceEvent?: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
}

interface NotificationBellProps {
  className?: string;
}

export default function NotificationBell({ className }: NotificationBellProps) {
  const { t, i18n } = useTranslation();
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const userId = user?.sub ?? 'demo';
  const { propertyId, isPortfolioMode } = useProperty();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: notifications = [], isPending, isError, refetch } = useQuery({
    queryKey: ['staff-notifications', propertyId, userId],
    queryFn: () =>
      api
        .get('/v1/staff-notifications', { params: { propertyId }, skipErrorToast: true })
        .then((r) => (r.data?.data ?? r.data ?? []) as StaffNotification[]),
    enabled: !!propertyId && !isPortfolioMode && hasPermission('dashboard.view'),
    refetchInterval: 60_000,
  });

  const { data: unreadData } = useQuery({
    queryKey: ['staff-notifications-unread', propertyId, userId],
    queryFn: () =>
      api
        .get('/v1/staff-notifications/unread-count', { params: { propertyId }, skipErrorToast: true })
        .then((r) => r.data?.count ?? r.data ?? 0),
    enabled: !!propertyId && !isPortfolioMode,
  });

  const unreadCount = typeof unreadData === 'number' ? unreadData : 0;

  const markRead = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/v1/staff-notifications/${id}/read`, null, { params: { propertyId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-notifications', propertyId, userId] });
      queryClient.invalidateQueries({ queryKey: ['staff-notifications-unread', propertyId, userId] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () =>
      api.patch('/v1/staff-notifications/read-all', null, { params: { propertyId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-notifications', propertyId, userId] });
      queryClient.invalidateQueries({ queryKey: ['staff-notifications-unread', propertyId, userId] });
    },
  });

  const handleSocketNotification = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['staff-notifications', propertyId, userId] });
    queryClient.invalidateQueries({ queryKey: ['staff-notifications-unread', propertyId, userId] });
  }, [queryClient, propertyId, userId]);

  useEffect(() => {
    if (!propertyId || isPortfolioMode) return;
    const socket = getSocket();
    socket.on('staffNotification', handleSocketNotification);
    return () => {
      socket.off('staffNotification', handleSocketNotification);
    };
  }, [propertyId, isPortfolioMode, handleSocketNotification]);

  useEffect(() => { setOpen(false); }, [propertyId, userId]);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  if (!propertyId || isPortfolioMode) {
    return (
      <button
        className={`relative p-2 rounded-lg opacity-40 cursor-not-allowed ${className ?? ''}`}
        aria-label={t('staffNotifications.selectProperty')}
        disabled
      >
        <Bell size={18} className="text-telivity-slate" />
      </button>
    );
  }

  const severityColor = (s: string) => {
    if (s === 'critical') return 'border-l-red-500';
    if (s === 'warning') return 'border-l-telivity-orange';
    return 'border-l-telivity-teal';
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`relative p-2 rounded-lg hover:bg-telivity-light-grey transition-colors ${className ?? ''}`}
        aria-label={t('staffNotifications.title')}
        aria-expanded={open}
      >
        <Bell size={18} className="text-telivity-slate" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-telivity-orange text-white text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-telivity-navy">{t('staffNotifications.title')}</h3>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={() => markAllRead.mutate()}
                    className="p-1.5 rounded hover:bg-telivity-light-grey text-telivity-teal"
                    title={t('staffNotifications.markAll')}
                    aria-label={t('staffNotifications.markAll')}
                    disabled={markAllRead.isPending}
                  >
                    <CheckCheck size={14} />
                  </button>
                )}
                <button aria-label={t('common.close')} onClick={() => setOpen(false)} className="p-1.5 rounded hover:bg-telivity-light-grey">
                  <X size={14} className="text-telivity-mid-grey" />
                </button>
              </div>
            </div>
            <div className="max-h-96 overflow-y-auto">
              {isPending ? <p role="status" className="px-4 py-8 text-sm text-center">{t('staffNotifications.loading')}</p> : isError ? <div role="alert" className="p-4 text-sm text-center"><p>{t('staffNotifications.error')}</p><button className="mt-2 text-telivity-teal font-semibold" onClick={() => void refetch()}>{t('staffNotifications.retry')}</button></div> : notifications.length === 0 ? (
                <p className="px-4 py-8 text-sm text-telivity-mid-grey text-center">{t('staffNotifications.empty')}</p>
              ) : (
                <ul>
                  {notifications.map((n) => (
                    <li key={n.id}>
                      <button
                        className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-telivity-light-grey border-l-4 ${severityColor(n.severity)} ${
                          !n.isRead ? 'bg-telivity-teal/5' : ''
                        }`}
                        onClick={() => {
                          if (!n.isRead) markRead.mutate(n.id);
                          const href = notificationAction(n, hasPermission);
                          if (href) { setOpen(false); navigate(href); }
                        }}
                      >
                        <p className="text-sm font-medium text-telivity-navy">{staffNotificationText(n).title}</p>
                        <p className="text-xs text-telivity-mid-grey mt-0.5 line-clamp-2">{staffNotificationText(n).message}</p>
                        {notificationAction(n, hasPermission) && <span className="mt-2 block text-xs font-semibold text-telivity-teal">{t('staffNotifications.open')} →</span>}
                        <p className="text-[10px] text-telivity-mid-grey mt-1">
                          {format(new Date(n.createdAt), 'd MMM, HH:mm', { locale: getDateLocale(i18n.resolvedLanguage) })}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
