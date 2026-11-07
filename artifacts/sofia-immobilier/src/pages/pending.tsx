// =============================================================================
// LOT 1 — ESPACE D'ATTENTE D'INSTALLATION PHYSIQUE & D'ACTIVATION ADMIN (AGENCE)
// =============================================================================
// Affiché tant que `agencies.status = 'pending'`.
// Garanties métier :
//   • Aucune demande prématurée de paiement d'abonnement en ligne ou manuel.
//   • Suivi transparent des 3 étapes :
//       1. Dossier & offre enregistrés,
//       2. Installation physique et règlement des frais d'installation sur site,
//       3. Activation par l'administrateur → ouverture automatique de 14 jours
//          d'essai gratuit avec 100 % des quotas et modules de l'offre choisie.
//   • Changement d'offre pendant `pending` réservé à l'administrateur lorsque
//     les frais d'installation changent (Décision métier 1).
// =============================================================================
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, BadgeCheck, Building2, Check, CheckCircle2, Clock3, LogOut,
  MapPin, Phone, RefreshCw, ShieldCheck, Sparkles, Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading, LoadingRows, cash, dateLabel, dateTimeLabel } from '@/lib/workspace-ui';
import { useAuth } from '@/lib/auth-context';
import { useAgency } from '@/lib/agency-context';
import {
  installationStatusLabel,
  pendingErrorLabel,
  physicalInstallationMethodLabel,
  usePendingState,
} from '@/lib/pending-api';

const MODULE_LABELS: Record<string, string> = {
  biens: 'Biens immobiliers',
  contacts: 'Prospects et contacts',
  pipeline: 'Pipeline commercial',
  dashboard: 'Tableau de bord',
  ca_chart: 'Graphique du CA',
  visites: 'Visites',
  visits: 'Visites',
  whatsapp: 'WhatsApp',
  automatisations: 'Automatisations',
  automations: 'Automatisations',
  assistant_ia: 'Assistant IA',
  assistant: 'Assistant IA',
  ca_filters: 'CA avec filtres',
  ca_export_csv: 'Export CSV du CA',
  stats: 'Statistiques avancées',
  rapports: 'Rapports mensuels',
  rapports_mensuels: 'Rapports mensuels',
  payments: 'Paiements',
  support: 'Support prioritaire',
};

const unlimited = (value?: number | null) => Number(value ?? 0) >= 1_000_000_000;

export default function PendingValidationPage() {
  const { activeAgencyId } = useAgency();
  const { signOut } = useAuth();
  const queryClient = useQueryClient();
  const state = usePendingState(activeAgencyId);

  // Bascule automatique dès que l'administrateur active l'agence (`status = 'trial'`)
  useEffect(() => {
    if (state.data?.found && state.data.is_pending === false) {
      void queryClient.invalidateQueries({ queryKey: ['sofia'] });
    }
  }, [state.data?.found, state.data?.is_pending, queryClient]);

  if (state.isLoading) {
    return (
      <>
        <Heading
          eyebrow="Mise en service"
          title="Dossier d’installation en cours"
          description="Chargement de l’état de mise en service de votre agence."
        />
        <LoadingRows label="Chargement de votre dossier d’agence" />
      </>
    );
  }

  if (state.error) {
    return (
      <>
        <Heading
          eyebrow="Mise en service"
          title="Dossier d’installation en cours"
          description="Impossible de charger votre dossier."
        />
        <div className="notice-box is-error" role="alert" data-testid="status-pending-error">
          <AlertTriangle size={15} />
          <span>{pendingErrorLabel(state.error, 'charger l’état de votre agence')}</span>
        </div>
      </>
    );
  }

  const data = state.data;
  const chosen = data?.plan ?? null;
  const currency = chosen?.currency ?? 'XOF';
  const setupFee = Number(data?.setup_fee ?? chosen?.setup_fee ?? 0);
  const monthlyAfterTrial = Number(data?.price_monthly_after_trial ?? chosen?.price_monthly ?? 0);
  const trialDays = Number(data?.trial_days ?? 14);
  const install = data?.installation ?? null;
  const installDone = install?.status === 'completed';
  const installPaidPending = install?.status === 'paid_pending_setup';

  const handleRefresh = async () => {
    await Promise.all([
      state.refetch(),
      queryClient.invalidateQueries({ queryKey: ['sofia'] }),
    ]);
  };

  return (
    <div className="pending-page">
      <div className="pending-topbar">
        <div className="pending-brand">
          <span className="pending-brand-mark"><Clock3 size={16} /></span>
          <div>
            <strong>{data?.agency_name ?? 'Votre agence'}</strong>
            <small>En attente d’installation physique et d’activation</small>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleRefresh()}
            disabled={state.isFetching}
            data-testid="button-pending-refresh"
          >
            <RefreshCw size={13} /> {state.isFetching ? 'Actualisation…' : 'Actualiser le statut'}
          </Button>
          <button
            type="button"
            className="button-link"
            onClick={() => void signOut()}
            data-testid="button-pending-sign-out"
          >
            <LogOut size={14} /> Se déconnecter
          </button>
        </div>
      </div>

      <section className="panel pending-hero" data-testid="panel-pending-status">
        <div className="pending-hero-icon"><Wrench size={22} /></div>
        <div>
          <h2>
            {installDone
              ? 'Installation physique enregistrée — activation imminente'
              : 'Votre dossier est enregistré — installation physique à suivre'}
          </h2>
          <p>
            {installDone ? (
              <>
                L’installation physique de votre agence a été validée par notre équipe. Dès que
                l’administrateur clique sur <strong>« Activer l’agence »</strong>, votre espace
                s’ouvrira automatiquement avec <strong>{trialDays} jours d’essai gratuit</strong> et
                l’intégralité des fonctionnalités de votre offre.
              </>
            ) : (
              <>
                Notre équipe Sofia Immobilier prend contact avec vous pour procéder à{' '}
                <strong>l’installation physique sur site</strong> et encaisser les frais
                d’installation correspondants. Dès la mise en service validée par l’administrateur,
                vos <strong>{trialDays} jours d’essai gratuit</strong> démarrent automatiquement.
              </>
            )}
          </p>
        </div>
        <span className="status-tag" data-testid="badge-pending-status">
          {installationStatusLabel(install?.status)}
        </span>
      </section>

      {data?.pending_note && (
        <div className="notice-box is-warning" role="status" data-testid="status-pending-admin-note">
          <AlertTriangle size={15} />
          <span>
            <strong>Message de l’administration Sofia :</strong> {data.pending_note}
          </span>
        </div>
      )}

      {/* --- Étapes du parcours d'activation -------------------------------- */}
      <section className="panel" data-testid="panel-pending-steps">
        <div className="panel-head">
          <div>
            <h2>Suivi de mise en service</h2>
            <p>Aucun paiement d’abonnement en ligne n’est demandé avant la fin de vos {trialDays} jours d’essai</p>
          </div>
          <ShieldCheck size={18} />
        </div>

        <div className="pending-admin-grid" style={{ marginTop: 8 }}>
          <div className="pending-admin-cell" data-testid="step-pending-1">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle2 size={14} /> Étape 1 · Validée
            </span>
            <strong>Dossier & offre enregistrés</strong>
            <small>
              {data?.pending_since ? `Enregistré le ${dateLabel(data.pending_since)}` : 'Dossier enregistré'}
              {chosen ? ` · Offre ${chosen.display_name ?? chosen.name}` : ''}
            </small>
          </div>

          <div className="pending-admin-cell" data-testid="step-pending-2">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {installDone ? <CheckCircle2 size={14} /> : <Wrench size={14} />}
              {installDone
                ? 'Étape 2 · Réalisée'
                : installPaidPending
                  ? 'Étape 2 · En cours de déploiement'
                  : 'Étape 2 · Intervention sur site'}
            </span>
            <strong>Installation physique ({cash(setupFee, currency)})</strong>
            <small>
              {installDone && install?.amount_collected != null ? (
                <>
                  Encaissé : {cash(Number(install.amount_collected), currency)} (
                  {physicalInstallationMethodLabel(install.payment_method)})
                  {install.receipt_reference ? ` · Reçu ${install.receipt_reference}` : ''}
                  {install.completed_at ? ` · le ${dateTimeLabel(install.completed_at)}` : ''}
                </>
              ) : installPaidPending && install?.amount_collected != null ? (
                <>
                  Frais reçus ({cash(Number(install.amount_collected), currency)}) · finalisation technique sur site
                </>
              ) : (
                <>Règlement physique sur site lors du déploiement par l’équipe Sofia (hors SasPay)</>
              )}
            </small>
          </div>

          <div className="pending-admin-cell" data-testid="step-pending-3">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={14} /> Étape 3 · Activation admin
            </span>
            <strong>{trialDays} jours d’essai gratuit complets</strong>
            <small>
              Accès à 100 % des quotas et modules de l’offre {chosen?.display_name ?? chosen?.name ?? ''},
              puis abonnement à {cash(monthlyAfterTrial, currency)} / mois à l’issue des {trialDays} jours.
            </small>
          </div>
        </div>
      </section>

      {/* --- Récapitulatif de l'offre retenue et des coordonnées ------------ */}
      <div className="offer-layout">
        <section className="panel" data-testid="panel-pending-chosen-plan">
          <div className="panel-head">
            <div>
              <h2><Sparkles size={17} /> Offre retenue pour votre agence</h2>
              <p>Quotas et modules intégralement inclus dès le 1er jour de votre essai de {trialDays} jours</p>
            </div>
          </div>

          {chosen ? (
            <>
              <div className="offer-facts" style={{ marginBottom: 14 }}>
                <div>
                  <span>Offre choisie</span>
                  <strong data-testid="text-pending-plan-name">{chosen.display_name ?? chosen.name}</strong>
                </div>
                <div>
                  <span>Frais d’installation physique</span>
                  <strong data-testid="text-pending-setup-fee">{cash(setupFee, currency)}</strong>
                </div>
                <div>
                  <span>Pendant les {trialDays} premiers jours</span>
                  <strong>0 FCFA (essai gratuit complet)</strong>
                </div>
                <div>
                  <span>Abonnement après l’essai</span>
                  <strong data-testid="text-pending-monthly-price">
                    {cash(monthlyAfterTrial, currency)} / mois
                  </strong>
                </div>
              </div>

              <ul className="plan-features" style={{ marginBottom: 14 }}>
                {chosen.max_properties != null && (
                  <li>
                    <Check size={13} />{' '}
                    {unlimited(chosen.max_properties)
                      ? 'Biens immobiliers illimités'
                      : `Jusqu’à ${chosen.max_properties} biens immobiliers actifs`}
                  </li>
                )}
                {chosen.max_members != null && (
                  <li>
                    <Check size={13} />{' '}
                    {unlimited(chosen.max_members)
                      ? 'Membres d’équipe illimités'
                      : `Jusqu’à ${chosen.max_members} membres d’équipe`}
                  </li>
                )}
                {chosen.monthly_agent_messages != null && (
                  <li>
                    <Check size={13} />{' '}
                    {Number(chosen.monthly_agent_messages).toLocaleString('fr-FR')} messages IA / mois
                  </li>
                )}
                {(chosen.modules ?? []).map((mod) => (
                  <li key={mod}>
                    <Check size={13} /> {MODULE_LABELS[mod] ?? mod.replace(/_/g, ' ')}
                  </li>
                ))}
              </ul>

              <div className="notice-box" role="note" data-testid="note-pending-plan-admin-only">
                <BadgeCheck size={15} />
                <span>
                  Vous souhaitez modifier l’offre retenue avant ou pendant vos {trialDays} jours d’essai ?
                  Par mesure de cohérence avec les frais d’installation physique, le changement d’offre
                  est effectué directement par l’administrateur Sofia Immobilier sur simple demande.
                </span>
              </div>
            </>
          ) : (
            <div className="notice-box is-warning" role="status">
              <AlertTriangle size={15} />
              <span>
                Aucune offre n’est encore rattachée à votre dossier. Notre administrateur associera
                l’offre retenue lors de votre installation.
              </span>
            </div>
          )}
        </section>

        <section className="panel" data-testid="panel-pending-agency-details">
          <div className="panel-head">
            <div>
              <h2><Building2 size={17} /> Coordonnées d’intervention</h2>
              <p>Informations transmises à l’équipe d’installation Sofia Immobilier</p>
            </div>
          </div>

          <div className="review-list">
            <div><span>Agence</span><strong>{data?.agency_name ?? '—'}</strong></div>
            {data?.legal_name && <div><span>Raison sociale</span><strong>{data.legal_name}</strong></div>}
            <div>
              <span><Phone size={12} style={{ display: 'inline', marginRight: 4 }} /> Téléphone</span>
              <strong>{data?.phone || 'Non renseigné'}</strong>
            </div>
            <div><span>E-mail</span><strong>{data?.email || 'Non renseigné'}</strong></div>
            <div>
              <span><MapPin size={12} style={{ display: 'inline', marginRight: 4 }} /> Localisation</span>
              <strong>{[data?.address, data?.city, data?.country].filter(Boolean).join(', ') || '—'}</strong>
            </div>
          </div>

          <div className="notice-box" style={{ marginTop: 14 }}>
            <ShieldCheck size={15} />
            <span>
              À l’issue de vos {trialDays} jours d’essai gratuit, vos échéances mensuelles pourront être
              réglées en ligne via <strong>SasPay</strong> (les frais éventuels de transaction dépendent
              du moyen de paiement choisi lors du règlement).
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
