// LOT A (point 4) — RACHAT D'UN LIEN D'INVITATION par l'agent, SANS SMTP.
// FONCTION NOUVELLE (n'existait pas avant) : la baseline n'offrait aucun moyen
// de créer un compte sans email de confirmation.
//
// Appelée SANS authentification (l'agent n'a pas encore de compte) :
// la seule preuve d'accès est le jeton à usage unique, haché en base.
//
// Durcissements appliqués après revue de sécurité :
//   (b) aucune fuite : un jeton invalide, expiré, révoqué ou déjà utilisé
//       renvoie le MÊME message générique. Le nom de l'agence n'est renvoyé
//       que lorsque le jeton est valable (information nécessaire à l'agent).
//   (c) limitation de tentatives par jeton ET par adresse IP, côté base.
//   (d) longueur minimale de mot de passe imposée.
import { createClient } from 'npm:@supabase/supabase-js@2'
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

const MIN_PASSWORD_LENGTH = 8

// (b) Message unique pour tout jeton non valable : ne pas distinguer
//     « inconnu », « expiré » et « déjà utilisé » empêche de sonder des jetons.
const INVALID_INVITATION = { error: 'invitation_invalid_or_no_longer_valid' }

function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'inconnue'
  )
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anon || !service) return json({ error: 'server_configuration_error' }, 500)

  let body: any
  try { body = await request.json() } catch { return json({ error: 'invalid_json' }, 400) }

  const token = String(body.token ?? '').trim()
  const email = String(body.email ?? '').trim().toLowerCase()
  const fullName = String(body.full_name ?? '').trim()
  const password = String(body.password ?? '')

  if (!token || !email || !fullName || !password) {
    return json({ error: 'token_email_full_name_and_password_are_required' }, 400)
  }

  // (d) Longueur minimale de mot de passe.
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: 'password_too_short', min_length: MIN_PASSWORD_LENGTH }, 400)
  }

  const admin = createClient(url, service, { auth: { persistSession: false } })

  // (c) Limitation de tentatives AVANT tout traitement : par jeton et par IP.
  //     Les compteurs sont hachés côté base (ni jeton ni IP en clair).
  const { data: attempt, error: attemptError } = await admin.rpc('register_invitation_attempt', {
    p_token: token,
    p_ip: clientIp(request),
  })
  if (attemptError) {
    console.error('rate_limit_check_failed', { message: attemptError.message })
    return json({ error: 'server_error', details: attemptError.message }, 500)
  }
  if (!(attempt as { allowed: boolean }).allowed) {
    return json({ error: 'too_many_attempts', retry_after_minutes: 60 }, 429)
  }

  // 1. Diagnostic du jeton sans le consommer.
  const { data: statusData, error: statusError } = await admin.rpc('agency_invitation_status', {
    p_token: token,
  })
  if (statusError) return json({ error: 'server_error', details: statusError.message }, 500)

  const status = statusData as { state: string; agency_name?: string; role?: string; _agency_id?: string }

  // (b) Réponse générique identique pour invalid / expired / already_used / revoked.
  if (status.state !== 'valid') {
    if (status.state === 'agency_suspended') {
      return json({ error: 'agency_unavailable' }, 403)
    }
    return json(INVALID_INVITATION, 400)
  }

  const agencyId = status._agency_id as string

  // 2. La limite de places doit encore tenir au moment du rachat.
  const { data: seats, error: seatsError } = await admin.rpc('agency_seat_availability', {
    p_agency_id: agencyId,
  })
  if (seatsError) return json({ error: 'server_error', details: seatsError.message }, 500)
  const seatsInfo = seats as { available: number; is_unlimited: boolean }
  if (!seatsInfo.is_unlimited && seatsInfo.available <= 0) {
    return json({ error: 'member_limit_reached' }, 409)
  }

  // 3. Création du compte avec le mot de passe choisi par l'agent.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,          // pas de SMTP : le compte est utilisable tout de suite
    user_metadata: { full_name: fullName, invitation: true },
  })
  if (createError || !created.user?.id) {
    const message = createError?.message?.toLowerCase() ?? ''
    const taken = message.includes('already') || message.includes('registered') || message.includes('exists')
    return json({
      error: taken ? 'email_already_exists' : 'account_creation_failed',
      details: createError?.message ?? 'aucun utilisateur renvoyé',
    }, taken ? 409 : 502)
  }

  // 4. Rachat du jeton : le marque utilisé ET crée l'adhésion, de façon atomique.
  const { error: redeemError } = await admin.rpc('redeem_agency_invitation', {
    p_token: token,
    p_email: email,
    p_full_name: fullName,
  })
  if (redeemError) {
    const { error: compensationError } = await admin.auth.admin.deleteUser(created.user.id)
    console.error('invitation_redeem_failed', {
      message: redeemError.message,
      compensation_failed: Boolean(compensationError),
    })
    const limit = redeemError.message?.includes('imite')
    return json({
      error: limit ? 'member_limit_reached' : 'invitation_redeem_failed',
      details: redeemError.message,
      code: redeemError.code ?? null,
    }, limit ? 409 : 500)
  }

  // 5. Aucune session créée ici : l'agent se reconnecte avec l'email et le mot
  //    de passe qu'il vient de choisir. Renvoyer un jeton d'accès fabriqué côté
  //    service_role élargirait la surface d'attaque sans bénéfice.
  //    agency_name est renvoyé : l'agent vient de rejoindre cette agence.
  return json({
    agency_name: status.agency_name,
    role: status.role,
    email,
    next_step: 'signin',
  }, 201)
})
