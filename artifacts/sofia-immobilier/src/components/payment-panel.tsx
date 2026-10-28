// =============================================================================
// BLOC 1 — Panneau « Abonnement et facturation » (agence)
// =============================================================================
// Remplaçait l'ancienne déclaration libre (montant saisi par l'agence, deux
// moyens codés en dur). Il s'appuie maintenant sur la source unique :
//   public.agency_payment_access      → offres, moyen configuré, demandes
//   public.agency_create_payment_request → demande + référence serveur
//   /abonnement/paiement/:id          → instructions puis preuve de paiement
//
// Rien n'est codé en dur ici : ni tarif, ni numéro, ni statut. Si aucun moyen
// n'est configuré, l'écran l'affiche et la page de paiement bloque l'envoi.
// =============================================================================
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  AlertTriangle, ArrowRight, Check, Clock3, CreditCard, Loader2, Lock,
  ShieldCheck, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgency } from '@/lib/agency-context';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { cash, dateLabel } from '@/lib/workspace-ui';
import {
  REQUEST_STATUS_TONE, SUBSCRIPTION_STATUS_LABELS, requestStatusLabel,
  useAgencyBilling, useCreatePaymentRequest, type PlanOption,
} from '@/lib/billing-api';

const unlimited = (value: number) => value >= 1_000_000_000;

export function PaymentSection({ agencyId }: { agencyId?: string }) {
  const { canManageAgency } = useAgency();
  const billing = useAgencyBilling(agencyId);
  const createRequest = useCreatePaymentRequest(agencyId);
  const [, setLocation] = useLocation();
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(1);

  if (billing.isLoading) {
    return (
      <section className="panel" data-testid="panel-payment-section">
        <div className="panel-head">
          <div>
            <h2><Wallet size={17} /> Abonnement et facturation</h2>
            <p>Chargement de vos moyens de paiement…</p>
          </div>
        </div>
        <div className="loading-state" aria-label="Chargement">
          <Loader2 className="spin" size={18} />
        </div>
      </section>
    );
  }

  if (billing.error || !billing.data) {
    return (
      <section className="panel" data-testid="panel-payment-section">
        <div className="panel-head">
          <div>
            <h2><Wallet size={17} /> Abonnement et facturation</h2>
            <p>Paiement Mobile Money validé par l’administrateur</p>
          </div>
        </div>
        <p className="form-error" role="alert" data-testid="status-payment-section-error">
          {getSupabaseErrorMessage(billing.error, 'charger l’abonnement')}
        </p>
        <Button variant="outline" onClick={() => void billing.refetch()}>Réessayer</Button>
      </section>
    );
  }

  const data = billing.data;
  const usable = Object.values(data.payment_config?.methods ?? {}).filter((m) => m.configured);
  const durations = (data.durations ?? [1]).filter((d) => Number.isFinite(d) && d > 0);
  const open = data.requests.filter((r) =>
    r.status === 'awaiting_payment' || r.status === 'pending' || r.status === 'correction_requested',
  );

  const choose = (plan: PlanOption) => {
    setError('');
    createRequest.mutate(
      { planId: plan.id, durationMonths: duration },
      {
        onSuccess: (created) => setLocation(`/abonnement/paiement/${created.id}`),
        onError: (e) => setError(getSupabaseErrorMessage(e, 'créer la demande de paiement')),
      },
    );
  };

  return (
    <section className="panel" data-testid="panel-payment-section">
      <div className="panel-head">
        <div>
          <h2><Wallet size={17} /> Abonnement et facturation</h2>
          <p>Choisissez une offre, payez par Mobile Money, transmettez la preuve.</p>
        </div>
        <Link href="/abonnement" className="button-link" data-testid="link-full-billing">
          Tout voir <ArrowRight size={13} />
        </Link>
      </div>

      {!canManageAgency && (
        <div className="permission-note" role="status" data-testid="status-payment-permission">
          <Lock size={15} />
          <span>
            Seuls le propriétaire et les administrateurs de l’agence peuvent payer
            l’abonnement.
          </span>
        </div>
      )}

      <div className="billing-current-strip">
        <div>
          <span>Offre actuelle</span>
          <strong data-testid="text-current-plan-name">
            {data.plan?.display_name ?? 'Aucune offre'}
          </strong>
        </div>
        <div>
          <span>Statut</span>
          <strong data-testid="text-subscription-status">
            {SUBSCRIPTION_STATUS_LABELS[data.subscription?.status ?? ''] ?? 'Aucun abonnement'}
          </strong>
        </div>
        <div>
          <span>Échéance</span>
          <strong data-testid="text-subscription-end">
            {data.subscription?.ends_at ? dateLabel(data.subscription.ends_at) : '—'}
          </strong>
        </div>
      </div>

      {usable.length === 0 && (
        <div className="notice-box is-warning" role="status" data-testid="status-payment-instructions-missing">
          <AlertTriangle size={15} />
          <span>
            <strong>Moyen de paiement en cours de configuration.</strong> Aucun
            numéro de paiement n’est encore publié par l’administrateur : vous
            pouvez choisir une offre, mais la transmission d’une preuve reste
            bloquée jusqu’à la configuration.
          </span>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert" data-testid="status-create-request-error">{error}</p>
      )}

      <div className="billing-offer-toolbar">
        <label className="billing-duration">
          <span>Durée</span>
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            aria-label="Durée de l’abonnement"
            data-testid="select-panel-duration"
          >
            {durations.map((months) => (
              <option key={months} value={months}>
                {months === 1 ? '1 mois' : `${months} mois`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="billing-plans is-compact">
        {(data.plans ?? []).map((plan) => {
          const busy = createRequest.isPending && createRequest.variables?.planId === plan.id;
          return (
            <article
              key={plan.id}
              className={`billing-plan${plan.id === data.plan?.id ? ' is-current' : ''}`}
              data-testid={`card-panel-plan-${plan.name}`}
            >
              <header>
                <div>
                  <strong>{plan.display_name ?? plan.name}</strong>
                  {plan.id === data.plan?.id && <span className="billing-plan-tag">Offre actuelle</span>}
                </div>
                <p className="billing-plan-price">
                  {cash(Number(plan.price_monthly), plan.currency)} <span>/ mois</span>
                </p>
              </header>
              <ul className="billing-plan-limits">
                <li>{unlimited(plan.max_properties) ? 'Biens illimités' : `${plan.max_properties} biens`}</li>
                <li>{unlimited(plan.max_members) ? 'Utilisateurs illimités' : `${plan.max_members} utilisateurs`}</li>
                <li>
                  {unlimited(plan.monthly_agent_messages)
                    ? 'Messages IA illimités'
                    : `${plan.monthly_agent_messages} messages IA`}
                </li>
              </ul>
              <p className="billing-plan-total">
                <Check size={12} /> Total {duration === 1 ? '1 mois' : `${duration} mois`} :{' '}
                <strong>{cash(Number(plan.price_monthly) * duration, plan.currency)}</strong>
              </p>
              <Button
                className="primary-action"
                disabled={!canManageAgency || createRequest.isPending}
                onClick={() => choose(plan)}
                data-testid={`button-panel-choose-${plan.name}`}
              >
                {busy ? <Loader2 size={14} className="spin" /> : <CreditCard size={14} />}
                Payer cette offre
              </Button>
            </article>
          );
        })}
      </div>

      {open.length > 0 && (
        <div className="billing-open-requests" data-testid="panel-panel-open-requests">
          <h3><Clock3 size={14} /> Demandes en cours</h3>
          {open.map((row) => (
            <div key={row.id} className="billing-open-row" data-testid={`row-panel-request-${row.id}`}>
              <span className="mono">{row.reference}</span>
              <span>{cash(Number(row.expected_amount ?? row.amount ?? 0), row.currency)}</span>
              <span className={`status-pill billing-status ${REQUEST_STATUS_TONE[row.status] ?? ''}`}>
                {requestStatusLabel(row.status)}
              </span>
              <Link href={`/abonnement/paiement/${row.id}`} className="button-link">
                {row.status === 'correction_requested' ? 'Corriger' : 'Continuer'} <ArrowRight size={12} />
              </Link>
            </div>
          ))}
        </div>
      )}

      <p className="billing-footnote">
        <ShieldCheck size={12} /> Le paiement n’est jamais validé automatiquement :
        un administrateur vérifie la transaction avant d’activer l’abonnement.
      </p>
    </section>
  );
}
