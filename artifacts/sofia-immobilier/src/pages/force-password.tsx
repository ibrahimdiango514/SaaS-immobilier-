// LOT A (point 4) — CHANGEMENT DE MOT DE PASSE OBLIGATOIRE À LA PREMIÈRE CONNEXION.
// Un compte créé par le propriétaire reçoit un mot de passe temporaire et le
// drapeau user_profiles.must_change_password = true. Tant qu'il n'est pas
// changé, aucune page de l'espace de travail n'est accessible.
import { useState } from 'react';
import { BackButton } from '@/components/back-button';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BrandMark } from '@/lib/workspace-ui';
import { getSupabaseClient, getSupabaseErrorMessage } from '@/lib/supabase';

const MIN_PASSWORD_LENGTH = 8;

export default function ForcePasswordPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const change = useMutation({
    mutationFn: async (nextPassword: string) => {
      const client = getSupabaseClient();
      // 1. Le mot de passe lui-même : seul Supabase Auth peut le changer.
      const { error: authError } = await client.auth.updateUser({ password: nextPassword });
      if (authError) throw authError;
      // 2. Le drapeau : la politique RLS « user_profiles_update_self » autorise
      //    l'utilisateur à lever son propre drapeau, et uniquement le sien.
      const { data: session } = await client.auth.getSession();
      const userId = session.session?.user.id;
      if (userId) {
        // user_profiles vit dans saas_immobilier, pas dans public.
        await (client.schema('saas_immobilier') as unknown as {
          from: (t: string) => { update: (v: Record<string, unknown>) => { eq: (c: string, v: string) => Promise<{ error: unknown }> } };
        }).from('user_profiles').update({ must_change_password: false }).eq('id', userId);
      }
    },
    onSuccess: () => onDone(),
    onError: (err) => setError(getSupabaseErrorMessage(err, 'changer le mot de passe')),
  });

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = password.length >= MIN_PASSWORD_LENGTH && password === confirm;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || change.isPending) return;
    setError('');
    change.mutate(password);
  };

  return (
    <div className="login-page">
      <div className="public-back-row"><BackButton to="/login" label="Revenir à la connexion" testId="button-back-force-password" /></div>
      <div className="login-aside">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">Sécurisez votre accès</div>
          </div>
        </div>
        <div className="login-aside-copy">
          <span className="eyebrow">Première connexion</span>
          <h2>Choisissez votre mot de passe</h2>
          <p>Votre accès a été créé par votre agence avec un mot de passe temporaire. Pour protéger vos données, vous devez le remplacer avant de continuer.</p>
        </div>
        <div className="login-aside-rule">
          <ShieldCheck size={16} />
          <span>Votre agence ne connaîtra jamais ce nouveau mot de passe.</span>
        </div>
      </div>

      <main className="login-main">
        <div className="login-card">
          <span className="form-kicker"><KeyRound size={13} /> Étape obligatoire</span>
          <h2>Changer le mot de passe temporaire</h2>
          <p>Tant que ce mot de passe n’est pas remplacé, l’espace de travail reste verrouillé.</p>
          <form onSubmit={submit} className="login-form">
            <label className="login-input-wrap">
              <span><LockKeyhole size={14} /> Nouveau mot de passe</span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder={`${MIN_PASSWORD_LENGTH} caractères minimum`} data-testid="input-new-password" />
            </label>
            <label className="login-input-wrap">
              <span><LockKeyhole size={14} /> Confirmer</span>
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required data-testid="input-new-password-confirm" />
            </label>
            {tooShort && <p className="form-error" role="alert">Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères.</p>}
            {mismatch && <p className="form-error" role="alert">Les deux mots de passe ne correspondent pas.</p>}
            {error && <p className="form-error" role="alert" data-testid="status-force-password-error">{error}</p>}
            <Button type="submit" className="login-submit" disabled={!valid || change.isPending} data-testid="button-force-password-submit">
              {change.isPending ? 'Enregistrement…' : 'Enregistrer et continuer'}
            </Button>
          </form>
          <div className="login-aside-rule">
            <CheckCircle2 size={16} />
            <span>Vous ne pouvez pas ignorer cette étape ni revenir en arrière.</span>
          </div>
        </div>
      </main>
    </div>
  );
}
