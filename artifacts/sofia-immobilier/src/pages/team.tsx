// LOT A (point 4) — PAGE ÉQUIPE.
// Réservée au propriétaire et aux administrateurs de l'agence.
// Toute autorisation est tranchée côté serveur (has_agency_role sur le JWT) :
// cette page ne fait qu'afficher et transmettre, elle n'accorde rien.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, Copy, KeyRound, Link2, LockKeyhole, MessageCircle, RotateCcw, ShieldCheck,
  UserPlus, UserRound, UserX, UsersRound, X,
} from 'lucide-react';
import { ButtonPrimary, ErrorState, Heading, LoadingRows, roleNames, useSafeRetry, safeFormat } from '@/lib/workspace-ui';
import { useAgency } from '@/lib/agency-context';
import { getSupabaseClient, getSupabaseErrorMessage } from '@/lib/supabase';
import {
  createAgencyInvitation, createAgencyMember, fetchSeatInfo, resetAgentPassword,
  teamErrorLabel, type CreatedInvitation, type SeatInfo, type TeamRole,
} from '@/lib/agency-team-api';

interface TeamMember {
  id: string;
  agency_id: string;
  user_id: string;
  role: string;
  status: string;
  created_at: string;
  full_name: string | null;
  email: string | null;
}

const MIN_PASSWORD_LENGTH = 8;

const rosterQueryKey = (agencyId?: string) => ['equipe', 'roster', agencyId];
const seatQueryKey = (agencyId?: string) => ['equipe', 'places', agencyId];

function useTeamRoster(agencyId?: string) {
  return useQuery({
    queryKey: rosterQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<TeamMember[]> => {
      if (!agencyId) return [];
      // Jointure vers user_profiles : la politique RLS
      // « user_profiles_select_agency_colleagues » autorise la lecture entre
      // membres actifs d'une même agence. Le cast contourne les types générés,
      // incomplets pour cette jointure.
      // Les tables metier vivent dans le schema saas_immobilier (comme db() de
      // data-hooks.ts). Sans .schema(), PostgREST cherche dans public et echoue.
      const { data, error } = await (getSupabaseClient().schema('saas_immobilier') as unknown as {
        from: (t: string) => {
          select: (cols: string) => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> } };
        };
      })
        .from('agency_members')
        .select('id, agency_id, user_id, role, status, created_at, user_profiles(full_name, email)')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
        const raw = row.user_profiles as { full_name?: string; email?: string } | Array<{ full_name?: string; email?: string }> | null;
        const profile = Array.isArray(raw) ? raw[0] : raw;
        return {
          id: String(row.id),
          agency_id: String(row.agency_id),
          user_id: String(row.user_id),
          role: String(row.role),
          status: String(row.status),
          created_at: String(row.created_at),
          full_name: profile?.full_name ?? null,
          email: profile?.email ?? null,
        };
      });
    },
  });
}

function useSeatInfo(agencyId?: string) {
  return useQuery({
    queryKey: seatQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: () => fetchSeatInfo(agencyId as string),
  });
}

function useSetMemberStatus(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'active' | 'inactive' }) => {
      const { error } = await (getSupabaseClient().schema('saas_immobilier') as unknown as {
        from: (t: string) => { update: (v: Record<string, string>) => { eq: (c: string, v: string) => Promise<{ error: unknown }> } };
      })
        .from('agency_members')
        .update({ status })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: rosterQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: seatQueryKey(agencyId) }),
      ]);
    },
  });
}

function CopyField({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="reveal-field">
      <span className="form-kicker">{label}</span>
      <div className="reveal-row">
        <code data-testid={testId}>{value}</code>
        <button type="button" className="icon-button" onClick={() => void copy()} aria-label={`Copier ${label}`} data-testid={`button-copy-${testId}`}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {copied && <p className="form-feedback" role="status">Copié dans le presse-papiers.</p>}
    </div>
  );
}

function whatsappLink(invitationUrl: string | null, token: string, agencyName: string) {
  const url = invitationUrl ?? token;
  const message =
    `Bonjour !\n\nVoici votre lien d'accès à l'agence ${agencyName} sur Sofia Immobilier :\n${url}\n\n` +
    `Ce lien est valable 48 heures et ne fonctionne qu'une seule fois. ` +
    `Il vous permettra de créer votre compte et de choisir votre mot de passe.\n\n` +
    `À bientôt !`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

export default function TeamPage() {
  const { activeAgency, activeAgencyId, canManageAgency, activeMembership } = useAgency();
  const roster = useTeamRoster(activeAgencyId);
  const seats = useSeatInfo(activeAgencyId);
  const setStatus = useSetMemberStatus(activeAgencyId);
  const queryClient = useQueryClient();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('agent');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null);
  const [invitation, setInvitation] = useState<CreatedInvitation | null>(null);
  const [invitingRole, setInvitingRole] = useState<TeamRole>('agent');
  // BLOC 5 : réinitialisation du mot de passe d'un membre.
  const [resetTarget, setResetTarget] = useState<TeamMember | null>(null);
  const [resetResult, setResetResult] = useState<{ name: string; email: string; tempPassword: string } | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const seatInfo = seats.data as SeatInfo | undefined;
  const activeCount = (roster.data ?? []).filter((member) => member.status === 'active').length;
  const seatsUsed = seatInfo?.seats_used ?? activeCount;
  const seatsLimit = seatInfo?.seats_limit ?? 0;
  const unlimited = Boolean(seatInfo?.is_unlimited);
  const seatsFull = !unlimited && (seatInfo?.available ?? 1) <= 0;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: rosterQueryKey(activeAgencyId) }),
      queryClient.invalidateQueries({ queryKey: seatQueryKey(activeAgencyId) }),
    ]);
  };

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeAgencyId || busy) return;
    setBusy(true);
    setMessage('');
    setCreated(null);
    try {
      const result = await createAgencyMember({ agencyId: activeAgencyId, fullName, email, role });
      setCreated({ email: result.invited_email, tempPassword: result.temp_password });
      setFullName('');
      setEmail('');
      setMessage('Membre créé. Transmettez le mot de passe temporaire : il ne sera plus affiché.');
      await refresh();
    } catch (error) {
      setMessage(teamErrorLabel(error));
    } finally {
      setBusy(false);
    }
  };

  const submitInvite = async () => {
    if (!activeAgencyId || busy) return;
    setBusy(true);
    setMessage('');
    setInvitation(null);
    try {
      const result = await createAgencyInvitation({ agencyId: activeAgencyId, role: invitingRole });
      setInvitation(result);
      setMessage('Lien d’invitation créé. Partagez-le : il ne sera plus affiché.');
      await refresh();
    } catch (error) {
      setMessage(teamErrorLabel(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (member: TeamMember) => {
    if (member.role === 'owner') return;
    const next = member.status === 'active' ? 'inactive' : 'active';
    setMessage('');
    try {
      await setStatus.mutateAsync({ id: member.id, status: next });
      setMessage(next === 'inactive' ? 'Accès désactivé : la place est libérée.' : 'Accès réactivé.');
    } catch (error) {
      setMessage(getSupabaseErrorMessage(error, 'modifier cet accès'));
    }
  };

  // BLOC 5 : le mot de passe est généré côté serveur (Edge Function
  // `reset-agent-password`) et n'est affiché qu'une seule fois.
  const confirmResetPassword = async () => {
    if (!resetTarget || resetBusy) return;
    setResetBusy(true);
    setMessage('');
    setResetResult(null);
    try {
      const result = await resetAgentPassword({ membershipId: resetTarget.id });
      setResetResult({
        name: result.target_full_name ?? resetTarget.full_name ?? 'ce membre',
        email: result.target_email ?? resetTarget.email ?? '',
        tempPassword: result.temp_password,
      });
      setResetTarget(null);
      setMessage('Mot de passe réinitialisé. Transmettez-le : il ne sera plus affiché.');
      await refresh();
    } catch (error) {
      setMessage(teamErrorLabel(error));
      setResetTarget(null);
    } finally {
      setResetBusy(false);
    }
  };

  if (!canManageAgency) {
    return (
      <>
        <Heading eyebrow="Votre organisation" title="Équipe" description="Gestion des accès de votre agence." />
        <div className="permission-note" role="status" data-testid="status-team-permission">
          <LockKeyhole size={15} />
          <span>La gestion de l’équipe est réservée au propriétaire et aux administrateurs de l’agence.</span>
        </div>
      </>
    );
  }

  if (roster.isLoading || seats.isLoading) {
    return <><Heading eyebrow="Votre organisation" title="Équipe" description="Gestion des accès de votre agence." /><LoadingRows label="Chargement de l’équipe" /></>;
  }
  const loadError = roster.error ?? seats.error;
  if (loadError) {
    return <><Heading eyebrow="Votre organisation" title="Équipe" description="Gestion des accès de votre agence." /><ErrorState error={loadError as Error} retry={useSafeRetry(roster)} /></>;
  }

  return (
    <>
      <Heading
        eyebrow="Votre organisation"
        title="Équipe"
        description="Créez des accès, invitez des agents et suivez les places de votre offre."
      />

      <div className="team-layout">
        <section className="panel team-seats" data-testid="panel-team-seats">
          <div className="panel-head">
            <div>
              <h2>Places utilisées</h2>
              <p data-testid="text-seat-counter">
                {unlimited
                  ? `${seatsUsed} utilisateur(s) · offre illimitée`
                  : `${seatsUsed}/${seatsLimit} utilisateurs`}
              </p>
            </div>
            <UsersRound size={20} />
          </div>
          <div className="seat-bar" aria-hidden="true">
            <span style={{ width: unlimited ? '8%' : `${Math.min(100, seatsLimit ? (seatsUsed / seatsLimit) * 100 : 0)}%` }} />
          </div>
          <p className="seat-detail">
            {unlimited
              ? 'Votre offre ne fixe aucune limite d’utilisateurs.'
              : seatsFull
                ? 'Limite atteinte : désactivez un accès ou changez d’offre pour en ajouter.'
                : `${seatInfo?.available ?? 0} place(s) encore disponible(s). Les invitations en attente sont comptées.`}
          </p>
          {Number(seatInfo?.invitations_pending ?? 0) > 0 && (
            <p className="seat-pending" data-testid="text-pending-invitations">
              {seatInfo?.invitations_pending} invitation(s) en attente, déjà décomptée(s).
            </p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div><h2>Créer un accès directement</h2><p>Le mot de passe temporaire n’est affiché qu’une seule fois.</p></div>
            <UserPlus size={18} />
          </div>
          <form className="form-field" onSubmit={(event) => void submitCreate(event)}>
            <label>
              <span>Nom complet</span>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="Aminata Diallo" data-testid="input-member-name" />
            </label>
            <label>
              <span>Adresse e-mail</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="aminata@agence.ml" data-testid="input-member-email" />
            </label>
            <label>
              <span>Rôle</span>
              <select className="form-select" value={role} onChange={(e) => setRole(e.target.value as TeamRole)} data-testid="select-member-role">
                <option value="agent">Agent</option>
                <option value="admin">Administrateur</option>
              </select>
            </label>
            <div className="form-actions">
              <ButtonPrimary testId="button-create-member" onClick={() => undefined} disabled={busy || seatsFull}>
                <UserPlus size={14} /> {busy ? 'Création…' : 'Créer l’accès'}
              </ButtonPrimary>
              {seatsFull && <span className="form-error">Limite d’utilisateurs atteinte.</span>}
            </div>
          </form>
          {created && (
            <div className="reveal-box" data-testid="box-temp-password">
              <div className="reveal-head"><KeyRound size={15} /><strong>Identifiants à transmettre</strong></div>
              <CopyField label="Adresse e-mail" value={created.email} testId="text-created-email" />
              <CopyField label="Mot de passe temporaire" value={created.tempPassword} testId="text-temp-password" />
              <p className="privacy-note-text">
                Ce mot de passe ne sera plus affiché. La personne devra le changer à sa première connexion.
              </p>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <div><h2>Lien d’invitation</h2><p>Valable 48 heures, usage unique. Aucun e-mail n’est envoyé.</p></div>
            <Link2 size={18} />
          </div>
          <div className="form-field">
            <label>
              <span>Rôle proposé</span>
              <select className="form-select" value={invitingRole} onChange={(e) => setInvitingRole(e.target.value as TeamRole)} data-testid="select-invitation-role">
                <option value="agent">Agent</option>
                <option value="admin">Administrateur</option>
              </select>
            </label>
            <div className="form-actions">
              <ButtonPrimary testId="button-create-invitation" onClick={() => void submitInvite()} disabled={busy || seatsFull}>
                <Link2 size={14} /> {busy ? 'Création…' : 'Générer le lien'}
              </ButtonPrimary>
            </div>
          </div>
          {invitation && (
            <div className="reveal-box" data-testid="box-invitation">
              <div className="reveal-head"><ShieldCheck size={15} /><strong>Lien à partager</strong></div>
              {invitation.invitation_url
                ? <CopyField label="Lien d’invitation" value={invitation.invitation_url} testId="text-invitation-url" />
                : <CopyField label="Jeton d’invitation" value={invitation.token} testId="text-invitation-token" />}
              <p className="privacy-note-text">
                Ce lien ne sera plus affiché : la base n’en conserve que l’empreinte. Expire le {safeFormat(invitation.expires_at, { dateStyle: 'medium', timeStyle: 'short' })}.
              </p>
              {invitation.invitation_url && (
                <a
                  className="button-link whatsapp-link"
                  href={whatsappLink(invitation.invitation_url, invitation.token, activeAgency?.name ?? 'votre agence')}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="link-invitation-whatsapp"
                >
                  <MessageCircle size={15} /> Ouvrir dans WhatsApp
                </a>
              )}
            </div>
          )}
        </section>

        <section className="panel roster-panel">
          <div className="panel-head">
            <div><h2>Membres</h2><p>{roster.data?.length ?? 0} accès répertorié(s)</p></div>
            <UserRound size={18} />
          </div>
          {roster.data?.length ? (
            <div className="roster-list">
              {roster.data.map((member) => {
                const isOwner = member.role === 'owner';
                const isSelf = member.user_id === activeMembership?.user_id;
                return (
                  <div className="roster-row" key={member.id} data-testid={`row-member-${member.id}`}>
                    <span className="roster-avatar"><UserRound size={15} /></span>
                    <div className="roster-copy">
                      <strong>{member.full_name || 'Nom non renseigné'}</strong>
                      <span>{member.email || member.user_id.slice(0, 8) + '••••'}</span>
                    </div>
                    <span className="member-role">{roleNames[member.role] ?? member.role}</span>
                    <span className={`membership-status membership-${member.status}`}>{member.status === 'active' ? 'Actif' : 'Désactivé'}</span>
                    {/* BLOC 5 : réinitialisation du mot de passe — jamais sur le
                        propriétaire, jamais sur soi-même. */}
                    {!isOwner && (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => { setResetResult(null); setResetTarget(member); }}
                        disabled={resetBusy || isSelf}
                        title={isSelf ? 'Utilisez la page Profil pour changer votre propre mot de passe' : `Réinitialiser le mot de passe de ${member.full_name ?? 'ce membre'}`}
                        aria-label={`Réinitialiser le mot de passe de ${member.full_name ?? 'ce membre'}`}
                        data-testid={`button-reset-password-${member.id}`}
                      >
                        <RotateCcw size={14} />
                      </button>
                    )}
                    {isOwner ? (
                      <span className="owner-lock" title="Le propriétaire ne peut pas être désactivé"><LockKeyhole size={13} /></span>
                    ) : (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void toggleStatus(member)}
                        disabled={setStatus.isPending || isSelf}
                        title={isSelf ? 'Vous ne pouvez pas désactiver votre propre accès' : member.status === 'active' ? 'Désactiver cet accès' : 'Réactiver cet accès'}
                        aria-label={member.status === 'active' ? `Désactiver ${member.full_name ?? 'ce membre'}` : `Réactiver ${member.full_name ?? 'ce membre'}`}
                        data-testid={`button-toggle-member-${member.id}`}
                      >
                        <UserX size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-table" data-testid="empty-team-roster">
              <strong>Aucun membre</strong>
              <p>Créez un accès ou partagez un lien d’invitation.</p>
            </div>
          )}
        </section>
      </div>

      {resetTarget && (
        <div className="reveal-box reset-confirm" role="dialog" aria-modal="false" aria-label="Confirmer la réinitialisation du mot de passe" data-testid="box-reset-confirm">
          <div className="reveal-head"><RotateCcw size={15} /><strong>Réinitialiser le mot de passe ?</strong></div>
          <p className="privacy-note-text">
            Un nouveau mot de passe sera généré pour{' '}
            <strong>{resetTarget.full_name || resetTarget.email || 'ce membre'}</strong>.
            L’accès actuel cessera de fonctionner et la personne devra changer ce mot de
            passe à sa première connexion. Cette action est enregistrée dans le journal d’activité.
          </p>
          <div className="form-actions">
            <button type="button" className="button-link" onClick={() => setResetTarget(null)} disabled={resetBusy} data-testid="button-reset-cancel">
              <X size={14} /> Annuler
            </button>
            <ButtonPrimary testId="button-reset-confirm" onClick={() => void confirmResetPassword()} disabled={resetBusy}>
              <KeyRound size={14} /> {resetBusy ? 'Réinitialisation…' : 'Confirmer'}
            </ButtonPrimary>
          </div>
        </div>
      )}

      {resetResult && (
        <div className="reveal-box" data-testid="box-reset-password">
          <div className="reveal-head"><KeyRound size={15} /><strong>Nouveau mot de passe à transmettre</strong></div>
          <CopyField label="Membre" value={resetResult.name} testId="text-reset-member" />
          {resetResult.email && <CopyField label="Adresse e-mail" value={resetResult.email} testId="text-reset-email" />}
          <CopyField label="Mot de passe temporaire" value={resetResult.tempPassword} testId="text-reset-temp-password" />
          <p className="privacy-note-text">
            Ce mot de passe ne sera plus affiché. La personne devra le changer à sa première connexion.
          </p>
          <button type="button" className="button-link" onClick={() => setResetResult(null)} data-testid="button-reset-dismiss">
            <Check size={14} /> J’ai transmis le mot de passe
          </button>
        </div>
      )}

      {message && (
        <p className={message.includes('échoué') || message.includes('atteinte') || message.includes('réservée') || message.includes('incorrect') ? 'form-error' : 'form-feedback'} role="status" data-testid="status-team-message">
          {message}
        </p>
      )}
    </>
  );
}
