// =============================================================================
// BLOC 3 (session 3) — CLOCHE D'ALERTES ADMIN + CARTE « À TRAITER »
// =============================================================================
// Visible sur TOUTES les pages admin (mobile compris). Compteur, liste avec
// titre / motif en une phrase / agence / date / couleur de priorité / action
// directe, états non lu → traité, rafraîchissement toutes les 30 s.
// =============================================================================
import { useState } from 'react';
import { AlertTriangle, Bell, CheckCheck, ChevronRight } from 'lucide-react';
import { Link } from 'wouter';
import {
  PRIORITY_LABELS,
  useAdminAlerts,
  useMarkAdminAlert,
  useMarkAllAdminAlerts,
  type AdminAlert,
} from '@/lib/admin-alerts-api';

function priorityClass(priority: string) {
  return `alert-pill alert-priority-${priority}`;
}

function AlertRow({ alert }: { alert: AdminAlert }) {
  const mark = useMarkAdminAlert();
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`admin-alert-row${alert.is_read ? ' is-read' : ' is-unread'}`}
      data-testid={`admin-alert-${alert.id}`}
    >
      <div className="admin-alert-head">
        <span className={priorityClass(alert.priority)}>{PRIORITY_LABELS[alert.priority] ?? alert.priority}</span>
        <strong>{alert.title}</strong>
        {!alert.is_read && <span className="notif-badge" aria-label="Non lue">•</span>}
      </div>
      <p className="admin-alert-reason">{alert.reason}</p>
      <div className="admin-alert-meta">
        {alert.agency_name && <span>{alert.agency_name}</span>}
        <span>{new Date(alert.created_at).toLocaleString('fr-FR')}</span>
      </div>
      <div className="admin-alert-actions">
        {alert.action_href && (
          <Link href={alert.action_href} className="button-link" data-testid={`admin-alert-action-${alert.id}`}>
            {alert.action_label ?? 'Ouvrir'} <ChevronRight size={13} />
          </Link>
        )}
        <button
          type="button"
          className="text-action"
          disabled={mark.isPending}
          onClick={() => mark.mutate({ id: alert.id, read: !alert.is_read })}
          data-testid={`admin-alert-toggle-${alert.id}`}
        >
          {alert.is_read ? 'Marquer non lue' : 'Marquer traitée'}
        </button>
        <button type="button" className="text-action" onClick={() => setOpen((v) => !v)}>
          {open ? 'Moins' : 'Détail'}
        </button>
      </div>
      {open && (
        <pre className="admin-alert-detail">{JSON.stringify({ kind: alert.kind, priorité: alert.priority }, null, 2)}</pre>
      )}
    </div>
  );
}

export function AdminAlertsBell() {
  const alertsQ = useAdminAlerts();
  const markAll = useMarkAllAdminAlerts();
  const [open, setOpen] = useState(false);
  const payload = alertsQ.data;
  const unread = payload?.unread ?? 0;
  const unreadIds = (payload?.alerts ?? []).filter((a) => !a.is_read).map((a) => a.id);

  return (
    <div className="notif-wrap">
      <button
        type="button"
        className="icon-button notif-button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Alertes administrateur (${unread} non lues)`}
        aria-expanded={open}
        data-testid="button-admin-alerts-bell"
      >
        <Bell size={15} />
        {unread > 0 && <span className="notif-badge" data-testid="count-admin-alerts">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel admin-alerts-panel" role="dialog" aria-label="Alertes administrateur" data-testid="panel-admin-alerts">
          <div className="notif-panel-head">
            <strong>À traiter ({unread})</strong>
            {unreadIds.length > 0 && (
              <button
                type="button"
                className="text-action"
                disabled={markAll.isPending}
                onClick={() => markAll.mutate(unreadIds)}
                data-testid="button-admin-alerts-read-all"
              >
                <CheckCheck size={13} /> Tout marquer traité
              </button>
            )}
          </div>
          {alertsQ.isLoading ? (
            <div className="notif-empty">Chargement…</div>
          ) : alertsQ.error ? (
            <div className="notif-empty" role="alert">
              Impossible de charger les alertes : {(alertsQ.error as Error).message}
            </div>
          ) : (payload?.alerts ?? []).length ? (
            <div className="notif-list">
              {payload!.alerts.map((alert) => <AlertRow key={alert.id} alert={alert} />)}
            </div>
          ) : (
            <div className="notif-empty">Aucune alerte. Tout est à jour.</div>
          )}
          <button type="button" className="notif-close" onClick={() => setOpen(false)}>Fermer</button>
        </div>
      )}
    </div>
  );
}

/** Carte « À traiter » affichée en haut de la vue d'ensemble admin. */
export function AdminAlertsCard() {
  const alertsQ = useAdminAlerts();
  const payload = alertsQ.data;
  const pending = (payload?.alerts ?? []).filter((alert) => !alert.is_read);

  if (alertsQ.isLoading) return <div className="panel"><div className="notif-empty">Chargement des alertes…</div></div>;
  if (alertsQ.error) {
    return (
      <section className="status-banner is-warn" role="alert" data-testid="status-admin-alerts-error">
        <div className="status-banner-icon"><AlertTriangle size={15} /></div>
        <div><strong>Alertes indisponibles</strong><p>{(alertsQ.error as Error).message}</p></div>
      </section>
    );
  }

  return (
    <section className="panel admin-alerts-card" data-testid="panel-admin-alerts-summary">
      <div className="panel-head">
        <div>
          <h2><Bell size={17} /> À traiter</h2>
          <p>
            {pending.length === 0
              ? 'Aucune alerte en attente.'
              : `${pending.length} alerte(s) en attente, dont ${payload?.critical ?? 0} prioritaire(s).`}
          </p>
        </div>
        <Link href="/admin/agences" className="button-link" data-testid="link-admin-alerts-all">Voir les agences</Link>
      </div>
      {pending.length > 0 && (
        <div className="admin-alerts-summary-list">
          {pending.slice(0, 5).map((alert) => (
            <div className="admin-alert-row is-unread" key={alert.id} data-testid={`admin-alert-summary-${alert.id}`}>
              <div className="admin-alert-head">
                <span className={priorityClass(alert.priority)}>{PRIORITY_LABELS[alert.priority] ?? alert.priority}</span>
                <strong>{alert.title}</strong>
              </div>
              <p className="admin-alert-reason">{alert.reason}</p>
              <div className="admin-alert-actions">
                {alert.action_href && (
                  <Link href={alert.action_href} className="button-link">
                    {alert.action_label ?? 'Ouvrir'} <ChevronRight size={13} />
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
