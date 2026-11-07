// =============================================================================
// LOT 2 & LOT 3 — PAGE « MON OFFRE, FACTURES & PAIEMENT SASPAY »
// =============================================================================
// • Compteurs complets du cycle LOT 2 :
//     - Essai gratuit 14j (J0 → J14, quotas complets)
//     - Période mensuelle active [J14 → E1] ou [En-1 → En] (accès complet même impayé)
//     - Période de grâce de 5 jours [E1 → E1 + 5j] (accès complet + compte à rebours)
// • Paiement en ligne sécurisé SasPay (LOT 3) :
//     - 1er mois post-essai ('first_subscription', ZÉRO frais d'installation)
//     - Renouvellement mensuel ('renewal')
//     - Montée d'offre immédiate au prorata calculé côté serveur ('plan_change')
// =============================================================================
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  AlertTriangle, ArrowRight, Bell, Building2, CalendarClock, Check, CheckCircle2,
  CreditCard, FileText, History, ImageIcon, Lock, RefreshCw, ShieldCheck, Sparkles,
  UsersRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  ErrorState, Heading, LoadingRows, useSafeRetry, cash, dateLabel,
  dateTimeLabel, formatDateTimeShort, safeFormat,
} from '@/lib/workspace-ui';
import { PaymentSection } from '@/components/payment-panel';
import { useAgencyAiUsage, compactNumber, whatsappStatusLabel } from '@/lib/usage-api';
import {
  useAgencyPlanState, usePlanChangeRequests, planChangeStatusLabel, useAllPlans,
  type PlanRow as SharedPlanRow,
} from '@/lib/plan-limits';
import {
  INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS, ONLINE_PAYMENT_STATUS_LABELS,
  SASPAY_PURPOSE_LABELS, useAgencyInvoices, useAgencyOnlinePayments,
  useCreateSasPayCheckout, usePlanUpgradePreview, type SasPayPurpose,
} from '@/lib/saspay-api';
import { BILLING_EVENT_LABELS, useAgencyBillingEvents } from '@/lib/notifications-api';
import { UsageGauge, WhatsAppBadge } from '@/components/usage-gauge';
import { useAgency } from '@/lib/agency-context';
import { getSupabaseClient, getSupabaseErrorMessage } from '@/lib/supabase';

interface UsagePlan {
  id: string;
  name: string;
  display_name: string;
  currency: string;
  setup_fee: number;
  price_monthly: number;
  max_members: number;
  max_properties: number;
  max_photos_per_property: number;
  monthly_agent_messages: number;
  monthly_follow_ups: number;
  modules: string[];
}

interface UsageSnapshot {
  plan: UsagePlan;
  seats: { seats_used: number; seats_limit: number; is_unlimited: boolean; invitations_pending: number };
  billing: {
    grace_days: number;
    is_overdue: boolean;
    is_due_soon: boolean;
    has_due_date: boolean;
    is_past_grace?: boolean;
    days_to_due?: number;
    ends_at?: string | null;
    sub_status?: string;
  };
  properties_used: number;
  properties_limit: number;
  photos_per_property_max: number;
  photos_per_property_limit: number;
}

type PlanRow = SharedPlanRow;

const MODULE_LABELS: Record<string, string> = {
  biens: 'Biens immobiliers',
  contacts: 'Prospects et contacts',
  pipeline: 'Pipeline commercial',
  dashboard: 'Tableau de bord',
  ca_chart: 'Graphique du CA',
  visits: 'Visites',
  whatsapp: 'WhatsApp',
  assistant: 'Assistant IA',
  automations: 'Automatisations',
  payments: 'Paiements',
};

const unlimited = (value: number) => value >= 1_000_000_000;

function useUsageSnapshot(agencyId?: string) {
  return useQuery({
    queryKey: ['offre', 'usage', agencyId],
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<UsageSnapshot> => {
      const { data, error } = await (getSupabaseClient() as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc('agency_usage_snapshot', { p_agency_id: agencyId as string });
      if (error) throw error;
      return data as UsageSnapshot;
    },
  });
}

function useRequestPlanChange(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; note: string }) => {
      const { data, error } = await (getSupabaseClient() as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc('request_plan_change', {
        p_agency_id: agencyId as string,
        p_plan_id: input.planId,
        p_note: input.note,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['offre'] });
    },
  });
}

function Meter({ label, used, limit, icon: Icon }: { label: string; used: number; limit: number; icon: typeof ImageIcon }) {
  const isUnlimited = unlimited(limit);
  const pct = isUnlimited ? 6 : Math.min(100, limit ? (used / limit) * 100 : 0);
  const full = !isUnlimited && used >= limit;
  return (
    <div className="usage-meter" data-testid={`meter-${label}`}>
      <div className="usage-meter-head">
        <span><Icon size={14} /> {label}</span>
        <strong data-testid={`text-${label}-count`}>
          {isUnlimited ? `${used} · illimité` : `${used}/${limit}`}
        </strong>
      </div>
      <div className="usage-bar" aria-hidden="true">
        <span className={full ? 'is-full' : ''} style={{ width: `${pct}%` }} />
      </div>
      {full && <p className="usage-limit-note">Limite atteinte.</p>}
    </div>
  );
}

function ProrataUpgradeDialog({
  open,
  onOpenChange,
  agencyId,
  targetPlan,
  isTrial,
  onRequestAdminChange,
  requestBusy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agencyId?: string;
  targetPlan: PlanRow | null;
  isTrial: boolean;
  onRequestAdminChange: (target: PlanRow) => Promise<void>;
  requestBusy: boolean;
}) {
  const previewQ = usePlanUpgradePreview(
    !isTrial ? agencyId : undefined,
    !isTrial && open ? (targetPlan?.id ?? null) : null,
  );
  const createCheckout = useCreateSasPayCheckout();
  const [error, setError] = useState('');

  const handlePayProrata = async () => {
    if (!agencyId || !targetPlan) return;
    setError('');
    try {
      const session = await createCheckout.mutateAsync({
        agencyId,
        purpose: 'plan_change',
        planId: targetPlan.id,
      });
      window.location.assign(session.checkout_url);
    } catch (err) {
      setError((err as Error).message || 'Impossible de lancer le paiement SasPay.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { setError(''); onOpenChange(next); }}>
      <DialogContent className="form-dialog" data-testid="dialog-prorata-upgrade">
        <DialogHeader>
          <span className="form-kicker">Changement d’offre</span>
          <DialogTitle>
            Passer à l’offre {targetPlan?.display_name ?? targetPlan?.name ?? ''}
          </DialogTitle>
          <DialogDescription>
            {isTrial
              ? 'Pendant les 14 jours d’essai gratuit, le changement d’offre est traité par l’administrateur (ajustement éventuel des frais d’installation physique).'
              : 'Le supplément est calculé automatiquement côté serveur au prorata exact des jours restants sur votre période mensuelle en cours.'}
          </DialogDescription>
        </DialogHeader>

        {isTrial && targetPlan ? (
          <div className="settings-form">
            <div className="notice-box" role="note">
              <ShieldCheck size={15} />
              <span>
                Nouvelle mensualité après essai :{' '}
                <strong>{cash(Number(targetPlan.price_monthly), targetPlan.currency)}</strong>/mois
                (frais d’installation catalogue : {cash(Number(targetPlan.setup_fee ?? 0), targetPlan.currency)}).
                Envoyez votre demande : l’administrateur ajustera votre offre immédiatement.
              </span>
            </div>
            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              <Button
                type="button"
                disabled={requestBusy}
                onClick={() => void onRequestAdminChange(targetPlan).then(() => onOpenChange(false))}
                data-testid="button-confirm-trial-plan-request"
              >
                {requestBusy ? 'Envoi…' : 'Transmettre à l’administrateur'}
              </Button>
            </div>
          </div>
        ) : previewQ.isLoading ? (
          <LoadingRows label="Calcul sécurisé du prorata en cours" />
        ) : previewQ.error ? (
          <p className="form-error" role="alert">{getSupabaseErrorMessage(previewQ.error, 'calculer le prorata')}</p>
        ) : previewQ.data && !previewQ.data.eligible ? (
          <div className="settings-form">
            <div className="notice-box is-warning" role="status" data-testid="status-upgrade-ineligible">
              <AlertTriangle size={15} />
              <span>{previewQ.data.reason}</span>
            </div>
            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Fermer
              </Button>
            </div>
          </div>
        ) : previewQ.data ? (
          <div className="settings-form">
            <div className="offer-facts">
              <div>
                <span>Offre actuelle</span>
                <strong>{previewQ.data.current_plan_name} ({cash(Number(previewQ.data.current_price_monthly ?? 0), previewQ.data.currency ?? 'XOF')}/mois)</strong>
              </div>
              <div>
                <span>Nouvelle offre</span>
                <strong>{previewQ.data.target_plan_name} ({cash(Number(previewQ.data.target_price_monthly ?? 0), previewQ.data.currency ?? 'XOF')}/mois)</strong>
              </div>
              <div>
                <span>Jours restants sur la période</span>
                <strong>{previewQ.data.days_remaining} / {previewQ.data.total_days} jour(s) (jusqu’au {previewQ.data.period_end ? dateLabel(previewQ.data.period_end) : '—'})</strong>
              </div>
              <div>
                <span>Prorata net à régler maintenant</span>
                <strong data-testid="text-upgrade-prorata-amount">
                  {cash(Number(previewQ.data.prorata_amount ?? 0), previewQ.data.currency ?? 'XOF')}
                </strong>
              </div>
            </div>

            <div className="notice-box" role="note">
              <ShieldCheck size={15} />
              <span>
                Activation immédiate dès confirmation SasPay. Les frais éventuels de transaction dépendent du moyen
                de paiement choisi côté SasPay (Orange Money, Wave, carte).
              </span>
            </div>

            {error && <p className="form-error" role="alert" data-testid="status-upgrade-saspay-error">{error}</p>}

            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Annuler
              </Button>
              <Button
                type="button"
                disabled={createCheckout.isPending}
                onClick={() => void handlePayProrata()}
                data-testid="button-pay-prorata-saspay"
              >
                <CreditCard size={15} />{' '}
                {createCheckout.isPending
                  ? 'Ouverture de SasPay…'
                  : `Payer ${cash(Number(previewQ.data.prorata_amount ?? 0), previewQ.data.currency ?? 'XOF')} avec SasPay`}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function MyOfferPage() {
  const { activeAgencyId, canManageAgency } = useAgency();
  const usage = useUsageSnapshot(activeAgencyId);
  const planStateQ = useAgencyPlanState(activeAgencyId);
  const invoicesQ = useAgencyInvoices(activeAgencyId);
  const onlinePaymentsQ = useAgencyOnlinePayments(activeAgencyId);
  const billingEventsQ = useAgencyBillingEvents(activeAgencyId, 20);
  const createCheckout = useCreateSasPayCheckout();
  const aiUsage = useAgencyAiUsage(activeAgencyId);
  const plans = useAllPlans();
  const requestChange = useRequestPlanChange(activeAgencyId);
  const planRequests = usePlanChangeRequests(activeAgencyId);

  const [notice, setNotice] = useState('');
  const [upgradeMessage, setUpgradeMessage] = useState('');
  const [upgradeFailed, setUpgradeFailed] = useState(false);
  const [saspayError, setSaspayError] = useState('');
  const [upgradeTarget, setUpgradeTarget] = useState<PlanRow | null>(null);

  if (!canManageAgency) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Mon offre" description="Offre active, limites et paiement." />
        <div className="permission-note" role="status" data-testid="status-offer-permission">
          <Lock size={15} />
          <span>
            L’offre, les factures, les paiements SasPay et la consommation de l’agence sont réservés au
            propriétaire et aux administrateurs. Votre rôle ne permet pas d’y accéder.
          </span>
        </div>
      </>
    );
  }

  if (usage.isLoading) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Mon offre" description="Offre active, cycle de facturation et paiement en ligne." />
        <LoadingRows label="Chargement de l’offre" />
      </>
    );
  }

  if (usage.error) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Mon offre" description="Offre active, cycle de facturation et paiement en ligne." />
        <ErrorState error={usage.error as Error} retry={useSafeRetry(usage)} />
      </>
    );
  }

  const snapshot = usage.data as UsageSnapshot;
  const { plan, seats, billing } = snapshot;
  const planState = planStateQ.data;
  const isTrial = planState?.state === 'trial';
  const isGrace = planState?.billing_phase === 'grace_period' || planState?.state === 'overdue';
  const hasOpenCycleInvoice =
    Boolean(planState?.open_invoice_id) &&
    ['first_subscription', 'renewal', 'reactivation'].includes(String(planState?.open_invoice_kind ?? ''));

  const included = new Set(plan.modules ?? []);
  const catalog = Array.from(new Set((plans.data ?? []).flatMap((row) => row.modules ?? [])));
  const locked = catalog.filter((key) => !included.has(key));
  const upgrades = (plans.data ?? []).filter((row) => row.price_monthly > plan.price_monthly);
  const plansById = new Map((plans.data ?? []).map((row) => [row.id, row]));
  const invoices = invoicesQ.data ?? [];
  const onlinePayments = onlinePaymentsQ.data ?? [];

  const askUpgrade = async (target: PlanRow) => {
    setNotice('');
    setUpgradeMessage('');
    setUpgradeFailed(false);
    try {
      await requestChange.mutateAsync({
        planId: target.id,
        note: `Demande depuis Mon offre : passage de ${plan.display_name} à ${target.display_name}.`,
      });
      setUpgradeMessage(
        `Demande de passage à ${target.display_name} transmise à l’administrateur. Elle apparaît ci-dessous avec son statut.`,
      );
      setNotice(`Demande de passage à ${target.display_name} envoyée à l’administrateur.`);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      setUpgradeFailed(true);
      setUpgradeMessage(
        `${getSupabaseErrorMessage(error, 'envoyer la demande')}${code ? ` (code ${code})` : ''}`,
      );
    }
  };

  const launchSasPay = async (purpose: SasPayPurpose | 'invoice', invoiceId?: string | null) => {
    if (!activeAgencyId) return;
    setSaspayError('');
    try {
      const session = await createCheckout.mutateAsync({
        agencyId: activeAgencyId,
        purpose,
        invoiceId: invoiceId ?? null,
      });
      window.location.assign(session.checkout_url);
    } catch (err) {
      setSaspayError((err as Error).message || 'Impossible de démarrer le paiement SasPay.');
    }
  };

  const primaryPurpose: SasPayPurpose =
    planState?.open_invoice_kind === 'first_subscription'
      ? 'first_subscription'
      : 'renewal';
  const primaryAmount = Number(planState?.open_invoice_amount ?? plan.price_monthly ?? 0);

  return (
    <>
      {isGrace && (
        <div className="offer-alert is-overdue" role="status" data-testid="banner-due-alert">
          <AlertTriangle size={17} />
          <div>
            <strong>
              Période de grâce ({planState?.grace_days ?? billing.grace_days ?? 5} jours) —{' '}
              {planState?.grace_days_left ?? 1} jour(s) restant(s) avant suspension automatique
            </strong>
            <p>
              Vos accès complets au tableau de bord et à vos quotas restent maintenus jusqu’au{' '}
              <strong>{planState?.grace_ends_at ? dateLabel(planState.grace_ends_at) : 'terme du délai de grâce'}</strong>.
              Réglez votre facture mensuelle via SasPay ci-dessous pour conserver un service ininterrompu.
            </p>
          </div>
        </div>
      )}

      {!isGrace && billing.has_due_date && billing.is_due_soon && !planState?.is_current_period_paid && (
        <div className="offer-alert" role="status" data-testid="banner-due-soon-alert">
          <CalendarClock size={17} />
          <div>
            <strong>Échéance mensuelle proche</strong>
            <p>
              Votre période en cours arrive à échéance le{' '}
              <strong>{planState?.ends_at ? dateLabel(planState.ends_at) : (billing.ends_at ? dateLabel(billing.ends_at) : '—')}</strong>.
              Réglez dès maintenant en ligne avec SasPay.
            </p>
          </div>
        </div>
      )}

      <Heading
        eyebrow="Abonnement & Facturation (Heure de Bamako)"
        title="Mon offre"
        description="Cycle d’abonnement, paiement sécurisé SasPay, factures mensuelles et utilisation de vos quotas."
        action={
          <Link
            href="/notifications"
            className="button-link"
            data-testid="link-offer-to-notifications"
          >
            <Bell size={15} /> Centre de notifications & rappels
          </Link>
        }
      />

      <div className="offer-layout">
        {/* CARTE 1 : Offre active, compteurs du cycle LOT 2 & Paiement SasPay LOT 3 */}
        <section className="panel offer-current" data-testid="panel-current-offer">
          <div className="offer-plan-head">
            <div className="offer-plan-mark"><Sparkles size={20} /></div>
            <div>
              <span className="form-kicker">
                {isTrial
                  ? `Essai gratuit · ${planState?.trial_days_left ?? 0} jour(s) restant(s)`
                  : isGrace
                    ? `En période de grâce · ${planState?.grace_days_left ?? 1} j restant(s)`
                    : planState?.is_current_period_paid
                      ? 'Abonnement actif · période réglée'
                      : 'Abonnement actif · période en cours'}
              </span>
              <h2 data-testid="text-plan-name">{plan.display_name}</h2>
              <p className="offer-price" data-testid="text-plan-price">
                {cash(Number(plan.price_monthly), plan.currency)} <span>/ mois</span>
              </p>
            </div>
          </div>

          <div className="offer-facts">
            {isTrial ? (
              <>
                <div>
                  <span>Début de l’essai</span>
                  <strong>{planState?.starts_at ? dateLabel(planState.starts_at) : '—'}</strong>
                </div>
                <div>
                  <span>Fin des 14 jours d’essai</span>
                  <strong data-testid="text-trial-ends-at">
                    {planState?.trial_ends_at ? dateLabel(planState.trial_ends_at) : '—'}
                  </strong>
                </div>
                <div>
                  <span>Quotas pendant l’essai</span>
                  <strong>100 % complets ({plan.display_name})</strong>
                </div>
                <div>
                  <span>1re mensualité (à la fin de l’essai)</span>
                  <strong>{cash(Number(plan.price_monthly), plan.currency)} (0 frais d’installation)</strong>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span>Période mensuelle en cours</span>
                  <strong>
                    {planState?.current_period_start ? dateLabel(planState.current_period_start) : '—'}
                    {' → '}
                    {planState?.current_period_end ? dateLabel(planState.current_period_end) : (billing.ends_at ? dateLabel(billing.ends_at) : '—')}
                  </strong>
                </div>
                <div>
                  <span>Prochaine échéance</span>
                  <strong data-testid="text-next-due-date">
                    {planState?.ends_at
                      ? `${dateLabel(planState.ends_at)}${planState.days_to_due != null && planState.days_to_due >= 0 ? ` (dans ${planState.days_to_due} j)` : ''}`
                      : (billing.ends_at ? dateLabel(billing.ends_at) : '—')}
                  </strong>
                </div>
                <div>
                  <span>Statut de la période</span>
                  <strong data-testid="text-period-payment-state">
                    {planState?.is_current_period_paid
                      ? `Payée jusqu’au ${planState.paid_through_at ? dateLabel(planState.paid_through_at) : ''}`
                      : isGrace
                        ? `En grâce jusqu’au ${planState?.grace_ends_at ? dateLabel(planState.grace_ends_at) : ''}`
                        : 'Facture mensuelle ouverte (accès 100 % actif)'}
                  </strong>
                </div>
                <div>
                  <span>Délai de grâce après échéance</span>
                  <strong>{planState?.grace_days ?? billing.grace_days ?? 5} jours (accès complet maintenu)</strong>
                </div>
              </>
            )}
          </div>

          {/* BLOC PAIEMENT EN LIGNE SASPAY */}
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }} data-testid="box-saspay-primary">
            {isTrial ? (
              <div className="notice-box" role="note" data-testid="note-trial-no-payment-due">
                <CheckCircle2 size={15} />
                <span>
                  Aucun paiement n’est demandé pendant vos 14 jours d’essai gratuit. Le{' '}
                  <strong>{planState?.trial_ends_at ? dateLabel(planState.trial_ends_at) : 'jour J14'}</strong>, votre
                  1er mois d’abonnement démarrera automatiquement et votre facture mensuelle de{' '}
                  <strong>{cash(Number(plan.price_monthly), plan.currency)}</strong> (sans aucun frais d’installation)
                  pourra être réglée ici via SasPay.
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="notice-box" role="note" data-testid="note-saspay-fee-policy">
                  <ShieldCheck size={15} />
                  <span>
                    Paiement en ligne sécurisé via <strong>SasPay</strong> (Orange Money, Wave, carte). Sofia facture
                    uniquement le montant net de votre offre ; les frais éventuels de transaction dépendent du moyen
                    de paiement choisi côté SasPay.
                  </span>
                </div>

                {saspayError && (
                  <p className="form-error" role="alert" data-testid="status-saspay-checkout-error">
                    {saspayError}
                  </p>
                )}

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  {hasOpenCycleInvoice ? (
                    <Button
                      type="button"
                      className="w-full whitespace-normal h-auto py-2.5 text-center leading-snug"
                      onClick={() => void launchSasPay(primaryPurpose, planState?.open_invoice_id)}
                      disabled={createCheckout.isPending}
                      data-testid="button-saspay-pay-open-invoice"
                    >
                      <CreditCard size={15} />{' '}
                      {createCheckout.isPending
                        ? 'Ouverture de SasPay…'
                        : isGrace
                          ? `Régulariser ${cash(primaryAmount, plan.currency)} avec SasPay`
                          : `Payer ma facture (${cash(primaryAmount, plan.currency)}) avec SasPay`}{' '}
                      <ArrowRight size={14} />
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full whitespace-normal h-auto py-2.5 text-center leading-snug"
                      onClick={() => void launchSasPay('renewal', null)}
                      disabled={createCheckout.isPending}
                      data-testid="button-saspay-advance-renewal"
                    >
                      <CreditCard size={15} />{' '}
                      {createCheckout.isPending
                        ? 'Ouverture de SasPay…'
                        : `Renouveler 1 mois d’avance (${cash(Number(plan.price_monthly), plan.currency)}) via SasPay`}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* CARTE 2 : Utilisation des quotas */}
        <section className="panel" data-testid="panel-usage">
          <div className="panel-head">
            <div><h2>Utilisation</h2><p>Par rapport aux limites de votre offre</p></div>
            <Building2 size={18} />
          </div>
          <Meter label="biens" used={snapshot.properties_used} limit={snapshot.properties_limit} icon={Building2} />
          <Meter label="utilisateurs" used={seats.seats_used} limit={seats.seats_limit} icon={UsersRound} />
          <Meter label="photos" used={snapshot.photos_per_property_max} limit={snapshot.photos_per_property_limit} icon={ImageIcon} />
          <p className="usage-caption">
            « photos » = maximum atteint sur un seul bien.
            {seats.invitations_pending > 0 && ` ${seats.invitations_pending} invitation(s) en attente déjà comptée(s).`}
          </p>
        </section>

        {/* CARTE 3 : Consommation IA & WhatsApp */}
        <section className="panel ai-usage-panel" data-testid="panel-ai-usage">
          <div className="panel-head">
            <div>
              <h2>Utilisation IA ce mois</h2>
              <p>
                {aiUsage.data?.period_start
                  ? `Période du ${safeFormat(aiUsage.data.period_start, { month: 'long', year: 'numeric' })}`
                  : 'Période en cours'}
                {' · '}alerte à 80 % puis à 100 % du quota de votre offre.
              </p>
            </div>
            <Sparkles size={18} />
          </div>

          {aiUsage.isLoading && <p className="form-hint">Chargement des compteurs IA…</p>}
          {aiUsage.error && (
            <p className="form-error" role="alert" data-testid="status-ai-usage-error">
              {getSupabaseErrorMessage(aiUsage.error, 'charger l’utilisation IA')}
            </p>
          )}

          {aiUsage.data && (
            <>
              <div className="ai-gauges">
                <UsageGauge
                  label="Tokens IA"
                  used={aiUsage.data.usage.ai_tokens_total}
                  limit={aiUsage.data.plan.monthly_ai_tokens}
                  ratio={aiUsage.data.ratios.ai_tokens}
                  alert={aiUsage.data.alerts.ai_tokens}
                  testId="ai-tokens"
                />
                <UsageGauge
                  label="Messages"
                  used={aiUsage.data.usage.messages_count}
                  limit={aiUsage.data.plan.monthly_agent_messages}
                  ratio={aiUsage.data.ratios.messages}
                  alert={aiUsage.data.alerts.messages}
                  testId="ai-messages"
                />
                <UsageGauge
                  label="Conversations"
                  used={aiUsage.data.usage.conversations_count}
                  limit={aiUsage.data.plan.monthly_conversations}
                  ratio={aiUsage.data.ratios.conversations}
                  alert={aiUsage.data.alerts.conversations}
                  testId="ai-conversations"
                />
              </div>

              <p className="usage-caption" data-testid="text-ai-requests">
                {aiUsage.data.usage.ai_requests_count} requête(s) IA ce mois ·{' '}
                {compactNumber(aiUsage.data.usage.ai_tokens_input)} tokens en entrée,{' '}
                {compactNumber(aiUsage.data.usage.ai_tokens_output)} en sortie.
              </p>

              <div className="ai-whatsapp">
                <h3>Canal WhatsApp</h3>
                {aiUsage.data.whatsapp.length ? (
                  <div className="ai-whatsapp-list">
                    {aiUsage.data.whatsapp.map((connection) => (
                      <div key={connection.id} data-testid={`row-my-whatsapp-${connection.id}`}>
                        <WhatsAppBadge
                          providerLabel={connection.provider_label}
                          official={connection.official}
                          status={whatsappStatusLabel(connection.status)}
                          phoneNumber={connection.phone_number}
                          testId={connection.id}
                        />
                        <small>
                          Dernière activité :{' '}
                          {connection.last_activity_at
                            ? formatDateTimeShort(connection.last_activity_at)
                            : 'jamais'}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="usage-caption">
                    Aucun canal WhatsApp connecté. Votre offre {aiUsage.data.plan.display_name ?? ''} inclut{' '}
                    {aiUsage.data.plan.max_whatsapp_connections ?? 0} canal(aux).
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        {/* CARTE 4 : Modules & Montée d'offre (Prorata SasPay en actif / Admin en essai) */}
        <section className="panel" data-testid="panel-modules">
          <div className="panel-head">
            <div><h2>Modules & Évolution d’offre</h2><p>Inclus dans {plan.display_name}, et offres supérieures</p></div>
            <Check size={18} />
          </div>
          <div className="module-list">
            {catalog.map((key) => {
              const isIncluded = included.has(key);
              return (
                <div className={`module-row${isIncluded ? '' : ' is-locked'}`} key={key} data-testid={`module-${key}`}>
                  {isIncluded ? <Check size={14} /> : <Lock size={14} />}
                  <span>{MODULE_LABELS[key] ?? key}</span>
                  {!isIncluded && <em>Non inclus</em>}
                </div>
              );
            })}
          </div>

          {canManageAgency && upgrades.length > 0 && (
            <div className="upgrade-block">
              <p className="privacy-note-text">
                {isTrial
                  ? 'En période d’essai gratuit (14j), le changement d’offre passe par l’administrateur.'
                  : `${locked.length > 0 ? `${locked.length} module(s) supplémentaire(s) déblocable(s) immédiatement. ` : ''}Passez à une offre supérieure au prorata exact via SasPay :`}
              </p>
              <div className="upgrade-options">
                {upgrades.map((target) => (
                  <button
                    type="button"
                    key={target.id}
                    className="button-link"
                    onClick={() => setUpgradeTarget(target)}
                    disabled={requestChange.isPending || createCheckout.isPending}
                    data-testid={`button-upgrade-${target.name}`}
                  >
                    <Sparkles size={14} />
                    {isTrial
                      ? ` Demander l’offre ${target.display_name}`
                      : ` Passer au ${target.display_name} (prorata SasPay)`}
                  </button>
                ))}
              </div>
              {upgradeMessage && (
                <p
                  className={`form-feedback${upgradeFailed ? ' is-error' : ''}`}
                  role={upgradeFailed ? 'alert' : 'status'}
                  data-testid="status-upgrade-request"
                >
                  {upgradeMessage}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      {/* SECTION FACTURES D'ABONNEMENT (LOT 2) */}
      <section className="panel" data-testid="panel-agency-invoices">
        <div className="panel-head">
          <div>
            <h2>Mes factures d’abonnement</h2>
            <p>1re mensualité post-essai, renouvellements mensuels et devis de montée d’offre (hors frais d’installation physique)</p>
          </div>
          <FileText size={18} />
        </div>

        {invoicesQ.isLoading ? (
          <LoadingRows label="Chargement de vos factures" />
        ) : invoices.length === 0 ? (
          <p className="privacy-note-text" data-testid="status-invoices-empty">
            {isTrial
              ? `Aucune facture émise pendant vos 14 jours d’essai gratuit. Votre première facture mensuelle (${cash(Number(plan.price_monthly), plan.currency)}) sera générée automatiquement le ${planState?.trial_ends_at ? dateLabel(planState.trial_ends_at) : 'J14'}.`
              : 'Aucune facture d’abonnement enregistrée pour le moment.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Type</th>
                  <th>Période</th>
                  <th>Montant</th>
                  <th>Échéance</th>
                  <th>Statut</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} data-testid={`row-invoice-${inv.id}`}>
                    <td className="mono">{inv.reference ?? '—'}</td>
                    <td>
                      <strong>{INVOICE_KIND_LABELS[inv.invoice_kind] ?? inv.invoice_kind}</strong>
                      {inv.plan_to_name && <small style={{ display: 'block' }}>{inv.plan_to_name}</small>}
                    </td>
                    <td>
                      {inv.period_start ? dateLabel(inv.period_start) : '—'}
                      {inv.period_end ? ` → ${dateLabel(inv.period_end)}` : ''}
                    </td>
                    <td><strong>{cash(Number(inv.amount), inv.currency)}</strong></td>
                    <td>
                      {inv.due_at ? dateLabel(inv.due_at) : '—'}
                      {inv.status === 'pending' && inv.grace_ends_at && inv.invoice_kind !== 'plan_change' && (
                        <small style={{ display: 'block' }}>Grâce : {dateLabel(inv.grace_ends_at)}</small>
                      )}
                    </td>
                    <td>
                      <span className={`status-pill status-${inv.status === 'paid' ? 'available' : inv.status === 'pending' ? 'reserved' : 'unavailable'}`}>
                        {INVOICE_STATUS_LABELS[inv.status] ?? inv.status}
                      </span>
                    </td>
                    <td>
                      {inv.status === 'pending' ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={createCheckout.isPending}
                          onClick={() => void launchSasPay('invoice', inv.id)}
                          data-testid={`button-pay-invoice-${inv.id}`}
                        >
                          <CreditCard size={13} /> Payer via SasPay
                        </Button>
                      ) : inv.paid_at ? (
                        <small>Réglée le {dateLabel(inv.paid_at)}</small>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* SECTION TRANSACTIONS EN LIGNE SASPAY (LOT 3) */}
      <section className="panel" data-testid="panel-agency-online-payments">
        <div className="panel-head">
          <div>
            <h2>Transactions en ligne SasPay</h2>
            <p>Suivi en temps réel de vos sessions de paiement et vérification instantanée</p>
          </div>
          <CreditCard size={18} />
        </div>

        {onlinePaymentsQ.isLoading ? (
          <LoadingRows label="Chargement des transactions SasPay" />
        ) : onlinePayments.length === 0 ? (
          <p className="privacy-note-text" data-testid="status-online-payments-empty">
            Aucune session de paiement SasPay initiée pour le moment.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Motif</th>
                  <th>Offre</th>
                  <th>Montant</th>
                  <th>Statut</th>
                  <th>Référence SasPay</th>
                  <th>Suivi</th>
                </tr>
              </thead>
              <tbody>
                {onlinePayments.map((op) => (
                  <tr key={op.id} data-testid={`row-online-payment-${op.id}`}>
                    <td>{dateTimeLabel(op.created_at)}</td>
                    <td>{SASPAY_PURPOSE_LABELS[op.purpose] ?? op.purpose}</td>
                    <td>{op.plan_name ?? '—'}</td>
                    <td><strong>{cash(Number(op.amount), op.currency)}</strong></td>
                    <td>
                      <span className={`status-pill status-${op.status === 'paid' ? 'available' : op.status === 'pending' ? 'reserved' : 'unavailable'}`}>
                        {ONLINE_PAYMENT_STATUS_LABELS[op.status] ?? op.status}
                      </span>
                    </td>
                    <td className="mono">{op.transaction_reference ?? '—'}</td>
                    <td>
                      <Link
                        href={`/paiement/retour?payment=${encodeURIComponent(op.id)}`}
                        className="button-link"
                        data-testid={`link-verify-payment-${op.id}`}
                      >
                        <RefreshCw size={13} /> {op.status === 'pending' ? 'Vérifier' : 'Détail'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* SUIVI DES DEMANDES ADMINISTRATIVES DE CHANGEMENT D'OFFRE */}
      {(planRequests.data ?? []).length > 0 && (
        <section className="panel" data-testid="panel-plan-requests">
          <div className="panel-head">
            <div>
              <h2>Mes demandes administratives de changement d’offre</h2>
              <p>Historique des demandes traitées par l’équipe Sofia Immobilier</p>
            </div>
            <Sparkles size={18} />
          </div>
          <div className="plan-request-list">
            {(planRequests.data ?? []).map((row) => {
              const requested = plansById.get(row.requested_plan_id);
              const current = row.current_plan_id ? plansById.get(row.current_plan_id) : undefined;
              const statusClass =
                row.status === 'approved' ? 'is-approved' : row.status === 'rejected' ? 'is-rejected' : 'is-pending';
              return (
                <article className={`plan-request-row ${statusClass}`} key={row.id} data-testid={`row-plan-request-${row.status}`}>
                  <div className="plan-request-head">
                    <strong>
                      {current ? `${current.display_name ?? current.name} → ` : ''}
                      {requested?.display_name ?? requested?.name ?? 'Offre demandée'}
                    </strong>
                    <span className={`declaration-status ${statusClass}`}>
                      {planChangeStatusLabel(row.status)}
                    </span>
                  </div>
                  <p className="plan-request-meta">
                    Demandée le {dateLabel(row.created_at)}
                    {row.handled_at ? ` · traitée le ${dateLabel(row.handled_at)}` : ''}
                  </p>
                  {row.handle_note && (
                    <p className="plan-request-note">
                      <strong>Note de l’administrateur :</strong> {row.handle_note}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* LOT 4 — HISTORIQUE CHRONOLOGIQUE DES ÉVÉNEMENTS DE FACTURATION */}
      <section className="panel" data-testid="panel-billing-events-timeline">
        <div className="panel-head">
          <div>
            <h2>Historique des événements d’abonnement</h2>
            <p>Traçabilité horodatée (heure de Bamako) de votre essai, vos factures, vos paiements SasPay et vos changements d’offre</p>
          </div>
          <History size={18} />
        </div>
        {(billingEventsQ.data ?? []).length === 0 ? (
          <p className="privacy-note-text">
            Aucun événement de cycle enregistré pour le moment.
          </p>
        ) : (
          <div className="plan-request-list">
            {(billingEventsQ.data ?? []).slice(0, 10).map((ev) => (
              <article
                className="plan-request-row"
                key={ev.id}
                data-testid={`offer-billing-event-${ev.id}`}
              >
                <div className="plan-request-head">
                  <strong>{BILLING_EVENT_LABELS[ev.event_type] ?? ev.event_type}</strong>
                  {typeof ev.amount === 'number' && ev.amount > 0 && (
                    <span className="declaration-status is-approved">
                      {cash(ev.amount, 'XOF')}
                    </span>
                  )}
                </div>
                <p className="plan-request-meta">
                  {dateTimeLabel(ev.created_at)}
                  {ev.invoice_reference ? ` · Facture ${ev.invoice_reference}` : ''}
                  {ev.plan_to_name ? ` · Offre ${ev.plan_to_name}` : ''}
                </p>
                {ev.reason && <p className="plan-request-note">{ev.reason}</p>}
              </article>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <Link href="/notifications" className="text-action" data-testid="link-full-billing-history">
            Consulter tout l’historique & les rappels dans le Centre de notifications <ArrowRight size={13} />
          </Link>
        </div>
      </section>

      {/* REPLI MANUEL : Déclaration de paiement Orange Money / Wave avec justificatif */}
      <PaymentSection agencyId={activeAgencyId} />

      <ProrataUpgradeDialog
        open={Boolean(upgradeTarget)}
        onOpenChange={(next) => { if (!next) setUpgradeTarget(null); }}
        agencyId={activeAgencyId}
        targetPlan={upgradeTarget}
        isTrial={Boolean(isTrial)}
        onRequestAdminChange={askUpgrade}
        requestBusy={requestChange.isPending}
      />

      {notice && <p className="form-feedback" role="status" data-testid="status-offer-message">{notice}</p>}
    </>
  );
}
