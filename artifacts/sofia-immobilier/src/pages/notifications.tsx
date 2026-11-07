// =============================================================================
// LOT 4 — Centre de Notifications & Historique des Événements de Facturation
//         Route : /notifications (Espace Agence — Desktop & Mobile Android)
// =============================================================================
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Calendar,
  Check,
  CheckCheck,
  Clock3,
  CreditCard,
  ExternalLink,
  FileText,
  Filter,
  History,
  Inbox,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgency } from '@/lib/agency-context';
import {
  AGENCY_NOTIFICATION_CATEGORY_LABELS,
  BILLING_EVENT_LABELS,
  type AgencyNotificationCategory,
  useAgencyBillingEvents,
  useAgencyNotificationsCenter,
  useAgencyNotificationsRealtime,
  useMarkAgencyNotification,
  useMarkAllAgencyNotifications,
} from '@/lib/notifications-api';
import { formatDate, formatDateTime, Heading, LoadingRows, SOFIA_TIMEZONE } from '@/lib/workspace-ui';

type DatePreset = 'all' | '7d' | '30d' | 'custom';
type ReadFilter = 'all' | 'unread' | 'read';
type ActiveTab = 'notifications' | 'billing_events';

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const cashXof = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value)} FCFA`
    : '—';

export default function NotificationsCenterPage() {
  const { activeAgency, activeAgencyId } = useAgency();
  const [tab, setTab] = useState<ActiveTab>('notifications');
  const [category, setCategory] = useState<AgencyNotificationCategory>('all');
  const [readFilter, setReadFilter] = useState<ReadFilter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [search, setSearch] = useState('');

  useAgencyNotificationsRealtime(activeAgencyId);

  const effectiveFrom = useMemo(() => {
    if (datePreset === '7d') return isoDaysAgo(7);
    if (datePreset === '30d') return isoDaysAgo(30);
    if (datePreset === 'custom') return customFrom || null;
    return null;
  }, [datePreset, customFrom]);

  const effectiveTo = useMemo(() => {
    if (datePreset === 'custom') return customTo || null;
    return null;
  }, [datePreset, customTo]);

  const centerQ = useAgencyNotificationsCenter(activeAgencyId, {
    category,
    unreadOnly: readFilter === 'unread',
    fromDate: effectiveFrom,
    toDate: effectiveTo,
    limit: 150,
  });

  const eventsQ = useAgencyBillingEvents(activeAgencyId, 100);
  const markOne = useMarkAgencyNotification(activeAgencyId);
  const markAll = useMarkAllAgencyNotifications(activeAgencyId);

  const notifications = useMemo(() => {
    const raw = centerQ.data?.notifications ?? [];
    const needle = search.trim().toLocaleLowerCase('fr');
    return raw.filter((item) => {
      if (readFilter === 'read' && !item.read_at) return false;
      if (readFilter === 'unread' && item.read_at) return false;
      if (!needle) return true;
      const hay = `${item.title} ${item.message} ${item.category}`.toLocaleLowerCase('fr');
      return hay.includes(needle);
    });
  }, [centerQ.data, readFilter, search]);

  const billingEvents = useMemo(() => {
    const raw = eventsQ.data ?? [];
    const needle = search.trim().toLocaleLowerCase('fr');
    return raw.filter((ev) => {
      const day = ev.created_at.slice(0, 10);
      if (effectiveFrom && day < effectiveFrom) return false;
      if (effectiveTo && day > effectiveTo) return false;
      if (!needle) return true;
      const label = BILLING_EVENT_LABELS[ev.event_type] ?? ev.event_type;
      const hay = `${label} ${ev.invoice_reference ?? ''} ${ev.reference ?? ''} ${ev.reason ?? ''} ${ev.plan_to_name ?? ''}`.toLocaleLowerCase('fr');
      return hay.includes(needle);
    });
  }, [eventsQ.data, effectiveFrom, effectiveTo, search]);

  const unreadCount = centerQ.data?.unread_count ?? 0;
  const catCounts = centerQ.data?.category_counts ?? {};
  const billingAndGraceCount =
    Number(catCounts.billing ?? 0) + Number(catCounts.suspension ?? 0) + Number(catCounts.trial ?? 0);
  const paymentNotifCount = Number(catCounts.payment ?? 0);

  return (
    <div className="page-stack" data-testid="page-notifications-center">
      <Heading
        eyebrow={`Espace agence · Fuseau ${SOFIA_TIMEZONE}`}
        title="Centre de notifications & facturation"
        description={`Suivez en temps réel vos échéances d’abonnement, vos rappels automatiques, vos paiements SasPay et l’historique complet de « ${activeAgency?.name ?? 'votre agence'} ».`}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="outline"
              onClick={() => {
                void centerQ.refetch();
                void eventsQ.refetch();
              }}
              data-testid="button-refresh-notifications"
            >
              <RefreshCw size={14} /> Actualiser
            </Button>
            {unreadCount > 0 && (
              <Button
                className="primary-action"
                onClick={() => markAll.mutate(category === 'all' ? null : category)}
                disabled={markAll.isPending}
                data-testid="button-center-mark-all-read"
              >
                <CheckCheck size={15} /> Tout marquer lu ({unreadCount})
              </Button>
            )}
          </div>
        }
      />

      {/* KPIs rapides */}
      <div className="sofia-kpi-strip" data-testid="notifications-kpi-strip">
        <div className="panel-card sofia-kpi-mini">
          <div className="sofia-kpi-mini-head">
            <Bell size={16} />
            <span>Non lues</span>
          </div>
          <strong data-testid="kpi-unread-notifications">{unreadCount}</strong>
          <small>Sur {centerQ.data?.total_count ?? 0} notification(s) enregistrée(s)</small>
        </div>

        <div className="panel-card sofia-kpi-mini">
          <div className="sofia-kpi-mini-head">
            <Clock3 size={16} />
            <span>Échéances, essai & grâce</span>
          </div>
          <strong>{billingAndGraceCount}</strong>
          <small>Rappels automatiques J-7, J-3, J-1 et période de grâce</small>
        </div>

        <div className="panel-card sofia-kpi-mini">
          <div className="sofia-kpi-mini-head">
            <CreditCard size={16} />
            <span>Paiements SasPay</span>
          </div>
          <strong>{paymentNotifCount}</strong>
          <small>Sessions initiées, confirmations et relances</small>
        </div>

        <div className="panel-card sofia-kpi-mini">
          <div className="sofia-kpi-mini-head">
            <History size={16} />
            <span>Événements d’abonnement</span>
          </div>
          <strong>{(eventsQ.data ?? []).length}</strong>
          <small>Journal d’audit immuable de votre offre</small>
        </div>
      </div>

      {/* Onglets Notifications vs Historique de facturation */}
      <div className="sofia-tabs-bar" role="tablist" aria-label="Sections du centre de notifications">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notifications'}
          className={`sofia-tab-btn${tab === 'notifications' ? ' is-active' : ''}`}
          onClick={() => setTab('notifications')}
          data-testid="tab-agency-notifications"
        >
          <Bell size={15} /> Notifications & rappels
          {unreadCount > 0 && <span className="sofia-tab-badge">{unreadCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'billing_events'}
          className={`sofia-tab-btn${tab === 'billing_events' ? ' is-active' : ''}`}
          onClick={() => setTab('billing_events')}
          data-testid="tab-agency-billing-events"
        >
          <History size={15} /> Historique des événements de facturation
          <span className="sofia-tab-badge is-neutral">{(eventsQ.data ?? []).length}</span>
        </button>
      </div>

      {/* Barre de filtres responsive (Desktop + Android) */}
      <div className="panel-card sofia-filters-card" data-testid="notifications-filters-bar">
        <div className="sofia-filters-grid">
          <div className="sofia-filter-field">
            <label htmlFor="notif-search">
              <Search size={13} /> Recherche
            </label>
            <Input
              id="notif-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Facture, SasPay, essai, échéance…"
              data-testid="input-notifications-search"
            />
          </div>

          {tab === 'notifications' && (
            <>
              <div className="sofia-filter-field">
                <label htmlFor="notif-category">
                  <Filter size={13} /> Catégorie
                </label>
                <select
                  id="notif-category"
                  className="field-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as AgencyNotificationCategory)}
                  data-testid="select-notifications-category"
                >
                  {Object.entries(AGENCY_NOTIFICATION_CATEGORY_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sofia-filter-field">
                <label htmlFor="notif-status">Statut de lecture</label>
                <select
                  id="notif-status"
                  className="field-select"
                  value={readFilter}
                  onChange={(e) => setReadFilter(e.target.value as ReadFilter)}
                  data-testid="select-notifications-status"
                >
                  <option value="all">Toutes ({centerQ.data?.total_count ?? 0})</option>
                  <option value="unread">Non lues uniquement ({unreadCount})</option>
                  <option value="read">Lues uniquement</option>
                </select>
              </div>
            </>
          )}

          <div className="sofia-filter-field">
            <label htmlFor="notif-period">
              <Calendar size={13} /> Période (Bamako)
            </label>
            <select
              id="notif-period"
              className="field-select"
              value={datePreset}
              onChange={(e) => setDatePreset(e.target.value as DatePreset)}
              data-testid="select-notifications-period"
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
              <label htmlFor="notif-date-from">Du</label>
              <Input
                id="notif-date-from"
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                data-testid="input-notifications-from"
              />
            </div>
            <div className="sofia-filter-field">
              <label htmlFor="notif-date-to">Au</label>
              <Input
                id="notif-date-to"
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                data-testid="input-notifications-to"
              />
            </div>
          </div>
        )}
      </div>

      {/* Contenu Onglet 1 : Notifications */}
      {tab === 'notifications' && (
        <div className="panel-card" data-testid="list-agency-notifications">
          {centerQ.isLoading ? (
            <LoadingRows label="Chargement de vos notifications" />
          ) : notifications.length === 0 ? (
            <div className="state-card" data-testid="empty-agency-notifications">
              <div className="state-icon">
                <Inbox size={20} />
              </div>
              <h2>Aucune notification correspondant à ces filtres</h2>
              <p>
                Vos rappels d’essai gratuit, d’échéance mensuelle, de période de grâce et vos confirmations SasPay apparaissent automatiquement ici.
              </p>
              {(category !== 'all' || readFilter !== 'all' || datePreset !== 'all' || search) && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setCategory('all');
                    setReadFilter('all');
                    setDatePreset('all');
                    setSearch('');
                  }}
                >
                  Réinitialiser les filtres
                </Button>
              )}
            </div>
          ) : (
            <div className="sofia-center-list">
              {notifications.map((item) => {
                const isUnread = !item.read_at;
                const catLabel =
                  AGENCY_NOTIFICATION_CATEGORY_LABELS[item.category] ?? item.category;
                const isUrgent = item.priority === 'high' || item.priority === 'critical';

                return (
                  <article
                    key={item.id}
                    className={`sofia-center-row${isUnread ? ' is-unread' : ''}${isUrgent ? ' is-urgent' : ''}`}
                    data-testid={`center-notification-${item.id}`}
                  >
                    <div className="sofia-center-row-main">
                      <div className="sofia-center-meta">
                        <span className={`sofia-notif-pill is-${item.priority || 'normal'}`}>
                          {isUrgent && <ShieldAlert size={12} />} {catLabel}
                        </span>
                        {isUnread && <span className="sofia-unread-dot">Nouveau</span>}
                        <time dateTime={item.created_at}>
                          {formatDateTime(item.created_at)} (Bamako)
                        </time>
                      </div>
                      <h3>{item.title}</h3>
                      <p>{item.message}</p>
                    </div>

                    <div className="sofia-center-row-actions">
                      {item.action_href && (
                        <Link
                          href={item.action_href}
                          className="primary-action sofia-compact-btn"
                          onClick={() => {
                            if (isUnread) {
                              markOne.mutate({ notificationId: item.id, read: true });
                            }
                          }}
                          data-testid={`center-action-${item.id}`}
                        >
                          {item.action_label || 'Ouvrir'} <ArrowRight size={14} />
                        </Link>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          markOne.mutate({ notificationId: item.id, read: isUnread })
                        }
                        disabled={markOne.isPending}
                        data-testid={`center-toggle-${item.id}`}
                      >
                        <Check size={13} /> {isUnread ? 'Marquer lu' : 'Marquer non lu'}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Contenu Onglet 2 : Historique des événements de facturation */}
      {tab === 'billing_events' && (
        <div className="panel-card" data-testid="list-agency-billing-events">
          {eventsQ.isLoading ? (
            <LoadingRows label="Chargement de l’historique de facturation" />
          ) : billingEvents.length === 0 ? (
            <div className="state-card" data-testid="empty-agency-billing-events">
              <div className="state-icon">
                <FileText size={20} />
              </div>
              <h2>Aucun événement de facturation sur cette période</h2>
              <p>
                Chaque début ou fin d’essai, émission de facture, paiement SasPay, changement d’offre, suspension ou réactivation est tracé ici avec un lien direct.
              </p>
            </div>
          ) : (
            <div className="sofia-center-list">
              {billingEvents.map((ev) => {
                const title = BILLING_EVENT_LABELS[ev.event_type] ?? ev.event_type;
                return (
                  <article
                    key={ev.id}
                    className="sofia-center-row"
                    data-testid={`billing-event-${ev.id}`}
                  >
                    <div className="sofia-center-row-main">
                      <div className="sofia-center-meta">
                        <span className="sofia-notif-pill is-normal">
                          <FileText size={12} /> {ev.event_type.replace(/_/g, ' ')}
                        </span>
                        {ev.invoice_reference && (
                          <span className="sofia-ref-chip">Facture {ev.invoice_reference}</span>
                        )}
                        {typeof ev.amount === 'number' && ev.amount > 0 && (
                          <strong className="sofia-amount-chip">{cashXof(ev.amount)}</strong>
                        )}
                        <time dateTime={ev.created_at}>
                          {formatDateTime(ev.created_at)} (Bamako)
                        </time>
                      </div>
                      <h3>{title}</h3>
                      <p>
                        {ev.reason ||
                          (ev.plan_to_name
                            ? `Offre concernée : ${ev.plan_from_name ? `${ev.plan_from_name} → ` : ''}${ev.plan_to_name}`
                            : 'Événement enregistré automatiquement dans le journal d’abonnement.')}
                      </p>
                      <small style={{ opacity: 0.72 }}>
                        Date de référence : {formatDate(ev.created_at)}
                        {ev.reference ? ` · Réf. : ${ev.reference}` : ''}
                      </small>
                    </div>

                    <div className="sofia-center-row-actions">
                      <Link
                        href={ev.action_href || '/mon-offre'}
                        className="sofia-inline-action"
                        data-testid={`billing-event-link-${ev.id}`}
                      >
                        {ev.online_payment_id ? 'Voir le reçu SasPay' : 'Voir dans Mon offre'}{' '}
                        <ExternalLink size={13} />
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
