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
import { Info, KeyRound, LockKeyhole, Phone, Save, ShieldCheck, Sparkles, Timer } from 'lucide-react';
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
  readBillingSettings, readPaymentInstructions, usePlatformSettings,
  useUpdatePlatformSetting,
} from '@/lib/admin-billing-api';

export default function AdminSettingsPage() {
  const { user } = useAuth();
  const roleQ = usePlatformRole(user?.id);
  const settingsQ = usePlatformSettings();
  const update = useUpdatePlatformSetting();

  const [orangeNumber, setOrangeNumber] = useState('');
  const [orangeName, setOrangeName] = useState('');
  const [waveNumber, setWaveNumber] = useState('');
  const [waveName, setWaveName] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [note, setNote] = useState('');
  const [graceDays, setGraceDays] = useState('5');
  const [requireValidation, setRequireValidation] = useState(false);
  const [trialDays, setTrialDays] = useState('14');
  const [trialMessage, setTrialMessage] = useState('');
  const [trialBusy, setTrialBusy] = useState(false);
  const [message, setMessage] = useState('');

  const isOwner = roleQ.data?.platformAdmin?.role === 'platform_owner';

  const instructions = useMemo(() => readPaymentInstructions(settingsQ.data), [settingsQ.data]);
  const billing = useMemo(() => readBillingSettings(settingsQ.data), [settingsQ.data]);

  useEffect(() => {
    setOrangeNumber(instructions.orange_money.number);
    setOrangeName(instructions.orange_money.name);
    setWaveNumber(instructions.wave.number);
    setWaveName(instructions.wave.name);
    setBeneficiary(instructions.beneficiary ?? '');
    setNote(instructions.note ?? '');
  }, [instructions]);

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
    try {
      await update.mutateAsync({
        key: 'payment_instructions',
        value: {
          orange_money: { name: orangeName.trim(), number: orangeNumber.trim() },
          wave: { name: waveName.trim(), number: waveNumber.trim() },
          beneficiary: beneficiary.trim(),
          note: note.trim(),
        },
      });
      setMessage('Coordonnées de paiement enregistrées. Les agences les voient immédiatement.');
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
              <h2>Coordonnées de paiement</h2>
              <p>Affichées dans « Mon offre » de chaque agence, avant la déclaration.</p>
            </div>
            <span className={`permission-badge${isOwner ? ' allowed' : ''}`}>
              <KeyRound size={13} /> {isOwner ? 'Modification autorisée' : 'Lecture seule'}
            </span>
          </div>

          <div className="settings-form">
            <div className="form-field">
              <label className="form-label" htmlFor="setting-beneficiary">Nom du bénéficiaire</label>
              <Input
                id="setting-beneficiary"
                value={beneficiary}
                onChange={(e) => setBeneficiary(e.target.value)}
                disabled={disabled}
                placeholder="Ex. Sofia Immobilier SARL"
                data-testid="input-setting-beneficiary"
              />
              <small className="form-hint">
                Nom qui doit apparaître sur le téléphone du payeur au moment du transfert.
              </small>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label className="form-label" htmlFor="setting-orange-number">Numéro Orange Money</label>
                <Input
                  id="setting-orange-number"
                  value={orangeNumber}
                  onChange={(e) => setOrangeNumber(e.target.value)}
                  disabled={disabled}
                  placeholder="Ex. +223 70 00 00 00"
                  inputMode="tel"
                  data-testid="input-setting-orange-number"
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="setting-orange-name">Titulaire Orange Money</label>
                <Input
                  id="setting-orange-name"
                  value={orangeName}
                  onChange={(e) => setOrangeName(e.target.value)}
                  disabled={disabled}
                  placeholder="Ex. Ibrahim Diango"
                  data-testid="input-setting-orange-name"
                />
              </div>
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label className="form-label" htmlFor="setting-wave-number">Numéro Wave</label>
                <Input
                  id="setting-wave-number"
                  value={waveNumber}
                  onChange={(e) => setWaveNumber(e.target.value)}
                  disabled={disabled}
                  placeholder="Ex. +223 60 00 00 00"
                  inputMode="tel"
                  data-testid="input-setting-wave-number"
                />
              </div>
              <div className="form-field">
                <label className="form-label" htmlFor="setting-wave-name">Titulaire Wave</label>
                <Input
                  id="setting-wave-name"
                  value={waveName}
                  onChange={(e) => setWaveName(e.target.value)}
                  disabled={disabled}
                  placeholder="Ex. Ibrahim Diango"
                  data-testid="input-setting-wave-name"
                />
              </div>
            </div>

            <div className="form-field">
              <label className="form-label" htmlFor="setting-payment-note">Consigne affichée aux agences</label>
              <Textarea
                id="setting-payment-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={disabled}
                placeholder="Ex. Envoyez le montant exact puis déclarez le paiement avec la référence reçue par SMS."
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
                disabled={disabled || update.isPending}
                data-testid="button-save-payment-settings"
              >
                <Save size={14} /> {update.isPending ? 'Enregistrement…' : 'Enregistrer les coordonnées'}
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
