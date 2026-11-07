// =============================================================================
// LOT 4 — Cloche de notifications Temps Réel (Espace Agence — Desktop & Android)
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Bell, Check, CheckCheck, ExternalLink, Inbox } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import {
  AGENCY_NOTIFICATION_CATEGORY_LABELS,
  useAgencyNotificationsCenter,
  useAgencyNotificationsRealtime,
  useMarkAgencyNotification,
  useMarkAllAgencyNotifications,
} from '@/lib/notifications-api';
import { formatDateTime } from '@/lib/workspace-ui';

interface AgencyNotificationsBellProps {
  agencyId: string | null | undefined;
  testIdPrefix?: string;
}

export function AgencyNotificationsBell({
  agencyId,
  testIdPrefix = '',
}: AgencyNotificationsBellProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [, navigate] = useLocation();

  useAgencyNotificationsRealtime(agencyId);
  const centerQ = useAgencyNotificationsCenter(agencyId, { limit: 25 });
  const markOne = useMarkAgencyNotification(agencyId);
  const markAll = useMarkAllAgencyNotifications(agencyId);

  const unreadCount = centerQ.data?.unread_count ?? 0;
  const items = centerQ.data?.notifications ?? [];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const btnTestId = testIdPrefix ? `${testIdPrefix}-button-notifications` : 'button-notifications';
  const badgeTestId = testIdPrefix ? `${testIdPrefix}-count-unread-notifications` : 'count-unread-notifications';
  const panelTestId = testIdPrefix ? `${testIdPrefix}-panel-notifications` : 'panel-notifications';

  return (
    <div className="notif-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`icon-button notif-button${unreadCount > 0 ? ' has-unread' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={
          unreadCount > 0
            ? `${unreadCount} notification${unreadCount > 1 ? 's' : ''} non lue${unreadCount > 1 ? 's' : ''}`
            : 'Notifications'
        }
        title="Notifications"
        aria-expanded={open}
        data-testid={btnTestId}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="notif-badge" data-testid={badgeTestId}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="notif-panel sofia-notif-popover"
          role="dialog"
          aria-label="Notifications de l’agence"
          data-testid={panelTestId}
        >
          <div className="notif-panel-head">
            <div>
              <strong>Notifications</strong>
              <small style={{ display: 'block', fontSize: 11, opacity: 0.72 }}>
                {unreadCount > 0
                  ? `${unreadCount} non lue${unreadCount > 1 ? 's' : ''} · Heure de Bamako`
                  : 'Tout est à jour · Heure de Bamako'}
              </small>
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                className="text-action"
                onClick={() => markAll.mutate(null)}
                disabled={markAll.isPending}
                data-testid="button-mark-all-read"
              >
                <CheckCheck size={13} /> Tout lire
              </button>
            )}
          </div>

          {centerQ.isLoading ? (
            <div className="notif-empty">Chargement des notifications…</div>
          ) : centerQ.error ? (
            <div className="notif-empty">Impossible de charger les notifications.</div>
          ) : items.length === 0 ? (
            <div className="notif-empty">
              <Inbox size={20} style={{ margin: '0 auto 6px', opacity: 0.55 }} />
              Aucune notification pour l’instant.
            </div>
          ) : (
            <div className="notif-list">
              {items.slice(0, 12).map((item) => {
                const isUnread = !item.read_at;
                const catLabel =
                  AGENCY_NOTIFICATION_CATEGORY_LABELS[item.category] ?? item.category;
                return (
                  <div
                    key={item.id}
                    className={`notif-item sofia-notif-card${isUnread ? ' is-unread' : ''}`}
                    data-testid={`row-notification-${item.id}`}
                  >
                    <div className="sofia-notif-card-top">
                      <span className={`sofia-notif-pill is-${item.priority || 'normal'}`}>
                        {catLabel}
                      </span>
                      <small>{formatDateTime(item.created_at)}</small>
                    </div>
                    <strong>{item.title}</strong>
                    <span>{item.message}</span>
                    <div className="sofia-notif-card-actions">
                      {item.action_href && (
                        <button
                          type="button"
                          className="text-action"
                          onClick={() => {
                            if (isUnread) {
                              markOne.mutate({ notificationId: item.id, read: true });
                            }
                            setOpen(false);
                            navigate(item.action_href!);
                          }}
                          data-testid={`action-notification-${item.id}`}
                        >
                          {item.action_label || 'Consulter'} <ExternalLink size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-action muted"
                        onClick={() =>
                          markOne.mutate({ notificationId: item.id, read: isUnread })
                        }
                        disabled={markOne.isPending}
                        data-testid={`toggle-read-notification-${item.id}`}
                      >
                        <Check size={12} /> {isUnread ? 'Marquer lu' : 'Non lu'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="sofia-notif-footer">
            <Link
              href="/notifications"
              className="sofia-notif-center-link"
              onClick={() => setOpen(false)}
              data-testid="link-open-notifications-center"
            >
              Ouvrir le centre de notifications <ArrowRight size={13} />
            </Link>
            <button
              type="button"
              className="notif-close"
              onClick={() => setOpen(false)}
            >
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
