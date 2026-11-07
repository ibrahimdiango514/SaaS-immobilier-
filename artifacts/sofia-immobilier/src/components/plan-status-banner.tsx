// =============================================================================
// LOT 2 & LOT 3 — BANDEAU D'ÉTAT DU CYCLE D'ABONNEMENT & FACTURATION
// =============================================================================
// Affiche l'état exact du cycle lu depuis `public.agency_plan_state` :
//   • J0 → J14 : Essai gratuit de 14 jours (compteur de jours + quotas 100 %)
//   • J14 → E1 : 1er mois (ou mois courant) avec facture ouverte -> accès 100 %
//     maintenu + lien direct pour régler en ligne via SasPay
//   • E1 → E1 + 5j : Période de grâce de 5 jours -> compte à rebours avant
//     suspension automatique + maintien garanti des accès et quotas
// =============================================================================
import { useEffect, useRef } from 'react';
import { AlertTriangle, CalendarClock, CreditCard, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { agencyStateLabel, useAgencyPlanState } from '@/lib/plan-limits';
import { useAgency } from '@/lib/agency-context';
import { cash, dateLabel } from '@/lib/workspace-ui';
import { useSyncAgencyBillingLifecycle } from '@/lib/saspay-api';

const TONE: Record<string, string> = {
  trial: 'is-info',
  active: 'is-ok',
  overdue: 'is-warn',
  no_plan: 'is-warn',
  suspended_overdue: 'is-danger',
  suspended: 'is-danger',
  pending: 'is-info',
  cancelled: 'is-warn',
};

export function PlanStatusBanner({ compact = false }: { compact?: boolean }) {
  const { activeAgencyId, canManageAgency } = useAgency();
  const stateQ = useAgencyPlanState(activeAgencyId);
  const syncLifecycle = useSyncAgencyBillingLifecycle(activeAgencyId);
  const syncedKeyRef = useRef<string | null>(null);
  const state = stateQ.data;

  // Synchroniser automatiquement la bascule J14 -> 1er mois ou E1 -> grâce
  useEffect(() => {
    if (!activeAgencyId || !state) return;
    const trialExpired =
      state.subscription_status === 'trial' &&
      Boolean(state.trial_ends_at) &&
      new Date(state.trial_ends_at as string).getTime() <= Date.now();
    const periodReached =
      state.subscription_status === 'active' &&
      Boolean(state.ends_at) &&
      new Date(state.ends_at as string).getTime() <= Date.now();

    if (trialExpired || periodReached) {
      const key = `${activeAgencyId}:${state.subscription_status}:${state.ends_at ?? state.trial_ends_at}`;
      if (syncedKeyRef.current !== key && !syncLifecycle.isPending) {
        syncedKeyRef.current = key;
        syncLifecycle.mutate();
      }
    }
  }, [activeAgencyId, state, syncLifecycle]);

  if (stateQ.error) {
    return (
      <section className="status-banner is-warn" role="alert" data-testid="status-plan-error">
        <div className="status-banner-icon"><AlertTriangle size={15} /></div>
        <div>
          <strong>Impossible de lire votre offre</strong>
          <p>{(stateQ.error as Error).message}</p>
        </div>
      </section>
    );
  }

  if (stateQ.isLoading || !state) return null;

  // Abonnement actif déjà payé et aucune facture en attente : pas de bandeau intrusif
  if (state.state === 'active' && state.billing_phase !== 'active_unpaid_open') {
    return null;
  }

  const tone =
    state.billing_phase === 'active_unpaid_open'
      ? 'is-info'
      : (TONE[state.state] ?? 'is-warn');

  const action = canManageAgency ? (
    <Link href="/mon-offre" className="button-link" data-testid="link-plan-banner-action">
      <Sparkles size={14} />{' '}
      {state.billing_phase === 'grace_period' || state.state === 'overdue'
        ? 'Régulariser avec SasPay'
        : state.billing_phase === 'active_unpaid_open'
          ? 'Payer ma facture'
          : 'Voir mon offre'}
    </Link>
  ) : null;

  if (state.state === 'trial') {
    const days = state.trial_days_left ?? 0;
    return (
      <section className={`status-banner ${tone}`} data-testid="status-plan-trial">
        <div className="status-banner-icon"><CalendarClock size={15} /></div>
        <div>
          <strong>
            Essai gratuit 14 jours : {days} jour{days > 1 ? 's' : ''} restant{days > 1 ? 's' : ''}
          </strong>
          <p>
            Offre {state.plan_name ?? '—'} avec accès 100 % complet aux quotas et modules · fin de l’essai le{' '}
            {state.trial_ends_at ? dateLabel(state.trial_ends_at) : '—'}. Votre 1er mois d’abonnement (
            {state.plan_price_monthly ? cash(Number(state.plan_price_monthly), state.currency ?? 'XOF') : '—'})
            démarrera automatiquement à cette date.
          </p>
        </div>
        {action}
      </section>
    );
  }

  if (state.billing_phase === 'active_unpaid_open') {
    const dueDays = state.days_to_due ?? 0;
    const invAmount = Number(state.open_invoice_amount ?? state.plan_price_monthly ?? 0);
    return (
      <section className="status-banner is-info" role="status" data-testid="status-plan-open-invoice">
        <div className="status-banner-icon"><CreditCard size={15} /></div>
        <div>
          <strong>
            {state.open_invoice_kind === 'first_subscription'
              ? '1er mois d’abonnement en cours — facture mensuelle disponible'
              : 'Période mensuelle en cours — facture disponible'}
          </strong>
          <p>
            Vos accès et quotas {state.plan_name ?? ''} sont 100 % actifs. Facture de{' '}
            <strong>{cash(invAmount, state.currency ?? 'XOF')}</strong> à régler d’ici le{' '}
            <strong>{state.open_invoice_due_at ? dateLabel(state.open_invoice_due_at) : (state.ends_at ? dateLabel(state.ends_at) : '—')}</strong>
            {dueDays > 0 ? ` (${dueDays} jour${dueDays > 1 ? 's' : ''} avant échéance)` : ''}.
          </p>
        </div>
        {action}
      </section>
    );
  }

  if (state.state === 'overdue' || state.billing_phase === 'grace_period') {
    const graceLeft = state.grace_days_left ?? Math.max(0, (state.grace_days ?? 5) - Math.abs(state.days_to_due ?? 0));
    const invAmount = Number(state.open_invoice_amount ?? state.plan_price_monthly ?? 0);
    return (
      <section className="status-banner is-warn" role="status" data-testid="status-plan-overdue">
        <div className="status-banner-icon"><AlertTriangle size={15} /></div>
        <div>
          <strong>
            Période de grâce ({state.grace_days ?? 5} jours) : {graceLeft} jour{graceLeft > 1 ? 's' : ''} restant{graceLeft > 1 ? 's' : ''} avant suspension
          </strong>
          <p>
            Votre échéance mensuelle de <strong>{cash(invAmount, state.currency ?? 'XOF')}</strong> est dépassée.
            Vos accès complets restent maintenus jusqu’au{' '}
            <strong>{state.grace_ends_at ? dateLabel(state.grace_ends_at) : 'terme de la grâce'}</strong> : réglez en ligne via SasPay pour éviter la suspension automatique.
          </p>
        </div>
        {action}
      </section>
    );
  }

  if (state.state === 'no_plan') {
    return (
      <section className={`status-banner ${tone}`} role="status" data-testid="status-plan-missing">
        <div className="status-banner-icon"><CreditCard size={15} /></div>
        <div>
          <strong>Aucune offre active sur cette agence</strong>
          <p>Consultez « Mon offre » ou contactez l’administrateur pour activer votre formule.</p>
        </div>
        {action}
      </section>
    );
  }

  if (state.state === 'cancelled') {
    return (
      <section className={`status-banner ${tone}`} role="status" data-testid="status-plan-cancelled">
        <div className="status-banner-icon"><AlertTriangle size={15} /></div>
        <div>
          <strong>Abonnement {agencyStateLabel(state.state).toLowerCase()}</strong>
          <p>Contactez l’équipe Sofia Immobilier ou régularisez votre offre.</p>
        </div>
        {action}
      </section>
    );
  }

  if (compact || state.is_locked) return null;

  return (
    <section className={`status-banner ${tone}`} role="status" data-testid="status-plan-generic">
      <div className="status-banner-icon"><AlertTriangle size={15} /></div>
      <div>
        <strong>{agencyStateLabel(state.state)}</strong>
        <p>Vérifiez votre offre et vos paiements.</p>
      </div>
      {action}
    </section>
  );
}
