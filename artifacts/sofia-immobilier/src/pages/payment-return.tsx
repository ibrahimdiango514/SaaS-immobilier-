// =============================================================================
// LOT 3 — PAGE DE RETOUR APRÈS PAIEMENT SASPAY (`/paiement/retour`)
// =============================================================================
// Vérifie côté serveur l'état réel de la session SasPay (`saspay-verify`),
// déclenche le rapprochement immédiat si la transaction vient d'aboutir,
// rafraîchit le contexte d'agence (réactivation automatique comprise) et
// propose une redirection claire vers le tableau de bord ou « Mon offre ».
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock3, CreditCard, LayoutDashboard,
  RefreshCw, ShieldCheck, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingRows, cash, dateLabel, dateTimeLabel } from '@/lib/workspace-ui';
import {
  ONLINE_PAYMENT_STATUS_LABELS,
  SASPAY_PURPOSE_LABELS,
  verifySasPayPaymentStatus,
  type SasPayVerifiedPaymentState,
} from '@/lib/saspay-api';

export default function PaymentReturnPage() {
  const queryClient = useQueryClient();
  const params = useMemo(() => {
    const sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    return {
      paymentId: sp.get('payment') ?? sp.get('payment_id'),
      sessionId: sp.get('session_id') ?? sp.get('session'),
      labSandbox: sp.get('lab_sandbox') === '1',
    };
  }, []);

  const [payment, setPayment] = useState<(SasPayVerifiedPaymentState & { lab_sandbox?: boolean }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const pollCountRef = useRef(0);

  const runVerification = useCallback(async (isInitial = false, labSimulate?: 'paid' | 'failed') => {
    if (!params.paymentId && !params.sessionId) {
      setError('Aucun identifiant de paiement n’a été transmis dans l’adresse de retour.');
      setLoading(false);
      return;
    }

    if (isInitial) setLoading(true);
    else setVerifying(true);
    setError('');

    try {
      const state = await verifySasPayPaymentStatus({
        paymentId: params.paymentId,
        sessionId: params.sessionId,
        labSimulate: labSimulate ?? null,
      });
      setPayment(state);

      if (state.status === 'paid') {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['sofia'] }),
          queryClient.invalidateQueries({ queryKey: ['plan'] }),
          queryClient.invalidateQueries({ queryKey: ['offre'] }),
          queryClient.invalidateQueries({ queryKey: ['saspay'] }),
          queryClient.invalidateQueries({ queryKey: ['paiements'] }),
        ]);
      }
    } catch (err) {
      setError((err as Error).message || 'Impossible de vérifier le statut du paiement.');
    } finally {
      setLoading(false);
      setVerifying(false);
    }
  }, [params.paymentId, params.sessionId, queryClient]);

  useEffect(() => {
    void runVerification(true);
  }, [runVerification]);

  // Polling automatique doux si la transaction est encore en cours de confirmation mobile money
  useEffect(() => {
    if (!payment || payment.status !== 'pending') return;
    if (pollCountRef.current >= 6) return;

    const timer = window.setTimeout(() => {
      pollCountRef.current += 1;
      void runVerification(false);
    }, 3500);

    return () => window.clearTimeout(timer);
  }, [payment, runVerification]);

  if (loading) {
    return (
      <div className="pending-page" data-testid="page-payment-return-loading">
        <div className="panel" style={{ maxWidth: 680, margin: '40px auto' }}>
          <span className="form-kicker">Paiement sécurisé SasPay</span>
          <h2>Vérification de votre transaction auprès de SasPay…</h2>
          <p className="privacy-note-text">
            Nous confirmons le règlement directement côté serveur afin de mettre à jour votre abonnement en toute sécurité.
          </p>
          <LoadingRows label="Confirmation du paiement en cours" />
        </div>
      </div>
    );
  }

  if (error || !payment) {
    return (
      <div className="pending-page" data-testid="page-payment-return-error">
        <section className="panel" style={{ maxWidth: 680, margin: '40px auto' }}>
          <div className="panel-head">
            <div>
              <span className="form-kicker">Paiement SasPay</span>
              <h2>Vérification momentanément indisponible</h2>
            </div>
            <AlertTriangle size={20} />
          </div>
          <p className="form-error" role="alert" data-testid="status-payment-return-error">
            {error || 'Paiement introuvable.'}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
            <Button type="button" onClick={() => void runVerification(true)} data-testid="button-retry-payment-verify">
              <RefreshCw size={14} /> Réessayer la vérification
            </Button>
            <Link href="/mon-offre" className="button-link" data-testid="link-return-to-offer">
              <Wallet size={14} /> Retour à Mon offre
            </Link>
          </div>
        </section>
      </div>
    );
  }

  const isPaid = payment.status === 'paid';
  const isPending = payment.status === 'pending';
  const isReactivation = payment.purpose === 'reactivation';
  const isPlanChange = payment.purpose === 'plan_change';

  return (
    <div className="pending-page" data-testid="page-payment-return">
      <section className="panel" style={{ maxWidth: 740, margin: '32px auto' }} data-testid={`panel-payment-status-${payment.status}`}>
        <div className="pending-hero" style={{ marginBottom: 18 }}>
          <div className="pending-hero-icon">
            {isPaid ? <CheckCircle2 size={24} /> : isPending ? <Clock3 size={24} /> : <AlertTriangle size={24} />}
          </div>
          <div>
            <span className="form-kicker">SasPay · {SASPAY_PURPOSE_LABELS[payment.purpose] ?? payment.purpose}</span>
            <h2 data-testid="heading-payment-return">
              {isPaid
                ? isReactivation
                  ? 'Paiement confirmé — votre agence est réactivée !'
                  : isPlanChange
                    ? `Paiement confirmé — votre offre ${payment.plan_name ?? ''} est active !`
                    : 'Paiement confirmé avec succès !'
                : isPending
                  ? 'Confirmation de paiement en attente'
                  : 'La transaction n’a pas abouti'}
            </h2>
            <p>
              {isPaid ? (
                <>
                  Votre règlement de <strong>{cash(Number(payment.amount), payment.currency)}</strong> pour{' '}
                  <strong>{payment.agency_name}</strong> a été vérifié côté serveur auprès de SasPay.
                  {isReactivation && ' Tous vos modules et accès métier sont immédiatement rétablis.'}
                </>
              ) : isPending ? (
                <>
                  Si vous venez de valider le paiement sur votre téléphone (Orange Money / Wave),
                  la confirmation arrive généralement en quelques secondes. Vous pouvez cliquer sur « Actualiser »
                  ou revenir plus tard : notre webhook SasPay mettra votre abonnement à jour automatiquement.
                </>
              ) : (
                <>
                  Statut renvoyé : <strong>{ONLINE_PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}</strong>.
                  Aucun débit validé n’a été imputé. Vous pouvez relancer une session de paiement depuis votre espace.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="offer-facts" style={{ marginBottom: 18 }}>
          <div>
            <span>Agence</span>
            <strong>{payment.agency_name}</strong>
          </div>
          <div>
            <span>Offre</span>
            <strong>{payment.plan_name ?? '—'}</strong>
          </div>
          <div>
            <span>Montant Sofia</span>
            <strong data-testid="text-payment-return-amount">{cash(Number(payment.amount), payment.currency)}</strong>
          </div>
          <div>
            <span>Statut</span>
            <strong data-testid="text-payment-return-status">
              {ONLINE_PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}
            </strong>
          </div>
          {payment.transaction_reference && (
            <div>
              <span>Référence SasPay</span>
              <strong className="mono">{payment.transaction_reference}</strong>
            </div>
          )}
          {payment.paid_at && (
            <div>
              <span>Confirmé le</span>
              <strong>{dateTimeLabel(payment.paid_at)}</strong>
            </div>
          )}
          {isPaid && payment.subscription_ends_at && (
            <div>
              <span>Prochaine échéance</span>
              <strong>{dateLabel(payment.subscription_ends_at)}</strong>
            </div>
          )}
        </div>

        <div className="notice-box" role="note" style={{ marginBottom: 18 }}>
          <ShieldCheck size={15} />
          <span>
            Sécurité anti-falsification active : chaque transaction est contrôlée serveur-à-serveur auprès de SasPay
            avant mise à jour de votre abonnement.
          </span>
        </div>

        {isPending && (payment.lab_sandbox || params.labSandbox) && (
          <div
            className="panel-card"
            style={{
              marginBottom: 18,
              padding: 16,
              borderLeft: '4px solid #0f766e',
            }}
            data-testid="panel-saspay-lab-simulator"
          >
            <strong style={{ display: 'block', marginBottom: 6 }}>
              Mode Test Sofia Immobilier Lab — Aucun encaissement réel (0 FCFA débité)
            </strong>
            <p className="privacy-note-text" style={{ marginBottom: 12 }}>
              Vous êtes sur l’environnement isolé <strong>Sofia Immobilier Lab</strong>. Simulez la réponse serveur SasPay pour tester la validation de facture, la prolongation d’échéance ou la réactivation immédiate de l’agence.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Button
                type="button"
                className="primary-action"
                disabled={verifying}
                onClick={() => void runVerification(false, 'paid')}
                data-testid="button-lab-simulate-paid"
              >
                <CheckCircle2 size={14} /> Simuler paiement SasPay confirmé (0 FCFA réel)
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={verifying}
                onClick={() => void runVerification(false, 'failed')}
                data-testid="button-lab-simulate-failed"
              >
                <AlertTriangle size={14} /> Simuler échec / abandon SasPay
              </Button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isPending && (
            <Button
              type="button"
              onClick={() => {
                pollCountRef.current = 0;
                void runVerification(false);
              }}
              disabled={verifying}
              data-testid="button-refresh-payment-return"
            >
              <RefreshCw size={14} /> {verifying ? 'Vérification auprès de SasPay…' : 'Actualiser le statut'}
            </Button>
          )}

          {isPaid ? (
            <>
              <Link href="/dashboard" className="primary-action" data-testid="link-payment-go-dashboard">
                <LayoutDashboard size={15} /> Ouvrir mon tableau de bord <ArrowRight size={14} />
              </Link>
              <Link href="/mon-offre" className="button-link" data-testid="link-payment-go-offer">
                <Wallet size={14} /> Voir mon offre et mes factures
              </Link>
            </>
          ) : (
            <Link
              href={payment.agency_status === 'suspended' ? '/dashboard' : '/mon-offre'}
              className="button-link"
              data-testid="link-payment-retry"
            >
              <CreditCard size={14} /> Retourner à l’espace de paiement
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
