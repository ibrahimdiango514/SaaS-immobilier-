// =============================================================================
// LOT 2 & LOT 3 — ÉCRAN D'AGENCE SUSPENDUE & RÉACTIVATION IMMÉDIATE SASPAY
// =============================================================================
// Affiché hors `AppShell` lorsque `activeAgency.status === 'suspended'` :
//   • Tous les modules métier (biens, contacts, pipeline, visites, WhatsApp, IA)
//     sont fermés côté interface ET côté base (RLS `is_agency_member`).
//   • Si `suspended_reason === 'unpaid'` (après expiration des 5 jours de grâce)
//     et que l'utilisateur est propriétaire / administrateur de l'agence :
//     bouton direct « Régulariser et réactiver immédiatement via SasPay »
//     (`purpose = 'reactivation'`).
//   • Dès confirmation serveur du paiement SasPay, l'agence repasse
//     automatiquement en `status = 'active'` sans intervention manuelle.
// =============================================================================
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  AlertTriangle, ArrowRight, Bell, CheckCircle2, CreditCard, LockKeyhole, LogOut,
  RefreshCw, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingRows, cash, dateLabel, dateTimeLabel } from '@/lib/workspace-ui';
import { useAuth } from '@/lib/auth-context';
import { useAgency } from '@/lib/agency-context';
import {
  ONLINE_PAYMENT_STATUS_LABELS,
  useAgencyOnlinePayments,
  useCreateSasPayCheckout,
  useSasPayRegularisationState,
} from '@/lib/saspay-api';
import {
  useAgencyNotificationsCenter,
  useAgencyNotificationsRealtime,
} from '@/lib/notifications-api';

export default function SuspendedAgencyPage() {
  const { activeAgency, activeAgencyId, canManageAgency } = useAgency();
  const { signOut } = useAuth();
  const queryClient = useQueryClient();
  useAgencyNotificationsRealtime(activeAgencyId);
  const regQ = useSasPayRegularisationState(activeAgencyId, Boolean(activeAgencyId));
  const onlineQ = useAgencyOnlinePayments(activeAgencyId);
  const notifsQ = useAgencyNotificationsCenter(activeAgencyId, { limit: 8 });
  const createCheckout = useCreateSasPayCheckout();
  const [payError, setPayError] = useState('');

  // Si l'agence a été réactivée (webhook SasPay ou validation admin), rafraîchir immédiatement
  useEffect(() => {
    if (regQ.data?.agency_status && regQ.data.agency_status !== 'suspended') {
      void queryClient.invalidateQueries({ queryKey: ['sofia'] });
      void queryClient.invalidateQueries({ queryKey: ['plan'] });
    }
  }, [regQ.data?.agency_status, queryClient]);

  const handleRefresh = async () => {
    setPayError('');
    await Promise.all([
      regQ.refetch(),
      onlineQ.refetch(),
      queryClient.invalidateQueries({ queryKey: ['sofia'] }),
      queryClient.invalidateQueries({ queryKey: ['plan'] }),
    ]);
  };

  const handleReactivateWithSasPay = async () => {
    if (!activeAgencyId) return;
    setPayError('');
    try {
      const session = await createCheckout.mutateAsync({
        agencyId: activeAgencyId,
        purpose: 'reactivation',
        invoiceId: regQ.data?.invoice_id ?? null,
      });
      window.location.assign(session.checkout_url);
    } catch (err) {
      setPayError((err as Error).message || 'Impossible d’ouvrir la session SasPay.');
    }
  };

  if (regQ.isLoading) {
    return (
      <div className="pending-page" data-testid="page-suspended-loading">
        <LoadingRows label="Vérification de la situation de votre abonnement" />
      </div>
    );
  }

  const info = regQ.data;
  const isUnpaidSuspension = !info?.suspended_reason || info.suspended_reason === 'unpaid';
  const amountDue = Number(info?.amount ?? info?.price_monthly ?? 0);
  const currency = info?.currency ?? 'XOF';
  const recentPayments = (onlineQ.data ?? []).slice(0, 5);

  return (
    <div className="pending-page" data-testid="page-suspended-agency">
      <div className="pending-topbar">
        <div className="pending-brand">
          <span className="pending-brand-mark"><LockKeyhole size={16} /></span>
          <div>
            <strong>{info?.agency_name ?? activeAgency?.name ?? 'Votre agence'}</strong>
            <small>
              {isUnpaidSuspension
                ? 'Accès temporairement suspendu — échéance mensuelle impayée'
                : 'Accès agence suspendu par l’administration'}
            </small>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={regQ.isFetching}
            data-testid="button-suspended-refresh"
          >
            <RefreshCw size={13} /> {regQ.isFetching ? 'Vérification…' : 'Vérifier mon accès'}
          </Button>
          <button
            type="button"
            className="button-link"
            onClick={() => void signOut()}
            data-testid="button-suspended-sign-out"
          >
            <LogOut size={14} /> Se déconnecter
          </button>
        </div>
      </div>

      <section className="panel pending-hero" data-testid="panel-suspended-hero">
        <div className="pending-hero-icon"><AlertTriangle size={22} /></div>
        <div>
          <h2>
            {isUnpaidSuspension
              ? 'Régularisez votre abonnement pour réactiver immédiatement votre agence'
              : 'Suspension administrative du compte agence'}
          </h2>
          <p>
            {isUnpaidSuspension ? (
              <>
                La période de grâce de 5 jours suivant votre échéance mensuelle est arrivée à son terme.
                Vos biens, contacts et historiques restent <strong>intégralement conservés</strong> : dès confirmation
                de votre paiement en ligne via SasPay, l’accès complet à votre tableau de bord est rétabli automatiquement.
              </>
            ) : (
              <>
                Votre agence fait l’objet d’une suspension administrative (motif :{' '}
                <strong>{info?.suspended_reason}</strong>). Contactez l’équipe Sofia Immobilier pour débloquer votre espace.
              </>
            )}
          </p>
        </div>
      </section>

      <div className="offer-layout" style={{ marginTop: 18 }}>
        <section className="panel" data-testid="panel-suspended-summary">
          <div className="panel-head">
            <div>
              <h2>Détail de l’échéance à régulariser</h2>
              <p>Calcul sécurisé côté serveur — aucun frais d’installation refacturé</p>
            </div>
            <CreditCard size={18} />
          </div>

          <div className="offer-facts" style={{ marginBottom: 16 }}>
            <div>
              <span>Offre souscrite</span>
              <strong>{info?.plan_name ?? '—'}</strong>
            </div>
            <div>
              <span>Montant mensuel à régler</span>
              <strong data-testid="text-suspended-amount">
                {amountDue > 0 ? cash(amountDue, currency) : '—'}
              </strong>
            </div>
            <div>
              <span>Échéance initiale</span>
              <strong>{info?.due_at ? dateLabel(info.due_at) : '—'}</strong>
            </div>
            <div>
              <span>Fin des 5 jours de grâce</span>
              <strong>{info?.grace_ends_at ? dateLabel(info.grace_ends_at) : '—'}</strong>
            </div>
            {info?.invoice_reference && (
              <div>
                <span>Référence facture</span>
                <strong className="mono">{info.invoice_reference}</strong>
              </div>
            )}
            {info?.suspended_at && (
              <div>
                <span>Suspendue le</span>
                <strong>{dateTimeLabel(info.suspended_at)}</strong>
              </div>
            )}
          </div>

          {canManageAgency && isUnpaidSuspension && info?.can_pay ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="notice-box" role="note" data-testid="note-saspay-fees-suspended">
                <ShieldCheck size={15} />
                <span>
                  Montant net facturé par Sofia Immobilier : <strong>{cash(amountDue, currency)}</strong>.
                  Les éventuels frais de transaction sont calculés par SasPay selon le moyen de paiement choisi
                  (Orange Money, Wave, carte bancaire, etc.). Votre agence est réactivée automatiquement dès confirmation.
                </span>
              </div>

              {payError && (
                <p className="form-error" role="alert" data-testid="status-suspended-pay-error">
                  {payError}
                </p>
              )}

              <div>
                <Button
                  type="button"
                  onClick={() => void handleReactivateWithSasPay()}
                  disabled={createCheckout.isPending || amountDue <= 0}
                  data-testid="button-saspay-reactivate"
                >
                  <CreditCard size={15} />{' '}
                  {createCheckout.isPending
                    ? 'Ouverture sécurisée de SasPay…'
                    : `Régulariser ${cash(amountDue, currency)} et réactiver mon agence`}{' '}
                  <ArrowRight size={15} />
                </Button>
              </div>
            </div>
          ) : !canManageAgency ? (
            <div className="permission-note" role="status" data-testid="status-suspended-member-readonly">
              <LockKeyhole size={15} />
              <span>
                Seul le propriétaire ou un administrateur de l’agence peut procéder au règlement de réactivation.
                Prévenez le responsable de votre agence afin qu’il régularise l’échéance.
              </span>
            </div>
          ) : null}
        </section>

        <section className="panel" data-testid="panel-suspended-sessions">
          <div className="panel-head">
            <div>
              <h2>Dernières tentatives de paiement en ligne</h2>
              <p>Suivi SasPay et vérification immédiate</p>
            </div>
            <CheckCircle2 size={18} />
          </div>

          {recentPayments.length === 0 ? (
            <p className="privacy-note-text">
              Aucune transaction en ligne enregistrée récemment pour cette agence.
            </p>
          ) : (
            <div className="plan-request-list">
              {recentPayments.map((op) => (
                <article className="plan-request-row" key={op.id} data-testid={`row-suspended-op-${op.id}`}>
                  <div className="plan-request-head">
                    <strong>{cash(Number(op.amount), op.currency)}</strong>
                    <span className="declaration-status">
                      {ONLINE_PAYMENT_STATUS_LABELS[op.status] ?? op.status}
                    </span>
                  </div>
                  <p className="plan-request-meta">
                    Initiée le {dateTimeLabel(op.created_at)}
                    {op.transaction_reference ? ` · Réf. ${op.transaction_reference}` : ''}
                  </p>
                  {op.status === 'pending' && (
                    <div style={{ marginTop: 8 }}>
                      <Link
                        href={`/paiement/retour?payment=${encodeURIComponent(op.id)}`}
                        className="button-link"
                        data-testid={`link-verify-suspended-op-${op.id}`}
                      >
                        <RefreshCw size={13} /> Vérifier cette transaction
                      </Link>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* LOT 4 — Historique des rappels et notifications récentes de l'agence */}
      {(notifsQ.data?.notifications ?? []).length > 0 && (
        <section className="panel" style={{ marginTop: 18 }} data-testid="panel-suspended-notifications">
          <div className="panel-head">
            <div>
              <h2>Historique de vos rappels & notifications (heure de Bamako)</h2>
              <p>Rappels d’échéance, période de grâce de 5 jours et avis de suspension</p>
            </div>
            <Bell size={18} />
          </div>
          <div className="plan-request-list">
            {(notifsQ.data?.notifications ?? []).map((item) => (
              <article
                className="plan-request-row"
                key={item.id}
                data-testid={`suspended-notif-${item.id}`}
              >
                <div className="plan-request-head">
                  <strong>{item.title}</strong>
                  <small>{dateTimeLabel(item.created_at)}</small>
                </div>
                <p className="plan-request-meta">{item.message}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
