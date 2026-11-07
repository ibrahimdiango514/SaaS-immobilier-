import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { BackButton } from '@/components/back-button';
import { ArrowRight, CheckCircle2, LockKeyhole, Mail, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAuth } from '@/lib/auth-context';
import {
  loadSignupSelectedPlanId,
  saveSignupSelectedPlanId,
  usePublicPlansCatalog,
} from '@/lib/pending-api';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { BrandMark, cash } from '@/lib/workspace-ui';

const signupSchema = z
  .object({
    email: z.string().trim().email('Adresse e-mail invalide'),
    password: z
      .string()
      .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
      .regex(/[0-9]/, 'Le mot de passe doit contenir au moins un chiffre'),
    confirm: z.string().min(1, 'Confirmez votre mot de passe'),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'Les deux mots de passe ne correspondent pas',
  });

type SignupFormValues = z.infer<typeof signupSchema>;

function mapSignupError(error: unknown): string {
  const message = (error as { message?: string })?.message?.toLowerCase() ?? '';
  if (
    message.includes('already registered') ||
    message.includes('already been registered') ||
    message.includes('user_already_exists')
  ) {
    return 'Cette adresse e-mail est déjà utilisée. Connectez-vous ou utilisez une autre adresse.';
  }
  if (message.includes('password')) {
    return 'Mot de passe trop faible : 8 caractères minimum, avec au moins un chiffre.';
  }
  if (message.includes('rate limit') || message.includes('security purposes')) {
    return 'Trop de tentatives. Attendez une minute avant de réessayer.';
  }
  return getSupabaseErrorMessage(error, 'créer le compte');
}

const unlimited = (value: number) => value >= 1_000_000_000;

export default function SignupPage() {
  const { signUp, user, loading } = useAuth();
  const plans = usePublicPlansCatalog();
  const [, navigate] = useLocation();
  const [selectedPlanId, setSelectedPlanId] = useState<string>(() => loadSignupSelectedPlanId() ?? '');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: '', password: '', confirm: '' },
  });

  useEffect(() => {
    if (selectedPlanId) {
      saveSignupSelectedPlanId(selectedPlanId);
    }
  }, [selectedPlanId]);

  const submit = async (values: SignupFormValues) => {
    setError('');
    if (!selectedPlanId) {
      setError('Veuillez choisir votre offre (Essentiel, Pro ou Premium) avant de créer votre compte.');
      return;
    }
    saveSignupSelectedPlanId(selectedPlanId);
    setBusy(true);
    try {
      await signUp(values.email, values.password);
      setDone(true);
      navigate('/onboarding');
    } catch (err) {
      setError(mapSignupError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loading && user && !done) {
    return (
      <div className="auth-loading">
        <div className="state-card">
          <div className="state-icon"><ShieldCheck size={19} /></div>
          <h2>Session déjà ouverte</h2>
          <p>Vous êtes déjà connecté. Poursuivez la création ou l’accès à votre espace.</p>
          <Link href="/dashboard" className="text-action">Continuer vers mon espace <ArrowRight size={14} /></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="public-back-row">
        <BackButton to="/login" label="Retour à la connexion" testId="button-back-signup" />
      </div>
      <div className="login-aside">
        <Link href="/login" className="brand-lockup" data-testid="link-signup-brand">
          <BrandMark />
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">Créez le dossier de votre agence</div>
          </div>
        </Link>
        <div className="login-aside-copy">
          <span className="eyebrow">Bamako · Mise en service accompagnée</span>
          <h1>Votre agence équipée, <em>installée sur site et prête à performer.</em></h1>
          <p>
            Choisissez votre offre, enregistrez votre agence : notre équipe procède à
            l’installation physique puis active vos <strong>14 jours d’essai gratuit</strong>{' '}
            avec 100 % des fonctionnalités de votre offre.
          </p>
          <div className="login-aside-rule">
            <Wrench size={16} />
            <span>Installation physique dédiée · aucun paiement en ligne demandé à l’inscription</span>
          </div>
          <div className="login-aside-rule">
            <LockKeyhole size={16} />
            <span>Isolation stricte : chaque agence ne voit que ses propres données</span>
          </div>
        </div>
        <span className="login-aside-foot">SOFIA IMMOBILIER <span>—</span> INSCRIPTION</span>
      </div>

      <main className="login-main">
        <div className="login-card" style={{ maxWidth: 560 }}>
          {done ? (
            <>
              <span className="form-kicker">Compte créé</span>
              <h2>Complétez le dossier de votre agence</h2>
              <p>
                Si la confirmation par e-mail est requise, validez le lien reçu puis
                finalisez les coordonnées de votre agence. Votre offre choisie est conservée.
              </p>
              <div className="login-aside-rule">
                <CheckCircle2 size={16} />
                <span>Offre pré-sélectionnée prête pour la création du dossier d’agence.</span>
              </div>
              <Button className="login-submit" onClick={() => navigate('/onboarding')} data-testid="button-goto-onboarding">
                Continuer vers le dossier d’agence <ArrowRight size={15} />
              </Button>
            </>
          ) : (
            <>
              <span className="form-kicker">Nouveau compte agence</span>
              <h2>1. Choisissez votre offre *</h2>
              <p>
                Sélection obligatoire : les frais d’installation sont réglés lors du déploiement
                physique, puis vous bénéficiez de <strong>14 jours d’essai gratuit</strong> dès
                l’activation par l’administrateur.
              </p>

              <div
                role="radiogroup"
                aria-label="Choix obligatoire de l'offre"
                style={{ display: 'grid', gap: 10, margin: '14px 0 18px' }}
                data-testid="group-signup-plans"
              >
                {plans.isLoading ? (
                  <p className="form-hint">Chargement des offres Essentiel, Pro et Premium…</p>
                ) : plans.error ? (
                  <p className="form-error" role="alert">
                    Impossible de charger le catalogue des offres : {getSupabaseErrorMessage(plans.error, 'charger les offres')}
                  </p>
                ) : (
                  (plans.data ?? []).map((plan) => {
                    const isSelected = selectedPlanId === plan.id;
                    return (
                      <button
                        type="button"
                        key={plan.id}
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => {
                          setSelectedPlanId(plan.id);
                          setError('');
                        }}
                        data-testid={`button-signup-plan-${plan.name}`}
                        style={{
                          textAlign: 'left',
                          padding: '12px 14px',
                          borderRadius: 12,
                          border: isSelected
                            ? '2px solid hsl(var(--primary))'
                            : '1px solid var(--si-border, rgba(120,130,125,0.28))',
                          background: isSelected
                            ? 'color-mix(in srgb, hsl(var(--primary)) 9%, transparent)'
                            : 'transparent',
                          cursor: 'pointer',
                          transition: 'border-color 0.15s ease, background 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Sparkles size={14} /> {plan.display_name}
                          </strong>
                          <span style={{ fontSize: 13, fontWeight: 700 }}>
                            {cash(plan.price_monthly, plan.currency)} / mois <small style={{ fontWeight: 400 }}>après 14j d’essai</small>
                          </span>
                        </div>
                        <div style={{ fontSize: 12.5, opacity: 0.86, marginTop: 4 }}>
                          Installation physique sur site : <strong>{cash(plan.setup_fee, plan.currency)}</strong>
                          {' · '}
                          {unlimited(plan.max_properties) ? 'Biens illimités' : `${plan.max_properties} biens`}
                          {' · '}
                          {unlimited(plan.max_members) ? 'Membres illimités' : `${plan.max_members} membres`}
                          {' · '}
                          {plan.monthly_agent_messages.toLocaleString('fr-FR')} msg IA/mois
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              <h2 style={{ fontSize: 17, marginBottom: 4 }}>2. Créez vos identifiants</h2>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(submit)} className="login-form" data-testid="form-signup">
                  <FormField control={form.control} name="email" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Adresse e-mail</FormLabel>
                      <div className="login-input-wrap"><Mail size={15} aria-hidden="true" />
                        <FormControl><Input {...field} type="email" autoComplete="email" placeholder="vous@agence.ml" data-testid="input-signup-email" /></FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="password" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mot de passe</FormLabel>
                      <div className="login-input-wrap"><LockKeyhole size={15} aria-hidden="true" />
                        <FormControl><Input {...field} type="password" autoComplete="new-password" placeholder="8 caractères minimum" data-testid="input-signup-password" /></FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="confirm" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Confirmer le mot de passe</FormLabel>
                      <div className="login-input-wrap"><LockKeyhole size={15} aria-hidden="true" />
                        <FormControl><Input {...field} type="password" autoComplete="new-password" placeholder="Retapez le mot de passe" data-testid="input-signup-confirm" /></FormControl>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                  {error && <p className="form-error" role="alert" data-testid="status-signup-error">{error}</p>}
                  <Button
                    type="submit"
                    className="login-submit"
                    disabled={busy || plans.isLoading || !selectedPlanId}
                    data-testid="button-signup-submit"
                  >
                    {busy ? 'Création du compte…' : 'Continuer avec cette offre'} <ArrowRight size={15} />
                  </Button>
                </form>
              </Form>
              <div className="login-footnote">
                <ShieldCheck size={14} /> Déjà un compte ?{' '}
                <Link href="/login" className="text-action" data-testid="link-login-from-signup">Se connecter</Link>
              </div>
            </>
          )}
        </div>
        <span className="login-copyright">© {new Date().getFullYear()} Sofia Immobilier · Bamako</span>
      </main>
    </div>
  );
}
