import { useMemo, useState } from 'react';
import { CheckCircle2, Download, Search, XCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAllAgencies, useAdminUpdateSubscription, useAdminUpdateAgency } from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
import { LoadingRows, cash, dateLabel, downloadCsv } from '@/lib/workspace-ui';

const subscriptionStatus: Record<string, string> = {
  active: 'Actif',
  trial: 'Essai',
  expired: 'Expiré',
  cancelled: 'Annulé',
  past_due: 'Impayé',
};

export default function AdminSubscriptionsPage() {
  const agenciesQ = useAllAgencies();
  const updateSubscription = useAdminUpdateSubscription();
  const updateAgency = useAdminUpdateAgency();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pageError, setPageError] = useState('');
  const [pageSuccess, setPageSuccess] = useState('');

  const plans = agenciesQ.data?.plans ?? [];
  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    return (agenciesQ.data?.subscriptions ?? []).filter((subscription) => {
      const agency = agenciesQ.data?.agencies.find((a) => a.id === subscription.agency_id);
      const plan = plans.find((p) => p.id === subscription.plan_id);
      const haystack = `${agency?.name ?? ''} ${plan?.name ?? ''} ${subscription.status}`.toLocaleLowerCase('fr');
      return (!needle || haystack.includes(needle)) && (statusFilter === 'all' || subscription.status === statusFilter);
    });
  }, [agenciesQ.data, plans, search, statusFilter]);

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
    // Prolonge d'un mois à partir de maintenant.
    const endsAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    updateSubscription.mutate(
      { subscriptionId, status: 'active', ends_at: endsAt },
      {
        onSuccess: () => setPageSuccess('Abonnement réactivé pour 30 jours.'),
        onError: (error) => setPageError(getSupabaseErrorMessage(error, 'renouveler l’abonnement')),
      },
    );
  };

  const exportCsv = () => {
    downloadCsv(
      `sofia-abonnements-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Agence', 'Formule', 'Prix mensuel', 'Statut', 'Début', 'Fin', 'Essai jusqu’à'],
      rows.map((subscription) => {
        const agency = agenciesQ.data?.agencies.find((a) => a.id === subscription.agency_id);
        const plan = plans.find((p) => p.id === subscription.plan_id);
        return [
          agency?.name ?? '—',
          plan?.name ?? '—',
          plan ? `${plan.price_monthly} ${plan.currency}` : '—',
          subscriptionStatus[subscription.status] ?? subscription.status,
          dateLabel(subscription.starts_at),
          subscription.ends_at ? dateLabel(subscription.ends_at) : '—',
          subscription.trial_ends_at ? dateLabel(subscription.trial_ends_at) : '—',
        ];
      }),
    );
  };

  if (agenciesQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Facturation" title="Abonnements" description="Chargement des formules…" />
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
        eyebrow="Facturation"
        title="Abonnements"
        description="Formules de la plateforme et abonnement de chaque agence — modifications enregistrées en temps réel."
        action={
          <button className="button-link" onClick={exportCsv} data-testid="button-export-subscriptions">
            <Download size={15} /> Exporter (CSV)
          </button>
        }
      />

      {pageError && <p className="form-error module-error" role="alert">{pageError}</p>}
      {pageSuccess && <p className="form-feedback" role="status">{pageSuccess}</p>}

      <section className="plan-grid" aria-label="Formules disponibles">
        {plans.map((plan) => (
          <article className="panel plan-card" key={plan.id} data-testid={`plan-${plan.name}`}>
            <span className="form-kicker">Formule</span>
            <h2>{plan.name}</h2>
            <strong className="plan-price">{cash(Number(plan.price_monthly), plan.currency)}<small>/mois</small></strong>
            <ul>
              <li>{plan.max_members} membre(s) max.</li>
              <li>{plan.max_properties} bien(s) max.</li>
              <li>{plan.max_whatsapp_connections} ligne(s) WhatsApp</li>
              <li>{plan.monthly_conversations} conversation(s)/mois</li>
            </ul>
            <span className="plan-agency-count">
              {(agenciesQ.data?.subscriptions ?? []).filter((s) => s.plan_id === plan.id).length} agence(s) souscrite(s)
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
                <tr><th>Agence</th><th>Formule</th><th>Statut</th><th>Début</th><th>Fin</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map((subscription) => {
                  const agency = agenciesQ.data?.agencies.find((a) => a.id === subscription.agency_id);
                  const plan = plans.find((p) => p.id === subscription.plan_id);
                  return (
                    <tr key={subscription.id} data-testid={`row-subscription-${subscription.id}`}>
                      <td><strong>{agency?.name ?? 'Agence inconnue'}</strong><small>{agency?.city ?? ''}</small></td>
                      <td>{plan?.name ?? '—'}<small>{plan ? `${cash(Number(plan.price_monthly), plan.currency)}/mois` : ''}</small></td>
                      <td>
                        <span className={`status-pill status-${subscription.status === 'active' ? 'available' : subscription.status === 'trial' ? 'reserved' : 'unavailable'}`}>
                          {subscriptionStatus[subscription.status] ?? subscription.status}
                        </span>
                      </td>
                      <td>{dateLabel(subscription.starts_at)}</td>
                      <td>{subscription.ends_at ? dateLabel(subscription.ends_at) : subscription.trial_ends_at ? `Essai : ${dateLabel(subscription.trial_ends_at)}` : '—'}</td>
                      <td className="row-actions-cell">
                        <button className="row-action" disabled={updateSubscription.isPending} onClick={() => changeSubscription(subscription.id, 'active')} data-testid={`button-activate-subscription-${subscription.id}`}>
                          <CheckCircle2 size={14} /> <span>Activer</span>
                        </button>
                        <button className="row-action" disabled={updateSubscription.isPending} onClick={() => renewSubscription(subscription.id)} data-testid={`button-renew-subscription-${subscription.id}`}>
                          Renouveler 30 j
                        </button>
                        <button className="row-action danger" disabled={updateSubscription.isPending} onClick={() => changeSubscription(subscription.id, 'cancelled')} data-testid={`button-cancel-subscription-${subscription.id}`}>
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
          <div className="state-icon"><Search size={19} /></div>
          <h2>Aucun abonnement pour ces filtres</h2>
          <p>Modifiez la recherche ou le statut.</p>
        </div>
      )}
    </>
  );
}
