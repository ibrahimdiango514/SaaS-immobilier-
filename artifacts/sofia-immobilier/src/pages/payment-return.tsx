// =============================================================================
// RETOUR DE PAIEMENT SASPAY — /paiement/retour?payment=<uuid>
// =============================================================================
// Appelée par la page SasPay après un paiement réussi (return_url), ou
// manuellement. La route est enregistrée AVANT le WorkspaceGate : une agence
// en attente de validation (dashboard fermé) doit pouvoir revenir ici après
// avoir payé ses frais d'installation.
//
// La page rapproche elle-même le statut côté SasPay (saspay-verify) : c'est le
// filet de sécurité si le webhook n'est jamais arrivé. Idempotent — re-vérifier
// un paiement déjà confirmé ne change rien.
// =============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  AlertTriangle, BadgeCheck, Clock3, CreditCard, Loader2, RefreshCw, ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { cash } from '@/lib/workspace-ui';
import {
  saspayErrorLabel, verifySaspayPayment, type SaspayPaymentState,
} from '@/lib/saspay-api';

function readPaymentId(): string {
  try {
    return new URLSearchParams(window.location.search).get('payment')?.trim() ?? '';
  } catch {
    return '';
  }
}

function purposeLabel(purpose?: string): string {
  switch (purpose) {
    case 'setup':
      return 'frais d’installation et premier mois';
    case 'invoice':
      return 'facture';
    case 'renewal':
      return 'renouvellement d’abonnement';
    default:
      return 'paiement';
  }
}

function failLabel(reason?: string | null): string {
  if (!reason) return 'Le paiement n’a pas abouti.';
  if (reason.startsWith('amount_mismatch')) {
    return 'Le montant reçu ne correspond pas au montant attendu : contactez l’administrateur de la plateforme.';
  }
  if (reason.startsWith('saspay_')) {
    const suffix = reason.replace('saspay_', '');
    if (suffix === 'failed') return 'La transaction a échoué côté opérateur. Aucun montant n’a été débité.';
    if (suffix === 'cancelled') return 'La transaction a été annulée.';
    if (suffix === 'expired') return 'La session de paiement a expiré sans paiement : relancez un paiement.';
  }
  if (reason === 'echec signale par SasPay') return 'La transaction a échoué. Aucun montant n’a été crédité.';
  return reason;
}

export default function PaymentReturnPage() {
  const { user, loading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const paymentId = useRef(readPaymentId()).current;
  const [state, setState] = useState<SaspayPaymentState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const check = useCallback(async () => {
    if (!paymentId) {
      setError('Adresse de retour incomplète : identifiant de paiement manquant.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await verifySaspayPayment({ paymentId });
      setState(result);
      if (result.found === false) setError('Paiement introuvable.');
    } catch (e) {
      setError(saspayErrorLabel(e, 'vérifier le paiement'));
    } finally {
      setBusy(false);
    }
  }, [paymentId]);

  useEffect(() => {
    if (started.current || authLoading || !user) return;
    started.current = true;
    void check();
  }, [authLoading, user, check]);

  const status = state?.found ? state.status : null;
  const paid = status === 'paid';

  return (
    <div className="pending-page" data-testid="panel-payment-return">
      <div className="pending-topbar">
        <div className="pending-brand">
          <span className="pending-brand-mark"><CreditCard size={16} /></span>
          <div>
            <strong>sofia immobilier</strong>
            <small>Confirmation de paiement</small>
          </div>
        </div>
        <Link href="/" className="button-link" data-testid="link-return-home">
          Retour au tableau de bord
        </Link>
      </div>

      <section className="panel pending-hero" data-testid="status-return-card">
        <div className="pending-hero-icon">
          {paid ? <BadgeCheck size={22} /> : status === 'failed' || status === 'expired' || status === 'cancelled'
            ? <AlertTriangle size={22} />
            : status === 'pending' ? <Clock3 size={22} /> : <CreditCard size={22} />}
        </div>
        <div>
          {authLoading || (!state && !error) ? (
            <>
              <h2 data-testid="status-return-loading">
                <Loader2 size={18} className="animate-spin" /> Vérification du paiement…
              </h2>
              <p>
                Nous confirmons votre transaction auprès de la passerelle. Ne fermez
                pas cette page.
              </p>
            </>
          ) : !user ? (
            <>
              <h2 data-testid="status-return-auth-required">Session expirée</h2>
              <p>
                Reconnectez-vous pour confirmer l’état de votre paiement. Votre
                paiement est conservé : il sera rapproché automatiquement.
              </p>
            </>
          ) : paid ? (
            <>
              <h2 data-testid="status-return-paid">Paiement confirmé</h2>
              <p>
                {state?.amount != null && (
                  <strong>
                    {cash(Number(state.amount), state.currency ?? 'XOF')} ·{' '}
                  </strong>
                )}
                {purposeLabel(state?.purpose)} réglé
                {state?.purpose === 'setup'
                  ? ' — votre dossier est transmis à l’administrateur de la plateforme, qui valide et ouvre votre tableau de bord.'
                  : state?.purpose === 'renewal'
                    ? ' — votre abonnement est prolongé d’un mois.'
                    : '.'}
              </p>
              {state?.transaction_reference && (
                <p className="privacy-note-text">
                  Référence : {state.transaction_reference}
                </p>
              )}
            </>
          ) : status === 'pending' ? (
            <>
              <h2 data-testid="status-return-pending">Paiement en cours de confirmation</h2>
              <p>
                La passerelle n’a pas encore confirmé la transaction. Elle peut
                falloir quelques secondes : réessayez, ou revenez plus tard — le
                rapprochement se fait automatiquement.
              </p>
            </>
          ) : status === 'failed' || status === 'expired' || status === 'cancelled' ? (
            <>
              <h2 data-testid="status-return-failed">Paiement non confirmé</h2>
              <p>{failLabel(state?.fail_reason)}</p>
            </>
          ) : (
            <>
              <h2 data-testid="status-return-error">Vérification impossible</h2>
              <p>{error || 'Le paiement est introuvable.'}</p>
            </>
          )}

          {error && (status === 'pending' || !state?.found) && (
            <p className="form-error" role="alert" data-testid="status-return-detail">{error}</p>
          )}
          {!user && (
            <p className="form-error" role="alert" data-testid="status-return-detail">
              Connectez-vous pour voir l’état du paiement.
            </p>
          )}
        </div>
        {status === 'pending' && <span className="status-tag" data-testid="badge-return-pending">En attente</span>}
        {paid && <span className="status-tag" data-testid="badge-return-paid">Payé</span>}
      </section>

      <div className="pending-admin-actions">
        {!user ? (
          <Button type="button" onClick={() => navigate('/login')} data-testid="button-return-login">
            Se connecter
          </Button>
        ) : (
          <Button
            type="button"
            variant={paid ? 'outline' : 'default'}
            onClick={() => void check()}
            disabled={busy}
            data-testid="button-return-retry"
          >
            <RefreshCw size={15} /> {busy ? 'Vérification…' : 'Vérifier à nouveau'}
          </Button>
        )}
        {paid && state?.purpose === 'setup' && (
          <Button type="button" variant="outline" onClick={() => navigate('/')} data-testid="button-return-track">
            Suivre mon dossier
          </Button>
        )}
      </div>

      {(status === 'failed' || status === 'expired' || status === 'cancelled') && (
        <p className="pending-footnote" data-testid="status-return-retry-hint">
          Vous pouvez relancer le paiement depuis la page d’attente ou votre offre —
          le paiement manuel Orange Money / Wave reste disponible.
        </p>
      )}
      {paid && (
        <p className="pending-footnote" data-testid="status-return-footnote">
          <ShieldAlert size={12} /> Un double paiement éventuel est bloqué par le
          serveur : cette confirmation ne peut être appliquée qu’une seule fois.
        </p>
      )}
    </div>
  );
}
