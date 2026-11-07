// =============================================================================
// LOT 4 — Cloche d'Alertes Administrateur Temps Réel (Desktop & Android)
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { AlertTriangle, ArrowRight, Bell, Check, CheckCheck } from 'lucide-react';
import {
  ADMIN_ALERT_CATEGORY_LABELS,
  PRIORITY_LABELS,
  useAdminAlerts,
  useAdminAlertsRealtime,
  useMarkAdminAlert,
  useMarkAllAdminAlerts,
  type AdminAlert,
} from '@/lib/admin-alerts-api';
import { formatDateTime } from '@/lib/workspace-ui';

export function AdminAlertsBell({ testIdPrefix = '' }: { testIdPrefix?: string }) {
  useAdminAlertsRealtime(true);
  const alertsQ = useAdminAlerts(40);
  const markOne = useMarkAdminAlert();
  const markAll = useMarkAllAdminAlerts();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const unread = alertsQ.data?.unread ?? 0;
  const critical = alertsQ.data?.critical ?? 0;
  const alerts = alertsQ.data?.alerts ?? [];
  const unreadIds = alerts.filter((a) => !a.is_read).map((a) => a.id);

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

  const btnTestId = testIdPrefix ? `${testIdPrefix}-button-admin-alerts` : 'button-admin-alerts';
  const badgeTestId = testIdPrefix ? `${testIdPrefix}-badge-admin-alerts` : 'badge-admin-alerts';

  return (
    <div className="admin-alerts-bell" ref={wrapRef} data-testid="admin-alerts-bell">
      <button
        type="button"
        className={`icon-button admin-alerts-trigger${critical > 0 ? ' is-critical' : unread > 0 ? ' has-unread' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `${unread} alerte(s) non lue(s)` : 'Alertes plateforme'}
        aria-expanded={open}
        title="Alertes plateforme (temps réel)"
        data-testid={btnTestId}
      >
        <Bell size={16} />
        {unread > 0 && (
          <em className="admin-alerts-badge" data-testid={badgeTestId}>
            {unread > 99 ? '99+' : unread}
          </em>
        )}
      </button>

      {open && (
        <div
          className="admin-alerts-popover"
          role="dialog"
          aria-label="Alertes plateforme"
          data-testid="popover-admin-alerts"
        >
          <header className="admin-alerts-head">
            <div>
              <strong>Alertes plateforme</strong>
              <span>
                {unread > 0
                  ? `${unread} non lue(s)${critical > 0 ? ` · ${critical} haute(s)/critique(s)` : ''} · Bamako`
                  : 'Tout est à jour · Bamako'}
              </span>
            </div>
            {unreadIds.length > 0 && (
              <button
                type="button"
                className="text-action"
                onClick={() => markAll.mutate(null)}
                disabled={markAll.isPending}
                data-testid="button-admin-alerts-mark-all"
              >
                <CheckCheck size={13} /> Tout marquer lu
              </button>
            )}
          </header>

          <div className="admin-alerts-list">
            {alertsQ.isLoading ? (
              <p className="admin-alerts-empty">Analyse des signaux en cours…</p>
            ) : alerts.length === 0 ? (
              <p className="admin-alerts-empty">Aucune alerte enregistrée.</p>
            ) : (
              alerts.slice(0, 14).map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  onMark={(read) => markOne.mutate({ id: a.id, read })}
                  onNavigate={() => setOpen(false)}
                />
              ))
            )}
          </div>

          <div className="sofia-notif-footer">
            <Link
              href="/admin/activite"
              className="sofia-notif-center-link"
              onClick={() => setOpen(false)}
              data-testid="link-open-admin-alerts-center"
            >
              Ouvrir le centre de supervision & alertes <ArrowRight size={13} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function AlertRow({
  alert,
  onMark,
  onNavigate,
}: {
  alert: AdminAlert;
  onMark: (read: boolean) => void;
  onNavigate: () => void;
}) {
  const catLabel = alert.category
    ? ADMIN_ALERT_CATEGORY_LABELS[alert.category] ?? alert.category
    : null;

  return (
    <div
      className={`admin-alert-row is-${alert.priority}${alert.is_read ? ' is-read' : ''}`}
      data-testid={`admin-alert-${alert.kind}`}
    >
      <div className="admin-alert-main">
        <div className="admin-alert-meta">
          <span className={`priority-pill is-${alert.priority}`}>
            {alert.priority === 'critical' && <AlertTriangle size={11} />}
            {PRIORITY_LABELS[alert.priority]}
          </span>
          {catLabel && <span className="sofia-cat-tag">{catLabel}</span>}
          {alert.agency_name && <em>{alert.agency_name}</em>}
          <time dateTime={alert.created_at}>{formatDateTime(alert.created_at)}</time>
        </div>
        <strong>{alert.title}</strong>
        <p>{alert.reason}</p>
        <div className="admin-alert-actions">
          {alert.action_href && (
            <Link
              href={alert.action_href}
              className="text-action"
              onClick={() => {
                if (!alert.is_read) onMark(true);
                onNavigate();
              }}
              data-testid={`admin-alert-action-${alert.id}`}
            >
              {alert.action_label ?? 'Ouvrir'} <ArrowRight size={12} />
            </Link>
          )}
          <button
            type="button"
            className="text-action muted"
            onClick={() => onMark(!alert.is_read)}
            data-testid={`admin-alert-toggle-${alert.id}`}
          >
            <Check size={12} /> {alert.is_read ? 'Marquer non lu' : 'Marquer lu'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Carte synthèse pour la vue d'ensemble admin : uniquement les alertes non lues importantes. */
export function AdminAlertsSummaryCard() {
  useAdminAlertsRealtime(true);
  const alertsQ = useAdminAlerts(30);
  const markOne = useMarkAdminAlert();
  const unreadImportant = (alertsQ.data?.alerts ?? [])
    .filter((a) => !a.is_read && (a.priority === 'critical' || a.priority === 'high'))
    .slice(0, 5);

  if (alertsQ.isLoading || unreadImportant.length === 0) return null;

  return (
    <section
      className="panel-card admin-alerts-summary"
      aria-label="Alertes prioritaires"
      data-testid="card-admin-alerts-summary"
    >
      <div className="admin-section-head">
        <div>
          <span className="eyebrow">À traiter en priorité</span>
          <h2>
            {unreadImportant.length} alerte{unreadImportant.length > 1 ? 's' : ''} en attente d’action
          </h2>
        </div>
        <Link href="/admin/activite" className="text-action">
          Centre d’alertes <ArrowRight size={13} />
        </Link>
      </div>
      <div className="admin-alerts-summary-list">
        {unreadImportant.map((a) => (
          <div key={a.id} className={`admin-alert-summary-item is-${a.priority}`}>
            <div>
              <span className={`priority-pill is-${a.priority}`}>{PRIORITY_LABELS[a.priority]}</span>
              <strong>{a.title}</strong>
              <p>{a.reason}</p>
            </div>
            <div className="admin-alert-summary-cta">
              {a.action_href && (
                <Link
                  href={a.action_href}
                  className="secondary-button"
                  onClick={() => markOne.mutate({ id: a.id, read: true })}
                >
                  {a.action_label ?? 'Ouvrir'} <ArrowRight size={13} />
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export const AdminAlertsCard = AdminAlertsSummaryCard;
