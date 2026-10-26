// =============================================================================
// BLOC 5 — reset-agent-password  (verify_jwt = true)
// =============================================================================
// Réinitialise le mot de passe d'un membre de l'agence à la demande du
// propriétaire ou d'un administrateur de CETTE agence.
//
// Garde-fous (tous vérifiés côté serveur, jamais depuis le corps de requête) :
//   1. appelant authentifié via son JWT ;
//   2. appelant owner/admin de l'agence de la cible (has_agency_role, avec repli
//      sur une lecture directe de agency_members si la résolution RPC échoue) ;
//   3. la cible appartient à la MÊME agence (le membership est résolu par le
//      serveur à partir du membership_id, l'agence n'est jamais fournie seule) ;
//   4. la cible n'est PAS le propriétaire de l'agence ;
//   5. la cible n'est pas l'appelant lui-même ;
//   6. l'agence n'est pas suspendue.
//
// Le mot de passe est GÉNÉRÉ CÔTÉ SERVEUR (crypto.getRandomValues), renvoyé UNE
// SEULE FOIS dans la réponse, et `must_change_password` est posé à la fois dans
// auth.user_metadata et dans saas_immobilier.user_profiles (le verrou de
// WorkspaceGate lit ce dernier). L'action est tracée dans activity_log.
// =============================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
// BLOC 11 (bugs bloquants 2 et 3) — CORRECTIFS `corsHeaders` / `json` INTÉGRÉS.
// Cause racine : ces fonctions importaient `../_shared/http.ts`. Un déploiement
// fait par l'API Supabase (create/update_edge_function) n'envoie QUE le fichier
// d'entrée `index.ts` : le module partagé `_shared/http.ts` n'était donc pas
// présent dans l'artefact déployé, et la fonction échouait au chargement du
// module — d'où une création de membre et un lien d'invitation qui ne
// produisaient rien côté navigateur.
// Les 12 lignes du module partagé sont recopiées ici : chaque fonction déployée
// est désormais AUTONOME, sans aucune importation relative.
// `supabase/functions/_shared/http.ts` est conservé pour un déploiement via le
// CLI (`supabase functions deploy`), qui, lui, téléverse toute l'arborescence.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const SCHEMA = 'saas_immobilier'
const PASSWORD_LENGTH = 14
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Alphabet sans caractères ambigus (0/O, 1/l/I) — saisie facile sur mobile. */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const ALL = LOWER + UPPER + DIGITS

function generatePassword(length = PASSWORD_LENGTH): string {
  const bytes = new Uint8Array(length)
  const shuffle = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  crypto.getRandomValues(shuffle)

  const pick = (alphabet: string, byte: number) => alphabet.charAt(byte % alphabet.length)
  // Composition garantie : au moins une majuscule, une minuscule et un chiffre.
  const chars = [pick(UPPER, bytes[0]), pick(LOWER, bytes[1]), pick(DIGITS, bytes[2])]
  for (let i = 3; i < length; i += 1) chars.push(pick(ALL, bytes[i]))
  for (let i = length - 1; i > 0; i -= 1) {
    const j = shuffle[i] % (i + 1)
    const tmp = chars[i]
    chars[i] = chars[j]
    chars[j] = tmp
  }
  return chars.join('')
}

type Membership = {
  id: string
  agency_id: string
  user_id: string
  role: string
  status: string
}

/** Résout le membership visé (par id de membership, ou par agence + utilisateur). */
async function resolveMembership(
  admin: SupabaseClient,
  membershipId: string,
  agencyId: string,
  targetUserId: string,
): Promise<Membership | null> {
  let query = admin.schema(SCHEMA).from('agency_members').select('id, agency_id, user_id, role, status')
  if (membershipId) query = query.eq('id', membershipId)
  else query = query.eq('agency_id', agencyId).eq('user_id', targetUserId)
  const { data, error } = await query.maybeSingle()
  if (error) throw error
  return (data as Membership | null) ?? null
}

/**
 * Owner/admin de l'agence ? `has_agency_role` est la référence (owner satisfait
 * 'admin', administrateurs plateforme inclus). Le repli n'intervient QUE si
 * l'appel RPC échoue techniquement (résolution de schéma) — jamais s'il renvoie
 * `false`, et il est alors plus strict (membership actif de l'agence uniquement).
 */
async function isAgencyManager(
  callerClient: SupabaseClient,
  admin: SupabaseClient,
  agencyId: string,
  callerId: string,
): Promise<boolean> {
  const { data, error } = await callerClient.rpc('has_agency_role', {
    target_agency_id: agencyId,
    required_role: 'admin',
  })
  if (!error) return data === true

  const { data: membership } = await admin
    .schema(SCHEMA)
    .from('agency_members')
    .select('role, status')
    .eq('agency_id', agencyId)
    .eq('user_id', callerId)
    .maybeSingle()
  if (membership && membership.status === 'active' && ['owner', 'admin'].includes(membership.role)) {
    return true
  }
  const { data: platformAdmin } = await admin
    .schema(SCHEMA)
    .from('platform_admins')
    .select('role')
    .eq('user_id', callerId)
    .maybeSingle()
  return Boolean(platformAdmin)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'authentication_required' }, 401)

  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anon || !service) return json({ error: 'server_configuration_error' }, 500)

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  const membershipId = String(body.membership_id ?? '').trim()
  const agencyId = String(body.agency_id ?? '').trim()
  const targetUserId = String(body.target_user_id ?? '').trim()

  if (!membershipId && !(agencyId && targetUserId)) {
    return json({ error: 'membership_id_or_agency_and_target_are_required' }, 400)
  }
  for (const [label, value] of [
    ['membership_id', membershipId],
    ['agency_id', agencyId],
    ['target_user_id', targetUserId],
  ] as Array<[string, string]>) {
    if (value && !UUID_RE.test(value)) return json({ error: 'invalid_identifier', field: label }, 400)
  }

  const callerClient = createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, service, { auth: { persistSession: false } })

  // 1. Appelant authentifié — le JWT fait foi.
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'authentication_required' }, 401)

  // 2. Cible résolue PAR LE SERVEUR (même agence par construction).
  let membership: Membership | null = null
  try {
    membership = await resolveMembership(admin, membershipId, agencyId, targetUserId)
  } catch (error) {
    console.error('reset_password_membership_lookup_failed', (error as Error).message)
    return json({ error: 'server_error' }, 500)
  }
  if (!membership) return json({ error: 'membership_not_found' }, 404)

  // 3. Appelant owner/admin de l'agence de la cible.
  const allowed = await isAgencyManager(callerClient, admin, membership.agency_id, caller.id)
  if (!allowed) return json({ error: 'agency_admin_or_owner_required' }, 403)

  // 4. Le propriétaire de l'agence est intouchable.
  if (membership.role === 'owner') return json({ error: 'owner_password_cannot_be_reset' }, 403)

  // 5. Personne ne se réinitialise lui-même par ce chemin (→ page Profil).
  if (membership.user_id === caller.id) return json({ error: 'cannot_reset_own_password' }, 400)

  // 6. Agence non suspendue.
  const { data: agencyRow } = await admin
    .schema(SCHEMA)
    .from('agencies')
    .select('id, name, status')
    .eq('id', membership.agency_id)
    .maybeSingle()
  if (!agencyRow || agencyRow.status !== 'active') {
    return json({ error: 'agency_suspended' }, 403)
  }

  // 7. Compte cible.
  const { data: targetData, error: targetError } = await admin.auth.admin.getUserById(membership.user_id)
  const targetUser = targetData?.user
  if (targetError || !targetUser) return json({ error: 'target_account_not_found' }, 404)

  // 8. Nouveau mot de passe généré côté serveur + changement forcé à la connexion.
  const tempPassword = generatePassword()
  const previousMetadata = (targetUser.user_metadata ?? {}) as Record<string, unknown>
  const { error: updateError } = await admin.auth.admin.updateUserById(membership.user_id, {
    password: tempPassword,
    user_metadata: {
      ...previousMetadata,
      must_change_password: true,
      password_reset_at: new Date().toISOString(),
      password_reset_by: caller.id,
    },
  })
  if (updateError) {
    console.error('reset_password_auth_update_failed', updateError.message)
    return json({ error: 'password_reset_failed', details: updateError.message }, 502)
  }

  // 9. Drapeau côté profil : c'est lui que le verrou WorkspaceGate consulte.
  const { error: profileError } = await admin
    .schema(SCHEMA)
    .from('user_profiles')
    .update({ must_change_password: true })
    .eq('id', membership.user_id)
  if (profileError) {
    // Le mot de passe est déjà changé : on signale sans revenir en arrière.
    console.error('reset_password_profile_flag_failed', profileError.message)
  }

  // 10. Traçabilité (échec toléré : le trigger activity_log couvre déjà la table).
  const { error: logError } = await admin.schema(SCHEMA).from('activity_log').insert({
    agency_id: membership.agency_id,
    user_id: caller.id,
    action: 'updated',
    entity_type: 'agency_members',
    entity_id: membership.id,
    summary: `Mot de passe réinitialisé pour ${targetUser.email ?? membership.user_id} (rôle ${membership.role})`,
    metadata: {
      table: 'agency_members',
      op: 'UPDATE',
      field: 'password',
      target_user_id: membership.user_id,
      target_email: targetUser.email ?? null,
      target_role: membership.role,
      must_change_password: true,
      reset_by: caller.id,
    },
  })
  if (logError) console.error('reset_password_activity_log_failed', logError.message)

  // Le mot de passe n'est renvoyé qu'ici, une seule fois.
  return json({
    membership_id: membership.id,
    agency_id: membership.agency_id,
    agency_name: agencyRow.name,
    target_user_id: membership.user_id,
    target_email: targetUser.email ?? null,
    target_full_name: (previousMetadata.full_name as string | undefined) ?? null,
    target_role: membership.role,
    temp_password: tempPassword,
    must_change_password: true,
  })
})
