import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ContactRound,
  Download,
  Home,
  MessageCircle,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  usePlatformSummary,
  useAllAgencies,
  useAllProperties,
  useAllContacts,
  useAllMediaRefs,
  useActivityLog,
  useAllSubscriptionPayments,
  useRecordSubscriptionPayment,
} from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
import { LoadingRows, cash, dateLabel, dateTimeLabel, downloadCsv } from '@/lib/workspace-ui';

const CHART_COLORS = ['#0f766e', '#14b8a6', '#f59e0b', '#64748b', '#e11d48', '#8b5cf6', '#0ea5e9'];

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(date: Date) {
  return new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(date);
}

export default function AdminOverviewPage() {
  const summaryQ = usePlatformSummary();
  const agenciesQ = useAllAgencies();
  const propertiesQ = useAllProperties();
  const contactsQ = useAllContacts();
  const mediaQ = useAllMediaRefs();
  const activityQ = useActivityLog(120);

  const loading = summaryQ.isLoading || agenciesQ.isLoading || propertiesQ.isLoading;
  const error = summaryQ.error ?? agenciesQ.error ?? propertiesQ.error;

  const summary = summaryQ.data;
  const agencies = agenciesQ.data?.agencies ?? [];
  const properties = propertiesQ.data ?? [];
  const contacts = contactsQ.data ?? [];
  const activity = activityQ.data ?? [];

  const kpis = [
    { label: 'Agences', value: summary?.agenciesTotal ?? '—', foot: `${summary?.agenciesActive ?? 0} active(s)`, icon: Building2, accent: 'teal' },
    { label: 'Biens', value: summary?.propertiesTotal ?? '—', foot: `${summary?.propertiesAvailable ?? 0} disponible(s)`, icon: Home, accent: 'blue' },
    { label: 'Contacts & leads', value: summary?.contactsTotal ?? '—', foot: `${summary?.leadsTotal ?? 0} lead(s) à qualifier`, icon: ContactRound, accent: 'amber' },
    { label: 'Visites', value: summary?.visitsTotal ?? '—', foot: 'Planifications enregistrées', icon: CalendarDays, accent: 'violet' },
    { label: 'Conversations', value: summary?.conversationsTotal ?? '—', foot: `${summary?.messagesTotal ?? 0} message(s)`, icon: MessageCircle, accent: 'emerald' },
    { label: 'Abonnements actifs', value: summary?.activeSubscriptions ?? '—', foot: `${summary?.trialSubscriptions ?? 0} en essai`, icon: TrendingUp, accent: 'indigo' },
    { label: 'Agences inactives 30 j', value: summary?.inactiveAgencies ?? '—', foot: 'Sans activité récente', icon: Clock3, accent: 'rose' },
    { label: 'Annonces incomplètes', value: summary?.incompleteProperties ?? '—', foot: `${summary?.propertiesWithoutPhoto ?? 0} bien(s) sans photo`, icon: AlertTriangle, accent: 'orange' },
  ];

  const creationSeries = useMemo(() => {
    const months: Array<{ key: string; label: string; biens: number; contacts: number; agences: number }> = [];
    for (let index = 5; index >= 0; index -= 1) {
      const date = new Date();
      date.setDate(1);
      date.setMonth(date.getMonth() - index);
      months.push({ key: monthKey(date), label: monthLabel(date), biens: 0, contacts: 0, agences: 0 });
    }
    const index = new Map(months.map((month) => [month.key, month]));
    for (const property of properties) {
      const bucket = index.get(monthKey(new Date(property.created_at)));
      if (bucket) bucket.biens += 1;
    }
    for (const contact of contacts) {
      const bucket = index.get(monthKey(new Date(contact.created_at)));
      if (bucket) bucket.contacts += 1;
    }
    for (const agency of agencies) {
      const bucket = index.get(monthKey(new Date(agency.created_at)));
      if (bucket) bucket.agences += 1;
    }
    return months;
  }, [properties, contacts, agencies]);

  const statusDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    for (const property of properties) counts.set(property.status, (counts.get(property.status) ?? 0) + 1);
    return [...counts.entries()].map(([status, count]) => ({ name: status, value: count }));
  }, [properties]);

  const contactDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    for (const contact of contacts) counts.set(contact.status, (counts.get(contact.status) ?? 0) + 1);
    return [...counts.entries()].map(([status, count]) => ({ name: status, value: count }));
  }, [contacts]);

  const alerts = useMemo(() => {
    const rows: Array<{ level: 'danger' | 'warn' | 'info'; icon: typeof AlertTriangle; title: string; detail: string; href: string }> = [];
    const propertyIdsWithPhoto = new Set((mediaQ.data ?? []).map((row) => row.property_id));
    const withoutPhoto = properties.filter((p) => !['draft', 'archived'].includes(p.status) && !propertyIdsWithPhoto.has(p.id));
    if (withoutPhoto.length) {
      rows.push({
        level: 'warn',
        icon: Home,
        title: `${withoutPhoto.length} bien(s) publié(s) sans photo`,
        detail: withoutPhoto.slice(0, 3).map((p) => p.reference).join(', ') + (withoutPhoto.length > 3 ? '…' : ''),
        href: '/admin/biens',
      });
    }
    const incomplete = properties.filter((p) => {
      if (['draft', 'archived'].includes(p.status)) return false;
      return !p.description || p.description.trim().length < 10 || !p.city || p.price <= 0;
    });
    if (incomplete.length) {
      rows.push({
        level: 'warn',
        icon: AlertTriangle,
        title: `${incomplete.length} annonce(s) incomplète(s)`,
        detail: 'Description, ville ou prix manquant — visibilité réduite pour les acheteurs.',
        href: '/admin/biens',
      });
    }
    const now = Date.now();
    const since = now - 30 * 24 * 3600 * 1000;
    const lastActivity = new Map<string, string>();
    for (const entry of activity) {
      if (entry.agency_id && !lastActivity.has(entry.agency_id)) lastActivity.set(entry.agency_id, entry.created_at);
    }
    const inactive = agencies.filter((agency) => {
      const last = lastActivity.get(agency.id);
      return !last || new Date(last).getTime() < since;
    });
    if (inactive.length) {
      rows.push({
        level: 'info',
        icon: Clock3,
        title: `${inactive.length} agence(s) sans activité depuis 30 jours`,
        detail: inactive.slice(0, 3).map((a) => a.name).join(', ') + (inactive.length > 3 ? '…' : ''),
        href: '/admin/agences',
      });
    }
    const suspended = agencies.filter((agency) => agency.status !== 'active');
    if (suspended.length) {
      rows.push({
        level: 'danger',
        icon: AlertTriangle,
        title: `${suspended.length} agence(s) suspendue(s) ou inactive(s)`,
        detail: suspended.map((a) => a.name).join(', '),
        href: '/admin/agences',
      });
    }
    const expired = (agenciesQ.data?.subscriptions ?? []).filter((subscription) => {
      if (subscription.status === 'active' && subscription.ends_at) return new Date(subscription.ends_at).getTime() <= now;
      if (subscription.status === 'trial' && subscription.trial_ends_at) return new Date(subscription.trial_ends_at).getTime() <= now;
      return false;
    });
    if (expired.length) {
      rows.push({
        level: 'danger',
        icon: AlertTriangle,
        title: `${expired.length} abonnement(s) expiré(s)`,
        detail: 'Renouvelez ou mettez à jour les formules concernées.',
        href: '/admin/abonnements',
      });
    }
    return rows;
  }, [properties, agencies, activity, mediaQ.data, agenciesQ.data?.subscriptions]);

  const topAgencies = useMemo(() => {
    const byProperties = new Map<string, number>();
    for (const property of properties) byProperties.set(property.agency_id, (byProperties.get(property.agency_id) ?? 0) + 1);
    const lastActivity = new Map<string, string>();
    for (const entry of activity) {
      if (entry.agency_id && !lastActivity.has(entry.agency_id)) lastActivity.set(entry.agency_id, entry.created_at);
    }
    return agencies
      .map((agency) => ({
        ...agency,
        propertyCount: byProperties.get(agency.id) ?? 0,
        lastActivity: lastActivity.get(agency.id) ?? null,
      }))
      .sort((a, b) => b.propertyCount - a.propertyCount || a.name.localeCompare(b.name, 'fr'))
      .slice(0, 5);
  }, [agencies, properties, activity]);

  const exportSnapshot = () => {
    downloadCsv(
      `sofia-bilan-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Indicateur', 'Valeur'],
      [
        ['Agences', summary?.agenciesTotal ?? 0],
        ['Agences actives', summary?.agenciesActive ?? 0],
        ['Biens', summary?.propertiesTotal ?? 0],
        ['Biens disponibles', summary?.propertiesAvailable ?? 0],
        ['Contacts', summary?.contactsTotal ?? 0],
        ['Leads', summary?.leadsTotal ?? 0],
        ['Visites', summary?.visitsTotal ?? 0],
        ['Conversations', summary?.conversationsTotal ?? 0],
        ['Messages', summary?.messagesTotal ?? 0],
        ['Abonnements actifs', summary?.activeSubscriptions ?? 0],
        ['Agences inactives 30j', summary?.inactiveAgencies ?? 0],
        ['Annonces incomplètes', summary?.incompleteProperties ?? 0],
        ['Biens sans photo', summary?.propertiesWithoutPhoto ?? 0],
      ],
    );
  };

  if (loading) {
    return (
      <>
        <AdminHeading eyebrow="Console plateforme" title="Vue d’ensemble" description="Chargement des indicateurs globaux…" />
        <LoadingRows label="Chargement du tableau de bord admin" />
      </>
    );
  }

  if (error) {
    return (
      <>
        <AdminHeading eyebrow="Console plateforme" title="Vue d’ensemble" description="Impossible de charger les indicateurs globaux." />
        <div className="state-card error-state" role="alert">
          <h2>Accès refusé ou indisponible</h2>
          <p>Seuls les administrateurs plateforme peuvent consulter ces données.</p>
          <button className="button-link" onClick={() => void summaryQ.refetch()}>Réessayer</button>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeading
        eyebrow="Console plateforme"
        title="Vue d’ensemble"
        description="Indicateurs globaux, croissance et alertes intelligentes — calculés en direct sur Supabase."
        action={
          <button className="button-link" onClick={exportSnapshot} data-testid="button-export-bilan">
            <Download size={15} /> Exporter le bilan (CSV)
          </button>
        }
      />

      <section className="kpi-grid" aria-label="Indicateurs clés">
        {kpis.map(({ label, value, foot, icon: Icon, accent }) => (
          <article className={`kpi-card accent-${accent}`} key={label} data-testid={`kpi-${label.replace(/\s/g, '-')}`}>
            <div className="kpi-top">
              <span>{label}</span>
              <span className="kpi-icon"><Icon size={15} /></span>
            </div>
            <div className="kpi-value">{value}</div>
            <div className="kpi-foot">{foot}</div>
          </article>
        ))}
      </section>

      <section className="admin-grid">
        <article className="panel chart-panel">
          <div className="panel-head">
            <div>
              <h2>Évolution des créations</h2>
              <p>6 derniers mois · biens, contacts et agences réels</p>
            </div>
            <span className="status-tag">Temps réel</span>
          </div>
          <div className="chart-box" data-testid="chart-creations">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={creationSeries} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradBiens" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0f766e" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#0f766e" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gradContacts" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--si-chart-grid)" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip contentStyle={{ borderRadius: 10, fontSize: 13 }} />
                <Area type="monotone" dataKey="biens" name="Biens" stroke="var(--si-chart-1)" strokeWidth={2} fill="url(#gradBiens)" />
                <Area type="monotone" dataKey="contacts" name="Contacts" stroke="var(--si-chart-2)" strokeWidth={2} fill="url(#gradContacts)" />
                <Area type="monotone" dataKey="agences" name="Agences" stroke="var(--si-chart-3)" strokeWidth={2} fill="transparent" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="panel chart-panel">
          <div className="panel-head">
            <div>
              <h2>Répartition des biens</h2>
              <p>Par statut actuel du portefeuille</p>
            </div>
          </div>
          <div className="chart-box" data-testid="chart-biens">
            {statusDistribution.length ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={statusDistribution} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--si-chart-grid)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ borderRadius: 10, fontSize: 13 }} />
                  <Bar dataKey="value" name="Biens" radius={[6, 6, 0, 0]}>
                    {statusDistribution.map((entry, index) => (
                      <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-table"><strong>Aucun bien</strong><p>Les statistiques apparaîtront dès le premier bien créé.</p></div>
            )}
          </div>
        </article>
      </section>

      <section className="admin-grid">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Alertes intelligentes</h2>
              <p>Anomalies détectées automatiquement sur les données réelles</p>
            </div>
            <span className={`status-tag${alerts.length ? ' is-warning' : ''}`}>{alerts.length} alerte(s)</span>
          </div>
          {alerts.length ? (
            <div className="alert-list">
              {alerts.map((alert, index) => (
                <Link key={`${alert.title}-${index}`} href={alert.href} className={`alert-row level-${alert.level}`} data-testid={`alert-${index}`}>
                  <span className="alert-icon"><alert.icon size={15} /></span>
                  <span className="alert-copy"><strong>{alert.title}</strong><small>{alert.detail}</small></span>
                  <ArrowRight size={14} />
                </Link>
              ))}
            </div>
          ) : (
            <div className="empty-table" data-testid="empty-alerts">
              <div className="empty-table-mark"><CheckCircle2 size={17} /></div>
              <strong>Aucune anomalie détectée</strong>
              <p>Photos, annonces, abonnements et activité sont dans les normes.</p>
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Classement des agences</h2>
              <p>Par nombre de biens en portefeuille</p>
            </div>
            <Link href="/admin/agences" className="text-action">Toutes <ArrowRight size={13} /></Link>
          </div>
          {topAgencies.length ? (
            <ol className="ranking-list">
              {topAgencies.map((agency, index) => (
                <li key={agency.id} data-testid={`rank-agency-${index}`}>
                  <span className="rank-position">{index + 1}</span>
                  <span className="rank-copy">
                    <strong>{agency.name}</strong>
                    <small>{agency.city ?? agency.country} · activité : {agency.lastActivity ? dateLabel(agency.lastActivity) : 'aucune'}</small>
                  </span>
                  <span className="rank-value">{agency.propertyCount} bien(s)</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty-table"><strong>Aucune agence</strong></div>
          )}
        </article>
      </section>

      <section className="admin-grid">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Contacts par statut</h2>
              <p>Répartition du cycle commercial</p>
            </div>
          </div>
          <div className="chart-box chart-box-pie" data-testid="chart-contacts">
            {contactDistribution.length ? (
              <ResponsiveContainer width="100%" height={230}>
                <PieChart>
                  <Pie data={contactDistribution} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3}>
                    {contactDistribution.map((entry, index) => (
                      <Cell key={entry.name} fill={CHART_COLORS[(index + 2) % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ borderRadius: 10, fontSize: 13 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-table"><strong>Aucun contact</strong></div>
            )}
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Activité récente</h2>
              <p>Journal des actions sur toute la plateforme</p>
            </div>
            <Link href="/admin/activite" className="text-action">Journal complet <ArrowRight size={13} /></Link>
          </div>
          {activityQ.isLoading ? (
            <LoadingRows />
          ) : activity.length ? (
            <div className="activity-feed">
              {activity.slice(0, 7).map((entry) => (
                <div className="activity-row" key={entry.id} data-testid={`activity-${entry.id}`}>
                  <span className={`activity-dot is-${entry.action}`} />
                  <span className="activity-copy">
                    <strong>{entry.summary}</strong>
                    <small>{agencies.find((a) => a.id === entry.agency_id)?.name ?? 'Plateforme'} · {dateTimeLabel(entry.created_at)}</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-table"><strong>Aucune activité enregistrée</strong></div>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Formules les plus présentes</h2>
              <p>Répartition des abonnements</p>
            </div>
            <Sparkles size={16} />
          </div>
          {agenciesQ.data ? (
            <div className="plan-breakdown">
              {(agenciesQ.data.plans ?? []).map((plan) => {
                const count = (agenciesQ.data?.subscriptions ?? []).filter((s) => s.plan_id === plan.id).length;
                return (
                  <div className="plan-row" key={plan.id}>
                    <span><strong>{plan.name}</strong><small>{count} agence(s)</small></span>
                    <span className="plan-price">{cash(Number(plan.price_monthly), plan.currency)}/mois</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <LoadingRows />
          )}
        </article>
      </section>

      <SubscriptionsOverviewSection agenciesQ={agenciesQ} />
    </>
  );
}


type SubscriptionStatusLabel = Record<string, string>;
const subscriptionStatusLabel: SubscriptionStatusLabel = {
  active: 'Actif',
  trial: 'Essai',
  expired: 'Expiré',
  cancelled: 'Annulé',
  past_due: 'Impayé',
};

function SubscriptionsOverviewSection({ agenciesQ }: { agenciesQ: ReturnType<typeof useAllAgencies> }) {
  const paymentsQ = useAllSubscriptionPayments();
  const recordPayment = useRecordSubscriptionPayment();
  const [months, setMonths] = useState<6 | 12>(12);
  const [notice, setNotice] = useState('');
  const [pageError, setPageError] = useState('');

  const data = agenciesQ.data;
  const payments = paymentsQ.data ?? [];
  const subscriptions = data?.subscriptions ?? [];
  const plans = data?.plans ?? [];
  const agencies = data?.agencies ?? [];
  const subByAgency = new Map(subscriptions.map((sub) => [sub.agency_id, sub]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const compact = (value: number) => new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

  const now = new Date();
  const payingAgencies = agencies.filter((agency) => {
    const sub = subByAgency.get(agency.id);
    return Boolean(sub) && sub?.status === 'active' && agency.status !== 'suspended';
  });
  const trialAgencies = agencies.filter((agency) => subByAgency.get(agency.id)?.status === 'trial');
  const unpaidAgencies = agencies.filter((agency) => {
    const subStatus = subByAgency.get(agency.id)?.status;
    return agency.status === 'suspended' || (subStatus !== undefined && ['past_due', 'expired', 'cancelled'].includes(subStatus));
  });

  const thisMonthKey = monthKey(now);
  const prevMonthKey = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 15));
  const sumFor = (key: string) => payments.filter((payment) => monthKey(new Date(`${payment.paid_at}T12:00:00`)) === key).reduce((total, payment) => total + Number(payment.amount || 0), 0);
  const revenueMonth = sumFor(thisMonthKey);
  const revenuePrev = sumFor(prevMonthKey);
  const revenueVariation = revenuePrev > 0 ? ((revenueMonth - revenuePrev) / revenuePrev) * 100 : null;

  const series = useMemo(() => {
    const out: Array<{ key: string; label: string; revenus: number; payantes: number }> = [];
    const base = new Date();
    for (let offset = months - 1; offset >= 0; offset -= 1) {
      const date = new Date(base.getFullYear(), base.getMonth() - offset, 15);
      const key = monthKey(date);
      const monthPayments = payments.filter((payment) => monthKey(new Date(`${payment.paid_at}T12:00:00`)) === key);
      out.push({
        key,
        label: new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(date).replace('.', ''),
        revenus: monthPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0),
        payantes: new Set(monthPayments.map((payment) => payment.agency_id)).size,
      });
    }
    return out;
  }, [payments, months]);

  const handleRecord = (agency: { id: string; name: string }, subscription: { id: string }, plan: { name: string; price_monthly: number; currency: string } | null) => {
    setNotice('');
    setPageError('');
    recordPayment.mutate(
      { agencyId: agency.id, subscriptionId: subscription.id, amount: Number(plan?.price_monthly ?? 0), planName: plan?.name },
      {
        onSuccess: () => setNotice(`Paiement enregistré pour ${agency.name} — abonnement prolongé de 30 jours.`),
        onError: (error) => setPageError(getSupabaseErrorMessage(error, 'enregistrer le paiement')),
      },
    );
  };

  if (agenciesQ.isLoading || paymentsQ.isLoading) return <section className="admin-grid" aria-label="Abonnements"><LoadingRows label="Chargement des abonnements" /></section>;

  return (
    <section className="admin-grid abonnements-overview" aria-label="Abonnements">
      <article className="panel chart-panel">
        <div className="panel-head">
          <div>
            <h2>Abonnements payants</h2>
            <p>Revenus d’abonnements enregistrés et agences payantes par mois · suspendues et essais exclus des payantes</p>
          </div>
          <div className="revenue-toolbar revenue-period-select" role="group" aria-label="Période des abonnements">
            {([6, 12] as const).map((value) => (
              <button key={value} type="button" className={`button-link period-pill${months === value ? ' is-active' : ''}`} aria-pressed={months === value} onClick={() => setMonths(value)} data-testid={`button-abo-periode-${value}`}>{value} mois</button>
            ))}
          </div>
        </div>
        <div className="revenue-kpis">
          <article className="kpi-card" data-testid="kpi-abo-revenus-mois"><span className="kpi-label">Revenus du mois</span><strong className="kpi-value">{cash(revenueMonth, 'XOF')}</strong><span className="kpi-foot">Paiements enregistrés ce mois</span></article>
          <article className="kpi-card" data-testid="kpi-abo-payantes"><span className="kpi-label">Agences payantes</span><strong className="kpi-value">{payingAgencies.length}</strong><span className="kpi-foot">Abonnement actif, agence non suspendue</span></article>
          <article className="kpi-card" data-testid="kpi-abo-essai"><span className="kpi-label">En essai</span><strong className="kpi-value">{trialAgencies.length}</strong><span className="kpi-foot">Abonnement en période d’essai</span></article>
          <article className="kpi-card" data-testid="kpi-abo-impayes"><span className="kpi-label">Suspendues ou impayées</span><strong className="kpi-value">{unpaidAgencies.length}</strong><span className="kpi-foot">Agence suspendue ou abonnement impayé/expiré/annulé</span></article>
          <article className="kpi-card" data-testid="kpi-abo-variation"><span className="kpi-label">Variation revenus</span><strong className="kpi-value"><span className={`trend-chip ${revenueVariation !== null && revenueVariation >= 0 ? 'is-up' : 'is-down'}`}>{revenueVariation === null ? '—' : `${revenueVariation >= 0 ? '+' : '−'}${Math.abs(revenueVariation).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`}</span></strong><span className="kpi-foot">vs mois précédent</span></article>
        </div>
        {payments.length ? (
          <div className="chart-box" data-testid="chart-abonnements">
            <ResponsiveContainer width="100%" height={252}>
              <ComposedChart data={series} margin={{ top: 18, right: 6, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.12} vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis yAxisId="left" tickLine={false} axisLine={false} fontSize={10} tickFormatter={(value: number) => compact(Number(value))} width={54} />
                <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} fontSize={10} width={34} allowDecimals={false} />
                <Tooltip formatter={(value: number, name: string) => (name === 'Revenus' ? [cash(Number(value), 'XOF'), name] : [value, name])} />
                <Bar yAxisId="left" dataKey="revenus" fill="var(--si-chart-1)" radius={[6, 6, 0, 0]} name="Revenus">
                  <LabelList dataKey="revenus" position="insideTop" formatter={(value: number) => compact(Number(value))} style={{ fontSize: 9.5, fontWeight: 700, fill: '#ffffff' }} />
                </Bar>
                <Line yAxisId="right" type="monotone" dataKey="payantes" stroke="var(--si-chart-4)" strokeWidth={2.4} dot={{ r: 3 }} name="Payantes">
                  <LabelList dataKey="payantes" position="top" formatter={(value: number) => String(value)} style={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} />
                </Line>
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="empty-table" data-testid="empty-abonnements-chart">
            <div className="empty-table-mark"><TrendingUp size={17} /></div>
            <strong>Aucun paiement enregistré pour l’instant</strong>
            <p>Les revenus apparaissent dès le premier « Paiement reçu ». Aucun paiement n’est automatisé à ce jour : l’enregistrement est manuel côté admin.</p>
          </div>
        )}
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <h2>Agences et abonnements</h2>
            <p>Statut d’abonnement de chaque agence — calcul automatique depuis le statut et la formule</p>
          </div>
          <Link href="/admin/abonnements" className="text-action" data-testid="link-admin-manage-subscriptions">Gérer <ArrowRight size={13} /></Link>
        </div>
        {notice && <p className="form-feedback" role="status" data-testid="status-paiement-notice">{notice}</p>}
        {pageError && <p className="form-error" role="alert" data-testid="status-paiement-error">{pageError}</p>}
        {agencies.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Agence</th><th>Statut</th><th>Abonnement</th><th>Formule</th><th>Fin</th><th><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {agencies.map((agency) => {
                  const sub = subByAgency.get(agency.id);
                  const plan = sub ? planById.get(sub.plan_id) ?? null : null;
                  return (
                    <tr key={agency.id} data-testid={`row-abo-agence-${agency.id}`}>
                      <td><strong>{agency.name}</strong><small>{agency.city ?? agency.country}</small></td>
                      <td><span className={`status-pill status-${agency.status === 'active' ? 'available' : agency.status === 'suspended' ? 'unavailable' : 'reserved'}`}>{agency.status === 'active' ? 'Active' : agency.status === 'suspended' ? 'Suspendue' : agency.status}</span></td>
                      <td><span className={`status-pill status-${sub?.status === 'active' ? 'available' : sub?.status === 'trial' ? 'reserved' : 'unavailable'}`} data-testid={`pill-abo-${agency.id}`}>{sub ? subscriptionStatusLabel[sub.status] ?? sub.status : 'Aucun'}</span></td>
                      <td>{plan ? `${plan.name} · ${cash(Number(plan.price_monthly), plan.currency)}` : '—'}</td>
                      <td>{sub?.ends_at ? dateLabel(sub.ends_at) : sub?.trial_ends_at ? `Essai : ${dateLabel(sub.trial_ends_at)}` : '—'}</td>
                      <td className="row-actions-cell">
                        {sub ? (
                          <button className="row-action" disabled={recordPayment.isPending} onClick={() => handleRecord(agency, sub, plan)} data-testid={`button-paiement-recu-${agency.id}`}>Paiement reçu</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-table"><strong>Aucune agence enregistrée</strong></div>
        )}
      </article>
    </section>
  );
}
