// SASPAY-VERIFY - retour navigateur apres paiement : rapproche le statut
// cote SasPay puis renvoie l etat courant de l intention.
//
// Appelee par /paiement/retour?payment=<id> (et accepte aussi session_id).
// Filet de securite : si le webhook n est jamais arrive, la page de retour
// force elle-meme le rapprochement. Idempotent - saspay_confirm_payment
// ne retraite jamais un paiement deja paye.
//
// Securite :
//   - Bearer valide via auth.getUser() (verify_jwt desactive plateforme) ;
//   - acces agence verifie (is_agency_member pour payment_id,
//     saspay_payment_state pour session_id) ;
//   - appel SasPay cote serveur avec SASPAY_SECRET_KEY (jamais exposee).
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
const FAILED_STATUSES = new Set(['FAILED', 'CANCELLED', 'EXPIRED'])

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

  let body: any
  try { body = await request.json() } catch { return json({ error: 'invalid_json' }, 400) }

  const paymentId = typeof body.payment_id === 'string' ? body.payment_id.trim() : ''
  const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : ''
  if (!paymentId && !sessionId) return json({ error: 'payment_id_or_session_id_required' }, 400)

  const callerClient = createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  })
  const admin = createClient(url, service, { auth: { persistSession: false } })

  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  if (callerError || !callerData.user) return json({ error: 'authentication_required' }, 401)

  // 1. Localisation de l intention + controle d acces.
  let row: any = null
  if (paymentId) {
    const { data: rows, error: rowError } = await admin
      .schema('saas_immobilier')
      .from('online_payments')
      .select('id, agency_id, status, purpose, amount, currency, checkout_session_id, checkout_url, transaction_reference, fail_reason, paid_at, expires_at, created_at')
      .eq('id', paymentId)
      .limit(1)
    if (rowError) return json({ error: 'payment_read_failed', details: rowError.message }, 500)
    if (!rows || rows.length === 0) return json({ found: false, error: 'payment_not_found' }, 404)
    row = rows[0]

    const { data: allowed, error: allowedError } = await callerClient.rpc('is_agency_member', {
      target_agency_id: row.agency_id,
    })
    if (allowedError) return json({ error: 'access_check_failed', details: allowedError.message }, 500)
    if (allowed !== true) return json({ error: 'acces_refuse' }, 403)
  } else {
    const { data: state, error: stateError } = await callerClient.rpc('saspay_payment_state', {
      p_session_id: sessionId,
    })
    if (stateError) {
      const status = stateError.message?.includes('refuse') ? 403 : 500
      return json({ error: 'payment_state_failed', details: stateError.message }, status)
    }
    const st: any = Array.isArray(state) ? state[0] : state
    if (!st || st.found !== true) return json({ found: false })
    const { data: rows } = await admin
      .schema('saas_immobilier')
      .from('online_payments')
      .select('id, agency_id, status, purpose, amount, currency, checkout_session_id, checkout_url, transaction_reference, fail_reason, paid_at, expires_at, created_at')
      .eq('id', st.payment_id)
      .limit(1)
    row = rows && rows.length > 0 ? rows[0] : null
    if (!row) return json({ found: false })
  }

  // 2. Deja soldee : etat immediate, aucun appel SasPay.
  if (row.status !== 'pending' || !row.checkout_session_id) {
    return json({
      found: true,
      payment_id: row.id,
      agency_id: row.agency_id,
      purpose: row.purpose,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      checkout_session_id: row.checkout_session_id,
      transaction_reference: row.transaction_reference,
      fail_reason: row.fail_reason,
      paid_at: row.paid_at,
      expires_at: row.expires_at,
      verified: false,
    })
  }

  // 3. Rapprochement cote SasPay (la reponse serveur fait foi).
  if (saspayKey) {
    try {
      const statusResponse = await fetch(
        `${SASPAY_API_BASE}/checkout-sessions/${encodeURIComponent(row.checkout_session_id)}/status/`,
        { headers: { Authorization: `Bearer ${saspayKey}` } },
      )
      if (statusResponse.ok) {
        const parsedStatus = await statusResponse.json()
        // Enveloppe reelle {success, data} : on deplie data (spec = objet nu).
        const statusPayload = parsedStatus && typeof parsedStatus === 'object'
          && parsedStatus.data && typeof parsedStatus.data === 'object'
          ? parsedStatus.data
          : parsedStatus
        const saspayStatus = String(statusPayload?.status ?? '')
        const txId = statusPayload?.transaction_id ? String(statusPayload.transaction_id) : null
        const txRef = statusPayload?.transaction_reference
          ? String(statusPayload.transaction_reference)
          : null

        if (saspayStatus === 'PAID') {
          const { error: confirmError } = await admin.rpc('saspay_confirm_payment', {
            p_payment_id: row.id,
            p_session_id: row.checkout_session_id,
            p_outcome: 'paid',
            p_transaction_id: txId,
            p_transaction_reference: txRef,
            p_requested_amount: null,
            p_fail_reason: null,
          })
          if (confirmError) {
            console.error('verify_confirm_failed', { message: confirmError.message })
            return json({ error: 'confirm_failed', details: confirmError.message }, 500)
          }
        } else if (FAILED_STATUSES.has(saspayStatus)) {
          await admin.rpc('saspay_confirm_payment', {
            p_payment_id: row.id,
            p_session_id: row.checkout_session_id,
            p_outcome: 'failed',
            p_transaction_id: txId,
            p_transaction_reference: txRef,
            p_requested_amount: null,
            p_fail_reason: `saspay_${saspayStatus.toLowerCase()}`,
          })
        }
      }
    } catch (e) {
      // Reseau SasPay indisponible : on renvoie l etat local, la page peut
      // reappeler. Ce n est pas une erreur bloquante.
      console.error('verify_status_exception', { message: String(e) })
    }
  }

  // 4. Etat final (relecture apres confirmation eventuelle).
  const { data: finalRows } = await admin
    .schema('saas_immobilier')
    .from('online_payments')
    .select('id, agency_id, status, purpose, amount, currency, checkout_session_id, transaction_reference, fail_reason, paid_at, expires_at, created_at')
    .eq('id', row.id)
    .limit(1)
  const finalRow = finalRows && finalRows.length > 0 ? finalRows[0] : row

  return json({
    found: true,
    payment_id: finalRow.id,
    agency_id: finalRow.agency_id,
    purpose: finalRow.purpose,
    amount: finalRow.amount,
    currency: finalRow.currency,
    status: finalRow.status,
    checkout_session_id: finalRow.checkout_session_id,
    transaction_reference: finalRow.transaction_reference,
    fail_reason: finalRow.fail_reason,
    paid_at: finalRow.paid_at,
    expires_at: finalRow.expires_at,
    verified: true,
  })
})
