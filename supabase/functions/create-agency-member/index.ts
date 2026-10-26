// LOT A (point 4) — CRÉATION DIRECTE d'un membre d'agence, SANS SMTP.
// Remplace la version déployée qui exigeait inviteUserByEmail (donc un SMTP).
//
// Différences clés avec la baseline :
//   - admin.createUser + mot de passe temporaire (au lieu de inviteUserByEmail)
//   - mot de passe renvoyé UNE SEULE FOIS dans la réponse
//   - user_metadata.must_change_password = true (changement forcé à la 1re connexion)
//   - contrôle explicite : agence non suspendue + places disponibles
//     (invitations en attente comprises, via agency_seat_availability)
//   - agency_id jamais cru sur parole : vérifié côté serveur par has_agency_role
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
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

const allowedRoles = new Set(['admin', 'agent'])
const MIN_PASSWORD_LENGTH = 8

function generateTempPassword(): string {
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
  // Mot de passe temporaire optionnel : fourni par le propriétaire, sinon généré.
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

  // 1. Appelant authentifié
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  const caller = callerData.user
  if (callerError || !caller) return json({ error: 'authentication_required' }, 401)

  // 2. Propriétaire ou administrateur de CETTE agence (le JWT fait foi, pas le body)
  const { data: allowed, error: allowedError } = await callerClient.rpc('has_agency_role', {
    target_agency_id: agencyId,
    required_role: 'admin',
  })
  if (allowedError || allowed !== true) {
    return json({ error: 'agency_admin_or_owner_required', details: allowedError?.message ?? null }, 403)
  }

  // 3. Agence non suspendue
  // BLOC 11 : l'erreur RPC exacte est desormais renvoyee dans `details`, pour ne
  // plus jamais confondre « agence suspendue » et « appel technique en echec ».
  // BLOC 10 : `agence_active` attend `p_agency_id` (et non `agency_id`), et
  // PostgREST résout le RPC dans `public` — d'où le wrapper public.agence_active.
  // Avec l'ancien nom de paramètre l'appel échouait toujours et la fonction
  // renvoyait `agency_suspended` pour TOUTE agence, même active.
  const { data: active, error: activeError } = await callerClient.rpc('agence_active', { p_agency_id: agencyId })
  if (activeError) {
    return json({ error: 'agency_status_check_failed', details: activeError.message, code: activeError.code ?? null }, 500)
  }
  if (active !== true) return json({ error: 'agency_suspended' }, 403)

  // 4. Limite d'utilisateurs non atteinte (membres actifs + invitations en attente)
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

  // 5. Création du compte auth avec mot de passe temporaire
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,          // pas de SMTP : le compte est utilisable tout de suite
    user_metadata: {
      full_name: fullName,
      phone,
      must_change_password: true,  // changement forcé à la première connexion
    },
  })
  if (createError || !created.user?.id) {
    const message = createError?.message?.toLowerCase() ?? ''
    const taken = message.includes('already') || message.includes('registered') || message.includes('exists')
    return json({
      error: taken ? 'email_already_exists' : 'auth_user_creation_failed',
      details: createError?.message ?? 'aucun utilisateur renvoyé',
    }, taken ? 409 : 502)
  }

  // 6. Rattachement à l'agence — UNIQUEMENT cette agence
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
    const limit = membershipError.message?.includes('Limite') || membershipError.message?.includes('limite')
    return json({
      error: limit ? 'member_limit_reached' : 'agency_member_provisioning_failed',
      details: membershipError.message,
      code: membershipError.code ?? null,
    }, limit ? 409 : 500)
  }

  // ---------------------------------------------------------------------------
  // 7. CORRECTIFS APRÈS RATTACHEMENT RÉUSSI (création directe d'un agent)
  // ---------------------------------------------------------------------------
  // a. STATUT DU MEMBRE.
  //    `public.create_agency_member` insère la ligne avec status = 'invited'.
  //    Or `public.is_agency_member` ET `public.has_agency_role` n'acceptent que
  //    status = 'active'. L'agent pouvait donc se connecter mais son espace
  //    restait vide (« Aucune agence active associée »).
  //    La création directe par le propriétaire vaut accès immédiat : on active.
  //    La fonction SQL n'est PAS modifiée (accord préalable requis) : le flux
  //    d'invitation par lien utilise sa propre fonction et garde 'invited'.
  const { data: activatedRows, error: activateError } = await admin
    .schema('saas_immobilier')
    .from('agency_members')
    .update({ status: 'active' })
    .eq('agency_id', agencyId)
    .eq('user_id', created.user.id)
    .select('id')

  if (activateError || !activatedRows || activatedRows.length === 0) {
    // Compensation : pas de compte orphelin à moitié rattaché.
    const { error: compensationError } = await admin.auth.admin.deleteUser(created.user.id)
    console.error('agency_member_activation_failed', {
      message: activateError?.message ?? 'aucune ligne mise à jour',
      compensation_failed: Boolean(compensationError),
    })
    return json({
      error: 'agency_member_activation_failed',
      details: activateError?.message ?? 'la ligne agency_members n a pas pu etre activee',
      code: activateError?.code ?? null,
    }, 500)
  }

  // b. DRAPEAU must_change_password DANS user_profiles.
  //    Le trigger `handle_new_user_profile` crée bien la ligne (email, nom,
  //    téléphone) mais avec la valeur par défaut `false` : la page « changement
  //    obligatoire » ne s'affichait donc jamais, alors que les métadonnées Auth
  //    portaient déjà must_change_password = true.
  //    → On vérifie la ligne, on la met à jour ; si elle n'existe pas, on l'insère.
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
    // La ligne n'a pas été créée par le trigger : on l'insère.
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

  // Le mot de passe temporaire n'est renvoyé qu'ici, une seule fois.
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
