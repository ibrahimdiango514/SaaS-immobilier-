// =============================================================================
// LOT 2 & LOT 3 — ADMIN : PAIEMENTS SASPAY, RÉCONCILIATION, DÉCLARATIONS & OFFRES
// =============================================================================
import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CreditCard, Eye, FileText, RefreshCw, Search,
  ShieldCheck, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useAllAgencies } from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
import { LoadingRows, cash, dateLabel, dateTimeLabel } from '@/lib/workspace-ui';
import {
  DECLARATION_LABELS, METHOD_LABELS, PLAN_CHANGE_LABELS,
  useDeclarationProofUrl, useHandlePlanChange, usePaymentDeclarations,
  usePlanChangeRequests, useReviewPaymentDeclaration,
  type AdminDeclarationRow, type PlanChangeRequestRow,
} from '@/lib/admin-billing-api';
import {
  ONLINE_PAYMENT_STATUS_LABELS, SASPAY_PURPOSE_LABELS,
  useAdminReconcileSasPay, useAdminSasPayOverview,
} from '@/lib/saspay-api';

type Decision = 'approved' | 'rejected';

function ProofPreview({ proofPath }: { proofPath: string | null }) {
  const proof = useDeclarationProofUrl(proofPath);
  if (!proofPath) {
    return <span className="proof-none" data-testid="status-proof-none">Aucune capture</span>;
  }
  if (proof.isLoading) return <span className="proof-none">Chargement…</span>;
  if (!proof.data?.url) {
    return (
      <span className="proof-none is-error" data-testid="status-proof-unavailable">
        Capture illisible
      </span>
    );
  }
  const isPdf = proofPath.toLowerCase().endsWith('.pdf');
  return isPdf ? (
    <a className="proof-link" href={proof.data.url} target="_blank" rel="noreferrer" data-testid="link-proof-pdf">
      <FileText size={14} /> Ouvrir le PDF
    </a>
  ) : (
    <a className="proof-link" href={proof.data.url} target="_blank" rel="noreferrer" data-testid="link-proof-image">
      <Eye size={14} /> Voir la capture
    </a>
  );
}

function DecisionDialog({
  open,
  onOpenChange,
  title,
  description,
  requireNoteOnReject,
  busy,
  error,
  onDecide,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  requireNoteOnReject: boolean;
  busy: boolean;
  error: string;
  onDecide: (decision: Decision, note: string) => void;
  testId: string;
}) {
  const [decision, setDecision] = useState<Decision>('approved');
  const [note, setNote] = useState('');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { setNote(''); setDecision('approved'); onOpenChange(next); }}
    >
      <DialogContent className="form-dialog" data-testid={testId}>
        <DialogHeader>
          <span className="form-kicker">Décision administrateur</span>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="settings-form">
          <div className="method-choice" role="radiogroup" aria-label="Décision">
            <button
              type="button"
              role="radio"
              aria-checked={decision === 'approved'}
              className={`method-option${decision === 'approved' ? ' is-selected' : ''}`}
              onClick={() => setDecision('approved')}
              data-testid={`${testId}-approve`}
            >
              <strong>Valider</strong>
              <small>Le paiement est enregistré et l’abonnement mis à jour automatiquement.</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={decision === 'rejected'}
              className={`method-option${decision === 'rejected' ? ' is-selected' : ''}`}
              onClick={() => setDecision('rejected')}
              data-testid={`${testId}-reject`}
            >
              <strong>Rejeter</strong>
              <small>L’agence verra le motif et pourra déclarer à nouveau.</small>
            </button>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor={`${testId}-note`}>
              {decision === 'rejected' ? 'Motif du rejet' : 'Note (visible par l’agence)'}
            </label>
            <Textarea
              id={`${testId}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                decision === 'rejected'
                  ? 'Ex. Référence introuvable dans le relevé Orange Money.'
                  : 'Ex. Paiement reçu, abonnement mis à jour.'
              }
              data-testid={`${testId}-input-note`}
            />
            {decision === 'rejected' && requireNoteOnReject && (
              <small className="form-hint">Obligatoire pour un rejet.</small>
            )}
          </div>
          {error && <p className="form-error" role="alert" data-testid={`${testId}-error`}>{error}</p>}
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button
              type="button"
              disabled={busy || (decision === 'rejected' && requireNoteOnReject && !note.trim())}
              onClick={() => onDecide(decision, note)}
              data-testid={`${testId}-submit`}
            >
              {busy ? 'Traitement…' : decision === 'approved' ? 'Valider' : 'Rejeter'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeclarationCard({
  row,
  agencyName,
  onDecide,
  busy,
}: {
  row: AdminDeclarationRow;
  agencyName: string;
  onDecide: (row: AdminDeclarationRow) => void;
  busy: boolean;
}) {
  const pending = row.status === 'pending';
  return (
    <article className={`review-card is-${row.status}`} data-testid={`card-declaration-${row.id}`}>
      <header className="review-card-head">
        <div>
          <strong>{agencyName}</strong>
          <small>Déclaré le {dateTimeLabel(row.created_at)}</small>
        </div>
        <span className={`status-pill review-status is-${row.status}`}>{DECLARATION_LABELS[row.status] ?? row.status}</span>
      </header>
      <div className="review-facts">
        <div><span>Montant</span><strong data-testid={`amount-${row.id}`}>{cash(Number(row.amount), row.currency)}</strong></div>
        <div><span>Moyen</span><strong>{METHOD_LABELS[row.method] ?? row.method}</strong></div>
        <div><span>Payé le</span><strong>{dateLabel(row.paid_on)}</strong></div>
        <div><span>Référence</span><strong className="mono">{row.transaction_reference}</strong></div>
      </div>
      <div className="review-proof">
        <ProofPreview proofPath={row.proof_path} />
      </div>
      {row.review_note && (
        <p className={`review-note${row.status === 'rejected' ? ' is-rejected' : ''}`}>
          {row.status === 'rejected' ? 'Motif du rejet' : 'Note'} : {row.review_note}
        </p>
      )}
      {pending && (
        <footer className="review-actions">
          <Button size="sm" disabled={busy} onClick={() => onDecide(row)} data-testid={`button-review-${row.id}`}>
            <CreditCard size={14} /> Traiter la déclaration
          </Button>
        </footer>
      )}
    </article>
  );
}

function PlanChangeCard({
  row,
  agencyName,
  requestedPlan,
  currentPlan,
  onDecide,
  busy,
}: {
  row: PlanChangeRequestRow;
  agencyName: string;
  requestedPlan: string;
  currentPlan: string;
  onDecide: (row: PlanChangeRequestRow) => void;
  busy: boolean;
}) {
  const pending = row.status === 'pending';
  return (
    <article className={`review-card is-${row.status}`} data-testid={`card-plan-change-${row.id}`}>
      <header className="review-card-head">
        <div>
          <strong>{agencyName}</strong>
          <small>Demandée le {dateTimeLabel(row.created_at)}</small>
        </div>
        <span className={`status-pill review-status is-${row.status}`}>{PLAN_CHANGE_LABELS[row.status] ?? row.status}</span>
      </header>
      <div className="review-facts">
        <div><span>Offre actuelle</span><strong>{currentPlan}</strong></div>
        <div><span>Offre demandée</span><strong data-testid={`requested-${row.id}`}>{requestedPlan}</strong></div>
      </div>
      {row.note && <p className="review-note">Motif de l’agence : {row.note}</p>}
      {row.handle_note && (
        <p className={`review-note${row.status === 'rejected' ? ' is-rejected' : ''}`}>
          Décision : {row.handle_note}
        </p>
      )}
      {pending && (
        <footer className="review-actions">
          <Button size="sm" disabled={busy} onClick={() => onDecide(row)} data-testid={`button-handle-plan-${row.id}`}>
            <Sparkles size={14} /> Approuver ou refuser
          </Button>
        </footer>
      )}
    </article>
  );
}

export default function AdminBillingPage() {
  const agenciesQ = useAllAgencies();
  const declarationsQ = usePaymentDeclarations();
  const planChangesQ = usePlanChangeRequests();
  const saspayQ = useAdminSasPayOverview(60);
  const reconcileSasPay = useAdminReconcileSasPay();
  const review = useReviewPaymentDeclaration();
  const handlePlan = useHandlePlanChange();

  const [target, setTarget] = useState<AdminDeclarationRow | null>(null);
  const [planTarget, setPlanTarget] = useState<PlanChangeRequestRow | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'saspay' | 'payments' | 'plans'>('saspay');
  const [error, setError] = useState('');
  const [reconcileNotice, setReconcileNotice] = useState('');

  const agencyName = useMemo(() => {
    const map = new Map<string, string>();
    for (const agency of agenciesQ.data?.agencies ?? []) map.set(agency.id, agency.name);
    return (id: string) => map.get(id) ?? 'Agence inconnue';
  }, [agenciesQ.data?.agencies]);

  const planName = useMemo(() => {
    const map = new Map<string, string>();
    for (const plan of agenciesQ.data?.plans ?? []) {
      map.set(plan.id, plan.display_name ?? plan.name);
    }
    return (id: string | null) => (id ? map.get(id) ?? 'Offre inconnue' : 'Aucune offre');
  }, [agenciesQ.data?.plans]);

  const declarations = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    const rows = declarationsQ.data ?? [];
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        agencyName(row.agency_id).toLocaleLowerCase('fr').includes(needle) ||
        row.transaction_reference.toLocaleLowerCase('fr').includes(needle),
    );
  }, [declarationsQ.data, search, agencyName]);

  const planChanges = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    const rows = planChangesQ.data ?? [];
    if (!needle) return rows;
    return rows.filter((row) => agencyName(row.agency_id).toLocaleLowerCase('fr').includes(needle));
  }, [planChangesQ.data, search, agencyName]);

  const saspayPayments = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    const rows = saspayQ.data?.payments ?? [];
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        (row.agency_name ?? '').toLocaleLowerCase('fr').includes(needle) ||
        (row.transaction_reference ?? '').toLocaleLowerCase('fr').includes(needle) ||
        row.purpose.toLocaleLowerCase('fr').includes(needle),
    );
  }, [saspayQ.data?.payments, search]);

  const pendingDeclarations = (declarationsQ.data ?? []).filter((row) => row.status === 'pending').length;
  const pendingPlans = (planChangesQ.data ?? []).filter((row) => row.status === 'pending').length;
  const pendingSasPay = saspayQ.data?.kpis?.pending_count ?? 0;

  if (declarationsQ.isLoading || planChangesQ.isLoading || agenciesQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Facturation" title="Paiements SasPay et offres" description="Chargement des flux financiers…" />
        <LoadingRows />
      </>
    );
  }

  const runReconciliation = async () => {
    setError('');
    setReconcileNotice('');
    try {
      const res = await reconcileSasPay.mutateAsync(true);
      await saspayQ.refetch();
      setReconcileNotice(
        res.saspay_configured === false
          ? 'Cycle d’échéances exécuté avec succès. Clé API SasPay non configurée sur cet environnement (0 session distante interrogée).'
          : `Réconciliation SasPay terminée : ${res.checked} session(s) contrôlée(s), ${res.confirmed} paiement(s) confirmé(s), ${res.errors} erreur(s).`,
      );
    } catch (err) {
      setError(getSupabaseErrorMessage(err, 'réconcilier les sessions SasPay'));
    }
  };

  const decide = (decision: Decision, note: string) => {
    if (!target) return;
    setError('');
    review.mutate(
      { declarationId: target.id, decision, note },
      {
        onSuccess: () => setTarget(null),
        onError: (e) => setError(getSupabaseErrorMessage(e, decision === 'approved' ? 'valider la déclaration' : 'rejeter la déclaration')),
      },
    );
  };

  const decidePlan = (decision: Decision, note: string) => {
    if (!planTarget) return;
    setError('');
    handlePlan.mutate(
      { requestId: planTarget.id, decision, note },
      {
        onSuccess: () => setPlanTarget(null),
        onError: (e) => setError(getSupabaseErrorMessage(e, decision === 'approved' ? 'approuver la demande' : 'refuser la demande')),
      },
    );
  };

  return (
    <>
      <AdminHeading
        eyebrow="Facturation & SasPay (LOT 3)"
        title="Paiements et offres"
        description="Supervisez les encaissements en ligne SasPay (1er mois, renouvellement, prorata d’offre, réactivation), la réconciliation automatique et les déclarations manuelles."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reconcileSasPay.isPending}
            onClick={() => void runReconciliation()}
            data-testid="button-admin-reconcile-saspay"
          >
            <RefreshCw size={14} />{' '}
            {reconcileSasPay.isPending ? 'Réconciliation…' : 'Réconcilier SasPay & Échéances'}
          </Button>
        }
      />

      <section className="review-queue-summary" aria-label="Files d'attente">
        <button
          type="button"
          className={`queue-pill${tab === 'saspay' ? ' is-active' : ''}`}
          onClick={() => setTab('saspay')}
          aria-pressed={tab === 'saspay'}
          data-testid="tab-saspay"
        >
          <ShieldCheck size={14} /> Transactions SasPay
          <strong data-testid="count-pending-saspay">{pendingSasPay}</strong>
        </button>
        <button
          type="button"
          className={`queue-pill${tab === 'payments' ? ' is-active' : ''}`}
          onClick={() => setTab('payments')}
          aria-pressed={tab === 'payments'}
          data-testid="tab-payments"
        >
          <CreditCard size={14} /> Déclarations manuelles
          <strong data-testid="count-pending-payments">{pendingDeclarations}</strong>
        </button>
        <button
          type="button"
          className={`queue-pill${tab === 'plans' ? ' is-active' : ''}`}
          onClick={() => setTab('plans')}
          aria-pressed={tab === 'plans'}
          data-testid="tab-plan-changes"
        >
          <Sparkles size={14} /> Changements d’offre
          <strong data-testid="count-pending-plans">{pendingPlans}</strong>
        </button>
      </section>

      {error && <p className="form-error module-error" role="alert">{error}</p>}
      {reconcileNotice && <p className="form-feedback" role="status" data-testid="status-reconcile-notice">{reconcileNotice}</p>}

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Agence, motif ou référence de transaction…"
            aria-label="Rechercher"
            data-testid="input-search-billing"
          />
        </label>
        <span className="result-count">
          {tab === 'saspay'
            ? `${saspayPayments.length} transaction(s) SasPay`
            : tab === 'payments'
              ? `${declarations.length} déclaration(s)`
              : `${planChanges.length} demande(s)`}
        </span>
      </section>

      {tab === 'saspay' ? (
        saspayQ.isLoading ? (
          <LoadingRows label="Chargement du journal SasPay" />
        ) : saspayQ.error ? (
          <div className="state-card compact-empty" role="status" data-testid="status-saspay-admin-unavailable">
            <div className="state-icon"><ShieldCheck size={19} /></div>
            <h2>Vue SasPay en attente de migration</h2>
            <p>{getSupabaseErrorMessage(saspayQ.error, 'charger le suivi SasPay')}</p>
          </div>
        ) : (
          <>
            <section className="kpi-grid" style={{ marginBottom: 18 }} data-testid="grid-saspay-kpis">
              <article className="panel kpi-card">
                <span className="form-kicker">Volume SasPay confirmé</span>
                <strong className="kpi-value" data-testid="kpi-saspay-volume">
                  {cash(Number(saspayQ.data?.kpis?.paid_volume_xof ?? 0), 'XOF')}
                </strong>
                <small>{saspayQ.data?.kpis?.paid_count ?? 0} paiement(s) vérifié(s)</small>
              </article>
              <article className="panel kpi-card">
                <span className="form-kicker">Sessions en attente</span>
                <strong className="kpi-value" data-testid="kpi-saspay-pending">
                  {saspayQ.data?.kpis?.pending_count ?? 0}
                </strong>
                <small>Rapprochées par webhook ou réconciliation</small>
              </article>
              <article className="panel kpi-card">
                <span className="form-kicker">Exceptions ouvertes</span>
                <strong className="kpi-value" data-testid="kpi-saspay-exceptions">
                  {saspayQ.data?.kpis?.exceptions_count ?? 0}
                </strong>
                <small>Divergences bloquées côté serveur</small>
              </article>
              <article className="panel kpi-card">
                <span className="form-kicker">Webhooks reçus (24h)</span>
                <strong className="kpi-value" data-testid="kpi-saspay-webhooks">
                  {saspayQ.data?.kpis?.webhooks_24h ?? 0}
                </strong>
                <small>Signatures HMAC-SHA256 validées</small>
              </article>
            </section>

            {(saspayQ.data?.exceptions ?? []).length > 0 && (
              <section className="panel" style={{ marginBottom: 18 }} data-testid="panel-saspay-exceptions">
                <div className="panel-head">
                  <div>
                    <h2>Exceptions de rapprochement à contrôler</h2>
                    <p>Transactions bloquées automatiquement par les gardes de sécurité serveur</p>
                  </div>
                  <AlertTriangle size={18} />
                </div>
                <div className="plan-request-list">
                  {saspayQ.data!.exceptions.map((ex) => (
                    <article className="plan-request-row is-rejected" key={ex.payment_id}>
                      <div className="plan-request-head">
                        <strong>{ex.agency_name ?? 'Agence'}</strong>
                        <span className="mono">{ex.reason}</span>
                      </div>
                      <p className="plan-request-meta">
                        Session : {ex.session_id ?? '—'} · Transaction : {ex.transaction_id ?? '—'} · Vu le {dateTimeLabel(ex.last_seen_at)}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {saspayPayments.length === 0 ? (
              <div className="state-card compact-empty" data-testid="empty-saspay-admin">
                <div className="state-icon"><ShieldCheck size={19} /></div>
                <h2>Aucune transaction SasPay enregistrée</h2>
                <p>Les paiements en ligne d’abonnement apparaîtront automatiquement ici.</p>
              </div>
            ) : (
              <div className="panel list-panel" data-testid="table-saspay-admin">
                <div className="table-wrap">
                  <table className="data-table full-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Agence</th>
                        <th>Motif</th>
                        <th>Offre</th>
                        <th>Montant Sofia</th>
                        <th>Statut</th>
                        <th>Référence SasPay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {saspayPayments.map((row) => (
                        <tr key={row.id} data-testid={`row-admin-saspay-${row.id}`}>
                          <td>{dateTimeLabel(row.created_at)}</td>
                          <td><strong>{row.agency_name ?? '—'}</strong></td>
                          <td>{SASPAY_PURPOSE_LABELS[row.purpose] ?? row.purpose}</td>
                          <td>{row.plan_name ?? '—'}</td>
                          <td>
                            <strong>{cash(Number(row.amount), row.currency)}</strong>
                            {row.provider_charged_amount != null && Number(row.provider_charged_amount) !== Number(row.amount) && (
                              <small style={{ display: 'block' }}>
                                Débité client : {cash(Number(row.provider_charged_amount), row.currency)}
                              </small>
                            )}
                          </td>
                          <td>
                            <span className={`status-pill status-${row.status === 'paid' ? 'available' : row.status === 'pending' ? 'reserved' : 'unavailable'}`}>
                              {ONLINE_PAYMENT_STATUS_LABELS[row.status] ?? row.status}
                            </span>
                          </td>
                          <td className="mono">{row.transaction_reference ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )
      ) : tab === 'payments' ? (
        declarationsQ.error ? (
          <div className="state-card error-state" role="alert">
            <h2>File inaccessible</h2>
            <p>{getSupabaseErrorMessage(declarationsQ.error, 'charger les déclarations')}</p>
            <Button variant="outline" onClick={() => void declarationsQ.refetch()}>Réessayer</Button>
          </div>
        ) : declarations.length ? (
          <div className="review-grid" data-testid="list-declarations-admin">
            {declarations.map((row) => (
              <DeclarationCard
                key={row.id}
                row={row}
                agencyName={agencyName(row.agency_id)}
                onDecide={setTarget}
                busy={review.isPending}
              />
            ))}
          </div>
        ) : (
          <div className="state-card compact-empty" data-testid="empty-declarations-admin">
            <div className="state-icon"><CheckCircle2 size={19} /></div>
            <h2>Aucune déclaration manuelle à traiter</h2>
            <p>Les paiements déclarés manuellement par les agences apparaîtront ici.</p>
          </div>
        )
      ) : planChangesQ.error ? (
        <div className="state-card error-state" role="alert">
          <h2>File inaccessible</h2>
          <p>{getSupabaseErrorMessage(planChangesQ.error, 'charger les demandes')}</p>
          <Button variant="outline" onClick={() => void planChangesQ.refetch()}>Réessayer</Button>
        </div>
      ) : planChanges.length ? (
        <div className="review-grid" data-testid="list-plan-changes-admin">
          {planChanges.map((row) => (
            <PlanChangeCard
              key={row.id}
              row={row}
              agencyName={agencyName(row.agency_id)}
              requestedPlan={planName(row.requested_plan_id)}
              currentPlan={planName(row.current_plan_id)}
              onDecide={setPlanTarget}
              busy={handlePlan.isPending}
            />
          ))}
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-plan-changes-admin">
          <div className="state-icon"><AlertTriangle size={19} /></div>
          <h2>Aucune demande de changement d’offre</h2>
          <p>Les demandes envoyées depuis « Mon offre » apparaîtront ici.</p>
        </div>
      )}

      <DecisionDialog
        open={Boolean(target)}
        onOpenChange={(next) => { if (!next) setTarget(null); }}
        title={`Déclaration de ${target ? agencyName(target.agency_id) : ''}`}
        description={
          target
            ? `${cash(Number(target.amount), target.currency)} par ${METHOD_LABELS[target.method] ?? target.method}, référence ${target.transaction_reference}. La validation solde l’échéance ouverte, met à jour la période et réactive l’agence si elle était suspendue.`
            : ''
        }
        requireNoteOnReject
        busy={review.isPending}
        error={error}
        onDecide={decide}
        testId="dialog-review-payment"
      />

      <DecisionDialog
        open={Boolean(planTarget)}
        onOpenChange={(next) => { if (!next) setPlanTarget(null); }}
        title={`Demande de ${planTarget ? agencyName(planTarget.agency_id) : ''}`}
        description={
          planTarget
            ? `Passage de ${planName(planTarget.current_plan_id)} à ${planName(planTarget.requested_plan_id)}. L’approbation applique immédiatement la nouvelle offre.`
            : ''
        }
        requireNoteOnReject={false}
        busy={handlePlan.isPending}
        error={error}
        onDecide={decidePlan}
        testId="dialog-handle-plan"
      />
    </>
  );
}
