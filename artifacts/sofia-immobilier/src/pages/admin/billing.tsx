// =============================================================================
// ADMIN — console de facturation manuelle
// =============================================================================
// File de vérification des paiements Mobile Money :
//   filtres (statut / agence / période / moyen / recherche)
//   → détail complet + justificatif privé (URL signée)
//   → comparatif montant attendu / déclaré
//   → décision : valider · refuser (motif obligatoire) · demander une correction
//   → récapitulatif avant validation, puis confirmation avec la nouvelle échéance
//
// Toute la logique d'autorisation et d'activation est dans
// public.admin_review_payment (SECURITY DEFINER, transaction unique).
// Ce fichier ne décide de rien : il affiche et déclenche.
// =============================================================================
import { useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronRight, CreditCard, Eye,
  FileText, Filter, History, Info, Loader2, RefreshCw, Search, ShieldCheck,
  Sparkles, Undo2, XCircle,
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
import {
  ErrorState, LoadingRows, cash, dateLabel, dateTimeLabel, formatDateShort,
} from '@/lib/workspace-ui';
import { useHandlePlanChange, usePlanChangeRequests, PLAN_CHANGE_LABELS, type PlanChangeRequestRow } from '@/lib/admin-billing-api';
import {
  METHOD_LABELS, REQUEST_STATUS_TONE, decisionLabel, methodLabel, requestStatusLabel,
  useAdminPaymentDetail, useAdminPaymentQueue, useProofUrl, useReviewPayment,
  type AdminPaymentDetail, type AdminPaymentRow, type AdminQueueFilters,
  type PaymentDecision, type PaymentRequestStatus,
} from '@/lib/billing-api';

/* ------------------------------------------------------------------ */
/* Pastilles et briques                                                */
/* ------------------------------------------------------------------ */

function StatusPill({ status }: { status: PaymentRequestStatus }) {
  return (
    <span
      className={`status-pill billing-status ${REQUEST_STATUS_TONE[status] ?? ''}`}
      data-testid={`badge-status-${status}`}
    >
      {requestStatusLabel(status)}
    </span>
  );
}

const STATUS_TABS: Array<{ key: string; label: string; statuses?: PaymentRequestStatus[] }> = [
  { key: 'pending', label: 'À vérifier', statuses: ['pending'] },
  { key: 'correction', label: 'Corrections', statuses: ['correction_requested'] },
  { key: 'approved', label: 'Validés', statuses: ['approved'] },
  { key: 'rejected', label: 'Refusés', statuses: ['rejected'] },
  { key: 'closed', label: 'Annulés / expirés', statuses: ['cancelled', 'expired'] },
  { key: 'all', label: 'Tout' },
];

const METHOD_OPTIONS = ['orange_money', 'moov_money', 'wave'];

function ProofBox({ path, scope }: { path: string | null; scope: string }) {
  const proof = useProofUrl(path, scope);
  if (!path) {
    return (
      <div className="proof-none" data-testid="status-proof-none">
        <XCircle size={13} /> Aucun justificatif transmis
      </div>
    );
  }
  if (proof.isLoading) {
    return <div className="proof-none"><Loader2 size={13} className="spin" /> Ouverture sécurisée…</div>;
  }
  if (proof.data?.error || !proof.data?.url) {
    return (
      <div className="proof-none is-error" data-testid="status-proof-error">
        <AlertTriangle size={13} /> Justificatif illisible ou accès refusé
      </div>
    );
  }
  const url = proof.data.url;
  const isPdf = path.toLowerCase().endsWith('.pdf');
  const isImage = /\.(jpe?g|png|webp)$/i.test(path);
  return (
    <div className="proof-viewer" data-testid="panel-proof-viewer">
      {isImage && (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="Justificatif de paiement" loading="lazy" />
        </a>
      )}
      <a
        className="proof-link"
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid={isPdf ? 'link-proof-pdf' : 'link-proof-image'}
      >
        <Eye size={14} /> {isPdf ? 'Ouvrir le PDF' : 'Ouvrir en grand'}
      </a>
      <small>Lien signé valable 15 minutes · bucket privé</small>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Carte de la file                                                    */
/* ------------------------------------------------------------------ */

function QueueCard({ row, onOpen }: { row: AdminPaymentRow; onOpen: (id: string) => void }) {
  const declared = row.declared_amount === null ? null : Number(row.declared_amount);
  const expected = row.expected_amount === null ? null : Number(row.expected_amount);
  const mismatch = declared !== null && expected !== null && declared !== expected;

  return (
    <article
      className={`review-card billing-queue-card ${REQUEST_STATUS_TONE[row.status] ?? ''}`}
      data-testid={`card-queue-${row.id}`}
    >
      <header className="review-card-head">
        <div>
          <strong data-testid={`text-agency-${row.id}`}>{row.agency_name}</strong>
          <small>
            {row.plan_name ?? 'Offre inconnue'} ·{' '}
            <span className="mono">{row.reference ?? row.id.slice(0, 8)}</span>
          </small>
        </div>
        <StatusPill status={row.status} />
      </header>

      <div className="review-facts">
        <div>
          <span>Montant attendu</span>
          <strong data-testid={`text-expected-${row.id}`}>
            {expected === null ? '—' : cash(expected, row.currency)}
          </strong>
        </div>
        <div>
          <span>Montant déclaré</span>
          <strong
            className={mismatch ? 'is-mismatch' : undefined}
            data-testid={`text-declared-${row.id}`}
          >
            {declared === null ? '—' : cash(declared, row.currency)}
          </strong>
        </div>
        <div>
          <span>Moyen</span>
          <strong>{methodLabel(row.method)}</strong>
        </div>
        <div>
          <span>Référence transaction</span>
          <strong className="mono" data-testid={`text-txref-${row.id}`}>
            {row.transaction_reference ?? '—'}
          </strong>
        </div>
      </div>

      <div className="billing-queue-meta">
        <span>
          <CalendarClock size={12} /> Transmis le{' '}
          {row.submitted_at ? dateTimeLabel(row.submitted_at) : dateLabel(row.created_at)}
        </span>
        <span>
          <ShieldCheck size={12} />{' '}
          {row.proof_path ? 'Justificatif présent' : 'Sans justificatif'}
        </span>
        {row.subscription_ends_at && (
          <span>
            <History size={12} /> Abonnement jusqu’au {dateLabel(row.subscription_ends_at)}
          </span>
        )}
        {mismatch && (
          <span className="is-mismatch">
            <AlertTriangle size={12} /> Écart de montant
          </span>
        )}
      </div>

      <footer className="review-actions">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onOpen(row.id)}
          data-testid={`button-open-${row.id}`}
        >
          Examiner <ChevronRight size={14} />
        </Button>
      </footer>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Tiroir de détail + décision                                         */
/* ------------------------------------------------------------------ */

type RecapState = { decision: PaymentDecision; note: string } | null;

function DetailDialog({
  requestId,
  onClose,
}: {
  requestId: string | null;
  onClose: () => void;
}) {
  const detail = useAdminPaymentDetail(requestId);
  const review = useReviewPayment();
  const [recap, setRecap] = useState<RecapState>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<null | {
    decision: PaymentDecision;
    ends_at?: string;
    starts_at?: string;
    amount?: number;
    currency?: string;
    plan_name?: string;
  }>(null);

  // Repartir d'un état propre à chaque nouvelle demande ouverte.
  const data = detail.data;
  const pending = data?.request.status === 'pending';
  const mismatched =
    data?.request.amount !== null &&
    data?.request.amount !== undefined &&
    data.request.expected_amount !== null &&
    Number(data.request.amount) !== Number(data.request.expected_amount);

  const close = () => {
    setRecap(null);
    setNote('');
    setError('');
    setResult(null);
    onClose();
  };

  const runDecision = (decision: PaymentDecision, motif: string) => {
    if (!requestId) return;
    setError('');
    review.mutate(
      { requestId, decision, note: motif },
      {
        onSuccess: (res) => {
          setRecap(null);
          setResult({
            decision: res.decision,
            ends_at: res.ends_at,
            starts_at: res.starts_at,
            amount: res.amount,
            currency: res.currency,
            plan_name: res.plan_name,
          });
        },
        onError: (e) => {
          setRecap(null);
          setError(
            getSupabaseErrorMessage(
              e,
              decision === 'approved'
                ? 'valider ce paiement'
                : decision === 'rejected'
                  ? 'refuser ce paiement'
                  : 'demander une correction',
            ),
          );
        },
      },
    );
  };

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="billing-detail-dialog" data-testid="dialog-payment-detail">
        <DialogHeader>
          <span className="form-kicker">Vérification du paiement</span>
          <DialogTitle>
            {data ? `${data.agency.name} · ${data.request.reference ?? '—'}` : 'Chargement…'}
          </DialogTitle>
          <DialogDescription>
            Comparez le montant attendu, la référence de transaction et le justificatif
            avant toute décision. La validation enregistre l’encaissement et active
            l’abonnement de cette agence — en une seule transaction.
          </DialogDescription>
        </DialogHeader>

        {detail.isLoading && <LoadingRows label="Chargement du paiement" />}
        {detail.error && (
          <ErrorState error={detail.error} retry={() => void detail.refetch()} testId="status-detail-error" />
        )}

        {data && !result && (
          <div className="billing-detail">
            <div className="billing-detail-head">
              <StatusPill status={data.request.status} />
              <span className="billing-detail-ref mono">{data.request.reference}</span>
              {data.request.amount_matches ? (
                <span className="billing-flag is-ok" data-testid="status-amount-match">
                  <CheckCircle2 size={12} /> Montant conforme
                </span>
              ) : (
                <span className="billing-flag is-danger" data-testid="status-amount-mismatch">
                  <AlertTriangle size={12} /> Montant différent de l’attendu
                </span>
              )}
            </div>

            <div className="billing-detail-grid">
              <section>
                <h3><CreditCard size={14} /> Paiement déclaré</h3>
                <dl>
                  <div><dt>Offre</dt><dd>{data.request.plan_name ?? '—'}</dd></div>
                  <div><dt>Durée</dt><dd>{data.request.duration_months} mois</dd></div>
                  <div>
                    <dt>Montant attendu</dt>
                    <dd data-testid="detail-expected">
                      {data.request.expected_amount === null
                        ? '—'
                        : cash(Number(data.request.expected_amount), data.request.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt>Montant déclaré</dt>
                    <dd data-testid="detail-declared">
                      {data.request.amount === null
                        ? '—'
                        : cash(Number(data.request.amount), data.request.currency)}
                    </dd>
                  </div>
                  <div><dt>Moyen</dt><dd>{methodLabel(data.request.method)}</dd></div>
                  <div>
                    <dt>Référence transaction</dt>
                    <dd className="mono" data-testid="detail-txref">
                      {data.request.transaction_reference ?? '—'}
                    </dd>
                  </div>
                  <div><dt>Payé le</dt><dd>{dateLabel(data.request.paid_on)}</dd></div>
                  <div><dt>Payeur</dt><dd>{data.request.payer_name ?? 'Non précisé'}</dd></div>
                  <div><dt>Transmis le</dt><dd>{dateTimeLabel(data.request.submitted_at ?? data.request.created_at)}</dd></div>
                </dl>
                {data.request.note && <p className="review-note">Note de l’agence : {data.request.note}</p>}
              </section>

              <section>
                <h3><Filter size={14} /> Agence</h3>
                <dl>
                  <div><dt>Nom</dt><dd>{data.agency.name}</dd></div>
                  <div><dt>Statut</dt><dd>{data.agency.status}</dd></div>
                  <div><dt>Ville</dt><dd>{data.agency.city ?? '—'}</dd></div>
                  <div><dt>E-mail</dt><dd>{data.agency.email ?? '—'}</dd></div>
                  <div><dt>Téléphone</dt><dd>{data.agency.phone ?? '—'}</dd></div>
                  <div>
                    <dt>Abonnement</dt>
                    <dd>
                      {data.subscription
                        ? `${data.subscription.status} · jusqu’au ${
                            data.subscription.ends_at ? dateLabel(data.subscription.ends_at) : '—'
                          }`
                        : 'Aucun abonnement'}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>

            <section className="billing-detail-proof">
              <h3><FileText size={14} /> Justificatif</h3>
              <ProofBox path={data.request.proof_path} scope={`detail-${data.request.id}`} />
              {data.request.proof_mime && (
                <small className="billing-detail-file">
                  {data.request.proof_mime} ·{' '}
                  {data.request.proof_size
                    ? `${(Number(data.request.proof_size) / 1024).toFixed(0)} Ko`
                    : 'taille inconnue'}
                </small>
              )}
            </section>

            <section className="billing-detail-history">
              <h3><History size={14} /> Historique des décisions</h3>
              <ol data-testid="list-decision-history">
                {data.history.map((entry) => (
                  <li key={entry.id} data-testid={`row-history-${entry.action}`}>
                    <span className="billing-history-dot" />
                    <div>
                      <strong>{decisionLabel(entry.action)}</strong>
                      <small>
                        {dateTimeLabel(entry.created_at)}
                        {entry.actor_label ? ` · ${entry.actor_label}` : ''}
                        {entry.from_status ? ` · ${requestStatusLabel(entry.from_status)} → ${requestStatusLabel(entry.to_status ?? '')}` : ''}
                      </small>
                      {entry.note && <p>{entry.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            {pending ? (
              <section className="billing-decision" data-testid="panel-decision">
                <h3><ShieldCheck size={14} /> Décision</h3>
                <div className="form-field">
                  <label className="form-label" htmlFor="decision-note">
                    Motif / note (obligatoire pour un refus ou une correction)
                  </label>
                  <Textarea
                    id="decision-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Ex. Référence absente du relevé Orange Money du 21/10."
                    data-testid="input-decision-note"
                  />
                  <small className="form-hint">Le motif est visible par l’agence concernée.</small>
                </div>

                {mismatched && (
                  <p className="notice-box is-warning" role="status">
                    <AlertTriangle size={14} />
                    <span>
                      Le montant déclaré ne correspond pas au montant attendu : la
                      validation sera refusée par le serveur. Refusez ou demandez une
                      correction.
                    </span>
                  </p>
                )}

                {error && (
                  <p className="form-error" role="alert" data-testid="status-review-error">{error}</p>
                )}

                <div className="form-actions billing-decision-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={review.isPending || Boolean(mismatched)}
                    onClick={() => {
                      setError('');
                      if (!note.trim()) {
                        setError('Un motif est obligatoire pour demander une correction.');
                        return;
                      }
                      setRecap({ decision: 'correction_requested', note });
                    }}
                    data-testid="button-ask-correction"
                  >
                    <Undo2 size={14} /> Demander une correction
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="is-danger"
                    disabled={review.isPending}
                    onClick={() => {
                      setError('');
                      if (!note.trim()) {
                        setError('Le motif du refus est obligatoire : il sera affiché à l’agence.');
                        return;
                      }
                      setRecap({ decision: 'rejected', note });
                    }}
                    data-testid="button-reject-payment"
                  >
                    <XCircle size={14} /> Refuser
                  </Button>
                  <Button
                    type="button"
                    className="primary-action"
                    disabled={review.isPending || Boolean(mismatched)}
                    onClick={() => {
                      setError('');
                      setRecap({ decision: 'approved', note });
                    }}
                    data-testid="button-approve-payment"
                  >
                    <CheckCircle2 size={14} /> Valider le paiement
                  </Button>
                </div>
              </section>
            ) : (
              <p className="notice-box" role="status" data-testid="status-already-decided">
                <Info size={14} />
                <span>
                  Cette demande a déjà été traitée ({requestStatusLabel(data.request.status)}).
                  Aucune nouvelle décision n’est possible : le serveur refuserait l’opération.
                </span>
              </p>
            )}

            {/* --- Récapitulatif avant validation : rien n'est encore écrit --- */}
            {recap && (
              <section className="billing-recap" role="alertdialog" aria-label="Récapitulatif" data-testid="panel-approval-recap">
                <h3>
                  {recap.decision === 'approved'
                    ? 'Confirmer la validation'
                    : recap.decision === 'rejected'
                      ? 'Confirmer le refus'
                      : 'Confirmer la demande de correction'}
                </h3>
                <ul>
                  <li>Agence : <strong>{data.agency.name}</strong></li>
                  <li>Offre : <strong>{data.request.plan_name ?? '—'}</strong></li>
                  <li>
                    Montant :{' '}
                    <strong>
                      {data.request.amount === null
                        ? '—'
                        : cash(Number(data.request.amount), data.request.currency)}
                    </strong>
                  </li>
                  <li>
                    Référence : <span className="mono">{data.request.transaction_reference ?? '—'}</span>
                  </li>
                  <li>
                    Durée facturée : <strong>{data.request.duration_months} mois</strong>
                  </li>
                  {recap.decision === 'approved' && (
                    <li>
                      Effet : abonnement actif jusqu’au{' '}
                      <strong>
                        {data.subscription?.ends_at
                          ? `au moins ${dateLabel(data.subscription.ends_at)} + ${data.request.duration_months} mois`
                          : `aujourd’hui + ${data.request.duration_months} mois`}
                      </strong>{' '}
                      (les jours restants sont conservés).
                    </li>
                  )}
                  {recap.note && <li>Motif : {recap.note}</li>}
                </ul>
                <p className="billing-recap-warning">
                  <AlertTriangle size={13} /> Ne validez qu’après avoir vérifié l’arrivée
                  réelle des fonds sur le compte Mobile Money. Cette action est irréversible.
                </p>
                <div className="form-actions">
                  <Button type="button" variant="outline" onClick={() => setRecap(null)} disabled={review.isPending}>
                    Revenir
                  </Button>
                  <Button
                    type="button"
                    className="primary-action"
                    disabled={review.isPending}
                    onClick={() => runDecision(recap.decision, recap.note)}
                    data-testid="button-confirm-decision"
                  >
                    {review.isPending ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                    {recap.decision === 'approved'
                      ? 'Confirmer et activer l’abonnement'
                      : recap.decision === 'rejected'
                        ? 'Confirmer le refus'
                        : 'Confirmer la correction'}
                  </Button>
                </div>
              </section>
            )}
          </div>
        )}

        {result && (
          <div className="billing-result" data-testid="panel-review-result">
            <div
              className={`billing-result-mark ${
                result.decision === 'approved' ? 'is-approved' : 'is-rejected'
              }`}
            >
              {result.decision === 'approved' ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
            </div>
            <h2>
              {result.decision === 'approved'
                ? 'Paiement validé, abonnement activé'
                : result.decision === 'rejected'
                  ? 'Paiement refusé'
                  : 'Correction demandée'}
            </h2>
            {result.decision === 'approved' ? (
              <p data-testid="status-approved-summary">
                {result.plan_name ? `${result.plan_name} · ` : ''}
                {result.amount !== undefined
                  ? cash(Number(result.amount), result.currency ?? 'XOF')
                  : ''}{' '}
                · abonnement actif jusqu’au{' '}
                <strong>{result.ends_at ? dateLabel(result.ends_at) : '—'}</strong>. L’agence
                a reçu une notification et son tableau de bord est à jour.
              </p>
            ) : (
              <p>
                L’agence verra votre motif et pourra transmettre une nouvelle preuve.
                L’abonnement n’a pas été modifié.
              </p>
            )}
            <div className="form-actions">
              <Button type="button" onClick={close} data-testid="button-close-result">
                Fermer
              </Button>
            </div>
          </div>
        )}

        {!result && (
          <div className="billing-detail-footer">
            <Button type="button" variant="outline" onClick={close} data-testid="button-close-detail">
              Fermer
            </Button>
            <button
              type="button"
              className="button-link"
              onClick={() => void detail.refetch()}
              data-testid="button-refresh-detail"
            >
              <RefreshCw size={13} /> Rafraîchir
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet « changements d'offre » (comportement existant conservé)     */
/* ------------------------------------------------------------------ */

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
        <span className={`status-pill review-status is-${row.status}`}>
          {PLAN_CHANGE_LABELS[row.status] ?? row.status}
        </span>
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

function PlanChangeDialog({
  target,
  agencyLabel,
  planName,
  onClose,
}: {
  target: PlanChangeRequestRow | null;
  agencyLabel: string;
  planName: (id: string | null) => string;
  onClose: () => void;
}) {
  const handle = useHandlePlanChange();
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(next) => {
        if (!next) {
          setNote('');
          setDecision('approved');
          setError('');
          onClose();
        }
      }}
    >
      <DialogContent className="form-dialog" data-testid="dialog-handle-plan">
        <DialogHeader>
          <span className="form-kicker">Décision administrateur</span>
          <DialogTitle>{target ? `Demande de ${agencyLabel}` : ''}</DialogTitle>
          <DialogDescription>
            {target
              ? `Passage de ${planName(target.current_plan_id)} à ${planName(target.requested_plan_id)}. L’approbation applique immédiatement la nouvelle offre.`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="settings-form">
          <div className="method-choice" role="radiogroup" aria-label="Décision">
            <button
              type="button"
              role="radio"
              aria-checked={decision === 'approved'}
              className={`method-option${decision === 'approved' ? ' is-selected' : ''}`}
              onClick={() => setDecision('approved')}
              data-testid="dialog-handle-plan-approve"
            >
              <strong>Approuver</strong>
              <small>La nouvelle offre est appliquée.</small>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={decision === 'rejected'}
              className={`method-option${decision === 'rejected' ? ' is-selected' : ''}`}
              onClick={() => setDecision('rejected')}
              data-testid="dialog-handle-plan-reject"
            >
              <strong>Refuser</strong>
              <small>L’offre actuelle est conservée.</small>
            </button>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="plan-decision-note">Note</label>
            <Textarea
              id="plan-decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="dialog-handle-plan-input-note"
            />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
            <Button
              type="button"
              disabled={handle.isPending || (decision === 'rejected' && !note.trim())}
              onClick={() => {
                if (!target) return;
                setError('');
                handle.mutate(
                  { requestId: target.id, decision, note },
                  {
                    onSuccess: () => { setNote(''); onClose(); },
                    onError: (e) => setError(getSupabaseErrorMessage(e, 'traiter la demande')),
                  },
                );
              }}
              data-testid="dialog-handle-plan-submit"
            >
              {handle.isPending ? 'Traitement…' : decision === 'approved' ? 'Approuver' : 'Refuser'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function AdminBillingPage() {
  const [tab, setTab] = useState<'payments' | 'plans'>('payments');
  const [statusKey, setStatusKey] = useState('pending');
  const [agencyId, setAgencyId] = useState('');
  const [method, setMethod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [planTarget, setPlanTarget] = useState<PlanChangeRequestRow | null>(null);

  const agenciesQ = useAllAgencies();
  const planChangesQ = usePlanChangeRequests();

  const filters: AdminQueueFilters = useMemo(() => {
    const statuses = STATUS_TABS.find((t) => t.key === statusKey)?.statuses;
    return {
      statuses,
      agencyId: agencyId || undefined,
      method: method || undefined,
      from: from || undefined,
      to: to || undefined,
      search: search || undefined,
    };
  }, [statusKey, agencyId, method, from, to, search]);

  const queue = useAdminPaymentQueue(filters);
  const rows = queue.data?.rows ?? [];
  const counts = queue.data?.counts;

  const agencyLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const agency of agenciesQ.data?.agencies ?? []) map.set(agency.id, agency.name);
    return (id: string | null) => (id ? map.get(id) ?? 'Agence inconnue' : '—');
  }, [agenciesQ.data?.agencies]);

  const planName = useMemo(() => {
    const map = new Map<string, string>();
    for (const plan of agenciesQ.data?.plans ?? []) map.set(plan.id, plan.display_name ?? plan.name);
    return (id: string | null) => (id ? map.get(id) ?? 'Offre inconnue' : 'Aucune offre');
  }, [agenciesQ.data?.plans]);

  const planChanges = planChangesQ.data ?? [];
  const pendingPlans = planChanges.filter((row) => row.status === 'pending').length;
  const totalForTab = (key: string) => {
    if (!counts) return 0;
    if (key === 'pending') return counts.pending;
    if (key === 'correction') return counts.correction_requested;
    if (key === 'approved') return counts.approved;
    if (key === 'rejected') return counts.rejected;
    if (key === 'closed') return counts.cancelled + counts.expired;
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  };

  const resetFilters = () => {
    setAgencyId('');
    setMethod('');
    setFrom('');
    setTo('');
    setSearch('');
  };

  return (
    <>
      <AdminHeading
        eyebrow="Facturation"
        title="Paiements et abonnements"
        description="Vérifiez les preuves de paiement Mobile Money, validez ou refusez, et suivez les demandes de changement d’offre."
        action={
          <Button
            variant="outline"
            onClick={() => {
              void queue.refetch();
              void planChangesQ.refetch();
            }}
            data-testid="button-refresh-queue"
          >
            <RefreshCw size={14} /> Rafraîchir
          </Button>
        }
      />

      <section className="review-queue-summary" aria-label="Files d’attente">
        <button
          type="button"
          className={`queue-pill${tab === 'payments' ? ' is-active' : ''}`}
          onClick={() => setTab('payments')}
          aria-pressed={tab === 'payments'}
          data-testid="tab-payments"
        >
          <CreditCard size={14} /> Paiements à vérifier
          <strong data-testid="count-pending-payments">{counts?.pending ?? 0}</strong>
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

      {tab === 'payments' ? (
        <>
          <section className="billing-filter-bar" aria-label="Filtres" data-testid="panel-filters">
            <div className="billing-status-tabs">
              {STATUS_TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`billing-status-tab${statusKey === item.key ? ' is-active' : ''}`}
                  onClick={() => setStatusKey(item.key)}
                  aria-pressed={statusKey === item.key}
                  data-testid={`filter-status-${item.key}`}
                >
                  {item.label}
                  <span>{totalForTab(item.key)}</span>
                </button>
              ))}
            </div>

            <div className="billing-filter-fields">
              <label className="list-search">
                <Search size={15} />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Agence, référence, payeur…"
                  aria-label="Rechercher"
                  data-testid="input-search-billing"
                />
              </label>

              <select
                value={agencyId}
                onChange={(e) => setAgencyId(e.target.value)}
                aria-label="Filtrer par agence"
                data-testid="select-agency"
              >
                <option value="">Toutes les agences</option>
                {(agenciesQ.data?.agencies ?? []).map((agency) => (
                  <option key={agency.id} value={agency.id}>{agency.name}</option>
                ))}
              </select>

              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                aria-label="Filtrer par moyen de paiement"
                data-testid="select-method"
              >
                <option value="">Tous les moyens</option>
                {METHOD_OPTIONS.map((code) => (
                  <option key={code} value={code}>{METHOD_LABELS[code] ?? code}</option>
                ))}
              </select>

              <label className="billing-date-filter">
                <span>Du</span>
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  aria-label="Date de début"
                  data-testid="input-date-from"
                />
              </label>
              <label className="billing-date-filter">
                <span>Au</span>
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  aria-label="Date de fin"
                  data-testid="input-date-to"
                />
              </label>

              <button type="button" className="button-link" onClick={resetFilters} data-testid="button-reset-filters">
                Réinitialiser
              </button>
            </div>
          </section>

          {queue.isLoading ? (
            <LoadingRows label="Chargement de la file de paiements" />
          ) : queue.error ? (
            <ErrorState error={queue.error} retry={() => void queue.refetch()} testId="status-queue-error" />
          ) : rows.length === 0 ? (
            <div className="state-card compact-empty" data-testid="empty-payments-queue">
              <div className="state-icon"><CheckCircle2 size={19} /></div>
              <h2>Aucun paiement dans ce filtre</h2>
              <p>
                Les preuves transmises par les agences apparaissent ici dès leur envoi.
                Ajustez les filtres pour retrouver une demande plus ancienne.
              </p>
            </div>
          ) : (
            <>
              <p className="result-count" data-testid="text-queue-count">
                {rows.length} demande(s) · mise à jour {formatDateShort(new Date().toISOString())}
              </p>
              <div className="review-grid" data-testid="list-payments-queue">
                {rows.map((row) => (
                  <QueueCard key={row.id} row={row} onOpen={setOpenId} />
                ))}
              </div>
            </>
          )}
        </>
      ) : planChangesQ.isLoading ? (
        <LoadingRows label="Chargement des demandes" />
      ) : planChangesQ.error ? (
        <ErrorState error={planChangesQ.error} retry={() => void planChangesQ.refetch()} testId="status-plan-error" />
      ) : planChanges.length === 0 ? (
        <div className="state-card compact-empty" data-testid="empty-plan-changes-admin">
          <div className="state-icon"><AlertTriangle size={19} /></div>
          <h2>Aucune demande de changement d’offre</h2>
          <p>Les demandes envoyées depuis « Mon offre » apparaîtront ici.</p>
        </div>
      ) : (
        <div className="review-grid" data-testid="list-plan-changes-admin">
          {planChanges.map((row) => (
            <PlanChangeCard
              key={row.id}
              row={row}
              agencyName={agencyLabel(row.agency_id)}
              requestedPlan={planName(row.requested_plan_id)}
              currentPlan={planName(row.current_plan_id)}
              onDecide={setPlanTarget}
              busy={false}
            />
          ))}
        </div>
      )}

      <DetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PlanChangeDialog
        target={planTarget}
        agencyLabel={planTarget ? agencyLabel(planTarget.agency_id) : ''}
        planName={planName}
        onClose={() => setPlanTarget(null)}
      />
    </>
  );
}

export type { AdminPaymentDetail };
