import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { BackButton } from '@/components/back-button';
import { ArrowRight, CheckCircle2, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAuth } from '@/lib/auth-context';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { BrandMark } from '@/lib/workspace-ui';

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
  if (message.includes('already registered') || message.includes('already been registered') || message.includes('user_already_exists')) {
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

export default function SignupPage() {
  const { signUp, user, loading } = useAuth();
  const [, navigate] = useLocation();
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: '', password: '', confirm: '' },
  });

  const submit = async (values: SignupFormValues) => {
    setError('');
    setBusy(true);
    try {
      await signUp(values.email, values.password);
      setDone(true);
      // mailer_autoconfirm actif sur le projet : la session est ouverte,
      // direction l'onboarding de l'agence.
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
          <p>Vous êtes déjà connecté. Accédez à votre espace.</p>
          <Link href="/dashboard" className="text-action">Continuer vers mon espace <ArrowRight size={14} /></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      {/* BLOC 9 : retour visible aussi sur mobile (l'aside peut etre masque). */}
      <div className="public-back-row"><BackButton to="/login" label="Retour à la connexion" testId="button-back-signup" /></div>
      <div className="login-aside">
        <Link href="/login" className="brand-lockup" data-testid="link-signup-brand">
          <BrandMark />
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">Créez l’espace de votre agence</div>
          </div>
        </Link>
        <div className="login-aside-copy">
          <span className="eyebrow">Bamako · Inscription agence</span>
          <h1>Votre agence en ligne, <em>en quelques minutes.</em></h1>
          <p>Créez votre compte, renseignez les informations de votre agence et commencez à gérer vos biens immédiatement.</p>
          <div className="login-aside-rule"><LockKeyhole size={16} /><span>Accès isolé : chaque agence ne voit que ses données</span></div>
        </div>
        <span className="login-aside-foot">SOFIA IMMOBILIER <span>—</span> INSCRIPTION</span>
      </div>
      <main className="login-main">
        <div className="login-card">
          {done ? (
            <>
              <span className="form-kicker">Compte créé</span>
              <h2>Vérifiez votre e-mail</h2>
              <p>Un message de confirmation a été envoyé si la validation est activée. Sinon, l’onboarding de votre agence s’ouvre immédiatement.</p>
              <div className="login-aside-rule"><CheckCircle2 size={16} /><span>Vous pouvez aussi continuer directement.</span></div>
              <Button className="login-submit" onClick={() => navigate('/onboarding')} data-testid="button-goto-onboarding">
                Continuer vers l’onboarding <ArrowRight size={15} />
              </Button>
            </>
          ) : (
            <>
              <span className="form-kicker">Nouveau compte agence</span>
              <h2>Inscription</h2>
              <p>E-mail et mot de passe uniquement : les informations de l’agence suivront dans l’onboarding.</p>
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
                  <Button type="submit" className="login-submit" disabled={busy} data-testid="button-signup-submit">
                    {busy ? 'Création du compte…' : 'Créer mon compte'} <ArrowRight size={15} />
                  </Button>
                </form>
              </Form>
              <div className="login-footnote">
                <ShieldCheck size={14} /> Déjà un compte ? <Link href="/login" className="text-action" data-testid="link-login-from-signup">Se connecter</Link>
              </div>
            </>
          )}
        </div>
        <span className="login-copyright">© {new Date().getFullYear()} Sofia Immobilier · Bamako</span>
      </main>
    </div>
  );
}
