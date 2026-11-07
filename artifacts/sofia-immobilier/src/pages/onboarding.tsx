import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  ArrowLeft, ArrowRight, Building2, CheckCircle2, ImagePlus, MapPin, Phone,
  ShieldCheck, Sparkles, Wrench, X,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BackButton } from '@/components/back-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAuth } from '@/lib/auth-context';
import { validateLogoFile } from '@/lib/agency-logo';
import { useAgency } from '@/lib/agency-context';
import { useCreateAgency } from '@/lib/data-hooks';
import {
  clearSignupSelectedPlanId,
  loadSignupSelectedPlanId,
  saveSignupSelectedPlanId,
  usePublicPlansCatalog,
} from '@/lib/pending-api';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { BrandMark, cash } from '@/lib/workspace-ui';

/** Libellés français des modules, identiques à la page Mon offre. */
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

const onboardingSchema = z.object({
  name: z.string().trim().min(2, 'Le nom de l’agence est obligatoire (2 caractères minimum)'),
  legal_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Adresse e-mail invalide').or(z.literal('')).optional(),
  address: z.string().optional(),
  city: z.string().trim().min(1, 'La ville est obligatoire'),
  description: z.string().optional(),
});
type OnboardingValues = z.infer<typeof onboardingSchema>;

const STEPS = [
  { key: 'identity', title: 'Votre agence', subtitle: 'Nom et raison sociale', icon: Building2 },
  { key: 'contact', title: 'Coordonnées', subtitle: 'Téléphone, adresse, ville', icon: Phone },
  { key: 'branding', title: 'Présentation', subtitle: 'Logo et description', icon: ImagePlus },
  { key: 'plan', title: 'Votre offre *', subtitle: 'Essentiel, Pro ou Premium', icon: Sparkles },
  { key: 'review', title: 'Confirmation', subtitle: 'Vérifiez puis enregistrez', icon: CheckCircle2 },
];

const unlimited = (value: number) => value >= 1_000_000_000;

export default function OnboardingPage() {
  const { user, loading, signOut } = useAuth();
  const { memberships, loading: agencyLoading } = useAgency();
  const createAgency = useCreateAgency();
  const plans = usePublicPlansCatalog();
  const [chosenPlanId, setChosenPlanId] = useState<string | null>(() => loadSignupSelectedPlanId());
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [logo, setLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  const form = useForm<OnboardingValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      name: '',
      legal_name: '',
      phone: '',
      email: user?.email ?? '',
      address: '',
      city: 'Bamako',
      description: '',
    },
  });

  useEffect(() => {
    if (user?.email && !form.getValues('email')) {
      form.setValue('email', user.email);
    }
  }, [user?.email, form]);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/login');
      return;
    }
    if (!agencyLoading && memberships.length > 0) {
      navigate('/dashboard');
    }
  }, [loading, user, agencyLoading, memberships, navigate]);

  useEffect(() => {
    if (chosenPlanId) {
      saveSignupSelectedPlanId(chosenPlanId);
    }
  }, [chosenPlanId]);

  useEffect(() => () => {
    if (logoPreview) URL.revokeObjectURL(logoPreview);
  }, [logoPreview]);

  const progress = useMemo(() => `${((step + 1) / STEPS.length) * 100}%`, [step]);
  const selectedPlan = useMemo(
    () => (plans.data ?? []).find((p) => p.id === chosenPlanId) ?? null,
    [plans.data, chosenPlanId],
  );

  const goNext = async () => {
    setFormError('');
    const fieldsByStep: Array<Array<keyof OnboardingValues>> = [
      ['name'],
      ['city'],
      [],
      [],
      [],
    ];
    const fields = fieldsByStep[step];
    const valid = fields.length ? await form.trigger(fields) : true;
    if (!valid) return;

    if (step === 3 && !chosenPlanId) {
      setFormError('Le choix d’une offre (Essentiel, Pro ou Premium) est obligatoire pour continuer.');
      return;
    }

    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setFormError('');
    setStep((s) => Math.max(s - 1, 0));
  };

  const submit = async (values: OnboardingValues) => {
    setFormError('');
    if (!chosenPlanId) {
      setFormError('Veuillez sélectionner une offre (Essentiel, Pro ou Premium) avant d’enregistrer votre agence.');
      setStep(3);
      return;
    }
    try {
      await createAgency.mutateAsync({
        name: values.name,
        plan_id: chosenPlanId,
        legal_name: values.legal_name || null,
        phone: values.phone || null,
        email: values.email || null,
        address: values.address || null,
        city: values.city,
        description: values.description || null,
        logo,
      });
      clearSignupSelectedPlanId();
      // L'agence est créée en statut `pending` : WorkspaceGate affiche l'écran
      // d'attente d'installation physique et d'activation administrative.
      navigate('/dashboard');
    } catch (error) {
      const message = getSupabaseErrorMessage(error, 'enregistrer le dossier de l’agence');
      setFormError(
        message.toLowerCase().includes('duplicate') || message.toLowerCase().includes('slug')
          ? 'Une agence portant ce nom existe déjà. Choisissez un autre nom.'
          : message,
      );
      if (message.toLowerCase().includes('offre')) {
        setStep(3);
      }
    }
  };

  if (loading) {
    return (
      <div className="auth-loading">
        <div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div>
        <p className="auth-loading-caption">Chargement de votre espace…</p>
      </div>
    );
  }

  const values = form.getValues();

  return (
    <div className="onboarding-page">
      <header className="onboarding-header">
        <BackButton to="/login" label="Retour" testId="button-back-onboarding" />
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">Dossier d’inscription de votre agence</div>
          </div>
        </div>
        <button
          type="button"
          className="text-action"
          onClick={() => void signOut()}
          data-testid="button-signout-onboarding"
        >
          Se déconnecter
        </button>
      </header>

      <main className="onboarding-main">
        <section className="onboarding-progress" aria-label="Progression">
          <div className="onboarding-progress-track"><span style={{ width: progress }} /></div>
          <ol className="onboarding-steps">
            {STEPS.map((item, index) => (
              <li key={item.key} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}>
                <span className="onboarding-step-icon">
                  {index < step ? <CheckCircle2 size={15} /> : <item.icon size={15} />}
                </span>
                <div><strong>{item.title}</strong><small>{item.subtitle}</small></div>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel onboarding-card" data-testid="card-onboarding">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="onboarding-form">
              {step === 0 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 1 sur 5</span>
                  <h1>Comment s’appelle votre agence ?</h1>
                  <p>Ce nom apparaîtra dans votre espace de travail et sur votre dossier d’installation.</p>
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem><FormLabel>Nom commercial de l’agence *</FormLabel><FormControl>
                      <Input {...field} placeholder="Ex. Immo Bamako Conseil" data-testid="input-onboarding-name" autoFocus />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="legal_name" render={({ field }) => (
                    <FormItem><FormLabel>Raison sociale (optionnel)</FormLabel><FormControl>
                      <Input {...field} placeholder="Ex. SARL Immo Bamako" data-testid="input-onboarding-legal-name" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {step === 1 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 2 sur 5</span>
                  <h1>Où intervenir pour l’installation ?</h1>
                  <p>Ces coordonnées permettent à notre équipe de planifier le déploiement physique de votre agence.</p>
                  <div className="form-grid">
                    <FormField control={form.control} name="phone" render={({ field }) => (
                      <FormItem><FormLabel>Téléphone</FormLabel><FormControl>
                        <Input {...field} placeholder="+223 70 00 00 00" data-testid="input-onboarding-phone" />
                      </FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={form.control} name="email" render={({ field }) => (
                      <FormItem><FormLabel>E-mail de l’agence</FormLabel><FormControl>
                        <Input {...field} type="email" placeholder="contact@agence.ml" data-testid="input-onboarding-email" />
                      </FormControl><FormMessage /></FormItem>
                    )} />
                  </div>
                  <FormField control={form.control} name="address" render={({ field }) => (
                    <FormItem><FormLabel>Adresse physique</FormLabel><FormControl>
                      <Input {...field} placeholder="Quartier, rue, immeuble, repère…" data-testid="input-onboarding-address" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                  <FormField control={form.control} name="city" render={({ field }) => (
                    <FormItem><FormLabel>Ville *</FormLabel><FormControl>
                      <Input {...field} placeholder="Bamako" data-testid="input-onboarding-city" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {step === 2 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 3 sur 5</span>
                  <h1>Présentez votre agence</h1>
                  <p>Logo (JPG, PNG ou WebP — 2 Mo max., redimensionné automatiquement) et description courte.</p>
                  <div className="logo-picker">
                    {logoPreview ? (
                      <div className="logo-preview">
                        <img src={logoPreview} alt="Aperçu du logo" />
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => { setLogo(null); setLogoPreview(null); }}
                          aria-label="Retirer le logo"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <label className="upload-control">
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const invalid = validateLogoFile(file);
                            if (invalid) {
                              setFormError(invalid);
                              e.currentTarget.value = '';
                              return;
                            }
                            setFormError('');
                            setLogo(file);
                            setLogoPreview(URL.createObjectURL(file));
                          }}
                          data-testid="input-onboarding-logo"
                        />
                        <ImagePlus size={15} /> Choisir un logo
                      </label>
                    )}
                  </div>
                  <FormField control={form.control} name="description" render={({ field }) => (
                    <FormItem><FormLabel>Description de l’agence</FormLabel><FormControl>
                      <Textarea {...field} placeholder="Spécialistes de l’immobilier à Bamako depuis 2020…" data-testid="input-onboarding-description" />
                    </FormControl><FormMessage /></FormItem>
                  )} />
                </div>
              )}

              {step === 3 && (
                <section className="onboarding-plan-step" data-testid="step-choose-plan">
                  <header className="onboarding-step-head">
                    <span className="form-kicker">Étape 4 sur 5 · Choix obligatoire</span>
                    <h2>Choisissez votre offre *</h2>
                    <p>
                      Les frais d’installation sont encaissés <strong>physiquement lors de la mise en service sur site</strong>{' '}
                      (hors paiement en ligne). Dès l’activation par l’administrateur, vous bénéficiez de{' '}
                      <strong>14 jours d’essai gratuit</strong> avec 100 % des fonctionnalités et quotas de votre offre.
                      L’abonnement mensuel ne démarre qu’à la fin des 14 jours d’essai.
                    </p>
                  </header>
                  {plans.isLoading ? (
                    <p className="form-hint">Chargement des offres…</p>
                  ) : plans.error ? (
                    <p className="form-feedback is-error" role="alert">
                      Impossible de charger les offres : {getSupabaseErrorMessage(plans.error, 'charger les offres')}
                    </p>
                  ) : (
                    <div className="plan-grid" role="radiogroup" aria-label="Offres disponibles">
                      {(plans.data ?? []).map((plan) => {
                        const isChosen = chosenPlanId === plan.id;
                        return (
                          <button
                            type="button"
                            key={plan.id}
                            role="radio"
                            aria-checked={isChosen}
                            className={`plan-card is-selectable${isChosen ? ' is-chosen' : ''}`}
                            onClick={() => {
                              setChosenPlanId(plan.id);
                              setFormError('');
                            }}
                            data-testid={`button-onboarding-plan-${plan.name}`}
                          >
                            <header>
                              <strong>{plan.display_name}</strong>
                              {isChosen && <span className="status-tag">Choisie</span>}
                            </header>
                            <p className="plan-price">
                              {cash(Number(plan.price_monthly), plan.currency)}
                              <small> / mois après 14j d’essai</small>
                            </p>
                            <p className="plan-setup">
                              <Wrench size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                              Installation physique sur site :{' '}
                              <strong>{cash(Number(plan.setup_fee ?? 0), plan.currency)}</strong>
                            </p>
                            <ul className="plan-features">
                              <li>
                                <CheckCircle2 size={12} />{' '}
                                {unlimited(plan.max_properties) ? 'Biens illimités' : `Jusqu’à ${plan.max_properties} biens`}
                              </li>
                              <li>
                                <CheckCircle2 size={12} />{' '}
                                {unlimited(plan.max_members) ? 'Utilisateurs illimités' : `Jusqu’à ${plan.max_members} membres`}
                              </li>
                              <li>
                                <CheckCircle2 size={12} />{' '}
                                {plan.monthly_agent_messages.toLocaleString('fr-FR')} messages IA / mois
                              </li>
                              {(plan.modules ?? []).slice(0, 6).map((mod: string) => (
                                <li key={mod}>
                                  <CheckCircle2 size={12} /> {MODULE_LABELS[mod] ?? mod.replace(/_/g, ' ')}
                                </li>
                              ))}
                            </ul>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="form-hint" data-testid="hint-onboarding-plan-rule">
                    Pendant l’attente d’installation et les 14 jours d’essai, toute modification d’offre
                    impliquant un changement des frais d’installation est effectuée par l’administrateur Sofia.
                  </p>
                </section>
              )}

              {step === 4 && (
                <div className="onboarding-step">
                  <span className="form-kicker">Étape 5 sur 5</span>
                  <h1>Vérifiez votre dossier avant enregistrement</h1>
                  <p>
                    Votre agence sera enregistrée en attente d’installation physique. Dès la mise en
                    service validée par l’administrateur, vos 14 jours d’essai gratuit démarreront automatiquement.
                  </p>
                  <div className="review-list" data-testid="display-onboarding-review">
                    <div><span>Agence</span><strong>{values.name || '—'}</strong></div>
                    <div><span>Raison sociale</span><strong>{values.legal_name || 'Non renseignée'}</strong></div>
                    <div><span>Téléphone</span><strong>{values.phone || 'Non renseigné'}</strong></div>
                    <div><span>E-mail</span><strong>{values.email || 'Non renseigné'}</strong></div>
                    <div><span>Adresse</span><strong>{[values.address, values.city].filter(Boolean).join(', ') || '—'}</strong></div>
                    <div><span>Logo</span><strong>{logo ? logo.name : 'Ajouté plus tard'}</strong></div>
                    <div>
                      <span>Offre retenue</span>
                      <strong data-testid="review-selected-plan">
                        {selectedPlan ? selectedPlan.display_name : 'Aucune offre choisie'}
                      </strong>
                    </div>
                    <div>
                      <span>Frais d’installation physique</span>
                      <strong>
                        {selectedPlan ? `${cash(selectedPlan.setup_fee, selectedPlan.currency)} (sur site)` : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Essai gratuit à l’activation</span>
                      <strong>14 jours complets (100 % des quotas de l’offre)</strong>
                    </div>
                    <div>
                      <span>Abonnement après les 14 jours</span>
                      <strong>
                        {selectedPlan
                          ? `${cash(selectedPlan.price_monthly, selectedPlan.currency)} / mois (via SasPay)`
                          : '—'}
                      </strong>
                    </div>
                  </div>
                  <div className="notice-box">
                    <ShieldCheck size={14} />
                    <span>
                      Aucun paiement en ligne n’est demandé aujourd’hui. À l’issue des 14 jours d’essai,
                      les règlements mensuels s’effectuent via SasPay (les frais éventuels de transaction
                      dépendent du moyen de paiement choisi).
                    </span>
                  </div>
                </div>
              )}

              {formError && <p className="form-error" role="alert" data-testid="status-onboarding-error">{formError}</p>}

              <div className="onboarding-actions">
                {step > 0 ? (
                  <Button type="button" variant="outline" onClick={goBack} disabled={createAgency.isPending} data-testid="button-onboarding-back">
                    <ArrowLeft size={15} /> Retour
                  </Button>
                ) : (
                  <span />
                )}
                {step < STEPS.length - 1 ? (
                  <Button
                    type="button"
                    onClick={() => void goNext()}
                    disabled={step === 3 && !chosenPlanId}
                    data-testid="button-onboarding-next"
                  >
                    Continuer <ArrowRight size={15} />
                  </Button>
                ) : (
                  <Button type="submit" disabled={createAgency.isPending || !chosenPlanId} data-testid="button-onboarding-submit">
                    {createAgency.isPending ? 'Enregistrement du dossier…' : 'Enregistrer mon agence'} <CheckCircle2 size={15} />
                  </Button>
                )}
              </div>
            </form>
          </Form>
        </section>

        <p className="onboarding-foot">
          <MapPin size={13} /> Vos données sont isolées par agence grâce aux politiques de sécurité RLS.
        </p>
      </main>
    </div>
  );
}
