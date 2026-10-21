// =============================================================================
// BLOC 7 — ESPACE PLATEFORME : CONSOMMATION IA ET CANAL WHATSAPP
// =============================================================================
// LECTURE SEULE. Tout vient de `public.platform_agency_usage()` (garde
// `is_platform_admin()` côté SQL) : cet écran n'accorde rien et n'écrit rien.
// Réutilise `agency_usage`, `usage_events` et `whatsapp_connections` — aucune
// table dupliquée.
// =============================================================================
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  Activity, AlertTriangle, Download, Gauge, MessageCircle, RefreshCw, Search,
  Sparkles, Users2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { AdminHeading } from './admin-shell';
import { LoadingRows, downloadCsv, formatDateTimeShort } from '@/lib/workspace-ui';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { UsageGauge, WhatsAppBadge } from '@/components/usage-gauge';
import {
  usePlatformAgencyUsage, whatsappStatusLabel, type PlatformUsageRow, type UsageAlert,
} from '@/lib/usage-api';

const ALERT_ORDER: Record<UsageAlert, number> = { reached: 0, warning: 1, ok: 2, unlimited: 3 };

type AlertFilter = 'all' | 'warning' | 'reached' | 'whatsapp';

export default function AdminUsagePage() {
  const usageQ = usePlatformAgencyUsage();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<AlertFilter>('all');
  const [sort, setSort] = useState<'tokens' | 'name' | 'alert'>('tokens');

  const rows = useMemo<PlatformUsageRow[]>(() => {
    const all = usageQ.data?.agencies ?? [];
    const needle = search.trim().toLocaleLowerCase('fr');
    const filtered = all.filter((row) => {
      const haystack = `${row.agency_name} ${row.agency_slug ?? ''} ${row.plan_name ?? ''} ${row.whatsapp_provider_label ?? ''} ${row.whatsapp_phone_number ?? ''}`.toLocaleLowerCase('fr');
      if (needle && !haystack.includes(needle)) return false;
      if (filter === 'warning') return row.tokens_alert === 'warning';
      if (filter === 'reached') return row.tokens_alert === 'reached';
      if (filter === 'whatsapp') return Boolean(row.whatsapp_provider);
      return true;
    });
    return filtered.sort((a, b) => {
      if (sort === 'name') return a.agency_name.localeCompare(b.agency_name, 'fr');
      if (sort === 'alert') {
        const byAlert = ALERT_ORDER[a.tokens_alert] - ALERT_ORDER[b.tokens_alert];
        return byAlert !== 0 ? byAlert : b.tokens_total - a.tokens_total;
      }
      return b.tokens_total - a.tokens_total;
    });
  }, [usageQ.data, search, filter, sort]);

  const totals = usageQ.data?.totals;

  const exportCsv = () => {
    downloadCsv(
      `sofia-consommation-ia-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Agence', 'Statut', 'Offre', 'Tokens IA (mois)', 'Quota tokens', '% tokens',
        'Alerte tokens', 'Requêtes IA', 'Messages', 'Quota messages', '% messages',
        'Conversations', 'Quota conversations', 'Canal WhatsApp', 'Officiel',
        'Numéro', 'État canal', 'Dernière activité',
      ],
      rows.map((row) => [
        row.agency_name,
        row.agency_status,
        row.plan_name ?? 'Aucune offre',
        row.tokens_total,
        row.tokens_limit,
        row.tokens_ratio,
        row.tokens_alert,
        row.ai_requests_count,
        row.messages_count,
        row.messages_limit,
        row.messages_ratio,
        row.conversations_count,
        row.conversations_limit,
        row.whatsapp_provider_label ?? 'Aucun',
        row.whatsapp_provider ? (row.whatsapp_official ? 'oui' : 'non') : '—',
        row.whatsapp_phone_number ?? '',
        whatsappStatusLabel(row.whatsapp_status),
        row.whatsapp_last_activity_at ?? '',
      ]),
    );
  };

  if (usageQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Plateforme" title="Consommation IA & WhatsApp" description="Chargement des compteurs du mois en cours." />
        <LoadingRows label="Chargement de la consommation" />
      </>
    );
  }

  if (usageQ.error) {
    return (
      <>
        <AdminHeading eyebrow="Plateforme" title="Consommation IA & WhatsApp" description="Les compteurs ne sont pas disponibles." />
        <div className="state-card error-state" role="alert" data-testid="status-usage-error">
          <div className="state-icon"><AlertTriangle size={19} /></div>
          <h2>Accès refusé ou erreur de chargement</h2>
          <p>{getSupabaseErrorMessage(usageQ.error, 'charger la consommation')}</p>
          <Button variant="outline" onClick={() => void usageQ.refetch()} data-testid="button-usage-retry">
            <RefreshCw size={14} /> Réessayer
          </Button>
        </div>
      </>
    );
  }

  const periodLabel = usageQ.data?.period_start
    ? new Date(usageQ.data.period_start).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : 'mois en cours';

  return (
    <>
      <AdminHeading
        eyebrow="Plateforme"
        title="Consommation IA & WhatsApp"
        description={`Compteurs du ${periodLabel}, par agence. Lecture seule : alertes à 80 % et 100 % du quota de l'offre.`}
        action={
          <div className="heading-actions">
            <Button variant="outline" onClick={() => void usageQ.refetch()} data-testid="button-refresh-usage">
              <RefreshCw size={14} /> Actualiser
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={!rows.length} data-testid="button-export-usage">
              <Download size={14} /> Exporter
            </Button>
          </div>
        }
      />

      {/* -------------------------------------------------------------- */}
      {/* Totaux plateforme                                                */}
      {/* -------------------------------------------------------------- */}
      <div className="kpi-grid usage-kpis" data-testid="grid-usage-kpis">
        <article className="kpi-card accent-blue">
          <div className="kpi-top"><span><Sparkles size={14} /> Tokens IA du mois</span></div>
          <div className="kpi-value" data-testid="text-totals-tokens">{(totals?.tokens_total ?? 0).toLocaleString('fr-FR')}</div>
          <div className="kpi-foot">{(totals?.requests_total ?? 0).toLocaleString('fr-FR')} requête(s) IA</div>
        </article>
        <article className="kpi-card accent-amber">
          <div className="kpi-top"><span><Gauge size={14} /> Quotas sous tension</span></div>
          <div className="kpi-value" data-testid="text-totals-alerts">
            {(totals?.agencies_at_warning ?? 0) + (totals?.agencies_at_limit ?? 0)}
          </div>
          <div className="kpi-foot">
            {totals?.agencies_at_warning ?? 0} à 80 % · {totals?.agencies_at_limit ?? 0} à 100 %
          </div>
        </article>
        <article className="kpi-card accent-green">
          <div className="kpi-top"><span><MessageCircle size={14} /> Messages du mois</span></div>
          <div className="kpi-value" data-testid="text-totals-messages">{(totals?.messages_total ?? 0).toLocaleString('fr-FR')}</div>
          <div className="kpi-foot">{(totals?.conversations_total ?? 0).toLocaleString('fr-FR')} conversation(s)</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-top"><span><Users2 size={14} /> Canaux WhatsApp</span></div>
          <div className="kpi-value" data-testid="text-totals-whatsapp">{totals?.agencies_with_whatsapp ?? 0}</div>
          <div className="kpi-foot">sur {totals?.agencies ?? 0} agence(s)</div>
        </article>
      </div>

      {((totals?.agencies_at_limit ?? 0) > 0 || (totals?.agencies_at_warning ?? 0) > 0) && (
        <div className="notice-box is-warning" role="status" data-testid="status-usage-alerts">
          <AlertTriangle size={15} />
          <span>
            {(totals?.agencies_at_limit ?? 0) > 0 && (
              <>{totals?.agencies_at_limit} agence(s) ont atteint 100 % de leur quota de tokens IA. </>
            )}
            {(totals?.agencies_at_warning ?? 0) > 0 && (
              <>{totals?.agencies_at_warning} agence(s) dépassent 80 %. </>
            )}
            Proposez-leur une offre supérieure depuis{' '}
            <Link href="/admin/abonnements" className="text-action">Abonnements</Link>.
          </span>
        </div>
      )}

      {/* -------------------------------------------------------------- */}
      {/* Barre d'outils                                                   */}
      {/* -------------------------------------------------------------- */}
      <section className="list-toolbar" aria-label="Filtres de consommation">
        <label className="list-search">
          <Search size={15} />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Agence, offre, numéro WhatsApp"
            aria-label="Rechercher une agence"
            data-testid="input-search-usage"
          />
        </label>
        <select
          className="form-select compact-select"
          value={filter}
          onChange={(event) => setFilter(event.target.value as AlertFilter)}
          aria-label="Filtrer les alertes"
          data-testid="filter-usage-alert"
        >
          <option value="all">Toutes les agences</option>
          <option value="warning">À 80 % du quota</option>
          <option value="reached">Quota atteint (100 %)</option>
          <option value="whatsapp">Avec un canal WhatsApp</option>
        </select>
        <select
          className="form-select compact-select"
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
          aria-label="Trier"
          data-testid="filter-usage-sort"
        >
          <option value="tokens">Trier par tokens</option>
          <option value="alert">Trier par alerte</option>
          <option value="name">Trier par nom</option>
        </select>
        <span className="result-count" data-testid="text-usage-count">
          {rows.length} agence(s)
        </span>
      </section>

      {/* -------------------------------------------------------------- */}
      {/* Tableau par agence                                               */}
      {/* -------------------------------------------------------------- */}
      {rows.length ? (
        <div className="panel list-panel">
          <div className="table-wrap">
            <table className="data-table full-table usage-table">
              <thead>
                <tr>
                  <th>Agence</th>
                  <th>Tokens IA du mois</th>
                  <th>Messages</th>
                  <th>Conversations</th>
                  <th>Canal WhatsApp</th>
                  <th>Dernière activité</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.agency_id} data-testid={`row-usage-${row.agency_id}`}>
                    <td>
                      <Link href={`/admin/agences`} className="table-primary-link">
                        <strong>{row.agency_name}</strong>
                        <small>
                          {row.plan_name ?? 'Aucune offre active'}
                          {row.agency_status !== 'active' && ` · ${row.agency_status}`}
                        </small>
                      </Link>
                    </td>
                    <td>
                      <UsageGauge
                        label="Tokens IA"
                        used={row.tokens_total}
                        limit={row.tokens_limit}
                        ratio={row.tokens_ratio}
                        alert={row.plan_name ? row.tokens_alert : 'unlimited'}
                        testId={`tokens-${row.agency_id}`}
                        dense
                      />
                      <small className="gauge-sub">
                        {row.ai_requests_count} requête(s) · {row.ai_tokens_input} in / {row.ai_tokens_output} out
                      </small>
                    </td>
                    <td>
                      <UsageGauge
                        label="Messages"
                        used={row.messages_count}
                        limit={row.messages_limit}
                        ratio={row.messages_ratio}
                        alert={row.plan_name ? row.messages_alert : 'unlimited'}
                        testId={`messages-${row.agency_id}`}
                        dense
                      />
                    </td>
                    <td>
                      <UsageGauge
                        label="Conversations"
                        used={row.conversations_count}
                        limit={row.conversations_limit}
                        ratio={row.conversations_ratio}
                        alert={row.plan_name ? (row.conversations_limit > 0 && row.conversations_count >= row.conversations_limit ? 'reached' : row.conversations_limit > 0 && row.conversations_count >= 0.8 * row.conversations_limit ? 'warning' : 'ok') : 'unlimited'}
                        testId={`conversations-${row.agency_id}`}
                        dense
                      />
                    </td>
                    <td>
                      <WhatsAppBadge
                        providerLabel={row.whatsapp_provider_label}
                        official={row.whatsapp_official}
                        status={whatsappStatusLabel(row.whatsapp_status)}
                        phoneNumber={row.whatsapp_phone_number}
                        connections={row.whatsapp_connections}
                        testId={row.agency_id}
                      />
                    </td>
                    <td>
                      {row.whatsapp_last_activity_at
                        ? formatDateTimeShort(row.whatsapp_last_activity_at)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-usage">
          <div className="state-icon"><Activity size={19} /></div>
          <h2>Aucune agence pour ce filtre</h2>
          <p>Élargissez la recherche ou réinitialisez le filtre d’alerte.</p>
          <Button variant="outline" onClick={() => { setSearch(''); setFilter('all'); }} data-testid="button-clear-usage-filters">
            Effacer les filtres
          </Button>
        </div>
      )}

      <p className="permission-note" role="note" data-testid="note-usage-readonly">
        <Activity size={15} />
        <span>
          Compteurs alimentés par <code>public.record_ai_usage()</code> (rôle <code>service_role</code> uniquement,
          appelée par n8n ou par l’assistant IA). Cet écran est en lecture seule : aucune écriture n’est possible ici.
        </span>
      </p>
    </>
  );
}
