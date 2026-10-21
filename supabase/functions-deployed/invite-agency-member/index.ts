// BASELINE — code déployé (version 1), récupéré tel quel de l'ESZIP Supabase.
// ezbr_sha256: 97baf4baf12026041c94a134519b0ea28435949eac1facb28d39f4da963bae84
// NE PAS MODIFIER : sert de retour arrière.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/http.ts'

const invitationRedirectUrl = 'https://sbc-ai-agency-dashbord.netlify.app'
const allowedRoles = new Set(['admin', 'manager', 'agent', 'viewer'])

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'authentication_required' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: 'server_configuration_error' }, 500)

  const callerClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } })
  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

  const { data: userData, error: userError } = await callerClient.auth.getUser()
  const caller = userData.user
  if (userError || !caller) return json({ error: 'authentication_required' }, 401)

  let payload
  try { payload = await request.json() } catch { return json({ error: 'invalid_json' }, 400) }

  const agencyId = payload.agency_id?.trim()
  const fullName = payload.full_name?.trim()
  const email = payload.email?.trim().toLowerCase()
  const phone = payload.phone?.trim() || undefined
  const role = payload.role?.trim().toLowerCase()

  if (!agencyId || !fullName || !email || !role) {
    return json({ error: 'agency_context_full_name_email_and_role_are_required' }, 400)
  }
  if (!allowedRoles.has(role)) return json({ error: 'role_not_allowed' }, 400)

  // The agency id is only context. The caller JWT is checked against this agency server-side.
  const { data: canManageAgency, error: roleCheckError } = await callerClient.rpc('has_agency_role', {
    target_agency_id: agencyId,
    required_role: 'admin',
  })
  if (roleCheckError || canManageAgency !== true) return json({ error: 'agency_admin_or_owner_required' }, 403)

  const { data: invitation, error: invitationError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName, phone },
    redirectTo: invitationRedirectUrl,
  })

  if (invitationError || !invitation.user?.id) {
    const message = invitationError?.message?.toLowerCase() ?? ''
    if (message.includes('already') || message.includes('registered') || message.includes('exists')) {
      return json({ error: 'email_already_exists' }, 409)
    }
    console.error('agency_member_invitation_failed', { message: invitationError?.message })
    return json({ error: 'auth_invitation_failed' }, 502)
  }

  const invitedUserId = invitation.user.id
  const { data: membership, error: membershipError } = await adminClient.rpc('create_agency_member', {
    p_actor_user_id: caller.id,
    p_agency_id: agencyId,
    p_invited_user_id: invitedUserId,
    p_role: role,
  })

  if (membershipError) {
    const { error: compensationError } = await adminClient.auth.admin.deleteUser(invitedUserId)
    console.error('agency_member_provisioning_failed', {
      message: membershipError.message,
      compensation_failed: Boolean(compensationError),
    })
    return json({ error: 'agency_member_provisioning_failed', details: membershipError.message }, 500)
  }

  return json({
    membership: Array.isArray(membership) ? membership[0] : membership,
    invited_email: email,
  }, 201)
})
