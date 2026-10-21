// BASELINE — code déployé (version 2), récupéré tel quel de l'ESZIP Supabase.
// ezbr_sha256: 88b880d699d7f9b294c1c59f7f627c39e600568f27a0275195ed43308397554d
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

  const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY'), service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anon || !service) return json({ error: 'server_configuration_error' }, 500)

  let body
  try { body = await request.json() } catch { return json({ error: 'invalid_json' }, 400) }

  if ('password' in body) return json({ error: 'password_not_supported_use_invitation' }, 400)

  const agencyId = body.agency_id?.trim(), fullName = body.full_name?.trim(), email = body.email?.trim().toLowerCase(), phone = body.phone?.trim() || undefined, role = body.role?.trim().toLowerCase()
  if (!agencyId || !fullName || !email || !role) return json({ error: 'agency_context_full_name_email_and_role_are_required' }, 400)
  if (!allowedRoles.has(role)) return json({ error: 'role_not_allowed' }, 400)

  const callerClient = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: authorization } } })
  const admin = createClient(url, service, { auth: { persistSession: false } })

  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'authentication_required' }, 401)

  const { data: allowed, error: allowedError } = await callerClient.rpc('has_agency_role', { target_agency_id: agencyId, required_role: 'admin' })
  if (allowedError || allowed !== true) return json({ error: 'agency_admin_or_owner_required' }, 403)

  const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName, phone },
    redirectTo: invitationRedirectUrl,
  })
  if (invitationError || !invitation.user?.id) {
    const message = invitationError?.message?.toLowerCase() ?? ''
    return json({ error: message.includes('already') || message.includes('registered') ? 'email_already_exists' : 'auth_invitation_failed' }, message.includes('already') || message.includes('registered') ? 409 : 502)
  }

  const invitedId = invitation.user.id
  const { data, error } = await admin.rpc('create_agency_member', { p_actor_user_id: caller.id, p_agency_id: agencyId, p_invited_user_id: invitedId, p_role: role })
  if (error) {
    const { error: compensationError } = await admin.auth.admin.deleteUser(invitedId)
    console.error('agency_member_provisioning_failed', { message: error.message, compensation_failed: Boolean(compensationError) })
    return json({ error: 'agency_member_provisioning_failed', details: error.message }, 500)
  }

  return json({ membership: Array.isArray(data) ? data[0] : data, invited_email: email }, 201)
})
