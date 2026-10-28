// =============================================================================
// PAGE DE PAIEMENT DÉDIÉE — /abonnement/paiement/:requestId
// =============================================================================
// Parcours en 4 étapes visibles :
//   1. Offre choisie      2. Instructions de paiement
//   3. Preuve de paiement 4. Confirmation « En attente de vérification »
//
// La référence affichée (SI-AAAAMMJJ-XXXXXX) est générée et stockée par le
// serveur : elle ne change pas au rechargement, et elle est transmise avec la
// preuve. Aucune coordonnée de paiement n'est inventée : si le moyen choisi
// n'est pas configuré, l'écran le dit et le bouton reste inactif.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock3, Copy, FileText,
  Info, Loader2, Phone, ShieldCheck, Upload, Wallet, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgency } from '@/lib/agency-context';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { ErrorState, Heading, LoadingRows, cash, dateLabel, useSafeRetry } from '@/lib/workspace-ui';
import {
  MAX_PROOF_SIZE, REQUEST_STATUS_TONE, orderedMethods, requestStatusLabel, todayIso,
  useAgencyBilling, useSubmitPaymentProof, validateProofFile,
  type PaymentMethodCode, type PaymentRequestRow,
} from '@/lib/billing-api';

type Step = 'instructions' | 'proof' | 'done';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'instructions', label: 'Instructions' },
  { key: 'proof', label: 'Preuve de paiement' },
  { key: 'done', label: 'Confirmation' },
];

function Stepper({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="billing-steps" aria-label="Étapes du paiement" data-testid="stepper-payment">
      <li className="is-done">
        <span className="billing-step-mark">1</span>
        <div><strong>Offre choisie</strong><small>Référence générée</small></div>
      </li>
      {STEPS.map((step, i) => {
        const state = i < index ? 'is-done' : i === index ? 'is-current' : 'is-todo';
        return (
          <li key={step.key} className={state} aria-current={i === index ? 'step' : undefined}>
            <span className="billing-step-mark">{i + 2}</span>
            <div>
              <strong>{step.label}</strong>
              <small>
                {state === 'is-done' ? 'Terminé' : state === 'is-current' ? 'En cours' : 'À venir'}
              </small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function RequestSummary({ row }: { row: PaymentRequestRow }) {
  return (
    <div className="billing-summary" data-testid="panel-request-summary">
      <div>
        <span>Offre</span>
        <strong data-testid="text-payment-plan">{row.plan_name ?? '—'}</strong>
      </div>
      <div>
        <span>Montant exact à payer</span>
        <strong className="billing-amount" data-testid="text-payment-amount">
          {cash(Number(row.expected_amount ?? row.amount ?? 0), row.currency)}
        </strong>
      </div>
      <div>
        <span>Durée</span>
        <strong>{row.duration_months === 1 ? '1 mois' : `${row.duration_months} mois`}</strong>
      </div>
      <div>
        <span>Référence de la demande</span>
        <strong className="mono" data-testid="text-payment-reference">{row.reference ?? '—'}</strong>
      </div>
    </div>
  );
}

export default function SubscriptionPaymentPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = params.requestId;
  const { activeAgencyId, canManageAgency } = useAgency();
  const billing = useAgencyBilling(activeAgencyId);
  const submit = useSubmitPaymentProof(activeAgencyId);
  const retry = useSafeRetry(billing);

  const [step, setStep] = useState<Step>('instructions');
  const [method, setMethod] = useState<PaymentMethodCode | ''>('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [payerName, setPayerName] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [receipt, setReceipt] = useState<{ reference: string; status: string } | null>(null);

  const row = useMemo(
    () => (billing.data?.requests ?? []).find((item) => item.id === requestId),
    [billing.data, requestId],
  );

  const methods = orderedMethods(billing.data?.payment_config);
  const usable = methods.filter((m) => m.configured);

  useEffect(() => {
    if (!method && usable.length === 1) setMethod(usable[0].code);
  }, [method, usable]);

  const selected = methods.find((m) => m.code === method);
  const proofRequired =
    Boolean(billing.data?.payment_config?.proof_required) || Boolean(selected?.proof_required);
  const proofIssue = proof ? validateProofFile(proof) : null;

  if (billing.isLoading) {
    return (
      <>
        <Heading eyebrow="Paiement" title="Paiement de l’abonnement" description="Chargement…" />
        <LoadingRows label="Chargement de la demande" />
      </>
    );
  }

  if (!activeAgencyId) {
    return (
      <>
        <Heading eyebrow="Paiement" title="Paiement de l’abonnement" description="Demande de paiement." />
        <div className="state-card compact-empty" data-testid="status-payment-no-agency">
          <div className="state-icon"><Wallet size={19} /></div>
          <h2>Aucune agence sélectionnée</h2>
          <p>Ouvrez la page « Abonnement et facturation » après avoir choisi une agence.</p>
          <Link href="/abonnement" className="button-link">Abonnement</Link>
        </div>
      </>
    );
  }

  if (billing.error) {
    return (
      <>
        <Heading eyebrow="Paiement" title="Paiement de l’abonnement" description="Demande de paiement." />
        <ErrorState error={billing.error} retry={retry} testId="status-payment-page-error" />
      </>
    );
  }

  if (!canManageAgency) {
    return (
      <>
        <Heading eyebrow="Paiement" title="Paiement de l’abonnement" description="Demande de paiement." />
        <div className="permission-note" role="status">
          <ShieldCheck size={15} />
          <span>Seul le propriétaire ou un administrateur de l’agence peut payer l’abonnement.</span>
        </div>
        <Link href="/abonnement" className="button-link"><ArrowLeft size={13} /> Retour</Link>
      </>
    );
  }

  if (!row) {
    return (
      <>
        <Heading eyebrow="Paiement" title="Demande introuvable" description="Cette demande n’existe pas ou n’appartient pas à votre agence." />
        <div className="state-card compact-empty" data-testid="status-request-not-found">
          <div className="state-icon"><AlertTriangle size={19} /></div>
          <h2>Demande introuvable</h2>
          <p>Vérifiez la référence depuis la page « Abonnement et facturation ».</p>
          <Link href="/abonnement" className="button-link">Retour à l’abonnement</Link>
        </div>
      </>
    );
  }

  /* ------------------------------------------------------------------ */
  /* États terminaux : plus de formulaire                                */
  /* ------------------------------------------------------------------ */
  const terminal =
    row.status === 'pending' ||
    row.status === 'approved' ||
    row.status === 'rejected' ||
    row.status === 'cancelled' ||
    row.status === 'expired' ||
    step === 'done';

  const submitProof = () => {
    setError('');
    if (!method) {
      setError('Choisissez un moyen de paiement.');
      return;
    }
    if (proofIssue) {
      setError(proofIssue);
      return;
    }
    if (proofRequired && !proof) {
      setError('Une capture ou un reçu est obligatoire pour ce paiement.');
      return;
    }
    if (!reference.trim()) {
      setError('La référence de la transaction est obligatoire.');
      return;
    }
    if (!paidOn) {
      setError('La date du paiement est obligatoire.');
      return;
    }
    if (paidOn > todayIso()) {
      setError('La date du paiement ne peut pas être dans le futur.');
      return;
    }
    if (!confirmed) {
      setError('Vous devez confirmer l’exactitude des informations.');
      return;
    }

    submit.mutate(
      {
        requestId: row.id,
        method: method as PaymentMethodCode,
        amount: Number(row.expected_amount ?? row.amount ?? 0),
        transactionReference: reference,
        paidOn,
        payerName,
        proof,
      },
      {
        onSuccess: (result) => {
          setReceipt({ reference: result.reference, status: result.status });
          setStep('done');
        },
        onError: (e) => setError(getSupabaseErrorMessage(e, 'transmettre la preuve de paiement')),
      },
    );
  };

  return (
    <>
      <Heading
        eyebrow="Paiement manuel"
        title="Paiement de l’abonnement"
        description="Mobile Money · validation par l’administrateur"
        action={
          <Link href="/abonnement" className="button-link" data-testid="link-back-subscription">
            <ArrowLeft size={13} /> Abonnement
          </Link>
        }
      />

      <Stepper current={terminal ? 'done' : step} />

      {terminal ? (
        <section className="panel billing-result" data-testid="panel-payment-result">
          {row.status === 'pending' || step === 'done' ? (
            <>
              <div className="billing-result-mark is-pending"><Clock3 size={22} /></div>
              <h2 data-testid="status-payment-submitted">En attente de vérification</h2>
              <p>
                Votre preuve a bien été enregistrée. L’administrateur vérifie la
                transaction ; l’abonnement sera activé ou prolongé à la validation.
              </p>
              <div className="billing-summary is-compact">
                <div>
                  <span>Référence de la demande</span>
                  <strong className="mono" data-testid="text-confirmed-reference">
                    {receipt?.reference ?? row.reference}
                  </strong>
                </div>
                <div>
                  <span>Statut</span>
                  <strong>{requestStatusLabel(receipt?.status ?? row.status)}</strong>
                </div>
                <div>
                  <span>Montant transmis</span>
                  <strong>{cash(Number(row.amount ?? row.expected_amount ?? 0), row.currency)}</strong>
                </div>
                <div>
                  <span>Moyen</span>
                  <strong>{row.method?.replace(/_/g, ' ') ?? '—'}</strong>
                </div>
              </div>
              <p className="billing-footnote">
                <Info size={12} /> Aucun encaissement n’est considéré comme effectué
                avant la vérification effective par l’administrateur.
              </p>
              <Link href="/abonnement" className="button-link" data-testid="link-result-back">
                <ArrowLeft size={13} /> Retour à l’abonnement
              </Link>
            </>
          ) : row.status === 'approved' ? (
            <>
              <div className="billing-result-mark is-approved"><CheckCircle2 size={22} /></div>
              <h2>Paiement validé</h2>
              <p>
                Cette demande a été vérifiée{' '}
                {row.reviewed_at ? `le ${dateLabel(row.reviewed_at)}` : ''}. Votre
                abonnement a été activé ou prolongé.
              </p>
              <Link href="/abonnement" className="button-link">Voir mon abonnement</Link>
            </>
          ) : row.status === 'rejected' ? (
            <>
              <div className="billing-result-mark is-rejected"><XCircle size={22} /></div>
              <h2>Paiement refusé</h2>
              {row.review_note && (
                <p className="billing-request-reason is-rejected" data-testid="status-payment-rejected-reason">
                  <strong>Motif :</strong> {row.review_note}
                </p>
              )}
              <p>Vous pouvez effectuer un nouveau paiement depuis la page d’abonnement.</p>
              <Link href="/abonnement" className="button-link">Retour à l’abonnement</Link>
            </>
          ) : row.status === 'cancelled' ? (
            <>
              <div className="billing-result-mark is-cancelled"><XCircle size={22} /></div>
              <h2>Demande annulée</h2>
              <p>{row.cancel_reason ?? 'Cette demande a été annulée.'}</p>
              <Link href="/abonnement" className="button-link">Retour à l’abonnement</Link>
            </>
          ) : (
            <>
              <div className="billing-result-mark is-expired"><Clock3 size={22} /></div>
              <h2>Demande expirée</h2>
              <p>Cette demande de paiement n’est plus valable. Créez-en une nouvelle.</p>
              <Link href="/abonnement" className="button-link">Retour à l’abonnement</Link>
            </>
          )}
        </section>
      ) : step === 'instructions' ? (
        /* ---------------- Étape : instructions ---------------- */
        <div className="billing-layout">
          <section className="panel" data-testid="panel-instructions">
            <div className="panel-head">
              <div>
                <h2><Wallet size={17} /> Votre demande de paiement</h2>
                <p>Offre, montant et référence à rappeler lors du transfert</p>
              </div>
              <span className={`status-pill billing-status ${REQUEST_STATUS_TONE[row.status] ?? ''}`}>
                {requestStatusLabel(row.status)}
              </span>
            </div>

            <RequestSummary row={row} />

            <div className="billing-copy">
              <span>Référence à indiquer</span>
              <button
                type="button"
                className="billing-copy-button"
                onClick={() => {
                  void navigator.clipboard?.writeText(row.reference ?? '');
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                }}
                data-testid="button-copy-reference"
              >
                <Copy size={14} /> {copied ? 'Copiée' : 'Copier la référence'}
              </button>
            </div>

            {row.status === 'correction_requested' && row.review_note && (
              <div className="notice-box is-danger" role="status" data-testid="status-correction-notice">
                <AlertTriangle size={15} />
                <span>
                  <strong>Correction demandée :</strong> {row.review_note}
                </span>
              </div>
            )}

            <div className="billing-expiry">
              <Clock3 size={13} /> Cette demande est valable jusqu’au{' '}
              {row.expires_at ? dateLabel(row.expires_at) : 'nouvel ordre'}.
            </div>
          </section>

          <section className="panel" data-testid="panel-payment-instructions">
            <div className="panel-head">
              <div>
                <h2><Phone size={17} /> Comment payer</h2>
                <p>Choisissez le service utilisé pour le transfert</p>
              </div>
            </div>

            {usable.length === 0 ? (
              <div className="notice-box is-warning" role="alert" data-testid="status-no-method">
                <AlertTriangle size={15} />
                <span>
                  <strong>Moyen de paiement en cours de configuration.</strong>{' '}
                  Aucun numéro de paiement n’est publié. Vous ne pouvez pas encore
                  transmettre de preuve : contactez l’administrateur.
                </span>
              </div>
            ) : (
              <>
                <div className="method-choice" role="radiogroup" aria-label="Moyen de paiement">
                  {usable.map((option) => (
                    <button
                      key={option.code}
                      type="button"
                      role="radio"
                      aria-checked={method === option.code}
                      className={`method-option${method === option.code ? ' is-selected' : ''}`}
                      onClick={() => setMethod(option.code)}
                      data-testid={`button-method-${option.code}`}
                    >
                      <strong>{option.label}</strong>
                      <small>{option.number}</small>
                    </button>
                  ))}
                </div>

                {selected && (
                  <div className="billing-instructions" data-testid="panel-selected-method">
                    <div>
                      <span>Bénéficiaire</span>
                      <strong>{selected.beneficiary || 'Non précisé'}</strong>
                    </div>
                    <div>
                      <span>Numéro de paiement</span>
                      <strong className="mono">{selected.number}</strong>
                    </div>
                    <div>
                      <span>Montant exact</span>
                      <strong className="billing-amount">
                        {cash(Number(row.expected_amount ?? 0), row.currency)}
                      </strong>
                    </div>
                    {selected.instructions && (
                      <div className="is-wide">
                        <span>Consignes</span>
                        <strong>{selected.instructions}</strong>
                      </div>
                    )}
                  </div>
                )}

                <ol className="billing-howto">
                  <li>Envoyez exactement {cash(Number(row.expected_amount ?? 0), row.currency)} au numéro indiqué.</li>
                  <li>Conservez la référence de transaction reçue par SMS.</li>
                  <li>Revenez ici et transmettez la preuve ci-dessous.</li>
                </ol>

                <Button
                  className="primary-action"
                  disabled={!method}
                  onClick={() => setStep('proof')}
                  data-testid="button-continue-to-proof"
                >
                  J’ai effectué le paiement <ArrowRight size={14} />
                </Button>
              </>
            )}

            {billing.data?.payment_config?.note && (
              <p className="payment-note">{billing.data.payment_config.note}</p>
            )}
          </section>
        </div>
      ) : (
        /* ---------------- Étape : preuve ---------------- */
        <section className="panel billing-proof" data-testid="panel-proof-form">
          <div className="panel-head">
            <div>
              <h2><FileText size={17} /> Transmettre la preuve de paiement</h2>
              <p>Ces informations seront vérifiées par l’administrateur</p>
            </div>
            <button type="button" className="button-link" onClick={() => setStep('instructions')} data-testid="button-back-instructions">
              <ArrowLeft size={13} /> Instructions
            </button>
          </div>

          <RequestSummary row={row} />

          <div className="settings-form">
            <div className="form-field">
              <span className="form-label">Moyen de paiement utilisé</span>
              <div className="method-choice" role="radiogroup" aria-label="Moyen utilisé">
                {usable.map((option) => (
                  <button
                    key={option.code}
                    type="button"
                    role="radio"
                    aria-checked={method === option.code}
                    className={`method-option${method === option.code ? ' is-selected' : ''}`}
                    onClick={() => setMethod(option.code)}
                    data-testid={`button-proof-method-${option.code}`}
                  >
                    <strong>{option.label}</strong>
                    <small>{option.number}</small>
                  </button>
                ))}
              </div>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label className="form-label" htmlFor="proof-amount">
                  Montant payé ({row.currency === 'XOF' ? 'FCFA' : row.currency})
                </label>
                <Input
                  id="proof-amount"
                  value={Number(row.expected_amount ?? 0)}
                  readOnly
                  aria-readonly="true"
                  className="is-readonly"
                  data-testid="input-proof-amount"
                />
                <small className="form-hint">
                  Montant imposé par l’offre choisie : il ne peut pas être modifié,
                  et le serveur refuse tout autre montant.
                </small>
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="proof-date">Date du paiement</label>
                <Input
                  id="proof-date"
                  type="date"
                  max={todayIso()}
                  value={paidOn}
                  onChange={(e) => setPaidOn(e.target.value)}
                  data-testid="input-proof-date"
                />
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="proof-reference">
                Référence de la transaction Mobile Money
              </label>
              <Input
                id="proof-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Ex. MP241021.1432.A12345"
                autoComplete="off"
                data-testid="input-proof-reference"
              />
              <small className="form-hint">
                Reçue par SMS après le transfert. Une même référence ne peut valider
                qu’un seul paiement, toutes agences confondues.
              </small>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="proof-payer">Nom du payeur (facultatif)</label>
              <Input
                id="proof-payer"
                value={payerName}
                onChange={(e) => setPayerName(e.target.value)}
                placeholder="Nom inscrit sur le transfert"
                data-testid="input-proof-payer"
              />
            </div>

            <div className="form-field">
              <span className="form-label">
                Capture ou reçu {proofRequired ? '(obligatoire)' : '(facultatif)'}
              </span>
              <label className={`upload-control proof-upload${proof ? ' has-file' : ''}`}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) => {
                    setProof(e.target.files?.[0] ?? null);
                    e.currentTarget.value = '';
                  }}
                  data-testid="input-proof-file"
                />
                {proof ? <FileText size={15} /> : <Upload size={15} />}
                {proof
                  ? `${proof.name} · ${(proof.size / 1024).toFixed(0)} Ko`
                  : 'JPG, PNG, WebP ou PDF · 5 Mo maximum'}
              </label>
              {proofIssue && <p className="form-error" role="alert">{proofIssue}</p>}
              <small className="form-hint">
                <ShieldCheck size={12} /> Stockage privé : seuls votre agence et
                l’administrateur peuvent l’ouvrir.
              </small>
            </div>

            <label className="billing-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="checkbox-proof-confirm"
              />
              <span>
                Je certifie que ces informations sont exactes et que le transfert a
                réellement été effectué pour le montant indiqué.
              </span>
            </label>

            {error && (
              <p className="form-error" role="alert" data-testid="status-proof-error">{error}</p>
            )}

            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => setStep('instructions')}>
                Retour
              </Button>
              <Button
                type="button"
                className="primary-action"
                onClick={submitProof}
                disabled={submit.isPending || Boolean(proofIssue)}
                data-testid="button-submit-proof"
              >
                {submit.isPending ? <Loader2 size={14} className="spin" /> : <ShieldCheck size={14} />}
                {submit.isPending ? 'Envoi…' : 'Transmettre la preuve'}
              </Button>
            </div>
          </div>
        </section>
      )}

      <p className="billing-footnote">
        <Info size={12} /> Une preuve transmise n’équivaut pas à un encaissement :
        seul l’administrateur, après vérification, valide le paiement.
        Limite de {MAX_PROOF_SIZE / 1024 / 1024} Mo par justificatif.
      </p>
    </>
  );
}
