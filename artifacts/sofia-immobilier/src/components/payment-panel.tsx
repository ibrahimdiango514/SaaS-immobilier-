// =============================================================================
// BLOC 1 — Déclaration de paiement manuel (Orange Money / Wave).
// =============================================================================
// Affiche les instructions lues depuis platform_settings, le formulaire de
// déclaration (montant, date, moyen, référence, capture optionnelle) et
// l'historique des déclarations avec leur état.
//
// Le serveur refuse une déclaration hors agence : ce composant n'accorde rien.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CreditCard, FileText, ImageIcon, Info,
  Phone, ShieldCheck, Upload, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { cash, dateLabel, dateTimeLabel } from '@/lib/workspace-ui';
import {
  DECLARATION_STATUS_LABELS, PAYMENT_METHODS, describeDeclarationStatus,
  useAgencyPaymentAccess, useSubmitPaymentDeclaration, validateProofFile,
  type AgencyPaymentAccess, type PaymentDeclarationRow, type PaymentMethod,
} from '@/lib/payments-api';

const today = () => new Date().toISOString().slice(0, 10);

function channel(access: AgencyPaymentAccess | undefined, method: PaymentMethod) {
  const raw = access?.instructions?.[method] ?? {};
  return { name: (raw.name ?? '').trim(), number: (raw.number ?? '').trim() };
}

function InstructionsCard({ access }: { access: AgencyPaymentAccess }) {
  const beneficiary = (access.instructions?.beneficiary ?? '').trim();
  const note = (access.instructions?.note ?? '').trim();
  const configured = PAYMENT_METHODS.some((m) => channel(access, m.value).number);

  if (!configured) {
    return (
      <div className="notice-box" role="status" data-testid="status-payment-instructions-missing">
        <Info size={14} />
        <span>
          Les coordonnées de paiement n’ont pas encore été publiées par
          l’administrateur de la plateforme. Vous pouvez tout de même déclarer un
          paiement déjà effectué : saisissez la référence de votre transaction.
        </span>
      </div>
    );
  }

  return (
    <div className="payment-instructions" data-testid="panel-payment-instructions">
      <div className="payment-instructions-head">
        <Phone size={15} />
        <div>
          <strong>Comment payer</strong>
          {beneficiary && <span>Bénéficiaire : {beneficiary}</span>}
        </div>
      </div>
      <div className="payment-channels">
        {PAYMENT_METHODS.map((method) => {
          const info = channel(access, method.value);
          return (
            <div className={`payment-channel${info.number ? '' : ' is-empty'}`} key={method.value} data-testid={`channel-${method.value}`}>
              <span className="form-kicker">{method.label}</span>
              {info.number ? (
                <>
                  <strong>{info.number}</strong>
                  <small>{info.name || beneficiary || 'Bénéficiaire non précisé'}</small>
                </>
              ) : (
                <small>Numéro non publié</small>
              )}
            </div>
          );
        })}
      </div>
      {note && <p className="payment-note">{note}</p>}
    </div>
  );
}

function DeclarationRow({ row }: { row: PaymentDeclarationRow }) {
  const status = describeDeclarationStatus(row.status);
  return (
    <div className={`declaration-row is-${status}`} data-testid={`row-declaration-${row.id}`}>
      <span className="declaration-icon">
        {status === 'approved' ? <CheckCircle2 size={16} /> : status === 'rejected' ? <XCircle size={16} /> : <CreditCard size={16} />}
      </span>
      <div className="declaration-main">
        <strong>{cash(Number(row.amount), row.currency)}</strong>
        <small>
          {PAYMENT_METHODS.find((m) => m.value === row.method)?.label ?? row.method} ·
          {' '}payé le {dateLabel(row.paid_on)} · réf. {row.transaction_reference}
        </small>
        <small className="declaration-meta">Déclaré le {dateTimeLabel(row.created_at)}</small>
      </div>
      <div className="declaration-state">
        <span className={`status-pill declaration-status is-${status}`}>{DECLARATION_STATUS_LABELS[status]}</span>
        {status === 'rejected' && row.review_note && (
          <p className="declaration-reason" data-testid={`text-declaration-reason-${row.id}`}>
            Motif : {row.review_note}
          </p>
        )}
        {status === 'approved' && row.review_note && (
          <p className="declaration-reason is-ok">{row.review_note}</p>
        )}
      </div>
    </div>
  );
}

function DeclarationDialog({
  open,
  onOpenChange,
  access,
  agencyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  access: AgencyPaymentAccess;
  agencyId?: string;
}) {
  const submit = useSubmitPaymentDeclaration(agencyId);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('orange_money');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [proof, setProof] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setDone('');
    setProof(null);
    setReference('');
    setPaidOn(today());
    setMethod('orange_money');
    setAmount(access.expected_amount > 0 ? String(Math.round(access.expected_amount)) : '');
  }, [open, access.expected_amount]);

  const info = channel(access, method);
  const proofIssue = proof ? validateProofFile(proof) : null;

  const onSubmit = async () => {
    setError('');
    if (proofIssue) {
      setError(proofIssue);
      return;
    }
    try {
      await submit.mutateAsync({
        amount: Number(amount),
        method,
        transactionReference: reference,
        paidOn,
        proof,
      });
      setDone('Déclaration envoyée. L’administrateur va la vérifier.');
      window.setTimeout(() => onOpenChange(false), 1600);
    } catch (e) {
      setError(getSupabaseErrorMessage(e, 'déclarer le paiement'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="form-dialog payment-dialog" data-testid="dialog-payment-declaration">
        <DialogHeader>
          <span className="form-kicker">Paiement manuel</span>
          <DialogTitle>Déclarer mon paiement</DialogTitle>
          <DialogDescription>
            Indiquez le paiement que vous avez effectué. Il reste « en attente »
            jusqu’à sa validation par l’administrateur, qui prolonge alors votre
            abonnement d’un mois.
          </DialogDescription>
        </DialogHeader>

        {access.expected_amount > 0 && access.plan && (
          <div className="payment-expected" data-testid="status-expected-amount">
            <Info size={14} />
            <span>
              Montant attendu pour {access.plan.display_name} :
              {' '}<strong>{cash(access.expected_amount, access.plan.currency)}</strong> / mois.
            </span>
          </div>
        )}

        <div className="settings-form">
          <div className="form-field">
            <span className="form-label">Moyen de paiement</span>
            <div className="method-choice" role="radiogroup" aria-label="Moyen de paiement">
              {PAYMENT_METHODS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  role="radio"
                  aria-checked={method === option.value}
                  className={`method-option${method === option.value ? ' is-selected' : ''}`}
                  onClick={() => setMethod(option.value)}
                  data-testid={`button-method-${option.value}`}
                >
                  <strong>{option.label}</strong>
                  <small>{option.hint}</small>
                </button>
              ))}
            </div>
          </div>

          {info.number && (
            <div className="notice-box" data-testid="status-channel-target">
              <Phone size={14} />
              <span>
                Envoyez au <strong>{info.number}</strong>
                {info.name ? ` — ${info.name}` : ''}.
              </span>
            </div>
          )}

          <div className="form-grid">
            <div className="form-field">
              <label className="form-label" htmlFor="payment-amount">Montant payé (FCFA)</label>
              <Input
                id="payment-amount"
                type="number"
                min="0"
                step="500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                data-testid="input-payment-amount"
              />
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="payment-date">Date du paiement</label>
              <Input
                id="payment-date"
                type="date"
                max={today()}
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
                data-testid="input-payment-date"
              />
            </div>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="payment-reference">
              Référence de la transaction
            </label>
            <Input
              id="payment-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Ex. MP241021.1432.A12345"
              data-testid="input-payment-reference"
            />
            <small className="form-hint">
              Identifiant reçu par SMS après le transfert. Obligatoire.
            </small>
          </div>

          <div className="form-field">
            <span className="form-label">Capture du transfert (optionnelle)</span>
            <label className={`upload-control proof-upload${proof ? ' has-file' : ''}`}>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => { setProof(e.target.files?.[0] ?? null); e.currentTarget.value = ''; }}
                data-testid="input-payment-proof"
              />
              {proof ? <FileText size={15} /> : <Upload size={15} />}
              {proof ? proof.name : 'Joindre une capture (JPG, PNG, WebP ou PDF · 5 Mo max)'}
            </label>
            {proofIssue && <p className="form-error" role="alert">{proofIssue}</p>}
            <small className="form-hint">
              <ShieldCheck size={12} /> Stockage privé : visible par votre agence
              et l’administrateur uniquement.
            </small>
          </div>

          {error && <p className="form-error" role="alert" data-testid="status-payment-error">{error}</p>}
          {done && <p className="form-feedback" role="status" data-testid="status-payment-success">{done}</p>}

          <div className="form-actions">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-payment">
              Annuler
            </Button>
            <Button
              type="button"
              onClick={() => void onSubmit()}
              disabled={submit.isPending || !amount || !reference.trim() || !paidOn || Boolean(proofIssue)}
              data-testid="button-submit-payment"
            >
              {submit.isPending ? 'Envoi…' : 'Déclarer le paiement'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PaymentSection({ agencyId }: { agencyId?: string }) {
  const access = useAgencyPaymentAccess(agencyId);
  const [open, setOpen] = useState(false);
  const data = access.data;
  const declarations = useMemo(() => data?.declarations ?? [], [data]);
  const pending = declarations.filter((d) => describeDeclarationStatus(d.status) === 'pending');

  if (access.isLoading) return null;
  if (access.error || !data) {
    return (
      <div className="notice-box is-error" role="alert" data-testid="status-payment-access-error">
        <AlertTriangle size={14} />
        <span>{getSupabaseErrorMessage(access.error, 'charger les informations de paiement')}</span>
      </div>
    );
  }

  return (
    <section className="panel payment-panel" data-testid="panel-payment">
      <div className="panel-head">
        <div>
          <h2><CreditCard size={17} /> Paiement de l’abonnement</h2>
          <p>Déclarez un paiement Orange Money ou Wave, puis suivez sa validation.</p>
        </div>
        <Button
          className="primary-action"
          onClick={() => setOpen(true)}
          disabled={!data.can_manage}
          data-testid="button-pay-subscription"
        >
          <CreditCard size={14} /> Payer mon abonnement
        </Button>
      </div>

      {!data.can_manage && (
        <div className="permission-note" role="status" data-testid="status-payment-readonly">
          <ShieldCheck size={15} />
          <span>
            Seul le propriétaire ou un administrateur de l’agence peut déclarer un
            paiement. Vous pouvez consulter l’état des déclarations.
          </span>
        </div>
      )}

      {pending.length > 0 && (
        <div className="notice-box" role="status" data-testid="status-payment-pending">
          <Info size={14} />
          <span>
            {pending.length} déclaration(s) en attente de validation. Votre
            abonnement sera prolongé dès validation.
          </span>
        </div>
      )}

      <InstructionsCard access={data} />

      <div className="declaration-list" data-testid="list-declarations">
        {declarations.length ? (
          declarations.map((row) => <DeclarationRow key={row.id} row={row} />)
        ) : (
          <div className="empty-table" data-testid="empty-declarations">
            <div className="empty-table-mark"><ImageIcon size={17} /></div>
            <strong>Aucune déclaration</strong>
            <p>Vos paiements déclarés apparaîtront ici avec leur état.</p>
          </div>
        )}
      </div>

      <DeclarationDialog open={open} onOpenChange={setOpen} access={data} agencyId={agencyId} />
    </section>
  );
}
