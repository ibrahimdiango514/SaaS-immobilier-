// SASPAY-WEBHOOK - reception des events SasPay + rapprochement des paiements.
//
// Le webhook SasPay ne contient PAS l id de la session de checkout : il livre
// la transaction (id, reference, montant). Strategie de rapprochement :
//   1. verification HMAC de la signature (X-Webhook-Signature sur
//      `${timestamp}.${corps_brut}`, tolerance 300 s) ;
//   2. lecture des intentions ouvertes munies d une session
//      (RPC saspay_recent_pending_sessions, bornee a 25 / 48 h) ;
//   3. pour chacune, GET /checkout-sessions/{id}/status/ - la reponse serveur
//      SasPay fait foi (jamais le seul corps du webhook) ;
//   4. confirmation idempotente via saspay_confirm_payment (barrieres de
//      montant et d idempotence cote SQL).
//
// Un event non apparie repond 200 : SasPay ne doit pas boucler sur les events
// qui ne concernent pas nos paiements (settlement, wallet, webhook.test...).
// Une erreur transitoire repond 500 pour permettre la rejeu automatique.
//
// verify_jwt desactive cote plateforme : la seule authentification est la
// signature HMAC. Aucun secret n est logue.
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
const TOLERANCE_SECONDS = 300
const PAYIN_EVENTS = new Set(['transaction.success', 'transaction.failed', 'transaction.cancelled'])
const FAILED_STATUSES = new Set(['FAILED', 'CANCELLED', 'EXPIRED'])

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ba = hexToBytes(a)
  const bb = hexToBytes(b)
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const secret = Deno.env.get('SASPAY_WEBHOOK_SECRET')
  const url = Deno.env.get('SUPABASE_URL')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !service) return json({ error: 'server_configuration_error' }, 500)
  if (!secret) return json({ error: 'saspay_not_configured' }, 503)

  // Corps BRUT : la signature couvre les octets recus, jamais une re-serialisation.
  const rawBody = await request.text()
  const signature = (request.headers.get('X-Webhook-Signature') ?? '').trim().toLowerCase()
  const timestamp = (request.headers.get('X-Webhook-Timestamp') ?? '').trim()
  const eventHeader = (request.headers.get('X-Webhook-Event') ?? '').trim()

  if (!signature || !timestamp) return json({ error: 'missing_signature_headers' }, 401)

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return json({ error: 'invalid_timestamp' }, 401)
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return json({ error: 'timestamp_out_of_tolerance' }, 401)

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`)
  if (!timingSafeEqualHex(signature, expected)) return json({ error: 'invalid_signature' }, 401)

  let envelope: any
  try {
    envelope = JSON.parse(rawBody)
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const event = String(envelope?.event ?? eventHeader ?? '')
  const data = envelope?.data ?? {}

  const admin = createClient(url, service, { auth: { persistSession: false } })

  // Journal de reception (ecriture exclusive service_role).
  let logId: string | null = null
  const { data: logRow, error: logError } = await admin
    .schema('saas_immobilier')
    .from('saspay_webhook_events')
    .insert({
      event_type: event,
      signature,
      signature_ts: ts,
      payload: envelope,
      processing_result: 'received',
      processed_at: new Date().toISOString(),
    })
    .select('id')
    .limit(1)
  if (logError) {
    console.error('webhook_log_failed', { message: logError.message, code: logError.code ?? null })
  } else if (logRow && logRow.length > 0) {
    logId = String(logRow[0].id)
  }

  async function markLog(result: string) {
    if (!logId) return
    const { error } = await admin
      .schema('saas_immobilier')
      .from('saspay_webhook_events')
      .update({ processing_result: result, processed_at: new Date().toISOString() })
      .eq('id', logId)
    if (error) console.error('webhook_log_update_failed', { message: error.message })
  }

  // Events hors paiement : accuse reception, rien a rapprocher.
  if (!PAYIN_EVENTS.has(event)) {
    await markLog('ignored_event')
    return json({ received: true, event, matched: 0 })
  }

  try {
    // Intentions ouvertes munies d une session (bornee : 25 max / 48 h).
    const { data: pending, error: pendingError } = await admin.rpc('saspay_recent_pending_sessions', {
      p_limit: 25,
    })
    if (pendingError) {
      await markLog(`error:${pendingError.message}`)
      return json({ error: 'pending_sessions_failed', details: pendingError.message }, 500)
    }
    const sessions: any[] = Array.isArray(pending) ? pending : (pending ?? [])

    const success = event === 'transaction.success'
    const webhookTxId = typeof data.id === 'string' ? data.id : null
    const webhookAmount = data.amount !== undefined && data.amount !== null && data.amount !== ''
      ? Number(data.amount)
      : null

    let matched = 0
    const outcomes: string[] = []

    for (const item of sessions) {
      const paymentId = String(item?.payment_id ?? '')
      const sessionId = String(item?.checkout_session_id ?? '')
      if (!paymentId || !sessionId) continue

      // La reponse serveur SasPay fait foi : on reinterroge le statut.
      let statusPayload: any
      try {
        const statusResponse = await fetch(
          `${SASPAY_API_BASE}/checkout-sessions/${encodeURIComponent(sessionId)}/status/`,
          { headers: { Authorization: `Bearer ${Deno.env.get('SASPAY_SECRET_KEY') ?? ''}` } },
        )
        if (!statusResponse.ok) {
          outcomes.push(`status_http_${statusResponse.status}`)
          continue
        }
        const parsedStatus = await statusResponse.json()
        // Enveloppe reelle {success, data} : on deplie data (spec = objet nu).
        statusPayload = parsedStatus && typeof parsedStatus === 'object'
          && parsedStatus.data && typeof parsedStatus.data === 'object'
          ? parsedStatus.data
          : parsedStatus
      } catch {
        outcomes.push('status_network_error')
        continue
      }

      const saspayStatus = String(statusPayload?.status ?? '')
      const txId = statusPayload?.transaction_id ? String(statusPayload.transaction_id) : null
      const txRef = statusPayload?.transaction_reference
        ? String(statusPayload.transaction_reference)
        : null

      if (saspayStatus === 'PAID') {
        // Le montant annonce par le webhook n est utilise QUE si la
        // transaction du webhook EST celle de la session : sinon on laisse
        // NULL (la session SasPay a ete creee avec notre montant exact).
        const amountForBarrier = webhookTxId && txId && webhookTxId === txId ? webhookAmount : null
        const { data: confirmed, error: confirmError } = await admin.rpc('saspay_confirm_payment', {
          p_payment_id: paymentId,
          p_session_id: sessionId,
          p_outcome: 'paid',
          p_transaction_id: txId,
          p_transaction_reference: txRef,
          p_requested_amount: amountForBarrier,
          p_fail_reason: null,
        })
        if (confirmError) {
          outcomes.push(`confirm_error:${confirmError.message}`)
          continue
        }
        const conf: any = Array.isArray(confirmed) ? confirmed[0] : confirmed
        matched += 1
        outcomes.push(conf?.already_processed ? 'already_paid' : 'paid')
        continue
      }

      if (FAILED_STATUSES.has(saspayStatus) && webhookTxId && txId && webhookTxId === txId) {
        const { error: confirmError } = await admin.rpc('saspay_confirm_payment', {
          p_payment_id: paymentId,
          p_session_id: sessionId,
          p_outcome: 'failed',
          p_transaction_id: txId,
          p_transaction_reference: txRef,
          p_requested_amount: null,
          p_fail_reason: `saspay_${saspayStatus.toLowerCase()}`,
        })
        if (confirmError) {
          outcomes.push(`confirm_error:${confirmError.message}`)
          continue
        }
        matched += 1
        outcomes.push('marked_failed')
      }
    }

    const result = matched > 0 ? `matched:${matched}:${outcomes.join(',')}` : `no_match:${outcomes.join(',') || 'none'}`
    await markLog(result)
    return json({ received: true, event, matched, outcomes })
  } catch (e) {
    const message = String(e)
    await markLog(`exception:${message}`)
    console.error('webhook_processing_exception', { message })
    return json({ error: 'webhook_processing_failed' }, 500)
  }
})
