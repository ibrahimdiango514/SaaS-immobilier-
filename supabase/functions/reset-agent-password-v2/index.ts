// =============================================================================
// reset-agent-password-v2  (verify_jwt = false cote passerelle pour CORS OPTIONS)
// =============================================================================
// Reinitialise le mot de passe d'un membre de l'agence a la demande du
// proprietaire ou d'un administrateur de CETTE agence.
// Source autonome en ASCII pur, sans import relatif.
// =============================================================================
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

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
    .select('role, status')
    .eq('user_id', callerId)
    .eq('status', 'active')
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

  // 1. Appelant authentifie
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'authentication_required' }, 401)

  // 2. Cible resolue cote serveur
  let membership: Membership | null = null
  try {
    membership = await resolveMembership(admin, membershipId, agencyId, targetUserId)
  } catch (error) {
    console.error('reset_password_membership_lookup_failed', (error as Error).message)
    return json({ error: 'server_error' }, 500)
  }
  if (!membership) return json({ error: 'membership_not_found' }, 404)

  // 3. Appelant owner/admin de l'agence de la cible
  const allowed = await isAgencyManager(callerClient, admin, membership.agency_id, caller.id)
  if (!allowed) return json({ error: 'agency_admin_or_owner_required' }, 403)

  // 4. Le proprietaire de l'agence est intouchable
  if (membership.role === 'owner') return json({ error: 'owner_password_cannot_be_reset' }, 403)

  // 5. Personne ne se reinitialise lui-meme par ce chemin
  if (membership.user_id === caller.id) return json({ error: 'cannot_reset_own_password' }, 400)

  // 6. Agence active ou en essai ('active' / 'trial')
  const { data: agencyRow } = await admin
    .schema(SCHEMA)
    .from('agencies')
    .select('id, name, status')
    .eq('id', membership.agency_id)
    .maybeSingle()
  if (!agencyRow || !['active', 'trial'].includes(String(agencyRow.status))) {
    return json({ error: 'agency_suspended' }, 403)
  }

  // 7. Compte cible
  const { data: targetData, error: targetError } = await admin.auth.admin.getUserById(membership.user_id)
  const targetUser = targetData?.user
  if (targetError || !targetUser) return json({ error: 'target_account_not_found' }, 404)

  // 8. Nouveau mot de passe genere cote serveur + changement force a la connexion
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

  // 9. Drapeau cote profil (lu par WorkspaceGate)
  const { error: profileError } = await admin
    .schema(SCHEMA)
    .from('user_profiles')
    .upsert(
      {
        id: membership.user_id,
        email: targetUser.email ?? null,
        full_name: (previousMetadata.full_name as string | undefined) ?? null,
        role: 'agency',
        must_change_password: true,
      },
      { onConflict: 'id' },
    )
  if (profileError) {
    console.error('reset_password_profile_flag_failed', profileError.message)
  }

  // 10. Tracabilite
  const { error: logError } = await admin.schema(SCHEMA).from('activity_log').insert({
    agency_id: membership.agency_id,
    user_id: caller.id,
    action: 'updated',
    entity_type: 'agency_members',
    entity_id: membership.id,
    summary: `Mot de passe reinitialise pour ${targetUser.email ?? membership.user_id} (role ${membership.role})`,
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
