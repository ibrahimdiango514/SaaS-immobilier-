// =============================================================================
// LOT 4 & LOT 5 — ADMIN : CENTRE D'ALERTES DE SUPERVISION & JOURNAL D'ACTIVITÉ
// =============================================================================
import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  Calendar,
  Check,
  CheckCheck,
  Clock3,
  CreditCard,
  Download,
  Filter,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'wouter';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useActivityLog, useAllAgencies } from '@/lib/data-hooks';
import {
  ADMIN_ALERT_CATEGORY_LABELS,
  type AdminAlertCategory,
  type AlertPriority,
  PRIORITY_LABELS,
  useAdminAlertsCenter,
  useAdminAlertsRealtime,
  useBillingAutomationHealth,
  useMarkAdminAlert,
  useMarkAllAdminAlerts,
} from '@/lib/admin-alerts-api';
import { AdminHeading } from './admin-shell';
import {
  LoadingRows,
  SOFIA_TIMEZONE,
  dateTimeLabel,
  downloadCsv,
  entityLabels,
} from '@/lib/workspace-ui';

type AdminSupervisionTab = 'alerts' | 'activity';
type DatePreset = 'all' | '7d' | '30d' | 'custom';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export default function AdminActivityPage() {
  const [tab, setTab] = useState<AdminSupervisionTab>('alerts');

  // --- Onglet 1 : Centre d'alertes administrateur (Temps réel) ---
  useAdminAlertsRealtime(true);
  const [alertSearch, setAlertSearch] = useState('');
  const [alertCategory, setAlertCategory] = useState<AdminAlertCategory>('all');
  const [alertPriority, setAlertPriority] = useState<AlertPriority | 'all'>('all');
  const [alertStatus, setAlertStatus] = useState<'all' | 'unread' | 'read'>('all');
  const [alertAgency, setAlertAgency] = useState('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const effectiveFrom = useMemo(() => {
    if (datePreset === '7d') return isoDaysAgo(7);
    if (datePreset === '30d') return isoDaysAgo(30);
    if (datePreset === 'custom') return fromDate || null;
    return null;
  }, [datePreset, fromDate]);

  const effectiveTo = useMemo(
    () => (datePreset === 'custom' ? toDate || null : null),
    [datePreset, toDate],
  );

  const alertsCenterQ = useAdminAlertsCenter({
    category: alertCategory,
    priority: alertPriority,
    status: alertStatus,
    agencyId: alertAgency,
    fromDate: effectiveFrom,
    toDate: effectiveTo,
    limit: 200,
  });
  const cronHealthQ = useBillingAutomationHealth();
  const markOneAlert = useMarkAdminAlert();
  const markAllAlerts = useMarkAllAdminAlerts();

  // --- Onglet 2 : Journal d'activité global ---
  const activityQ = useActivityLog(300);
  const agenciesQ = useAllAgencies();
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState('all');
  const [agencyFilter, setAgencyFilter] = useState('all');

  const agencies = agenciesQ.data?.agencies ?? [];
  const entityTypes = useMemo(
    () => [...new Set((activityQ.data ?? []).map((entry) => entry.entity_type))].sort(),
    [activityQ.data],
  );

  const filteredAlerts = useMemo(() => {
    const raw = alertsCenterQ.data?.alerts ?? [];
    const needle = alertSearch.trim().toLocaleLowerCase('fr');
    if (!needle) return raw;
    return raw.filter((al) => {
      const hay = `${al.title} ${al.reason} ${al.agency_name ?? ''} ${al.kind}`.toLocaleLowerCase('fr');
      return hay.includes(needle);
    });
  }, [alertsCenterQ.data, alertSearch]);

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    return (activityQ.data ?? []).filter((entry) => {
      const agency = agencies.find((a) => a.id === entry.agency_id);
      const haystack = `${entry.summary} ${entry.entity_type} ${entry.action} ${agency?.name ?? ''}`.toLocaleLowerCase('fr');
      return (
        (!needle || haystack.includes(needle)) &&
        (entityFilter === 'all' || entry.entity_type === entityFilter) &&
        (agencyFilter === 'all' || entry.agency_id === agencyFilter)
      );
    });
  }, [activityQ.data, agencies, search, entityFilter, agencyFilter]);

  const exportCsv = () => {
    downloadCsv(
      `sofia-activite-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date (Bamako)', 'Action', 'Entité', 'Agence', 'Résumé'],
      rows.map((entry) => [
        dateTimeLabel(entry.created_at),
        entry.action,
        entityLabels[entry.entity_type] ?? entry.entity_type,
        agencies.find((a) => a.id === entry.agency_id)?.name ?? 'Plateforme',
        entry.summary,
      ]),
    );
  };

  const unreadAlerts = alertsCenterQ.data?.unread ?? 0;
  const criticalAlerts = alertsCenterQ.data?.critical ?? 0;
  const saspayUnread = alertsCenterQ.data?.saspay_unread ?? 0;
  const graceOrSuspUnread = alertsCenterQ.data?.grace_or_suspended_unread ?? 0;
  const cronHealth = cronHealthQ.data;

  return (
    <>
      <AdminHeading
        eyebrow={`Supervision temps réel · ${SOFIA_TIMEZONE}`}
        title="Alertes plateforme & journal d’activité"
        description="Surveillez les inscriptions, fins d’essai, périodes de grâce, suspensions, paiements SasPay, anomalies de réconciliation et l’historique d’audit complet."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tab === 'alerts' ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    void alertsCenterQ.refetch();
                    void cronHealthQ.refetch();
                  }}
                  data-testid="button-refresh-admin-alerts"
                >
                  <RefreshCw size={14} /> Actualiser
                </Button>
                {unreadAlerts > 0 && (
                  <Button
                    className="primary-action"
                    onClick={() =>
                      markAllAlerts.mutate(alertCategory === 'all' ? null : alertCategory)
                    }
                    disabled={markAllAlerts.isPending}
                    data-testid="button-admin-center-mark-all"
                  >
                    <CheckCheck size={14} /> Tout marquer lu ({unreadAlerts})
                  </Button>
                )}
              </>
            ) : (
              <button
                className="button-link"
                onClick={exportCsv}
                data-testid="button-export-activity"
              >
                <Download size={15} /> Exporter (CSV)
              </button>
            )}
          </div>
        }
      />

      {/* Bandeau Santé Automatisation Cron LOT 5 */}
      {cronHealth && (
        <div
          className="panel-card sofia-cron-banner"
          data-testid="banner-cron-automation-health"
        >
          <div className="sofia-cron-banner-left">
            <ShieldCheck size={17} />
            <div>
              <strong>
                Planificateur automatique :{' '}
                {cronHealth.pg_cron_active && cronHealth.cron_jobs.some((j) => j.active)
                  ? 'Actif (exécution horaire pg_cron)'
                  : 'Mode manuel / Edge'}
              </strong>
              <small>
                Dernier cycle d’échéances :{' '}
                {cronHealth.last_cycle_run
                  ? dateTimeLabel(cronHealth.last_cycle_run.created_at)
                  : 'Aucun cycle enregistré'}{' '}
                · Dernière réconciliation SasPay :{' '}
                {cronHealth.last_reconciliation_run
                  ? dateTimeLabel(cronHealth.last_reconciliation_run.created_at)
                  : 'Aucune exécution récente'}
              </small>
            </div>
          </div>
          <Link href="/admin/abonnements" className="text-action">
            Gérer les cycles <ArrowRight size={13} />
          </Link>
        </div>
      )}

      {/* Onglets Supervision */}
      <div className="sofia-tabs-bar" role="tablist" aria-label="Supervision plateforme">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'alerts'}
          className={`sofia-tab-btn${tab === 'alerts' ? ' is-active' : ''}`}
          onClick={() => setTab('alerts')}
          data-testid="tab-admin-alerts-center"
        >
          <Bell size={15} /> Centre d’alertes plateforme
          {unreadAlerts > 0 && <span className="sofia-tab-badge">{unreadAlerts}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'activity'}
          className={`sofia-tab-btn${tab === 'activity' ? ' is-active' : ''}`}
          onClick={() => setTab('activity')}
          data-testid="tab-admin-activity-log"
        >
          <Activity size={15} /> Journal d’activité SQL
          <span className="sofia-tab-badge is-neutral">{(activityQ.data ?? []).length}</span>
        </button>
      </div>

      {/* =====================================================================
          ONGLET 1 : CENTRE D'ALERTES ADMINISTRATEUR
      ===================================================================== */}
      {tab === 'alerts' && (
        <>
          <div className="sofia-kpi-strip" data-testid="admin-alerts-kpi-strip">
            <div className="panel-card sofia-kpi-mini">
              <div className="sofia-kpi-mini-head">
                <Bell size={16} />
                <span>Non lues</span>
              </div>
              <strong data-testid="kpi-admin-unread">{unreadAlerts}</strong>
              <small>Alertes en attente de lecture</small>
            </div>

            <div className="panel-card sofia-kpi-mini">
              <div className="sofia-kpi-mini-head">
                <AlertTriangle size={16} />
                <span>Priorité haute / critique</span>
              </div>
              <strong data-testid="kpi-admin-critical">{criticalAlerts}</strong>
              <small>Anomalies, échecs répétés ou suspensions</small>
            </div>

            <div className="panel-card sofia-kpi-mini">
              <div className="sofia-kpi-mini-head">
                <CreditCard size={16} />
                <span>SasPay & réconciliation</span>
              </div>
              <strong>{saspayUnread}</strong>
              <small>Sessions, confirmations, échecs ou écarts</small>
            </div>

            <div className="panel-card sofia-kpi-mini">
              <div className="sofia-kpi-mini-head">
                <Clock3 size={16} />
                <span>Grâce 5j & suspensions</span>
              </div>
              <strong>{graceOrSuspUnread}</strong>
              <small>Agences entrées en grâce ou suspendues</small>
            </div>
          </div>

          <section className="panel-card sofia-filters-card" data-testid="admin-alerts-filters">
            <div className="sofia-filters-grid">
              <div className="sofia-filter-field">
                <label htmlFor="admin-alert-search">
                  <Search size={13} /> Recherche
                </label>
                <Input
                  id="admin-alert-search"
                  value={alertSearch}
                  onChange={(e) => setAlertSearch(e.target.value)}
                  placeholder="Agence, SasPay, facture, suspension…"
                  data-testid="input-admin-alerts-search"
                />
              </div>

              <div className="sofia-filter-field">
                <label htmlFor="admin-alert-cat">
                  <Filter size={13} /> Catégorie
                </label>
                <select
                  id="admin-alert-cat"
                  className="field-select"
                  value={alertCategory}
                  onChange={(e) => setAlertCategory(e.target.value as AdminAlertCategory)}
                  data-testid="filter-admin-alerts-category"
                >
                  {Object.entries(ADMIN_ALERT_CATEGORY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sofia-filter-field">
                <label htmlFor="admin-alert-prio">Priorité</label>
                <select
                  id="admin-alert-prio"
                  className="field-select"
                  value={alertPriority}
                  onChange={(e) => setAlertPriority(e.target.value as AlertPriority | 'all')}
                  data-testid="filter-admin-alerts-priority"
                >
                  <option value="all">Toutes priorités</option>
                  <option value="critical">Critique</option>
                  <option value="high">Haute</option>
                  <option value="normal">Normale</option>
                  <option value="low">Information</option>
                </select>
              </div>

              <div className="sofia-filter-field">
                <label htmlFor="admin-alert-status">Statut</label>
                <select
                  id="admin-alert-status"
                  className="field-select"
                  value={alertStatus}
                  onChange={(e) =>
                    setAlertStatus(e.target.value as 'all' | 'unread' | 'read')
                  }
                  data-testid="filter-admin-alerts-status"
                >
                  <option value="all">Toutes</option>
                  <option value="unread">Non lues uniquement</option>
                  <option value="read">Déjà lues</option>
                </select>
              </div>

              <div className="sofia-filter-field">
                <label htmlFor="admin-alert-agency">Agence</label>
                <select
                  id="admin-alert-agency"
                  className="field-select"
                  value={alertAgency}
                  onChange={(e) => setAlertAgency(e.target.value)}
                  data-testid="filter-admin-alerts-agency"
                >
                  <option value="all">Toutes les agences</option>
                  {agencies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sofia-filter-field">
                <label htmlFor="admin-alert-period">
                  <Calendar size={13} /> Période
                </label>
                <select
                  id="admin-alert-period"
                  className="field-select"
                  value={datePreset}
                  onChange={(e) => setDatePreset(e.target.value as DatePreset)}
                  data-testid="filter-admin-alerts-period"
                >
                  <option value="all">Tout l’historique</option>
                  <option value="7d">7 derniers jours</option>
                  <option value="30d">30 derniers jours</option>
                  <option value="custom">Plage personnalisée</option>
                </select>
              </div>
            </div>

            {datePreset === 'custom' && (
              <div className="sofia-custom-dates-row">
                <div className="sofia-filter-field">
                  <label htmlFor="admin-alert-from">Du</label>
                  <Input
                    id="admin-alert-from"
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                  />
                </div>
                <div className="sofia-filter-field">
                  <label htmlFor="admin-alert-to">Au</label>
                  <Input
                    id="admin-alert-to"
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                  />
                </div>
              </div>
            )}
          </section>

          {alertsCenterQ.isLoading ? (
            <LoadingRows label="Chargement des alertes plateforme" />
          ) : filteredAlerts.length === 0 ? (
            <div className="state-card compact-empty" data-testid="empty-admin-alerts">
              <div className="state-icon">
                <Bell size={19} />
              </div>
              <h2>Aucune alerte pour ces filtres</h2>
              <p>
                Les inscriptions d’agences, fins d’essai, entrées en grâce, suspensions, paiements SasPay et anomalies de vérification remontent automatiquement ici.
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setAlertSearch('');
                  setAlertCategory('all');
                  setAlertPriority('all');
                  setAlertStatus('all');
                  setAlertAgency('all');
                  setDatePreset('all');
                }}
              >
                <Filter size={14} /> Réinitialiser les filtres
              </Button>
            </div>
          ) : (
            <div className="panel-card" data-testid="list-admin-alerts-center">
              <div className="sofia-center-list">
                {filteredAlerts.map((al) => {
                  const catLabel = al.category
                    ? ADMIN_ALERT_CATEGORY_LABELS[al.category] ?? al.category
                    : 'Plateforme';
                  return (
                    <article
                      key={al.id}
                      className={`sofia-center-row${!al.is_read ? ' is-unread' : ''}${
                        al.priority === 'critical' || al.priority === 'high' ? ' is-urgent' : ''
                      }`}
                      data-testid={`row-admin-alert-${al.id}`}
                    >
                      <div className="sofia-center-row-main">
                        <div className="sofia-center-meta">
                          <span className={`priority-pill is-${al.priority}`}>
                            {al.priority === 'critical' && <AlertTriangle size={11} />}
                            {PRIORITY_LABELS[al.priority]}
                          </span>
                          <span className="sofia-cat-tag">{catLabel}</span>
                          {al.agency_name && (
                            <strong className="sofia-agency-chip">{al.agency_name}</strong>
                          )}
                          {!al.is_read && <span className="sofia-unread-dot">À traiter</span>}
                          <time dateTime={al.created_at}>
                            {dateTimeLabel(al.created_at)} (Bamako)
                          </time>
                        </div>
                        <h3>{al.title}</h3>
                        <p>{al.reason}</p>
                      </div>

                      <div className="sofia-center-row-actions">
                        {al.action_href && (
                          <Link
                            href={al.action_href}
                            className="primary-action sofia-compact-btn"
                            onClick={() => {
                              if (!al.is_read) {
                                markOneAlert.mutate({ id: al.id, read: true });
                              }
                            }}
                            data-testid={`action-admin-alert-${al.id}`}
                          >
                            {al.action_label ?? 'Ouvrir le dossier'} <ArrowRight size={13} />
                          </Link>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            markOneAlert.mutate({ id: al.id, read: !al.is_read })
                          }
                          disabled={markOneAlert.isPending}
                          data-testid={`toggle-admin-alert-${al.id}`}
                        >
                          <Check size={13} /> {al.is_read ? 'Marquer non lu' : 'Marquer lu'}
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* =====================================================================
          ONGLET 2 : JOURNAL D'ACTIVITÉ SQL GLOBAL
      ===================================================================== */}
      {tab === 'activity' && (
        <>
          {activityQ.isLoading ? (
            <LoadingRows label="Chargement du journal d’activité…" />
          ) : activityQ.error ? (
            <div className="state-card error-state" role="alert">
              <h2>Accès refusé</h2>
              <p>Seuls les administrateurs peuvent consulter le journal global.</p>
              <Button variant="outline" onClick={() => void activityQ.refetch()}>
                Réessayer
              </Button>
            </div>
          ) : (
            <>
              <section className="list-toolbar">
                <label className="list-search">
                  <Search size={15} />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Résumé, agence, type…"
                    aria-label="Rechercher dans le journal"
                    data-testid="input-search-activity"
                  />
                </label>
                <select
                  className="form-select compact-select"
                  value={entityFilter}
                  onChange={(e) => setEntityFilter(e.target.value)}
                  aria-label="Filtrer par type d’entité"
                  data-testid="filter-activity-entity"
                >
                  <option value="all">Tous les modules</option>
                  {entityTypes.map((type) => (
                    <option key={type} value={type}>
                      {entityLabels[type] ?? type}
                    </option>
                  ))}
                </select>
                <select
                  className="form-select compact-select"
                  value={agencyFilter}
                  onChange={(e) => setAgencyFilter(e.target.value)}
                  aria-label="Filtrer par agence"
                  data-testid="filter-activity-agency"
                >
                  <option value="all">Toutes les agences</option>
                  {agencies.map((agency) => (
                    <option key={agency.id} value={agency.id}>
                      {agency.name}
                    </option>
                  ))}
                </select>
                <span className="result-count">{rows.length} entrée(s)</span>
              </section>

              {rows.length ? (
                <div className="panel list-panel">
                  <div className="table-wrap">
                    <table className="data-table full-table">
                      <thead>
                        <tr>
                          <th>Date (Bamako)</th>
                          <th>Module</th>
                          <th>Action</th>
                          <th>Agence</th>
                          <th>Détail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((entry) => (
                          <tr key={entry.id} data-testid={`row-activity-${entry.id}`}>
                            <td>{dateTimeLabel(entry.created_at)}</td>
                            <td>
                              <span className="entity-tag">
                                {entityLabels[entry.entity_type] ?? entry.entity_type}
                              </span>
                            </td>
                            <td>
                              <span
                                className={`activity-dot is-${entry.action}`}
                                style={{ display: 'inline-block', marginRight: 6 }}
                              />
                              {entry.action === 'created'
                                ? 'Création'
                                : entry.action === 'updated'
                                  ? 'Modification'
                                  : entry.action === 'deleted'
                                    ? 'Suppression'
                                    : entry.action}
                            </td>
                            <td>
                              {agencies.find((a) => a.id === entry.agency_id)?.name ?? (
                                <em>Plateforme</em>
                              )}
                            </td>
                            <td>{entry.summary}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="state-card compact-empty" data-testid="empty-activity">
                  <div className="state-icon">
                    <Activity size={19} />
                  </div>
                  <h2>Aucune entrée pour ces filtres</h2>
                  <p>Le journal se remplit automatiquement à mesure que les agences travaillent.</p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch('');
                      setEntityFilter('all');
                      setAgencyFilter('all');
                    }}
                  >
                    <Filter size={14} /> Réinitialiser les filtres
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
