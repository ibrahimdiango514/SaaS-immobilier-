// CREATION DIRECTE d'un membre d'agence, sans SMTP.
//
// Cette fonction est le slug "create-agency-member-v2". L'ancien slug
// "create-agency-member" restait bloque sur un BOOT_ERROR du runtime Supabase
// ("Function failed to start") : le meme code, redeploye sous ce slug, ne
// demarrait jamais, alors qu'il demarre sous un slug neuf. Ce n'etait donc pas
// une erreur de code mais un artefact de deploiement corrompu cote plateforme.
// La source ci-dessous est volontairement en ASCII pur.
//
// SECURITE - verify_jwt est desactive cote plateforme.
// Le preflight CORS (OPTIONS) ne porte jamais d'en-tete Authorization : la
// passerelle le rejetait avant d'executer ce code, le navigateur bloquait
// l'appel, et le client ne recevait qu'un "Failed to send a request to the Edge
// Function" sans statut ni message. Aucune protection n'est perdue ici :
// la fonction exige un Bearer, valide le jeton avec auth.getUser() et verifie
// l'appartenance a l'agence avec has_agency_role().
import { createClient } from 'npm:@supabase/supabase-js@2'

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

function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
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

  let body: any
  try { body = await request.json() } catch { return json({ error: 'invalid_json' }, 400) }

  const agencyId = String(body.agency_id ?? '').trim()
  const fullName = String(body.full_name ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const role = String(body.role ?? '').trim().toLowerCase()
  const phone = String(body.phone ?? '').trim() || undefined
  const tempPassword = typeof body.temp_password === 'string' ? body.temp_password : generateTempPassword()

  if (!agencyId || !fullName || !email || !role) {
    return json({ error: 'agency_context_full_name_email_and_role_are_required' }, 400)
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
  const { data: allowed, error: allowedError } = await callerClient.rpc('has_agency_role', {
    target_agency_id: agencyId,
    required_role: 'admin',
  })
  if (allowedError || allowed !== true) {
    return json({ error: 'agency_admin_or_owner_required', details: allowedError?.message ?? null }, 403)
  }

  // 3. Agence non suspendue (RPC public.agence_active attend p_agency_id)
  const { data: active, error: activeError } = await callerClient.rpc('agence_active', { p_agency_id: agencyId })
  if (activeError) {
    return json({ error: 'agency_status_check_failed', details: activeError.message, code: activeError.code ?? null }, 500)
  }
  if (active !== true) return json({ error: 'agency_suspended' }, 403)

  // 4. Limite de places (membres actifs + invitations en attente)
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

  // 5. Compte Auth avec mot de passe temporaire (pas de SMTP)
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

  // 6. Rattachement a l'agence - UNIQUEMENT cette agence
  const { data: membership, error: membershipError } = await admin.rpc('create_agency_member', {
    p_actor_user_id: caller.id,
    p_agency_id: agencyId,
    p_invited_user_id: created.user.id,
    p_role: role,
  })
  if (membershipError) {
    // Compensation : on ne laisse pas un compte orphelin.
    const { error: compensationError } = await admin.auth.admin.deleteUser(created.user.id)
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

  // 7a. Le statut par defaut est 'invited' : is_agency_member et has_agency_role
  //     n'acceptent que 'active'. Une creation directe vaut acces immediat.
  const { data: activatedRows, error: activateError } = await admin
    .schema('saas_immobilier')
    .from('agency_members')
    .update({ status: 'active' })
    .eq('agency_id', agencyId)
    .eq('user_id', created.user.id)
    .select('id')

  if (activateError || !activatedRows || activatedRows.length === 0) {
    const { error: compensationError } = await admin.auth.admin.deleteUser(created.user.id)
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

  // 7b. Drapeau must_change_password dans user_profiles (lu par App.tsx).
  //     Le trigger handle_new_user_profile cree la ligne avec la valeur false.
  const profilePayload: Record<string, unknown> = {
    must_change_password: true,
    email,
    full_name: fullName,
  }
  if (phone) profilePayload.phone = phone

  const profiles = admin.schema('saas_immobilier').from('user_profiles')
  const { data: profileRows, error: profileError } = await profiles
    .update(profilePayload)
    .eq('id', created.user.id)
    .select('id')

  let profileAction = 'updated'
  if (!profileError && (!profileRows || profileRows.length === 0)) {
    // La ligne n'a pas ete creee par le trigger : on l'insere.
    const { error: insertError } = await admin
      .schema('saas_immobilier')
      .from('user_profiles')
      .insert({ id: created.user.id, role: 'agency', ...profilePayload })
    if (insertError) {
      console.error('user_profile_flag_failed', { message: insertError.message, code: insertError.code })
      return json({
        error: 'user_profile_flag_failed',
        details: insertError.message,
        code: insertError.code ?? null,
      }, 500)
    }
    profileAction = 'inserted'
  } else if (profileError) {
    console.error('user_profile_flag_failed', { message: profileError.message, code: profileError.code })
    return json({
      error: 'user_profile_flag_failed',
      details: profileError.message,
      code: profileError.code ?? null,
    }, 500)
  }

  // Le mot de passe temporaire n'est renvoye qu'ici, une seule fois.
  return json({
    membership: Array.isArray(membership) ? membership[0] : membership,
    membership_status: 'active',
    user_profile: profileAction,
    invited_email: email,
    temp_password: tempPassword,
    must_change_password: true,
    seats: seatsInfo,
  }, 201)
})
