// LOT A (point 4) — client d'appel des Edge Functions « équipe ».
//
// Aucune logique d'autorisation ici : c'est le serveur qui tranche. Le front
// n'envoie jamais un agency_id « de confiance » — les fonctions vérifient
// l'appelant via son JWT et refusent tout agency_id non autorisé.
import { getSupabaseClient } from './supabase';

export type TeamRole = 'admin' | 'agent';

export interface SeatInfo {
  available: number;
  seats_used: number;
  seats_limit: number;
  is_unlimited: boolean;
  members_active?: number;
  members_invited?: number;
  invitations_pending?: number;
}

export interface CreatedMember {
  invited_email: string;
  temp_password: string;
  must_change_password: boolean;
  seats: SeatInfo;
}

export interface CreatedInvitation {
  invitation_id: string;
  token: string;
  invitation_url: string | null;
  expires_at: string;
  role: TeamRole;
  seats: SeatInfo;
  warning?: string;
}

/** BLOC 5 : résultat d'une réinitialisation de mot de passe par owner/admin. */
export interface ResetPasswordResult {
  membership_id: string;
  agency_id: string;
  agency_name: string;
  target_user_id: string;
  target_email: string | null;
  target_full_name: string | null;
  target_role: string;
  temp_password: string;
  must_change_password: boolean;
}

export interface RedeemedInvitation {
  agency_name: string;
  role: string;
  email: string;
  next_step: 'signin';
}

// Traduit les codes d'erreur serveur en français, sans révéler plus que ce que
// le serveur a bien voulu dire (en particulier pour les jetons d'invitation).
const errorLabels: Record<string, string> = {
  authentication_required: 'Session expirée. Reconnectez-vous puis réessayez.',
  agency_admin_or_owner_required:
    'Seuls le propriétaire ou un administrateur de l’agence peuvent gérer l’équipe.',
  agency_suspended: 'Cette agence est suspendue. Contactez l’administrateur de la plateforme.',
  agency_unavailable: 'Cette agence n’est plus disponible.',
  member_limit_reached: 'La limite d’utilisateurs de votre offre est atteinte.',
  email_already_exists: 'Cette adresse e-mail est déjà utilisée par un compte.',
  role_not_allowed: 'Ce rôle n’est pas autorisé.',
  password_too_short: 'Le mot de passe est trop court (8 caractères minimum).',
  too_many_attempts: 'Trop de tentatives. Réessayez dans une heure.',
  invitation_invalid_or_no_longer_valid:
    'Ce lien d’invitation n’est pas valide ou n’est plus utilisable. Demandez un nouveau lien.',
  auth_user_creation_failed: 'La création du compte a échoué. Réessayez.',
  membership_not_found: 'Ce membre est introuvable dans votre agence.',
  target_account_not_found: 'Le compte de ce membre est introuvable.',
  owner_password_cannot_be_reset:
    'Le mot de passe du propriétaire ne peut pas être réinitialisé ici.',
  cannot_reset_own_password:
    'Vous ne pouvez pas réinitialiser votre propre mot de passe ici — utilisez la page Profil.',
  password_reset_failed: 'La réinitialisation du mot de passe a échoué. Réessayez.',
  invalid_identifier: 'Identifiant invalide. Rechargez la page puis réessayez.',
  membership_id_or_agency_and_target_are_required: 'Aucun membre n’a été indiqué.',
  account_creation_failed: 'La création du compte a échoué. Réessayez.',
  invitation_redeem_failed: 'L’activation de l’invitation a échoué. Réessayez.',
  agency_member_provisioning_failed: 'Le rattachement à l’agence a échoué. Réessayez.',
  invitation_creation_failed: 'La création du lien d’invitation a échoué. Réessayez.',
  seat_check_failed: 'Le contrôle des places disponibles a échoué. Réessayez.',
  server_configuration_error: 'Configuration serveur incomplète. Contactez le support.',
  server_error: 'Erreur serveur. Réessayez.',
  agency_status_check_failed: 'Le statut de l’agence n’a pas pu être vérifié. Réessayez.',
  edge_function_unavailable: 'La fonction serveur n’a pas répondu. Réessayez ; si l’erreur persiste, contactez le support.',
  method_not_allowed: 'Méthode non autorisée.',
  invalid_json: 'Requête malformée.',
};

/**
 * BLOC 11 — Erreur d'Edge Function porteuse du code métier ET du détail technique.
 * Les fonctions renvoient désormais `{ error, details, code }` : l'interface peut
 * afficher la cause exacte au lieu d'un message générique ou d'un échec muet.
 */
export class EdgeFunctionError extends Error {
  readonly errorCode: string;
  readonly details: string | null;
  readonly technicalCode: string | null;
  readonly httpStatus: number | null;

  constructor(errorCode: string, details: string | null, technicalCode: string | null, httpStatus: number | null) {
    super(errorCode);
    this.name = 'EdgeFunctionError';
    this.errorCode = errorCode;
    this.details = details;
    this.technicalCode = technicalCode;
    this.httpStatus = httpStatus;
  }
}

export function teamErrorLabel(error: unknown): string {
  // BLOC 11 : libellé français + cause technique exacte, jamais un échec muet.
  if (error instanceof EdgeFunctionError) {
    const base = errorLabels[error.errorCode] ?? error.errorCode;
    const parts: string[] = [base];
    if (error.details) parts.push(`Détail : ${error.details}`);
    const codes = [error.technicalCode, error.httpStatus ? `HTTP ${error.httpStatus}` : null]
      .filter(Boolean)
      .join(', ');
    if (codes) parts.push(`(${codes})`);
    return parts.join(' ');
  }
  const candidate = error as { code?: string; message?: string } | null;
  const code = candidate?.code ?? candidate?.message ?? '';
  if (code && errorLabels[code]) return errorLabels[code];
  const message = candidate?.message ?? '';
  const known = Object.keys(errorLabels).find((key) => message.includes(key));
  if (known) return errorLabels[known];
  return message || 'Une erreur est survenue. Réessayez.';
}

type EdgeErrorPayload = { error?: string; details?: string | null; code?: string | null };

async function invoke<T>(slug: string, body: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke(slug, { body });
  if (error) {
    // functions.invoke masque le corps de réponse ; on le récupère si possible.
    const context = (error as { context?: Response }).context;
    if (context) {
      const payload = (await context.json().catch(() => null)) as EdgeErrorPayload | null;
      if (payload?.error) {
        throw new EdgeFunctionError(payload.error, payload.details ?? null, payload.code ?? null, context.status);
      }
    }
    // BLOC 11 : une fonction qui ne démarre pas (module manquant, erreur Deno)
    // produit une FunctionsHttpError/FunctionsFetchError SANS corps exploitable.
    // On le dit explicitement au lieu de remonter un objet opaque.
    const name = (error as { name?: string }).name ?? '';
    const raw = (error as { message?: string }).message ?? '';
    throw new EdgeFunctionError(
      'edge_function_unavailable',
      raw || `La fonction « ${slug} » n'a pas pu être exécutée.`,
      name || null,
      (error as { context?: Response }).context?.status ?? null,
    );
  }
  const payload = data as EdgeErrorPayload & T;
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new EdgeFunctionError(payload.error, payload.details ?? null, payload.code ?? null, null);
  }
  return payload;
}

/** Création directe d'un membre : renvoie un mot de passe temporaire, affiché une seule fois. */
export function createAgencyMember(input: {
  agencyId: string;
  fullName: string;
  email: string;
  role: TeamRole;
  phone?: string;
}) {
  return invoke<CreatedMember>('create-agency-member', {
    agency_id: input.agencyId,
    full_name: input.fullName,
    email: input.email,
    role: input.role,
    phone: input.phone,
  });
}

/** Génère un lien d'invitation à usage unique (48 h), renvoyé une seule fois. */
export function createAgencyInvitation(input: { agencyId: string; role: TeamRole }) {
  return invoke<CreatedInvitation>('invite-agency-member', {
    agency_id: input.agencyId,
    role: input.role,
  });
}

/** Récupère le nombre de places disponibles pour l'agence active. */
export async function fetchSeatInfo(agencyId: string): Promise<SeatInfo> {
  // Cast : les types generes du depot sont incomplets et n'exposent pas les
  // signatures RPC. La verite reste la base (agence_seat_availability(uuid)).
  const client = getSupabaseClient() as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  const { data, error } = await client.rpc('agency_seat_availability', { p_agency_id: agencyId });
  if (error) throw error;
  return data as SeatInfo;
}

/**
 * Page publique : l'agent ouvre son lien, choisit son mot de passe.
 * Appelée sans authentification — c'est le jeton qui fait foi.
 */
export function redeemAgencyInvitation(input: {
  token: string;
  email: string;
  fullName: string;
  password: string;
}) {
  return invoke<RedeemedInvitation>('redeem-agency-invitation', {
    token: input.token,
    email: input.email,
    full_name: input.fullName,
    password: input.password,
  });
}

/**
 * BLOC 5 — Réinitialise le mot de passe d'un membre (owner/admin uniquement).
 * Le mot de passe est généré côté serveur et n'est renvoyé qu'une seule fois.
 */
export function resetAgentPassword(input: { membershipId?: string; agencyId?: string; targetUserId?: string }) {
  return invoke<ResetPasswordResult>('reset-agent-password', {
    membership_id: input.membershipId,
    agency_id: input.agencyId,
    target_user_id: input.targetUserId,
  });
}
