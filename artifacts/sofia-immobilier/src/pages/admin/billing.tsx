// =============================================================================
// BLOC 2 (2 + 3) — ADMIN : file « Paiements à valider » et demandes de
// changement d'offre.
// =============================================================================
// Aucune décision d'autorisation ici : review_payment_declaration et
// admin_handle_plan_change vérifient is_platform_admin() côté base.
// =============================================================================
import { useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CreditCard, Eye, FileText, Search, Sparkles,
  XCircle,
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

/** Boîte de décision partagée : validation / rejet avec motif. */
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
              <small>Le paiement est enregistré et l’abonnement prolongé d’un mois.</small>
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
                  ? 'Ex. Référence introuvable dans le relevé Orange Money du 21/10.'
                  : 'Ex. Paiement reçu, abonnement prolongé d’un mois.'
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
  const review = useReviewPaymentDeclaration();
  const handlePlan = useHandlePlanChange();

  const [target, setTarget] = useState<AdminDeclarationRow | null>(null);
  const [planTarget, setPlanTarget] = useState<PlanChangeRequestRow | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'payments' | 'plans'>('payments');
  const [error, setError] = useState('');

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

  const pendingDeclarations = (declarationsQ.data ?? []).filter((row) => row.status === 'pending').length;
  const pendingPlans = (planChangesQ.data ?? []).filter((row) => row.status === 'pending').length;

  if (declarationsQ.isLoading || planChangesQ.isLoading || agenciesQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Facturation" title="Paiements et offres" description="Chargement des files…" />
        <LoadingRows />
      </>
    );
  }

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
        eyebrow="Facturation"
        title="Paiements et offres"
        description="Validez les paiements déclarés par les agences et traitez leurs demandes de changement d’offre."
      />

      <section className="review-queue-summary" aria-label="Files d'attente">
        <button
          type="button"
          className={`queue-pill${tab === 'payments' ? ' is-active' : ''}`}
          onClick={() => setTab('payments')}
          aria-pressed={tab === 'payments'}
          data-testid="tab-payments"
        >
          <CreditCard size={14} /> Paiements à valider
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

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Agence ou référence de transaction…"
            aria-label="Rechercher"
            data-testid="input-search-billing"
          />
        </label>
        <span className="result-count">
          {tab === 'payments' ? `${declarations.length} déclaration(s)` : `${planChanges.length} demande(s)`}
        </span>
      </section>

      {tab === 'payments' ? (
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
            <h2>Aucune déclaration à traiter</h2>
            <p>Les paiements déclarés par les agences apparaîtront ici.</p>
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
            ? `${cash(Number(target.amount), target.currency)} par ${METHOD_LABELS[target.method] ?? target.method}, référence ${target.transaction_reference}. La validation enregistre le paiement, prolonge l’abonnement d’un mois et réactive l’agence si elle était suspendue.`
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
