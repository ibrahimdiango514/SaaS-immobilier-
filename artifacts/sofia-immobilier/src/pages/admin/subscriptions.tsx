// =============================================================================
// LOT 2 & LOT 3 — ADMIN : GESTION DES ABONNEMENTS & DU CYCLE D'ÉCHÉANCES
// =============================================================================
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarClock, CheckCircle2, Download, Play, Plus, Search,
  ShieldCheck, Sparkles, XCircle,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAllAgencies, useAdminUpdateSubscription } from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
import { LoadingRows, cash, dateLabel, dateTimeLabel, downloadCsv } from '@/lib/workspace-ui';
import { useAdminChangeAgencyPlan } from '@/lib/admin-billing-api';
import { adminEndTrial, adminExtendTrial } from '@/lib/trial-api';
import { useAdminRunBillingLifecycle } from '@/lib/saspay-api';
import { useBillingAutomationHealth, useSetSuspensionShield } from '@/lib/admin-alerts-api';

const subscriptionStatus: Record<string, string> = {
  active: 'Actif',
  trial: 'Essai 14j',
  past_due: 'Grâce 5j / Impayé',
  expired: 'Expiré',
  cancelled: 'Annulé',
};

export default function AdminSubscriptionsPage() {
  const queryClient = useQueryClient();
  const agenciesQ = useAllAgencies();
  const updateSubscription = useAdminUpdateSubscription();
  const changePlan = useAdminChangeAgencyPlan();
  const runLifecycle = useAdminRunBillingLifecycle();
  const cronHealthQ = useBillingAutomationHealth();
  const setShield = useSetSuspensionShield();

  const [search, setSearch] = useState('');
  const [planDraft, setPlanDraft] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState('all');
  const [trialBusyId, setTrialBusyId] = useState<string | null>(null);
  const [pageError, setPageError] = useState('');
  const [pageSuccess, setPageSuccess] = useState('');

  const plans = agenciesQ.data?.plans ?? [];
  const agencies = agenciesQ.data?.agencies ?? [];
  const subscriptions = agenciesQ.data?.subscriptions ?? [];

  const cycleStats = useMemo(() => {
    const inTrial = subscriptions.filter((s) => s.status === 'trial').length;
    const active = subscriptions.filter((s) => s.status === 'active').length;
    const inGrace = subscriptions.filter((s) => {
      const ag = agencies.find((a) => a.id === s.agency_id);
      return s.status === 'past_due' && ag?.status === 'active';
    }).length;
    const suspendedUnpaid = agencies.filter(
      (a) => a.status === 'suspended' && (!a.suspended_reason || a.suspended_reason === 'unpaid'),
    ).length;
    return { inTrial, active, inGrace, suspendedUnpaid };
  }, [subscriptions, agencies]);

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    return subscriptions.filter((subscription) => {
      const agency = agencies.find((a) => a.id === subscription.agency_id);
      const plan = plans.find((p) => p.id === subscription.plan_id);
      const haystack = `${agency?.name ?? ''} ${plan?.name ?? ''} ${plan?.display_name ?? ''} ${subscription.status}`.toLocaleLowerCase('fr');
      return (!needle || haystack.includes(needle)) && (statusFilter === 'all' || subscription.status === statusFilter);
    });
  }, [subscriptions, agencies, plans, search, statusFilter]);

  const handleRunLifecycle = async () => {
    setPageError('');
    setPageSuccess('');
    try {
      const res = await runLifecycle.mutateAsync();
      setPageSuccess(
        `Cycle d’échéances exécuté : ${res.trials_converted} fin(s) d’essai → 1er mois, ${res.renewals_opened} renouvellement(s), ${res.entered_grace} entrée(s) en grâce 5j, ${res.suspended} suspension(s) auto, ${res.notifications_sent} notification(s).`,
      );
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'exécuter le cycle de facturation'));
    }
  };

  const handleExtendTrial = async (agencyId: string, agencyName: string) => {
    setPageError('');
    setPageSuccess('');
    setTrialBusyId(agencyId);
    try {
      const res = await adminExtendTrial(agencyId, 7);
      await queryClient.invalidateQueries({ queryKey: ['sofia'] });
      setPageSuccess(`Essai gratuit de ${agencyName} prolongé de 7 jours (jusqu’au ${dateLabel(res.trial_ends_at)}).`);
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'prolonger l’essai'));
    } finally {
      setTrialBusyId(null);
    }
  };

  const handleEndTrialNow = async (agencyId: string, agencyName: string) => {
    if (!window.confirm(`Clôturer l’essai gratuit de « ${agencyName} » et ouvrir immédiatement son 1er mois d’abonnement (génération de la 1re facture mensuelle) ?`)) {
      return;
    }
    setPageError('');
    setPageSuccess('');
    setTrialBusyId(agencyId);
    try {
      const res = await adminEndTrial(agencyId, 'Passage anticipé en 1er mois depuis la console Abonnements');
      await queryClient.invalidateQueries({ queryKey: ['sofia'] });
      setPageSuccess(`1er mois ouvert pour ${agencyName} (échéance le ${dateLabel(res.ends_at)}).`);
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'clôturer l’essai'));
    } finally {
      setTrialBusyId(null);
    }
  };

  const changeSubscription = (subscriptionId: string, status: string) => {
    setPageError('');
    setPageSuccess('');
    updateSubscription.mutate(
      { subscriptionId, status },
      {
        onSuccess: () => setPageSuccess('Abonnement mis à jour.'),
        onError: (error) => setPageError(getSupabaseErrorMessage(error, 'mettre à jour l’abonnement')),
      },
    );
  };

  const renewSubscription = (subscriptionId: string) => {
    setPageError('');
    setPageSuccess('');
    const endsAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    updateSubscription.mutate(
      { subscriptionId, status: 'active', ends_at: endsAt },
      {
        onSuccess: () => setPageSuccess('Abonnement prolongé de 30 jours.'),
        onError: (error) => setPageError(getSupabaseErrorMessage(error, 'renouveler l’abonnement')),
      },
    );
  };

  const applyPlanChange = (agencyId: string, agencyName: string, planId: string) => {
    const plan = plans.find((row) => row.id === planId);
    if (!plan) return;
    const label = plan.display_name ?? plan.name;
    if (!window.confirm(`Passer l'agence « ${agencyName} » à l'offre ${label} ?`)) return;
    setPageError('');
    setPageSuccess('');
    changePlan.mutate(
      { agencyId, planId },
      {
        onSuccess: () => {
          setPlanDraft((prev) => ({ ...prev, [agencyId]: '' }));
          setPageSuccess(`Offre ${label} appliquée à ${agencyName}.`);
        },
        onError: (error) => setPageError(getSupabaseErrorMessage(error, 'changer l’offre')),
      },
    );
  };

  const exportCsv = () => {
    downloadCsv(
      `sofia-abonnements-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Agence', 'Statut agence', 'Formule', 'Prix mensuel', 'Statut abonnement', 'Début', 'Échéance', 'Essai jusqu’à'],
      rows.map((subscription) => {
        const agency = agencies.find((a) => a.id === subscription.agency_id);
        const plan = plans.find((p) => p.id === subscription.plan_id);
        return [
          agency?.name ?? '—',
          agency?.status ?? '—',
          plan?.display_name ?? plan?.name ?? '—',
          plan ? `${plan.price_monthly} ${plan.currency}` : '—',
          subscriptionStatus[subscription.status] ?? subscription.status,
          dateLabel(subscription.starts_at),
          subscription.ends_at ? dateLabel(subscription.ends_at) : '—',
          subscription.trial_ends_at ? dateLabel(subscription.trial_ends_at) : '—',
        ];
      }),
    );
  };

  const handleGrantShield = async (agencyId: string, agencyName: string) => {
    setPageError('');
    setPageSuccess('');
    try {
      const res = await setShield.mutateAsync({
        agencyId,
        days: 3,
        note: 'Délai exceptionnel accordé depuis la console Abonnements',
      });
      await queryClient.invalidateQueries({ queryKey: ['sofia'] });
      setPageSuccess(
        `Protection anti-suspension accordée à « ${agencyName} » jusqu’au ${
          res.auto_suspend_disabled_until ? dateTimeLabel(res.auto_suspend_disabled_until) : '—'
        } (heure de Bamako).`,
      );
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'accorder un délai exceptionnel'));
    }
  };

  if (agenciesQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Facturation" title="Abonnements" description="Chargement des formules et échéances…" />
        <LoadingRows />
      </>
    );
  }

  if (agenciesQ.error) {
    return (
      <>
        <AdminHeading eyebrow="Facturation" title="Abonnements" description="Impossible de charger les abonnements." />
        <div className="state-card error-state" role="alert">
          <h2>Accès refusé</h2>
          <Button variant="outline" onClick={() => void agenciesQ.refetch()}>Réessayer</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeading
        eyebrow="Facturation & Cycle LOT 2"
        title="Abonnements"
        description="Suivi du cycle complet : essai gratuit 14j → 1er mois payant → grâce de 5 jours → suspension automatique sur impayé."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={runLifecycle.isPending}
              onClick={() => void handleRunLifecycle()}
              data-testid="button-run-billing-lifecycle"
            >
              <Play size={14} />{' '}
              {runLifecycle.isPending ? 'Exécution du cycle…' : 'Exécuter le cycle d’échéances'}
            </Button>
            <button className="button-link" onClick={exportCsv} data-testid="button-export-subscriptions">
              <Download size={15} /> Exporter (CSV)
            </button>
          </div>
        }
      />

      {pageError && <p className="form-error module-error" role="alert">{pageError}</p>}
      {pageSuccess && <p className="form-feedback" role="status" data-testid="status-subscriptions-feedback">{pageSuccess}</p>}

      {cronHealthQ.data && (
        <div className="panel-card sofia-cron-banner" data-testid="subscriptions-cron-health">
          <div className="sofia-cron-banner-left">
            <ShieldCheck size={16} />
            <div>
              <strong>
                Automatisation horaire (pg_cron) :{' '}
                {cronHealthQ.data.pg_cron_active ? 'Active (5 * * * *)' : 'Manuelle'}
              </strong>
              <small>
                Dernier cycle :{' '}
                {cronHealthQ.data.last_cycle_run
                  ? dateTimeLabel(cronHealthQ.data.last_cycle_run.created_at)
                  : 'Aucun'}{' '}
                · Fuseau Africa/Bamako
              </small>
            </div>
          </div>
        </div>
      )}

      {/* COMPTEURS DU CYCLE D'ABONNEMENT LOT 2 */}
      <section className="kpi-grid" style={{ marginBottom: 18 }} data-testid="grid-subscription-lifecycle-kpis">
        <article className="panel kpi-card">
          <span className="form-kicker">Essai gratuit (J0 → J14)</span>
          <strong className="kpi-value" data-testid="kpi-subs-trial">{cycleStats.inTrial}</strong>
          <small>Quotas complets pendant 14 jours</small>
        </article>
        <article className="panel kpi-card">
          <span className="form-kicker">Période mensuelle active</span>
          <strong className="kpi-value" data-testid="kpi-subs-active">{cycleStats.active}</strong>
          <small>Abonnements mensuels en cours</small>
        </article>
        <article className="panel kpi-card">
          <span className="form-kicker">En grâce (5 jours)</span>
          <strong className="kpi-value" data-testid="kpi-subs-grace">{cycleStats.inGrace}</strong>
          <small>Échéance dépassée, accès maintenu 5j</small>
        </article>
        <article className="panel kpi-card">
          <span className="form-kicker">Suspendues (impayé)</span>
          <strong className="kpi-value" data-testid="kpi-subs-suspended">{cycleStats.suspendedUnpaid}</strong>
          <small>Réactivables automatiquement via SasPay</small>
        </article>
      </section>

      <section className="plan-grid" aria-label="Formules disponibles">
        {plans.map((plan) => (
          <article className="panel plan-card" key={plan.id} data-testid={`plan-${plan.name}`}>
            <span className="form-kicker">Formule</span>
            <h2>{plan.display_name ?? plan.name}</h2>
            <strong className="plan-price">{cash(Number(plan.price_monthly), plan.currency)}<small>/mois</small></strong>
            <small style={{ display: 'block', marginBottom: 8 }}>
              Installation physique : {cash(Number(plan.setup_fee ?? 0), plan.currency)} (hors SasPay)
            </small>
            <ul>
              <li>{plan.max_members >= 1_000_000_000 ? 'Membres illimités' : `${plan.max_members} membre(s) max.`}</li>
              <li>{plan.max_properties >= 1_000_000_000 ? 'Biens illimités' : `${plan.max_properties} bien(s) max.`}</li>
              <li>{plan.max_whatsapp_connections} ligne(s) WhatsApp</li>
              <li>{plan.monthly_conversations >= 1_000_000_000 ? 'Conversations illimitées' : `${plan.monthly_conversations} conversation(s)/mois`}</li>
            </ul>
            <span className="plan-agency-count">
              {subscriptions.filter((s) => s.plan_id === plan.id).length} agence(s) souscrite(s)
            </span>
          </article>
        ))}
      </section>

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Agence ou formule…" aria-label="Rechercher un abonnement" data-testid="input-search-subscriptions" />
        </label>
        <select className="form-select compact-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-subscription-status">
          <option value="all">Tous les statuts</option>
          {Object.entries(subscriptionStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="result-count">{rows.length} abonnement(s)</span>
      </section>

      {rows.length ? (
        <div className="panel list-panel">
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr>
                  <th>Agence</th>
                  <th>Formule</th>
                  <th>Phase / Statut</th>
                  <th>Début</th>
                  <th>Échéance & Grâce</th>
                  <th>Offre</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((subscription) => {
                  const agency = agencies.find((a) => a.id === subscription.agency_id);
                  const plan = plans.find((p) => p.id === subscription.plan_id);
                  const isSuspended = agency?.status === 'suspended';
                  const graceDate = subscription.ends_at
                    ? new Date(new Date(subscription.ends_at).getTime() + 5 * 86_400_000).toISOString()
                    : null;

                  return (
                    <tr key={subscription.id} data-testid={`row-subscription-${subscription.id}`}>
                      <td>
                        <strong>{agency?.name ?? 'Agence inconnue'}</strong>
                        <small>{agency?.city ?? ''}</small>
                      </td>
                      <td>
                        {plan?.display_name ?? plan?.name ?? '—'}
                        <small>{plan ? `${cash(Number(plan.price_monthly), plan.currency)}/mois` : ''}</small>
                      </td>
                      <td>
                        <span className={`status-pill status-${isSuspended ? 'unavailable' : subscription.status === 'active' ? 'available' : 'reserved'}`}>
                          {isSuspended
                            ? 'Suspendue (impayé)'
                            : (subscriptionStatus[subscription.status] ?? subscription.status)}
                        </span>
                      </td>
                      <td>{dateLabel(subscription.starts_at)}</td>
                      <td>
                        {subscription.status === 'trial' && subscription.trial_ends_at ? (
                          <div>
                            <strong>Fin essai : {dateLabel(subscription.trial_ends_at)}</strong>
                            <small style={{ display: 'block' }}>Puis ouverture auto du 1er mois</small>
                          </div>
                        ) : subscription.ends_at ? (
                          <div>
                            <strong>Échéance : {dateLabel(subscription.ends_at)}</strong>
                            {graceDate && (
                              <small style={{ display: 'block' }}>
                                Grâce 5j jusqu’au {dateLabel(graceDate)}
                              </small>
                            )}
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <div className="plan-switch">
                          <select
                            className="form-select compact-select"
                            value={planDraft[subscription.agency_id] ?? ''}
                            onChange={(e) => setPlanDraft((prev) => ({ ...prev, [subscription.agency_id]: e.target.value }))}
                            aria-label={`Nouvelle offre pour ${agency?.name ?? 'cette agence'}`}
                            data-testid={`select-plan-${subscription.id}`}
                          >
                            <option value="">Changer d’offre…</option>
                            {plans
                              .filter((row) => row.id !== subscription.plan_id)
                              .map((row) => (
                                <option key={row.id} value={row.id}>
                                  {row.display_name ?? row.name} · {cash(Number(row.price_monthly), row.currency)}/mois
                                </option>
                              ))}
                          </select>
                          <button
                            className="row-action"
                            disabled={changePlan.isPending || !planDraft[subscription.agency_id]}
                            onClick={() => applyPlanChange(
                              subscription.agency_id,
                              agency?.name ?? 'cette agence',
                              planDraft[subscription.agency_id],
                            )}
                            data-testid={`button-change-plan-${subscription.id}`}
                          >
                            <Sparkles size={14} /> <span>Appliquer</span>
                          </button>
                        </div>
                      </td>
                      <td className="row-actions-cell">
                        {subscription.status === 'trial' ? (
                          <>
                            <button
                              className="row-action"
                              disabled={trialBusyId === subscription.agency_id}
                              onClick={() => void handleExtendTrial(subscription.agency_id, agency?.name ?? 'cette agence')}
                              data-testid={`button-extend-trial-${subscription.id}`}
                            >
                              <Plus size={14} /> <span>+7j essai</span>
                            </button>
                            <button
                              className="row-action"
                              disabled={trialBusyId === subscription.agency_id}
                              onClick={() => void handleEndTrialNow(subscription.agency_id, agency?.name ?? 'cette agence')}
                              data-testid={`button-end-trial-${subscription.id}`}
                            >
                              <CalendarClock size={14} /> <span>Ouvrir 1er mois</span>
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="row-action"
                              disabled={updateSubscription.isPending}
                              onClick={() => changeSubscription(subscription.id, 'active')}
                              data-testid={`button-activate-subscription-${subscription.id}`}
                            >
                              <CheckCircle2 size={14} /> <span>Activer</span>
                            </button>
                            <button
                              className="row-action"
                              disabled={updateSubscription.isPending}
                              onClick={() => renewSubscription(subscription.id)}
                              data-testid={`button-renew-subscription-${subscription.id}`}
                            >
                              Renouveler 30 j
                            </button>
                            {subscription.status === 'past_due' && (
                              <button
                                className="row-action"
                                disabled={setShield.isPending}
                                onClick={() =>
                                  void handleGrantShield(
                                    subscription.agency_id,
                                    agency?.name ?? 'cette agence',
                                  )
                                }
                                title="Accorder +3 jours de protection contre la suspension automatique (litige / accord écrit)"
                                data-testid={`button-shield-subscription-${subscription.id}`}
                              >
                                <ShieldCheck size={14} /> <span>+3j délai</span>
                              </button>
                            )}
                          </>
                        )}
                        <button
                          className="row-action danger"
                          disabled={updateSubscription.isPending}
                          onClick={() => changeSubscription(subscription.id, 'cancelled')}
                          data-testid={`button-cancel-subscription-${subscription.id}`}
                        >
                          <XCircle size={14} /> <span>Résilier</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-subscriptions">
          <div className="state-icon"><AlertTriangle size={19} /></div>
          <h2>Aucun abonnement pour ces filtres</h2>
          <p>Modifiez la recherche ou le statut sélectionné.</p>
        </div>
      )}
    </>
  );
}
