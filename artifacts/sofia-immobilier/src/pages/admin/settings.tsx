// =============================================================================
// BLOC 2 (1) — ADMIN : réglages de la plateforme.
// =============================================================================
// Numéros de paiement, nom du bénéficiaire et délai de grâce. Ces valeurs sont
// lues par les agences (public.agency_payment_access) et par le calcul
// d'échéance (public.agency_billing_state lit `billing.grace_days`).
//
// Écriture : public.admin_update_platform_setting, dont la garde est
// is_platform_owner() — exactement la même que la politique RLS existante
// `platform_settings_admin_write`. Un administrateur non propriétaire voit
// l'écran en lecture seule.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Info, KeyRound, LockKeyhole, Phone, Save, ShieldCheck, Sparkles, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth-context';
import { usePlatformRole } from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
// BLOC 2 (session 3) : réglages de l'essai gratuit et de la validation admin.
import { adminSetSignupSettings } from '@/lib/trial-api';
import { LoadingRows, dateTimeLabel } from '@/lib/workspace-ui';
import {
  readBillingSettings, usePlatformSettings, useUpdatePlatformSetting,
} from '@/lib/admin-billing-api';
import {
  METHOD_LABELS, usePaymentConfig, useSavePaymentMethods,
  type PaymentMethodCode,
} from '@/lib/billing-api';

const METHOD_CODES: PaymentMethodCode[] = ['orange_money', 'moov_money', 'wave'];

interface MethodDraft {
  label: string;
  beneficiary: string;
  number: string;
  instructions: string;
  enabled: boolean;
  reference_required: boolean;
  proof_required: boolean;
}

const EMPTY_METHODS: Record<string, MethodDraft> = Object.fromEntries(
  METHOD_CODES.map((code) => [
    code,
    {
      label: METHOD_LABELS[code] ?? code,
      beneficiary: '',
      number: '',
      instructions: '',
      enabled: false,
      reference_required: true,
      proof_required: false,
    },
  ]),
);

export default function AdminSettingsPage() {
  const { user } = useAuth();
  const roleQ = usePlatformRole(user?.id);
  const settingsQ = usePlatformSettings();
  const update = useUpdatePlatformSetting();

  const [methods, setMethods] = useState<Record<string, MethodDraft>>(EMPTY_METHODS);
  const [proofRequired, setProofRequired] = useState(false);
  const [note, setNote] = useState('');
  const [graceDays, setGraceDays] = useState('5');
  const [requireValidation, setRequireValidation] = useState(false);
  const [trialDays, setTrialDays] = useState('14');
  const [trialMessage, setTrialMessage] = useState('');
  const [trialBusy, setTrialBusy] = useState(false);
  const [message, setMessage] = useState('');

  const isOwner = roleQ.data?.platformAdmin?.role === 'platform_owner';

  const billing = useMemo(() => readBillingSettings(settingsQ.data), [settingsQ.data]);
  const configQ = usePaymentConfig();
  const saveMethods = useSavePaymentMethods();

  // On repart TOUJOURS de la configuration réellement stockée (forme normalisée
  // renvoyée par la base), jamais d'un état local supposé.
  useEffect(() => {
    const config = configQ.data;
    if (!config) return;
    const next: Record<string, MethodDraft> = {};
    for (const code of METHOD_CODES) {
      const row = config.methods?.[code];
      next[code] = {
        label: row?.label ?? METHOD_LABELS[code] ?? code,
        beneficiary: row?.beneficiary ?? '',
        number: row?.number ?? '',
        instructions: row?.instructions ?? '',
        enabled: Boolean(row?.enabled),
        reference_required: row?.reference_required !== false,
        proof_required: Boolean(row?.proof_required),
      };
    }
    setMethods(next);
    setProofRequired(Boolean(config.proof_required));
    setNote(config.note ?? '');
  }, [configQ.data]);

  useEffect(() => {
    setGraceDays(String(billing.grace_days));
  }, [billing.grace_days]);

  const paymentRow = settingsQ.data?.find((row) => row.key === 'payment_instructions');
  const billingRow = settingsQ.data?.find((row) => row.key === 'billing');

  if (settingsQ.isLoading || roleQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Plateforme" title="Réglages" description="Chargement des réglages…" />
        <LoadingRows />
      </>
    );
  }

  const savePayments = async () => {
    setMessage('');
    // Garde-fou client : mêmes règles que public.admin_save_payment_methods.
    for (const code of METHOD_CODES) {
      const row = methods[code];
      if (!row) continue;
      if (row.number.trim() && !/^[0-9+() .-]{6,24}$/.test(row.number.trim())) {
        setMessage(`Numéro invalide pour ${METHOD_LABELS[code] ?? code} : chiffres, + ( ) . - uniquement.`);
        return;
      }
      if (row.enabled && !row.number.trim()) {
        setMessage(`${METHOD_LABELS[code] ?? code} est activé mais aucun numéro n’est renseigné.`);
        return;
      }
    }
    try {
      await saveMethods.mutateAsync({ methods, proofRequired, note });
      setMessage(
        'Moyens de paiement enregistrés. Les agences voient immédiatement ces instructions ; un moyen sans numéro reste bloqué.',
      );
    } catch (error) {
      setMessage(getSupabaseErrorMessage(error, 'enregistrer les coordonnées'));
    }
  };

  const saveBilling = async () => {
    setMessage('');
    const value = Number(graceDays);
    if (!Number.isInteger(value) || value < 0 || value > 60) {
      setMessage('Le délai de grâce doit être un nombre entier de jours entre 0 et 60.');
      return;
    }
    try {
      await update.mutateAsync({
        key: 'billing',
        value: { grace_days: value, reminder_days: billing.reminder_days ?? [5, 0] },
      });
      setMessage('Délai de grâce enregistré. Il s’applique au calcul des échéances.');
    } catch (error) {
      setMessage(getSupabaseErrorMessage(error, 'enregistrer le délai de grâce'));
    }
  };

  const disabled = !isOwner;

  return (
    <>
      <AdminHeading
        eyebrow="Plateforme"
        title="Réglages"
        description="Coordonnées de paiement affichées aux agences et délai de grâce avant suspension."
      />

      {settingsQ.error && (
        <div className="state-card error-state" role="alert">
          <h2>Réglages inaccessibles</h2>
          <p>{getSupabaseErrorMessage(settingsQ.error, 'charger les réglages')}</p>
          <Button variant="outline" onClick={() => void settingsQ.refetch()}>Réessayer</Button>
        </div>
      )}

      {!isOwner && (
        <div className="permission-note" role="status" data-testid="status-settings-readonly">
          <LockKeyhole size={15} />
          <span>
            Lecture seule : la modification des réglages est réservée au
            propriétaire de la plateforme.
          </span>
        </div>
      )}

      {message && (
        <p
          className={message.includes('Impossible') || message.includes('refusé') || message.includes('doit être') ? 'form-error module-error' : 'form-feedback'}
          role="status"
          data-testid="status-settings-message"
        >
          {message}
        </p>
      )}

      <div className="settings-stack">
        <section className="panel settings-panel" data-testid="panel-payment-settings">
          <div className="settings-heading">
            <div className="settings-icon"><Phone size={17} /></div>
            <div>
              <h2>Moyens de paiement</h2>
              <p>
                Numéros et consignes réellement affichés aux agences. Un moyen
                activé sans numéro est refusé ; un moyen sans numéro s’affiche
                « en cours de configuration » côté agence et la déclaration est
                bloquée.
              </p>
            </div>
            <span className={`permission-badge${isOwner ? ' allowed' : ''}`}>
              <KeyRound size={13} /> {isOwner ? 'Modification autorisée' : 'Lecture seule'}
            </span>
          </div>

          {configQ.error && (
            <p className="form-error" role="alert" data-testid="status-payment-config-error">
              {getSupabaseErrorMessage(configQ.error, 'charger la configuration des paiements')}
            </p>
          )}

          {configQ.data && !configQ.data.any_configured && (
            <div className="notice-box is-warning" role="alert" data-testid="status-payment-config-missing-settings">
              <AlertTriangle size={15} />
              <span>
                <strong>Aucun moyen de paiement publié.</strong> Toutes les agences
                sont bloquées à l’écran d’instructions : elles voient « moyen de
                paiement en cours de configuration » et ne peuvent pas transmettre
                de preuve. Renseignez le bénéficiaire et le numéro réel d’au moins
                un service ci-dessous, puis activez-le.
              </span>
            </div>
          )}

          {configQ.data && configQ.data.any_configured && (
            <p className="form-hint" data-testid="status-payment-config-ready">
              Moyens publiés et utilisables :{' '}
              {['orange_money', 'moov_money', 'wave']
                .filter((code) => configQ.data?.methods?.[code as PaymentMethodCode]?.configured)
                .map((code) => METHOD_LABELS[code] ?? code)
                .join(', ')}
              .
            </p>
          )}

          <div className="settings-form">
            <div className="billing-method-editor" data-testid="list-payment-methods">
              {METHOD_CODES.map((code) => {
                const row = methods[code] ?? EMPTY_METHODS[code];
                const updateRow = (patch: Partial<MethodDraft>) =>
                  setMethods((current) => ({ ...current, [code]: { ...row, ...patch } }));
                const configured = Boolean(row.number.trim());
                return (
                  <article
                    key={code}
                    className={`billing-method-card${row.enabled ? ' is-enabled' : ''}`}
                    data-testid={`card-method-${code}`}
                  >
                    <header>
                      <strong>{METHOD_LABELS[code] ?? code}</strong>
                      <span className={`billing-flag ${configured ? 'is-ok' : 'is-danger'}`}>
                        {configured ? 'Configuré' : 'En cours de configuration'}
                      </span>
                    </header>

                    <div className="form-grid">
                      <div className="form-field">
                        <label className="form-label" htmlFor={`method-${code}-beneficiary`}>
                          Bénéficiaire
                        </label>
                        <Input
                          id={`method-${code}-beneficiary`}
                          value={row.beneficiary}
                          onChange={(e) => updateRow({ beneficiary: e.target.value })}
                          disabled={disabled}
                          placeholder="Nom affiché au payeur"
                          data-testid={`input-method-${code}-beneficiary`}
                        />
                      </div>
                      <div className="form-field">
                        <label className="form-label" htmlFor={`method-${code}-number`}>
                          Numéro de paiement
                        </label>
                        <Input
                          id={`method-${code}-number`}
                          value={row.number}
                          onChange={(e) => updateRow({ number: e.target.value })}
                          disabled={disabled}
                          inputMode="tel"
                          placeholder="Chiffres, + ( ) . - uniquement"
                          data-testid={`input-method-${code}-number`}
                        />
                      </div>
                    </div>

                    <div className="form-field">
                      <label className="form-label" htmlFor={`method-${code}-instructions`}>
                        Consignes spécifiques (facultatif)
                      </label>
                      <Input
                        id={`method-${code}-instructions`}
                        value={row.instructions}
                        onChange={(e) => updateRow({ instructions: e.target.value })}
                        disabled={disabled}
                        placeholder="Ex. Indiquez la référence de la demande dans le motif du transfert."
                        data-testid={`input-method-${code}-instructions`}
                      />
                    </div>

                    <div className="billing-method-flags">
                      <label className="billing-confirm compact">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(e) => updateRow({ enabled: e.target.checked })}
                          disabled={disabled}
                          data-testid={`checkbox-method-${code}-enabled`}
                        />
                        <span>Activer ce moyen</span>
                      </label>
                      <label className="billing-confirm compact">
                        <input
                          type="checkbox"
                          checked={row.proof_required}
                          onChange={(e) => updateRow({ proof_required: e.target.checked })}
                          disabled={disabled}
                          data-testid={`checkbox-method-${code}-proof`}
                        />
                        <span>Justificatif obligatoire</span>
                      </label>
                    </div>
                  </article>
                );
              })}
            </div>

            <label className="billing-confirm">
              <input
                type="checkbox"
                checked={proofRequired}
                onChange={(e) => setProofRequired(e.target.checked)}
                disabled={disabled}
                data-testid="checkbox-proof-required"
              />
              <span>
                Exiger un justificatif pour tous les moyens de paiement (sinon le
                justificatif reste facultatif, la référence de transaction restant
                toujours obligatoire).
              </span>
            </label>

            <div className="form-field">
              <label className="form-label" htmlFor="setting-payment-note">Consigne affichée aux agences</label>
              <Textarea
                id="setting-payment-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={disabled}
                placeholder="Ex. Envoyez le montant exact puis transmettez la preuve avec la référence reçue par SMS."
                data-testid="input-setting-payment-note"
              />
            </div>

            <div className="form-actions">
              {paymentRow && (
                <span className="form-hint">
                  <Info size={12} /> Dernière modification : {dateTimeLabel(paymentRow.updated_at)}
                </span>
              )}
              <Button
                type="button"
                onClick={() => void savePayments()}
                disabled={disabled || saveMethods.isPending}
                data-testid="button-save-payment-settings"
              >
                <Save size={14} /> {saveMethods.isPending ? 'Enregistrement…' : 'Enregistrer les moyens de paiement'}
              </Button>
            </div>
          </div>
        </section>

        <section className="panel settings-panel" data-testid="panel-billing-settings">
          <div className="settings-heading">
            <div className="settings-icon"><Timer size={17} /></div>
            <div>
              <h2>Délai de grâce</h2>
              <p>Nombre de jours accordés après l’échéance avant suspension automatique.</p>
            </div>
            <span className={`permission-badge${isOwner ? ' allowed' : ''}`}>
              <KeyRound size={13} /> {isOwner ? 'Modification autorisée' : 'Lecture seule'}
            </span>
          </div>

          <div className="settings-form">
            <div className="form-field">
              <label className="form-label" htmlFor="setting-grace-days">Jours de grâce</label>
              <Input
                id="setting-grace-days"
                type="number"
                min="0"
                max="60"
                step="1"
                value={graceDays}
                onChange={(e) => setGraceDays(e.target.value)}
                disabled={disabled}
                data-testid="input-setting-grace-days"
              />
              <small className="form-hint">
                <ShieldCheck size={12} />
                Lu par la base pour le bandeau d’alerte des agences et par le job
                de suspension des impayés.
              </small>
            </div>
            <div className="form-actions">
              {billingRow && (
                <span className="form-hint">
                  <Info size={12} /> Dernière modification : {dateTimeLabel(billingRow.updated_at)}
                </span>
              )}
              <Button
                type="button"
                onClick={() => void saveBilling()}
                disabled={disabled || update.isPending}
                data-testid="button-save-billing-settings"
              >
                <Save size={14} /> {update.isPending ? 'Enregistrement…' : 'Enregistrer le délai'}
              </Button>
            </div>
          </div>
        </section>

        {/* BLOC 2 (session 3) — ESSAI GRATUIT ET VALIDATION À L'INSCRIPTION. */}
        <section className="panel settings-panel" data-testid="panel-trial-settings">
          <div className="settings-heading">
            <div className="settings-icon"><Sparkles size={17} /></div>
            <div>
              <h2>Essai gratuit et ouverture des comptes</h2>
              <p>
                Durée de l’essai et contrôle d’accès des nouvelles agences.
                Par défaut, une nouvelle agence ouvre son tableau de bord
                immédiatement en essai, sans validation.
              </p>
            </div>
            <span className={`permission-badge${isOwner ? ' allowed' : ''}`}>
              <KeyRound size={13} /> {isOwner ? 'Modification autorisée' : 'Lecture seule'}
            </span>
          </div>

          <div className="settings-form">
            <div className="form-field">
              <label className="form-label" htmlFor="setting-trial-days">Durée de l’essai (jours)</label>
              <Input
                id="setting-trial-days"
                type="number"
                min="1"
                max="90"
                step="1"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                disabled={disabled}
                data-testid="input-setting-trial-days"
              />
              <small className="form-hint">
                <ShieldCheck size={12} /> Un seul essai par agence. Les jours d’essai
                ne sont jamais déduits de la première période payée.
              </small>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="setting-require-validation">
                <input
                  id="setting-require-validation"
                  type="checkbox"
                  checked={requireValidation}
                  onChange={(e) => setRequireValidation(e.target.checked)}
                  disabled={disabled}
                  data-testid="checkbox-require-admin-validation"
                />{' '}
                Validation administrateur requise avant ouverture du dashboard
              </label>
              <small className="form-hint">
                <Info size={12} /> Décoché (par défaut) : la nouvelle agence entre
                directement en essai. Coché : elle attend votre validation.
              </small>
            </div>
            <div className="form-actions">
              <Button
                type="button"
                disabled={disabled || trialBusy}
                onClick={() => {
                  setTrialMessage('');
                  setTrialBusy(true);
                  adminSetSignupSettings(requireValidation, Number(trialDays) || 14)
                    .then((settings) => {
                      setTrialDays(String(settings.trial_days));
                      setRequireValidation(settings.require_admin_validation);
                      setTrialMessage('Réglages de l’essai enregistrés.');
                    })
                    .catch((error: unknown) => setTrialMessage(getSupabaseErrorMessage(error, 'enregistrer les réglages de l’essai')))
                    .finally(() => setTrialBusy(false));
                }}
                data-testid="button-save-trial-settings"
              >
                <Save size={14} /> {trialBusy ? 'Enregistrement…' : 'Enregistrer l’essai'}
              </Button>
              {trialMessage && <span className="form-hint" role="status">{trialMessage}</span>}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
