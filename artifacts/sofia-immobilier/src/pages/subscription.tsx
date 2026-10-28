// =============================================================================
// ABONNEMENT ET FACTURATION — espace agence
// =============================================================================
// Trois étapes réelles, toutes branchées sur la base :
//   A. choisir une offre   → public.agency_create_payment_request
//   B. payer (instructions) → page dédiée /abonnement/paiement/:requestId
//   C. transmettre la preuve → public.agency_submit_payment_proof
//
// Aucun tarif, aucun numéro de paiement n'est écrit en dur ici : tout vient de
// `saas_immobilier.plans` et de `platform_settings.payment_instructions` via
// public.agency_payment_access. Si un moyen n'est pas configuré, l'écran
// l'affiche explicitement et le serveur refuse la soumission.
// =============================================================================
import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  AlertTriangle, ArrowRight, Building2, Check, CheckCircle2, Clock3, CreditCard,
  ExternalLink, FileText, Info, Loader2, Lock, Phone, RefreshCw, ShieldCheck,
  Sparkles, Wallet, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgency } from '@/lib/agency-context';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import {
  ErrorState, Heading, LoadingRows, cash, dateLabel, dateTimeLabel, useSafeRetry,
} from '@/lib/workspace-ui';
import {
  REQUEST_STATUS_TONE, SUBSCRIPTION_STATUS_LABELS, orderedMethods, requestStatusLabel,
  useAgencyBilling, useAgencyBillingHistory, useCancelPaymentRequest,
  useCreatePaymentRequest, type PaymentRequestRow, type PlanOption,
} from '@/lib/billing-api';

const MODULE_LABELS: Record<string, string> = {
  biens: 'Biens immobiliers',
  contacts: 'Prospects et contacts',
  pipeline: 'Pipeline commercial',
  visites: 'Visites',
  dashboard: 'Tableau de bord',
  ca_chart: 'Graphique du chiffre d’affaires',
  ca_filters: 'Filtres du chiffre d’affaires',
  ca_export_csv: 'Export CSV',
  automatisations: 'Automatisations',
  assistant_ia: 'Assistant IA',
  stats_avancees: 'Statistiques avancées',
  rapports_mensuels: 'Rapports mensuels',
  support_prioritaire: 'Support prioritaire',
  whatsapp: 'WhatsApp',
};

const unlimited = (value: number) => value >= 1_000_000_000;

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`status-pill billing-status ${REQUEST_STATUS_TONE[status as keyof typeof REQUEST_STATUS_TONE] ?? ''}`}
      data-testid={`badge-request-status-${status}`}
    >
      {requestStatusLabel(status)}
    </span>
  );
}

function PlanCard({
  plan,
  current,
  busy,
  disabled,
  onChoose,
}: {
  plan: PlanOption;
  current: boolean;
  busy: boolean;
  disabled: boolean;
  onChoose: (plan: PlanOption) => void;
}) {
  const modules = (plan.modules ?? []).slice(0, 6);
  return (
    <article
      className={`billing-plan${current ? ' is-current' : ''}`}
      data-testid={`card-plan-${plan.name}`}
    >
      <header>
        <div>
          <strong>{plan.display_name ?? plan.name}</strong>
          {current && <span className="billing-plan-tag">Offre actuelle</span>}
        </div>
        <p className="billing-plan-price">
          {cash(Number(plan.price_monthly), plan.currency)} <span>/ mois</span>
        </p>
      </header>

      <ul className="billing-plan-limits">
        <li>
          <Building2 size={13} />
          {unlimited(plan.max_properties) ? 'Biens illimités' : `${plan.max_properties} biens`}
        </li>
        <li>
          <ShieldCheck size={13} />
          {unlimited(plan.max_members) ? 'Utilisateurs illimités' : `${plan.max_members} utilisateurs`}
        </li>
        <li>
          <Sparkles size={13} />
          {unlimited(plan.monthly_agent_messages)
            ? 'Messages IA illimités'
            : `${plan.monthly_agent_messages} messages IA / mois`}
        </li>
      </ul>

      {modules.length > 0 && (
        <div className="billing-plan-modules">
          {modules.map((key) => (
            <span key={key}>
              <Check size={11} /> {MODULE_LABELS[key] ?? key}
            </span>
          ))}
          {(plan.modules?.length ?? 0) > modules.length && (
            <span className="is-more">+{(plan.modules?.length ?? 0) - modules.length} autres</span>
          )}
        </div>
      )}

      <Button
        className={current ? 'is-secondary' : 'primary-action'}
        variant={current ? 'outline' : 'default'}
        disabled={disabled || busy}
        onClick={() => onChoose(plan)}
        data-testid={`button-choose-plan-${plan.name}`}
      >
        {busy ? <Loader2 size={14} className="spin" /> : <CreditCard size={14} />}
        {plan.is_current ? 'Renouveler cette offre' : 'Choisir cette offre'}
      </Button>
    </article>
  );
}

function RequestRow({ row, canManage }: { row: PaymentRequestRow; canManage: boolean }) {
  const cancel = useCancelPaymentRequest();
  const [error, setError] = useState('');
  const resumable = row.status === 'awaiting_payment' || row.status === 'correction_requested';

  return (
    <article
      className={`billing-request ${REQUEST_STATUS_TONE[row.status] ?? ''}`}
      data-testid={`row-request-${row.id}`}
    >
      <div className="billing-request-main">
        <div className="billing-request-head">
          <strong className="mono" data-testid={`text-request-reference-${row.id}`}>
            {row.reference ?? '—'}
          </strong>
          <StatusPill status={row.status} />
        </div>
        <p className="billing-request-meta">
          {row.plan_name ?? 'Offre'} ·{' '}
          <strong>{cash(Number(row.amount ?? row.expected_amount ?? 0), row.currency)}</strong>
          {row.duration_months > 1 ? ` · ${row.duration_months} mois` : ''}
          {row.method ? ` · ${row.method.replace(/_/g, ' ')}` : ''}
        </p>
        <p className="billing-request-dates">
          Créée le {dateLabel(row.created_at)}
          {row.submitted_at ? ` · transmise le ${dateLabel(row.submitted_at)}` : ''}
          {row.paid_on ? ` · payée le ${dateLabel(row.paid_on)}` : ''}
          {row.reviewed_at ? ` · traitée le ${dateLabel(row.reviewed_at)}` : ''}
        </p>
        {row.transaction_reference && (
          <p className="billing-request-dates">
            Référence transaction : <span className="mono">{row.transaction_reference}</span>
          </p>
        )}
        {(row.status === 'rejected' || row.status === 'correction_requested') && row.review_note && (
          <p className={`billing-request-reason${row.status === 'rejected' ? ' is-rejected' : ''}`} data-testid={`text-request-reason-${row.id}`}>
            <strong>{row.status === 'rejected' ? 'Motif du refus' : 'Correction demandée'} :</strong>{' '}
            {row.review_note}
          </p>
        )}
        {row.status === 'approved' && row.review_note && (
          <p className="billing-request-reason is-ok">Note de l’administrateur : {row.review_note}</p>
        )}
        {row.status === 'cancelled' && row.cancel_reason && (
          <p className="billing-request-reason">Annulée : {row.cancel_reason}</p>
        )}
      </div>

      {canManage && (
        <div className="billing-request-actions">
          {resumable && (
            <Link
              href={`/abonnement/paiement/${row.id}`}
              className="button-link"
              data-testid={`link-resume-${row.id}`}
            >
              {row.status === 'correction_requested' ? 'Corriger' : 'Continuer le paiement'}
              <ArrowRight size={13} />
            </Link>
          )}
          {(row.status === 'awaiting_payment' || row.status === 'correction_requested' || row.status === 'pending') && (
            <button
              type="button"
              className="button-link is-muted"
              disabled={cancel.isPending}
              onClick={() => {
                setError('');
                cancel.mutate(
                  { requestId: row.id, reason: 'Annulation par l’agence' },
                  { onError: (e) => setError(getSupabaseErrorMessage(e, 'annuler la demande')) },
                );
              }}
              data-testid={`button-cancel-${row.id}`}
            >
              Annuler
            </button>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </article>
  );
}

export default function SubscriptionPage() {
  const { activeAgencyId, canManageAgency } = useAgency();
  const [, setLocation] = useLocation();
  const billing = useAgencyBilling(activeAgencyId);
  const history = useAgencyBillingHistory(activeAgencyId);
  const createRequest = useCreatePaymentRequest(activeAgencyId);
  const retry = useSafeRetry(billing);
  const [error, setError] = useState('');
  const [duration, setDuration] = useState(1);

  const data = billing.data;
  const requests = useMemo(() => data?.requests ?? [], [data]);
  const openRequests = requests.filter(
    (r) => r.status === 'pending' || r.status === 'awaiting_payment' || r.status === 'correction_requested',
  );
  const closedRequests = requests.filter(
    (r) => r.status !== 'pending' && r.status !== 'awaiting_payment' && r.status !== 'correction_requested',
  );
  const methods = orderedMethods(data?.payment_config);
  const usable = methods.filter((m) => m.configured);
  const durations = (data?.durations ?? [1]).filter((d) => Number.isFinite(d) && d > 0);

  if (billing.isLoading) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Abonnement et facturation" description="Chargement de votre abonnement…" />
        <LoadingRows label="Chargement de l’abonnement" />
      </>
    );
  }

  if (!activeAgencyId) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Abonnement et facturation" description="Offre, paiement et historique." />
        <div className="state-card compact-empty" data-testid="status-billing-no-agency">
          <div className="state-icon"><Wallet size={19} /></div>
          <h2>Aucune agence sélectionnée</h2>
          <p>Sélectionnez une agence dans le menu de votre espace pour consulter son abonnement.</p>
        </div>
      </>
    );
  }

  if (billing.error || !data) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Abonnement et facturation" description="Offre, paiement et historique." />
        <ErrorState error={billing.error} retry={retry} testId="status-billing-error" />
      </>
    );
  }

  if (!canManageAgency) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Abonnement et facturation" description="Offre, paiement et historique." />
        <div className="permission-note" role="status" data-testid="status-billing-permission">
          <Lock size={15} />
          <span>
            L’abonnement et les paiements sont réservés au propriétaire et aux
            administrateurs de l’agence. Votre rôle permet de consulter le reste de
            l’application ; les règles d’accès de la base restent prioritaires.
          </span>
        </div>
      </>
    );
  }

  const { subscription, plan, billing: state } = data;
  const status = subscription?.status ?? 'none';
  const daysLeft =
    subscription?.ends_at
      ? Math.ceil((new Date(subscription.ends_at).getTime() - Date.now()) / 86_400_000)
      : null;

  const choosePlan = (target: PlanOption) => {
    setError('');
    createRequest.mutate(
      { planId: target.id, durationMonths: duration },
      {
        onSuccess: (created) => setLocation(`/abonnement/paiement/${created.id}`),
        onError: (e) => setError(getSupabaseErrorMessage(e, 'créer la demande de paiement')),
      },
    );
  };

  return (
    <>
      <Heading
        eyebrow="Abonnement"
        title="Abonnement et facturation"
        description="Choisissez votre offre, payez par Mobile Money et suivez la validation."
      />

      {/* ---------------- Coordonnées de paiement publiées ? ----------------
          État lu depuis `payment_config()` : si aucun numéro n'est publié,
          le parcours s'arrêterait à l'écran d'instructions. On le dit AVANT
          de créer une demande, au lieu de laisser l'agence buter plus loin. */}
      {usable.length === 0 && (
        <div className="notice-box is-warning" role="status" data-testid="banner-payment-config-missing">
          <AlertTriangle size={15} />
          <span>
            <strong>Paiement Mobile Money indisponible pour le moment.</strong>{' '}
            Aucun numéro Orange Money / Moov Money n’est publié par la plateforme
            (nous n’en inventons pas). Vous pouvez préparer votre demande, mais la
            transmission de la preuve restera bloquée jusqu’à la publication des
            coordonnées par l’administrateur.
          </span>
        </div>
      )}

      {/* ---------------- Alertes d'échéance réelles ---------------- */}
      {state?.has_due_date && (state.is_due_soon || state.is_overdue) && (
        <div
          className={`offer-alert${state.is_overdue ? ' is-overdue' : ''}`}
          role="status"
          data-testid="banner-subscription-alert"
        >
          <AlertTriangle size={17} />
          <div>
            <strong>{state.is_overdue ? 'Abonnement en retard de paiement' : 'Échéance proche'}</strong>
            <p>
              {state.is_overdue
                ? `Votre abonnement a dépassé son échéance. Suspension possible après le délai de grâce de ${state.grace_days} jour(s).`
                : `Votre abonnement arrive à échéance${daysLeft !== null ? ` dans ${Math.max(daysLeft, 0)} jour(s)` : ' prochainement'}. Réglez pour éviter toute interruption.`}
            </p>
          </div>
        </div>
      )}

      <div className="billing-layout">
        {/* ---------------- Offre actuelle ---------------- */}
        <section className="panel billing-current" data-testid="panel-current-subscription">
          <div className="panel-head">
            <div>
              <h2><Wallet size={17} /> Abonnement actuel</h2>
              <p>État réel enregistré par la plateforme</p>
            </div>
            <span className={`status-pill billing-status is-${status}`} data-testid="badge-subscription-status">
              {SUBSCRIPTION_STATUS_LABELS[status] ?? (status === 'none' ? 'Aucune offre' : status)}
            </span>
          </div>

          {plan ? (
            <>
              <p className="billing-current-plan" data-testid="text-current-plan">
                {plan.display_name}
              </p>
              <p className="billing-current-price">
                {cash(Number(plan.price_monthly), plan.currency)} <span>/ mois</span>
              </p>
              <div className="offer-facts">
                <div>
                  <span>Échéance</span>
                  <strong data-testid="text-subscription-end">
                    {subscription?.ends_at ? dateLabel(subscription.ends_at) : 'Aucune échéance'}
                  </strong>
                </div>
                <div>
                  <span>Jours restants</span>
                  <strong>
                    {daysLeft === null ? '—' : daysLeft >= 0 ? `${daysLeft} jour(s)` : `dépassé de ${Math.abs(daysLeft)} jour(s)`}
                  </strong>
                </div>
                <div>
                  <span>Délai de grâce</span>
                  <strong>{data.grace_days} jour(s)</strong>
                </div>
                {subscription?.trial_ends_at && (
                  <div>
                    <span>Fin de l’essai</span>
                    <strong>{dateLabel(subscription.trial_ends_at)}</strong>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-table" data-testid="empty-subscription">
              <div className="empty-table-mark"><Wallet size={17} /></div>
              <strong>Aucune offre active</strong>
              <p>Choisissez une offre ci-dessous pour ouvrir votre abonnement.</p>
            </div>
          )}
        </section>

        {/* ---------------- Moyens de paiement ---------------- */}
        <section className="panel billing-methods" data-testid="panel-payment-methods">
          <div className="panel-head">
            <div>
              <h2><Phone size={17} /> Moyens de paiement</h2>
              <p>Coordonnées publiées par la plateforme</p>
            </div>
          </div>

          {usable.length === 0 ? (
            <div className="notice-box is-warning" role="status" data-testid="status-methods-not-configured">
              <AlertTriangle size={15} />
              <span>
                <strong>Moyen de paiement en cours de configuration.</strong> Aucun
                numéro de paiement n’est encore publié : la transmission d’une preuve
                est bloquée jusqu’à la configuration par l’administrateur.
              </span>
            </div>
          ) : (
            <div className="payment-channels">
              {methods.map((method) => (
                <div
                  key={method.code}
                  className={`payment-channel${method.configured ? '' : ' is-empty'}`}
                  data-testid={`channel-${method.code}`}
                >
                  <span className="billing-method-label">{method.label}</span>
                  {method.configured ? (
                    <>
                      <strong>{method.number}</strong>
                      <small>{method.beneficiary || 'Bénéficiaire non précisé'}</small>
                      {method.instructions && <small>{method.instructions}</small>}
                    </>
                  ) : (
                    <small>Moyen de paiement en cours de configuration</small>
                  )}
                </div>
              ))}
            </div>
          )}

          {data.payment_config?.note && (
            <p className="payment-note" data-testid="text-payment-note">
              <Info size={12} /> {data.payment_config.note}
            </p>
          )}
          {data.payment_config?.proof_required && (
            <p className="payment-note">
              <FileText size={12} /> Une capture ou un reçu est exigé pour chaque paiement.
            </p>
          )}
        </section>
      </div>

      {/* ---------------- Choix de l'offre ---------------- */}
      <section className="panel billing-plans-panel" data-testid="panel-plans">
        <div className="panel-head">
          <div>
            <h2><Sparkles size={17} /> Offres disponibles</h2>
            <p>Tarifs et durées lus dans la configuration de la plateforme</p>
          </div>
          <label className="billing-duration">
            <span>Durée</span>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              aria-label="Durée de l’abonnement"
              data-testid="select-duration"
            >
              {durations.map((months) => (
                <option key={months} value={months}>
                  {months === 1 ? '1 mois (mensuel)' : `${months} mois`}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert" data-testid="status-create-request-error">
            {error}
          </p>
        )}

        <div className="billing-plans">
          {(data.plans ?? []).map((option) => (
            <PlanCard
              key={option.id}
              plan={option}
              current={option.id === plan?.id}
              busy={createRequest.isPending && createRequest.variables?.planId === option.id}
              disabled={createRequest.isPending}
              onChoose={choosePlan}
            />
          ))}
        </div>

        <p className="billing-footnote">
          Montant total pour {duration === 1 ? '1 mois' : `${duration} mois`} ={' '}
          prix mensuel × durée, sans frais caché. Les frais d’installation
          éventuels sont indiqués sur chaque offre et facturés séparément par
          l’administrateur.
        </p>
      </section>

      {/* ---------------- Demandes en cours ---------------- */}
      <section className="panel" data-testid="panel-open-requests">
        <div className="panel-head">
          <div>
            <h2><Clock3 size={17} /> Paiements en cours</h2>
            <p>Demandes à finaliser ou en attente de vérification</p>
          </div>
        </div>

        {openRequests.length === 0 ? (
          <div className="empty-table" data-testid="empty-open-requests">
            <div className="empty-table-mark"><CheckCircle2 size={17} /></div>
            <strong>Aucun paiement en cours</strong>
            <p>Choisissez une offre pour démarrer un paiement.</p>
          </div>
        ) : (
          <div className="billing-requests">
            {openRequests.map((row) => (
              <RequestRow key={row.id} row={row} canManage={canManageAgency} />
            ))}
          </div>
        )}
      </section>

      {/* ---------------- Historique ---------------- */}
      <section className="panel" data-testid="panel-billing-history">
        <div className="panel-head">
          <div>
            <h2><FileText size={17} /> Historique de facturation</h2>
            <p>Demandes traitées et encaissements enregistrés</p>
          </div>
          <button
            type="button"
            className="button-link"
            onClick={() => {
              void billing.refetch();
              void history.refetch();
            }}
            data-testid="button-refresh-billing"
          >
            <RefreshCw size={13} /> Rafraîchir
          </button>
        </div>

        {closedRequests.length === 0 ? (
          <div className="empty-table" data-testid="empty-billing-history">
            <div className="empty-table-mark"><XCircle size={17} /></div>
            <strong>Aucune demande traitée</strong>
            <p>Vos paiements validés ou refusés apparaîtront ici avec leur motif.</p>
          </div>
        ) : (
          <div className="billing-requests">
            {closedRequests.map((row) => (
              <RequestRow key={row.id} row={row} canManage={canManageAgency} />
            ))}
          </div>
        )}

        {history.error && (
          <p className="form-error" role="alert">
            {getSupabaseErrorMessage(history.error, 'charger les encaissements')}
          </p>
        )}
        {!history.error && (history.data?.length ?? 0) > 0 && (
          <div className="billing-payments">
            <h3>Encaissements enregistrés</h3>
            <div className="table-wrap">
              <table className="data-table" data-testid="table-payments-history">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Montant</th>
                    <th>Période couverte</th>
                    <th>Référence</th>
                  </tr>
                </thead>
                <tbody>
                  {(history.data ?? []).map((row) => (
                    <tr key={row.id} data-testid={`row-payment-${row.id}`}>
                      <td>{dateLabel(row.paid_at)}</td>
                      <td>
                        {row.entry_kind === 'reversal' ? '− ' : ''}
                        {cash(Number(row.amount), row.currency)}
                      </td>
                      <td>
                        {row.period_start ? dateLabel(row.period_start) : '—'}
                        {row.period_end ? ` → ${dateLabel(row.period_end)}` : ''}
                      </td>
                      <td className="mono">{row.reference ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <p className="billing-footnote">
        <ShieldCheck size={12} /> Le justificatif éventuel est stocké dans un espace
        privé, visible uniquement par votre agence et l’administrateur. Un paiement
        déclaré n’est jamais « encaissé » avant la vérification effective par
        l’administrateur. <ExternalLink size={12} />{' '}
        <span>
          Une question ? Écrivez à l’administrateur depuis la page « Mon profil ».
        </span>
      </p>
    </>
  );
}
