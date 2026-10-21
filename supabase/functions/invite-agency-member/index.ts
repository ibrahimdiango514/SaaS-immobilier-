// LOT A (point 4) — LIEN D'INVITATION, SANS SMTP.
// Remplace la version déployée qui exigeait inviteUserByEmail (donc un SMTP).
//
// Le jeton est généré et haché CÔTÉ BASE par public.create_agency_invitation()
// (sha256, usage unique, 48 h). Cette fonction ne fait que :
//   1. authentifier l'appelant,
//   2. vérifier qu'il est propriétaire/administrateur de l'agence ciblée,
//   3. vérifier que l'agence n'est pas suspendue,
//   4. vérifier que la limite d'utilisateurs n'est pas atteinte
//      (invitations en attente COMPRISES),
//   5. renvoyer le lien en clair UNE SEULE FOIS.
// Aucun email n'est envoyé : le lien est partagé manuellement (WhatsApp).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

const allowedRoles = new Set(['admin', 'agent'])

// Jamais codé en dur dans la logique métier : configurable par déploiement.
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

  // 1. Appelant authentifié
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'authentication_required' }, 401)

  // 2. Propriétaire ou administrateur de CETTE agence (le JWT fait foi, pas le body)
  const { data: allowed, error: allowedError } = await callerClient.rpc('has_agency_role', {
    target_agency_id: agencyId,
    required_role: 'admin',
  })
  if (allowedError || allowed !== true) return json({ error: 'agency_admin_or_owner_required' }, 403)

  // 3. Agence non suspendue
  // BLOC 10 : `agence_active` attend `p_agency_id` (et non `agency_id`), et
  // PostgREST résout le RPC dans `public` — d'où le wrapper public.agence_active.
  // Avec l'ancien nom de paramètre l'appel échouait toujours et la fonction
  // renvoyait `agency_suspended` pour TOUTE agence, même active.
  const { data: active, error: activeError } = await callerClient.rpc('agence_active', { p_agency_id: agencyId })
  if (activeError || active !== true) return json({ error: 'agency_suspended' }, 403)

  // 4. Limite d'utilisateurs non atteinte — invitations en attente comprises.
  //    agency_seat_availability compte déjà members_active + invitations_pending.
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

  // 5. Génération du jeton CÔTÉ BASE (haché sha256, usage unique, 48 h).
  //    La base applique elle-même la limite de places : double verrou.
  const { data: invitation, error: invitationError } = await admin.rpc('create_agency_invitation', {
    p_agency_id: agencyId,
    p_role: role,
  })
  if (invitationError || !invitation) {
    console.error('agency_invitation_creation_failed', { message: invitationError?.message })
    const limit = invitationError?.message?.includes('imite')
    return json({
      error: limit ? 'member_limit_reached' : 'invitation_creation_failed',
      details: invitationError?.message,
    }, limit ? 409 : 500)
  }

  const row = Array.isArray(invitation) ? invitation[0] : invitation
  const tokenPlain = (row as { token_plain: string }).token_plain
  const expiresAt = (row as { expires_at: string }).expires_at
  const invitationId = (row as { invitation_id: string }).invitation_id

  const invitationUrl = appBaseUrl
    ? `${appBaseUrl}/rejoindre?token=${encodeURIComponent(tokenPlain)}`
    : null

  // Le jeton en clair n'est renvoyé qu'ici, une seule fois : la base ne stocke
  // que son empreinte sha256, il est donc irrécupérable ensuite.
  return json({
    invitation_id: invitationId,
    token: tokenPlain,
    invitation_url: invitationUrl,
    expires_at: expiresAt,
    role,
    seats: seatsInfo,
    warning: appBaseUrl ? undefined : 'SOFIA_APP_BASE_URL non configuré : renvoyer le jeton brut.',
  }, 201)
})
