// =============================================================================
// BLOC 1 (session 3) — BANDEAU D'ÉTAT DE L'OFFRE
// =============================================================================
// Affiche l'état RÉEL de l'offre, lu depuis `public.agency_plan_state`.
// Objectif : plus jamais d'écran muet quand l'offre est absente ou en attente.
// La vue d'ensemble, Mon offre et Paramètres restent accessibles.
// =============================================================================
import { AlertTriangle, CalendarClock, CreditCard, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { agencyStateLabel, useAgencyPlanState } from '@/lib/plan-limits';
import { useAgency } from '@/lib/agency-context';

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
  const state = stateQ.data;

  // Erreur de lecture : on l'affiche, on ne la masque jamais.
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
  if (stateQ.isLoading || !state || state.state === 'active') return null;

  const tone = TONE[state.state] ?? 'is-warn';
  const action = canManageAgency ? (
    <Link href="/mon-offre" className="button-link" data-testid="link-plan-banner-action">
      <Sparkles size={14} /> Voir mon offre
    </Link>
  ) : null;

  if (state.state === 'trial') {
    const days = state.trial_days_left ?? 0;
    return (
      <section className={`status-banner ${tone}`} data-testid="status-plan-trial">
        <div className="status-banner-icon"><CalendarClock size={15} /></div>
        <div>
          <strong>Essai gratuit : {days} jour{days > 1 ? 's' : ''} restant{days > 1 ? 's' : ''}</strong>
          <p>
            Offre {state.plan_name ?? '—'} · l’essai se termine le{' '}
            {state.trial_ends_at ? new Date(state.trial_ends_at).toLocaleDateString('fr-FR') : '—'}.
            Votre abonnement payant ne démarre qu’après l’essai.
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
          <p>
            Votre espace de travail reste ouvert. Choisissez une offre pour débloquer
            les modules et les limites correspondantes. Aucun montant n’est débité
            avant validation par l’administrateur.
          </p>
        </div>
        {action}
      </section>
    );
  }

  if (state.state === 'overdue') {
    const days = Math.abs(state.days_to_due ?? 0);
    return (
      <section className={`status-banner ${tone}`} role="status" data-testid="status-plan-overdue">
        <div className="status-banner-icon"><AlertTriangle size={15} /></div>
        <div>
          <strong>Abonnement en retard de {days} jour{days > 1 ? 's' : ''}</strong>
          <p>
            Un délai de grâce de {state.grace_days ?? 5} jours s’applique avant
            suspension automatique. Déclarez votre paiement pour régulariser.
          </p>
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
          <p>Choisissez une nouvelle offre pour réactiver les modules de votre agence.</p>
        </div>
        {action}
      </section>
    );
  }

  // pending / suspended / suspended_overdue : gérés par l'écran dédié.
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
