// LOT A (point 4) - LIEN D'INVITATION, SANS SMTP.
//
// Le jeton est genere et hache COTE BASE par public.create_agency_invitation()
// (sha256, usage unique, 48 h). Cette fonction ne fait que :
//   1. authentifier l'appelant,
//   2. verifier qu'il est proprietaire/administrateur de l'agence ciblee,
//   3. verifier que l'agence n'est pas suspendue,
//   4. verifier que la limite d'utilisateurs n'est pas atteinte
//      (invitations en attente COMPRISES),
//   5. renvoyer le lien en clair UNE SEULE FOIS.
// Aucun email n'est envoye : le lien est partage manuellement (WhatsApp).
//
// SECURITE - verify_jwt est desactive cote plateforme.
// Le preflight CORS (OPTIONS) ne porte jamais d'en-tete Authorization : la
// passerelle le rejetait avant d'executer ce code, le navigateur bloquait
// l'appel, et le client ne recevait qu'un "Failed to fetch" sans statut ni
// message. Aucune protection n'est perdue : la fonction exige un Bearer,
// valide le jeton avec auth.getUser() et verifie l'appartenance a l'agence
// avec has_agency_role().
//
// Source volontairement en ASCII pur (voir create-agency-member-v2).
import { createClient } from 'npm:@supabase/supabase-js@2'

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

const allowedRoles = new Set(['admin', 'agent'])

// Jamais code en dur dans la logique metier : configurable par deploiement.
const appBaseUrl = (Deno.env.get('SOFIA_APP_BASE_URL') ?? '').replace(/\/$/, '')

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
  const role = String(body.role ?? '').trim().toLowerCase()
  if (!agencyId || !role) return json({ error: 'agency_id_and_role_are_required' }, 400)
  if (!allowedRoles.has(role)) return json({ error: 'role_not_allowed' }, 400)

  const callerClient = createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, service, { auth: { persistSession: false } })

  // 1. Appelant authentifie
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'authentication_required' }, 401)

  // 2. Proprietaire ou administrateur de CETTE agence (le JWT fait foi, pas le body)
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

  // 4. Limite d'utilisateurs non atteinte - invitations en attente comprises.
  //    agency_seat_availability compte deja members_active + invitations_pending.
  const { data: seats, error: seatsError } = await callerClient.rpc('agency_seat_availability', {
    p_agency_id: agencyId,
  })
  if (seatsError) return json({ error: 'seat_check_failed', details: seatsError.message }, 500)
  const seatsInfo = seats as { available: number; seats_used: number; seats_limit: number; is_unlimited: boolean; invitations_pending: number }
  if (!seatsInfo.is_unlimited && seatsInfo.available <= 0) {
    return json({
      error: 'member_limit_reached',
      seats_used: seatsInfo.seats_used,
      seats_limit: seatsInfo.seats_limit,
      invitations_pending: seatsInfo.invitations_pending,
    }, 409)
  }

  // 5. Generation du jeton COTE BASE (hache sha256, usage unique, 48 h).
  //    La base applique elle-meme la limite de places : double verrou.
  const { data: invitation, error: invitationError } = await admin.rpc('create_agency_invitation', {
    p_agency_id: agencyId,
    p_role: role,
  })
  if (invitationError || !invitation) {
    console.error('agency_invitation_creation_failed', { message: invitationError?.message })
    const limit = invitationError?.message?.includes('imite')
    return json({
      error: limit ? 'member_limit_reached' : 'invitation_creation_failed',
      details: invitationError?.message ?? 'aucune invitation renvoyee',
      code: invitationError?.code ?? null,
    }, limit ? 409 : 500)
  }

  const row = Array.isArray(invitation) ? invitation[0] : invitation
  const tokenPlain = (row as { token_plain: string }).token_plain
  const expiresAt = (row as { expires_at: string }).expires_at
  const invitationId = (row as { invitation_id: string }).invitation_id

  // SOFIA_APP_BASE_URL absent -> on retombe sur l'URL de production connue
  // au lieu de renvoyer un lien null.
  const effectiveBaseUrl = appBaseUrl || 'https://sbc-ai-agency-dashbord.netlify.app'
  const invitationUrl = `${effectiveBaseUrl}/rejoindre?token=${encodeURIComponent(tokenPlain)}`

  // Le jeton en clair n'est renvoye qu'ici, une seule fois : la base ne stocke
  // que son empreinte sha256, il est donc irrecuperable ensuite.
  return json({
    invitation_id: invitationId,
    token: tokenPlain,
    invitation_url: invitationUrl,
    expires_at: expiresAt,
    role,
    seats: seatsInfo,
    warning: appBaseUrl ? undefined : 'SOFIA_APP_BASE_URL non configure : URL de production utilisee par repli.',
  }, 201)
})
