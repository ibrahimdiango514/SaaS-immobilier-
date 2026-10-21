// LOT A (point 4) — PAGE PUBLIQUE DE RACHAT D'UN LIEN D'INVITATION.
// Accessible SANS compte : c'est le jeton présent dans l'URL qui fait foi.
// Le serveur ne renvoie le nom de l'agence que si le jeton est valable :
// cette page ne demande donc jamais d'identifier une agence.
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowRight, CheckCircle2, LockKeyhole, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BrandMark } from '@/lib/workspace-ui';
import { redeemAgencyInvitation, teamErrorLabel } from '@/lib/agency-team-api';

const MIN_PASSWORD_LENGTH = 8;

export default function JoinAgencyPage() {
  const [, navigate] = useLocation();
  const token = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('token') ?? ''
    : '';

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ agency: string; email: string } | null>(null);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = Boolean(fullName.trim() && email.trim() && password.length >= MIN_PASSWORD_LENGTH && password === confirm);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await redeemAgencyInvitation({ token, email, fullName, password });
      setDone({ agency: result.agency_name, email: result.email });
    } catch (err) {
      setError(teamErrorLabel(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-aside">
        <Link href="/login" className="brand-lockup" data-testid="link-join-brand">
          <BrandMark />
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">Rejoindre une agence</div>
          </div>
        </Link>
        <div className="login-aside-copy">
          <span className="eyebrow">Bamako · Invitation équipe</span>
          <h2>Votre agence vous attend</h2>
          <p>Activez votre accès en quelques secondes. Choisissez votre mot de passe : vous seul le connaîtrez.</p>
        </div>
        <div className="login-aside-rule">
          <ShieldCheck size={16} />
          <span>Lien à usage unique · expire après 48 heures</span>
        </div>
      </div>

      <main className="login-main">
        <div className="login-card">
          {!token ? (
            <>
              <span className="form-kicker">Lien incomplet</span>
              <h2>Jeton manquant</h2>
              <p>Ce lien d’invitation ne contient pas de jeton. Demandez à votre agence de vous en renvoyer un.</p>
              <Link href="/login" className="text-action">Retour à la connexion <ArrowRight size={14} /></Link>
            </>
          ) : done ? (
            <>
              <span className="form-kicker">Compte créé</span>
              <h2 data-testid="text-join-success">Bienvenue chez {done.agency}</h2>
              <p>Votre compte <strong>{done.email}</strong> est actif. Connectez-vous pour accéder à votre espace.</p>
              <div className="login-aside-rule"><CheckCircle2 size={16} /><span>Aucun e-mail de confirmation n’est nécessaire.</span></div>
              <Button className="login-submit" onClick={() => navigate('/login')} data-testid="button-join-signin">
                Se connecter <ArrowRight size={15} />
              </Button>
            </>
          ) : (
            <>
              <span className="form-kicker">Invitation équipe</span>
              <h2>Créer votre accès</h2>
              <p>Renseignez vos informations pour activer l’invitation reçue.</p>
              <form onSubmit={(event) => void submit(event)} className="login-form">
                <label className="login-input-wrap">
                  <span><UserRound size={14} /> Nom complet</span>
                  <Input value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="Aminata Diallo" data-testid="input-join-name" />
                </label>
                <label className="login-input-wrap">
                  <span><Mail size={14} /> Adresse e-mail</span>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="vous@exemple.ml" data-testid="input-join-email" />
                </label>
                <label className="login-input-wrap">
                  <span><LockKeyhole size={14} /> Mot de passe</span>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder={`${MIN_PASSWORD_LENGTH} caractères minimum`} data-testid="input-join-password" />
                </label>
                <label className="login-input-wrap">
                  <span><LockKeyhole size={14} /> Confirmer</span>
                  <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required data-testid="input-join-confirm" />
                </label>
                {tooShort && <p className="form-error" role="alert">Le mot de passe doit contenir au moins {MIN_PASSWORD_LENGTH} caractères.</p>}
                {mismatch && <p className="form-error" role="alert">Les deux mots de passe ne correspondent pas.</p>}
                {error && <p className="form-error" role="alert" data-testid="status-join-error">{error}</p>}
                <Button type="submit" className="login-submit" disabled={!valid || busy} data-testid="button-join-submit">
                  {busy ? 'Activation…' : 'Activer mon accès'}
                </Button>
              </form>
              <p className="login-footnote">Ce lien ne fonctionne qu’une seule fois. En cas d’erreur, demandez un nouveau lien à votre agence.</p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
