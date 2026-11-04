// SASPAY-CHECKOUT - creation d une intention de paiement + session SasPay.
//
// Flux :
//   1. Bearer valide via auth.getUser() (verify_jwt desactive cote plateforme,
//      comme create-agency-member-v2 : aucune protection perdue).
//   2. RPC saspay_create_checkout (cote navigateur, role authenticated) :
//      garde proprietaire/admin de l agence, montants, idempotence locale.
//   3. La session SasPay est creee ICI, cote serveur, avec la cle secrete
//      SASPAY_SECRET_KEY (jamais dans le navigateur).
//   4. RPC saspay_attach_checkout (service_role) : attache la session a
//      l intention. Idempotent - la premiere session gagne, jamais d ecrasement.
//
// Le return_url ramene le navigateur sur /paiement/retour?payment=<id> :
// la page d appelle saspay-verify qui rapproche le statut cote SasPay.
//
// Securite : aucun secret n est logue. Les erreurs SasPay sont renvoyees sans
// le corps complet (il peut contenir des informations marchand).
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

const SASPAY_API_BASE = 'https://api.saspay.me/api/v1'
const ALLOWED_PURPOSES = new Set(['setup', 'renewal', 'invoice'])

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'authentication_required' }, 401)

  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const saspayKey = Deno.env.get('SASPAY_SECRET_KEY')
  if (!url || !anon || !service) return json({ error: 'server_configuration_error' }, 500)
  if (!saspayKey) return json({ error: 'saspay_not_configured', details: 'SASPAY_SECRET_KEY absent' }, 503)

  let body: any
  try { body = await request.json() } catch { return json({ error: 'invalid_json' }, 400) }

  const agencyId = String(body.agency_id ?? '').trim()
  const purpose = String(body.purpose ?? '').trim().toLowerCase()
  const planId = typeof body.plan_id === 'string' && body.plan_id ? body.plan_id : null
  const invoiceId = typeof body.invoice_id === 'string' && body.invoice_id ? body.invoice_id : null
  const originHeader = request.headers.get('Origin')
  const bodyOrigin = typeof body.origin === 'string' ? body.origin.trim() : ''

  if (!agencyId) return json({ error: 'agency_id_required' }, 400)
  if (!ALLOWED_PURPOSES.has(purpose)) return json({ error: 'purpose_invalid' }, 400)

  // Origine du retour : fournie par le client, sinon header Origin du navigateur.
  let origin = bodyOrigin || originHeader || ''
  if (origin && !isHttpUrl(origin)) return json({ error: 'origin_invalid' }, 400)
  origin = origin.replace(/\/+$/, '')

  const callerClient = createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, service, { auth: { persistSession: false } })

  // 1. Appelant authentifie
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  if (callerError || !callerData.user) return json({ error: 'authentication_required' }, 401)

  // 2. Intention de paiement (garde agence + montants + idempotence cote SQL)
  const { data: created, error: createError } = await callerClient.rpc('saspay_create_checkout', {
    p_agency_id: agencyId,
    p_purpose: purpose,
    p_plan_id: planId,
    p_invoice_id: invoiceId,
  })
  if (createError || !created) {
    const message = createError?.message ?? 'create_checkout_failed'
    const status = message.includes('refuse') || message.includes('requis') ? 403
      : message.includes('invalide') || message.includes('choisissez') || message.includes('introuvable')
      || message.includes('nul') || message.includes('concernent') || message.includes('indisponible')
      ? 400 : 500
    return json({ error: 'checkout_intent_failed', details: message, code: createError?.code ?? null }, status)
  }

  const paymentId = String(created.payment_id ?? '')
  if (!paymentId) return json({ error: 'checkout_intent_failed', details: 'payment_id absent' }, 500)

  // 3. Etat courant de l intention (session deja attachee ?)
  const { data: rows, error: rowError } = await admin
    .schema('saas_immobilier')
    .from('online_payments')
    .select('id, amount, currency, status, checkout_session_id, checkout_url, metadata, expires_at')
    .eq('id', paymentId)
    .limit(1)
  if (rowError || !rows || rows.length === 0) {
    return json({ error: 'checkout_intent_read_failed', details: rowError?.message ?? 'not_found' }, 500)
  }
  const row: any = rows[0]

  // Deja munie d une session : on renvoie la session initiale (jamais de 2e).
  if (row.checkout_session_id && row.checkout_url) {
    return json({
      payment_id: row.id,
      session_id: row.checkout_session_id,
      checkout_url: row.checkout_url,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      reused: true,
    })
  }
  if (row.status !== 'pending') {
    return json({ error: 'intent_not_open', status: row.status, payment_id: row.id }, 409)
  }

  const meta = row.metadata ?? {}
  const returnUrl = origin ? `${origin}/paiement/retour?payment=${row.id}` : undefined

  // 4. Session SasPay cote serveur (cle secrete jamais exposee)
  const saspayPayload: Record<string, unknown> = {
    amount: Number(row.amount).toFixed(2),
    currency: String(row.currency ?? 'XOF'),
    description: String(meta.description ?? 'Sofia Immobilier - Paiement'),
    country: String(meta.country ?? 'ML'),
    customer_email: String(meta.customer_email ?? ''),
    customer_name: String(meta.customer_name ?? meta.agency_name ?? 'Sofia Immobilier'),
    metadata: {
      payment_id: row.id,
      agency_id: agencyId,
      purpose: purpose,
    },
  }
  if (returnUrl) saspayPayload.return_url = returnUrl
  if (String(meta.customer_phone ?? '')) saspayPayload.customer_phone = String(meta.customer_phone)

  let saspaySession: any
  let saspayStatus = 0
  let saspayFinalUrl = ''
  let saspayRedirected = false
  let saspayText = ''
  try {
    const saspayResponse = await fetch(`${SASPAY_API_BASE}/checkout-sessions/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${saspayKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(saspayPayload),
    })
    const text = await saspayResponse.text()
    saspayStatus = saspayResponse.status
    saspayFinalUrl = saspayResponse.url
    saspayRedirected = saspayResponse.redirected
    saspayText = text
    if (!saspayResponse.ok) {
      let detail = `saspay_http_${saspayResponse.status}`
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.message === 'string' && parsed.message) detail = parsed.message
        else if (typeof parsed?.code === 'string' && parsed.code) detail = parsed.code
        else if (typeof parsed?.detail === 'string' && parsed.detail) detail = parsed.detail
        else if (text) detail = `${detail} ${text.slice(0, 180)}`
      } catch { /* corps non JSON : extraits tronques seulement */ }
      console.error('saspay_session_create_failed', { status: saspayResponse.status, detail })
      return json({ error: 'saspay_session_failed', details: detail }, 502)
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed.success === false) {
          const msg = typeof parsed.message === 'string' && parsed.message
            ? parsed.message
            : typeof parsed.code === 'string' && parsed.code
            ? parsed.code
            : typeof parsed.detail === 'string' && parsed.detail
            ? parsed.detail
            : text.slice(0, 180)
          return json({ error: 'saspay_session_failed', details: `saspay_rejected ${msg}` }, 502)
        }
        // L API repond enveloppe {success, data, code} ; la spec OpenAPI
        // montre l objet nu. On deplie data quand il porte la session.
        saspaySession = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
          ? parsed.data
          : parsed
      } else {
        saspaySession = parsed
      }
    } catch {
      return json({
        error: 'saspay_session_failed',
        details: `session_incomplete status=${saspayStatus} body_non_json=${text.slice(0, 180)}`,
      }, 502)
    }
  } catch (e) {
    console.error('saspay_session_create_exception', { message: String(e) })
    return json({ error: 'saspay_session_failed', details: 'network_error' }, 502)
  }

  const sessionId = String(saspaySession?.id ?? '')
  const checkoutUrl = String(saspaySession?.checkout_url ?? '')
  if (!sessionId || !checkoutUrl) {
    // Reponse 2xx sans session : on renvoie un diagnostic complet pour
    // identifier la vraie cause (enveloppe d erreur, liste paginee,
    // redirection POST -> GET, champ renomme...).
    const keys = saspaySession && typeof saspaySession === 'object' && !Array.isArray(saspaySession)
      ? Object.keys(saspaySession).slice(0, 25).join('|')
      : Array.isArray(saspaySession) ? 'ARRAY' : typeof saspaySession
    const envelope = typeof saspaySession?.message === 'string' && saspaySession.message
      ? saspaySession.message
      : typeof saspaySession?.detail === 'string' && saspaySession.detail
      ? saspaySession.detail
      : typeof saspaySession?.code === 'string' && saspaySession.code
      ? saspaySession.code
      : ''
    const diagnostic = [
      `status=${saspayStatus}`,
      `redirected=${saspayRedirected}`,
      `final_url=${saspayFinalUrl}`,
      `keys=${keys}`,
      envelope ? `envelope=${envelope}` : '',
      `body=${saspayText.slice(0, 200)}`,
    ].filter(Boolean).join(' ')
    console.error('saspay_session_incomplete', diagnostic)
    return json({ error: 'saspay_session_failed', details: `session_incomplete ${diagnostic}` }, 502)
  }

  // 5. Attache la session a l intention (service_role, idempotent)
  const { data: attached, error: attachError } = await admin.rpc('saspay_attach_checkout', {
    p_payment_id: row.id,
    p_session_id: sessionId,
    p_checkout_url: checkoutUrl,
    p_expires_at: saspaySession.expires_at ? String(saspaySession.expires_at) : null,
  })
  if (attachError) {
    console.error('saspay_attach_failed', { message: attachError.message, code: attachError.code ?? null })
    return json({ error: 'checkout_attach_failed', details: attachError.message }, 500)
  }
  const attach: any = Array.isArray(attached) ? attached[0] : attached

  // La session initiale gagne : si une course a attache une autre session,
  // on renvoie TOUJOURS celle qui est en base.
  return json({
    payment_id: row.id,
    session_id: attach?.checkout_session_id ?? sessionId,
    checkout_url: attach?.checkout_url ?? checkoutUrl,
    amount: row.amount,
    currency: row.currency,
    status: 'pending',
    reused: Boolean(attach?.already_attached),
  }, 201)
})
