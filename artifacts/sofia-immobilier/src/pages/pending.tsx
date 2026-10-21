// =============================================================================
// SESSION 2 — BLOC 2 : ÉCRAN D'ATTENTE DE VALIDATION
// =============================================================================
// Affiché à la place du dashboard tant que `agencies.status = 'pending'`.
// L'agence y voit : l'offre choisie, le montant à payer (installation + premier
// mois), les instructions de paiement, le formulaire de déclaration (réutilise
// `submit_payment_declaration` via PaymentSection), l'état de sa déclaration, et
// le motif de refus si l'administrateur en a saisi un.
// Elle peut changer d'offre tant que ce n'est pas validé.
// Le contrat n'est pas construit : un emplacement lui est réservé.
// =============================================================================
import { useState } from 'react';
import {
  AlertTriangle, BadgeCheck, Check, Clock3, FileText, Lock, LogOut,
  Sparkles, Wallet,
} from 'lucide-react';
import { PaymentSection } from '@/components/payment-panel';
import { Heading, LoadingRows, cash } from '@/lib/workspace-ui';
import { useAuth } from '@/lib/auth-context';
import { useAgency } from '@/lib/agency-context';
import { useAllPlans } from '@/lib/plan-limits';
import {
  usePendingState, useSelectPendingPlan, pendingDeclarationLabel, pendingErrorLabel,
} from '@/lib/pending-api';

export default function PendingValidationPage() {
  const { activeAgencyId } = useAgency();
  const { signOut } = useAuth();
  const state = usePendingState(activeAgencyId);
  const plans = useAllPlans();
  const selectPlan = useSelectPendingPlan(activeAgencyId);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);

  if (state.isLoading) {
    return (
      <>
        <Heading eyebrow="Mise en service" title="Agence en attente de validation" description="Chargement de votre dossier." />
        <LoadingRows label="Chargement de l’état de votre agence" />
      </>
    );
  }

  if (state.error) {
    return (
      <>
        <Heading eyebrow="Mise en service" title="Agence en attente de validation" description="Impossible de charger votre dossier." />
        <div className="notice-box is-error" role="alert" data-testid="status-pending-error">
          <AlertTriangle size={15} />
          <span>{pendingErrorLabel(state.error, 'charger l’état de votre agence')}</span>
        </div>
      </>
    );
  }

  const data = state.data;
  const chosen = data?.plan ?? null;
  const amount = Number(data?.amount_due ?? 0);
  const instructions = data?.payment_instructions ?? null;
  const declaration = data?.latest_declaration ?? null;
  const rejected = declaration?.status === 'rejected';
  const sortedPlans = [...(plans.data ?? [])].sort(
    (a, b) => Number(a.price_monthly) - Number(b.price_monthly),
  );

  const choosePlan = async (planId: string, label: string) => {
    setNotice('');
    setNoticeError(false);
    try {
      await selectPlan.mutateAsync(planId);
      setNotice(`Offre « ${label} » sélectionnée. Le montant à régler a été mis à jour.`);
    } catch (error) {
      setNoticeError(true);
      setNotice(pendingErrorLabel(error, 'changer l’offre choisie'));
    }
  };

  return (
    <div className="pending-page">
      <div className="pending-topbar">
        <div className="pending-brand">
          <span className="pending-brand-mark"><Clock3 size={16} /></span>
          <div>
            <strong>{data?.agency_name ?? 'Votre agence'}</strong>
            <small>Mise en service en attente de validation</small>
          </div>
        </div>
        <button
          type="button"
          className="button-link"
          onClick={() => void signOut()}
          data-testid="button-pending-sign-out"
        >
          <LogOut size={14} /> Se déconnecter
        </button>
      </div>

      <section className="panel pending-hero" data-testid="panel-pending-status">
        <div className="pending-hero-icon"><Clock3 size={22} /></div>
        <div>
          <h2>Votre agence est créée — il reste une étape</h2>
          <p>
            Choisissez une offre, réglez les frais d’installation et le premier mois,
            puis déclarez votre paiement ci-dessous. L’administrateur de la plateforme
            valide ensuite votre dossier : <strong>votre tableau de bord s’ouvrira
            automatiquement avec les fonctionnalités de votre offre</strong>.
          </p>
        </div>
        <span className="status-tag" data-testid="badge-pending-status">En attente de validation</span>
      </section>

      {data?.pending_note && (
        <div className="notice-box is-error" role="alert" data-testid="status-pending-rejected">
          <AlertTriangle size={15} />
          <span>
            <strong>Motif de l’administrateur :</strong> {data.pending_note}.
            Corrigez votre déclaration ou changez d’offre, puis soumettez à nouveau.
          </span>
        </div>
      )}

      {declaration && (
        <div className={`notice-box${rejected ? ' is-error' : ''}`} role="status" data-testid="status-pending-declaration">
          {rejected ? <AlertTriangle size={15} /> : <BadgeCheck size={15} />}
          <span>
            Dernière déclaration ({pendingDeclarationLabel(declaration.status)}) —{' '}
            {cash(Number(declaration.amount), 'XOF')} par {declaration.method === 'wave' ? 'Wave' : 'Orange Money'},
            référence {declaration.transaction_reference}.
            {declaration.review_note ? ` Motif : ${declaration.review_note}.` : ''}
          </span>
        </div>
      )}

      {notice && (
        <p
          className={`form-feedback${noticeError ? ' is-error' : ''}`}
          role={noticeError ? 'alert' : 'status'}
          data-testid="status-pending-notice"
        >
          {notice}
        </p>
      )}

      {/* --- Comparatif des 3 offres + montant à payer ---------------------- */}
      <section className="panel" data-testid="panel-pending-plans">
        <div className="panel-head">
          <div>
            <h2><Wallet size={17} /> Choisissez votre offre</h2>
            <p>Modifiable tant que votre dossier n’est pas validé</p>
          </div>
          <Sparkles size={18} />
        </div>

        {plans.isLoading ? (
          <LoadingRows label="Chargement des offres" />
        ) : plans.error ? (
          <div className="notice-box is-error" role="alert" data-testid="status-pending-plans-error">
            <AlertTriangle size={14} />
            <span>{pendingErrorLabel(plans.error, 'charger les offres')}</span>
          </div>
        ) : (
          <div className="plan-grid">
            {sortedPlans.map((plan) => {
              const isChosen = chosen?.id === plan.id;
              const total = Number(plan.setup_fee ?? 0) + Number(plan.price_monthly);
              return (
                <article
                  className={`plan-card${isChosen ? ' is-chosen' : ''}`}
                  key={plan.id}
                  data-testid={`plan-card-${plan.name}`}
                >
                  <header>
                    <strong>{plan.display_name ?? plan.name}</strong>
                    {isChosen && <span className="status-tag">Offre choisie</span>}
                  </header>
                  <p className="plan-price">
                    {cash(Number(plan.price_monthly), plan.currency)}
                    <small> / mois</small>
                  </p>
                  <p className="plan-setup">
                    Installation {cash(Number(plan.setup_fee ?? 0), plan.currency)} ·{' '}
                    <strong>à régler aujourd’hui {cash(total, plan.currency)}</strong>
                  </p>
                  <ul className="plan-features">
                    {(plan.modules ?? []).slice(0, 8).map((mod: string) => (
                      <li key={mod}><Check size={12} /> {mod.replace(/_/g, ' ')}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className={isChosen ? 'button-link' : 'button-link is-primary'}
                    onClick={() => void choosePlan(plan.id, plan.display_name ?? plan.name)}
                    disabled={isChosen || selectPlan.isPending}
                    aria-pressed={isChosen}
                    data-testid={`button-choose-plan-${plan.name}`}
                  >
                    {isChosen ? 'Offre actuelle' : selectPlan.isPending ? 'Enregistrement…' : 'Choisir cette offre'}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* --- Instructions de paiement + déclaration -------------------------- */}
      <section className="panel" data-testid="panel-pending-instructions">
        <div className="panel-head">
          <div>
            <h2>Instructions de paiement</h2>
            <p>
              {chosen
                ? `Montant à régler pour « ${chosen.display_name ?? chosen.name} » : ${cash(amount, chosen.currency)}`
                : 'Sélectionnez une offre pour connaître le montant'}
            </p>
          </div>
        </div>

        {instructions?.orange_money?.number || instructions?.wave?.number ? (
          <div className="instruction-grid">
            {instructions.orange_money?.number && (
              <div className="instruction-card" data-testid="card-instructions-orange">
                <strong>Orange Money</strong>
                <p className="instruction-number">{instructions.orange_money.number}</p>
                <p className="instruction-name">
                  Bénéficiaire : {instructions.orange_money.name || 'non renseigné'}
                </p>
              </div>
            )}
            {instructions.wave?.number && (
              <div className="instruction-card" data-testid="card-instructions-wave">
                <strong>Wave</strong>
                <p className="instruction-number">{instructions.wave.number}</p>
                <p className="instruction-name">
                  Bénéficiaire : {instructions.wave.name || 'non renseigné'}
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="notice-box" role="status" data-testid="status-instructions-missing">
            <AlertTriangle size={14} />
            <span>
              Les numéros de paiement n’ont pas encore été renseignés par
              l’administrateur (Admin → Réglages). Vous pouvez tout de même
              déclarer votre paiement avec la référence de votre transaction.
            </span>
          </div>
        )}

        {/* Réutilise submit_payment_declaration : aucun doublon de logique. */}
        <PaymentSection agencyId={activeAgencyId} />
      </section>

      {/* --- Emplacement réservé au contrat (non construit) ------------------ */}
      <section className="panel is-disabled" data-testid="panel-pending-contract">
        <div className="panel-head">
          <div>
            <h2><FileText size={17} /> Contrat</h2>
            <p>Emplacement réservé — sera ajouté dans une prochaine étape</p>
          </div>
          <Lock size={18} />
        </div>
        <p className="privacy-note-text">
          Le contrat d’abonnement sera présenté ici pour signature avant la mise en
          service. Rien à faire pour l’instant.
        </p>
      </section>

      <p className="pending-footnote" data-testid="status-pending-footnote">
        Votre tableau de bord reste fermé jusqu’à la validation. Vous pouvez fermer
        cette page et revenir plus tard : votre dossier est conservé.
      </p>
    </div>
  );
}
