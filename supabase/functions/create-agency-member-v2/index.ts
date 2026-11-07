// CREATION DIRECTE d'un membre d'agence, sans SMTP.
// Slug : "create-agency-member-v2" (verify_jwt = false cote passerelle pour laisser
// passer le preflight CORS OPTIONS ; authentification stricte via auth.getUser()
// + controle d'autorisation serveur via has_agency_role).
// Source autonome en ASCII pur, sans import relatif.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const allowedRoles = new Set(['admin', 'agent'])
const MIN_PASSWORD_LENGTH = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const ALL = UPPER + LOWER + DIGITS

function generateTempPassword(length = 12): string {
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

async function isAuthorizedManager(
  callerClient: SupabaseClient,
  admin: SupabaseClient,
  agencyId: string,
  callerId: string,
): Promise<{ ok: boolean; details: string | null }> {
  const { data, error } = await callerClient.rpc('has_agency_role', {
    target_agency_id: agencyId,
    required_role: 'admin',
  })
  if (!error) return { ok: data === true, details: null }

  const { data: membership } = await admin
    .schema('saas_immobilier')
    .from('agency_members')
    .select('role, status')
    .eq('agency_id', agencyId)
    .eq('user_id', callerId)
    .maybeSingle()
  if (membership && membership.status === 'active' && ['owner', 'admin'].includes(membership.role)) {
    return { ok: true, details: null }
  }
  const { data: platformAdmin } = await admin
    .schema('saas_immobilier')
    .from('platform_admins')
    .select('role, status')
    .eq('user_id', callerId)
    .eq('status', 'active')
    .maybeSingle()
  return { ok: Boolean(platformAdmin), details: error.message }
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

  const agencyId = String(body.agency_id ?? '').trim()
  const fullName = String(body.full_name ?? '').trim()
  const email = String(body.email ?? '').replace(/\s+/g, '').toLowerCase()
  const role = String(body.role ?? '').trim().toLowerCase()
  const phone = String(body.phone ?? '').trim() || undefined
  const tempPassword =
    typeof body.temp_password === 'string' && body.temp_password.trim().length > 0
      ? body.temp_password.trim()
      : generateTempPassword()

  if (!agencyId || !fullName || !email || !role) {
    return json({ error: 'agency_context_full_name_email_and_role_are_required' }, 400)
  }
  if (!EMAIL_RE.test(email)) {
    return json({ error: 'invalid_email', details: 'Adresse e-mail invalide.' }, 400)
  }
  if (!allowedRoles.has(role)) return json({ error: 'role_not_allowed' }, 400)
  if (tempPassword.length < MIN_PASSWORD_LENGTH) {
    return json({ error: 'password_too_short', min_length: MIN_PASSWORD_LENGTH }, 400)
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

  // 2. Proprietaire ou administrateur de CETTE agence (le JWT fait foi)
  const managerCheck = await isAuthorizedManager(callerClient, admin, agencyId, caller.id)
  if (!managerCheck.ok) {
    return json({ error: 'agency_admin_or_owner_required', details: managerCheck.details }, 403)
  }

  // 3. Agence active ou en essai ('active' / 'trial')
  const { data: active, error: activeError } = await callerClient.rpc('agence_active', { p_agency_id: agencyId })
  if (activeError) {
    const { data: agencyRow, error: agencyFetchError } = await admin
      .schema('saas_immobilier')
      .from('agencies')
      .select('status')
      .eq('id', agencyId)
      .maybeSingle()
    if (agencyFetchError) {
      return json({
        error: 'agency_status_check_failed',
        details: activeError.message,
        code: activeError.code ?? null,
      }, 500)
    }
    if (!agencyRow || !['active', 'trial'].includes(String(agencyRow.status))) {
      return json({ error: 'agency_suspended' }, 403)
    }
  } else if (active !== true) {
    return json({ error: 'agency_suspended' }, 403)
  }

  // 4. Limite de places
  const { data: seats, error: seatsError } = await callerClient.rpc('agency_seat_availability', {
    p_agency_id: agencyId,
  })
  if (seatsError) return json({ error: 'seat_check_failed', details: seatsError.message }, 500)
  const seatsInfo = seats as { available: number; seats_used: number; seats_limit: number; is_unlimited: boolean }
  if (!seatsInfo.is_unlimited && seatsInfo.available <= 0) {
    return json({
      error: 'member_limit_reached',
      seats_used: seatsInfo.seats_used,
      seats_limit: seatsInfo.seats_limit,
    }, 409)
  }

  // 5. Compte Auth avec mot de passe temporaire (sans SMTP)
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      phone,
      must_change_password: true,
    },
  })
  if (createError || !created.user?.id) {
    const message = createError?.message?.toLowerCase() ?? ''
    const taken = message.includes('already') || message.includes('registered') || message.includes('exists')
    return json({
      error: taken ? 'email_already_exists' : 'auth_user_creation_failed',
      details: createError?.message ?? 'no user returned',
    }, taken ? 409 : 502)
  }

  const createdUserId = created.user.id

  // 6. Garantit user_profiles AVANT le rattachement agency_members (clé étrangère)
  //    et force must_change_password = true pour la premiere connexion.
  const profilePayload: Record<string, unknown> = {
    id: createdUserId,
    role: 'agency',
    must_change_password: true,
    email,
    full_name: fullName,
  }
  if (phone) profilePayload.phone = phone

  const { error: upsertProfileError } = await admin
    .schema('saas_immobilier')
    .from('user_profiles')
    .upsert(profilePayload, { onConflict: 'id' })

  if (upsertProfileError) {
    await admin.auth.admin.deleteUser(createdUserId)
    console.error('user_profile_flag_failed', {
      message: upsertProfileError.message,
      code: upsertProfileError.code,
    })
    return json({
      error: 'user_profile_flag_failed',
      details: upsertProfileError.message,
      code: upsertProfileError.code ?? null,
    }, 500)
  }

  // 7. Rattachement a l'agence - UNIQUEMENT cette agence
  const { data: membership, error: membershipError } = await admin.rpc('create_agency_member', {
    p_actor_user_id: caller.id,
    p_agency_id: agencyId,
    p_invited_user_id: createdUserId,
    p_role: role,
  })
  if (membershipError) {
    const { error: compensationError } = await admin.auth.admin.deleteUser(createdUserId)
    console.error('agency_member_provisioning_failed', {
      message: membershipError.message,
      compensation_failed: Boolean(compensationError),
    })
    return json({
      error: 'agency_member_provisioning_failed',
      details: membershipError.message,
      code: membershipError.code ?? null,
    }, 500)
  }

  // 8. Garantit status = 'active' (acces immediat)
  const { data: activatedRows, error: activateError } = await admin
    .schema('saas_immobilier')
    .from('agency_members')
    .update({ status: 'active' })
    .eq('agency_id', agencyId)
    .eq('user_id', createdUserId)
    .select('id')

  if (activateError || !activatedRows || activatedRows.length === 0) {
    const { error: compensationError } = await admin.auth.admin.deleteUser(createdUserId)
    console.error('agency_member_activation_failed', {
      message: activateError?.message ?? 'no row updated',
      compensation_failed: Boolean(compensationError),
    })
    return json({
      error: 'agency_member_activation_failed',
      details: activateError?.message ?? 'agency_members row could not be activated',
      code: activateError?.code ?? null,
    }, 500)
  }

  // 9. Journal d'activite (echec tolere)
  const membershipId = activatedRows[0]?.id ?? null
  await admin.schema('saas_immobilier').from('activity_log').insert({
    agency_id: agencyId,
    user_id: caller.id,
    action: 'created',
    entity_type: 'agency_members',
    entity_id: membershipId,
    summary: `Acces cree pour ${fullName} (${email}) avec le role ${role}`,
    metadata: {
      table: 'agency_members',
      op: 'INSERT',
      invited_user_id: createdUserId,
      invited_email: email,
      role,
      must_change_password: true,
    },
  }).then(() => undefined, () => undefined)

  // 10. Compteur de places rafraichi apres creation
  const { data: freshSeats } = await callerClient.rpc('agency_seat_availability', {
    p_agency_id: agencyId,
  })

  return json({
    membership: Array.isArray(membership) ? membership[0] : membership,
    membership_status: 'active',
    user_profile: 'upserted',
    invited_email: email,
    temp_password: tempPassword,
    must_change_password: true,
    seats: freshSeats ?? seatsInfo,
  }, 201)
})
