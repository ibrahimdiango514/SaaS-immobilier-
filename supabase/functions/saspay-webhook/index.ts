import { createClient } from 'npm:@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature, x-webhook-timestamp, x-webhook-event',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SASPAY_API_BASE = 'https://api.saspay.me/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^\d+(?:\.\d{1,2})?$/;
const HANDLED_EVENTS = new Set([
  'transaction.success',
  'transaction.failed',
  'transaction.cancelled',
]);

class HttpError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getServiceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

async function verifyWebhookSignature(
  secret: string,
  signatureHex: string,
  timestampStr: string,
  rawBody: string,
  nowEpochSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(signatureHex) || !/^\d{10}$/.test(timestampStr)) {
    return false;
  }
  if (Math.abs(nowEpochSec - Number(timestampStr)) > 300) {
    return false;
  }
  const sigBytes = new Uint8Array(
    signatureHex.match(/../g)!.map((pair) => parseInt(pair, 16)),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(`${timestampStr}.${rawBody}`),
  );
}

function getSasPaySecret(): string {
  const key = Deno.env.get('SASPAY_SECRET_KEY')?.trim();
  if (!key) throw new HttpError('saspay_not_configured', 503);
  return key;
}

function parseNumeric(val: unknown): string | null {
  if (typeof val !== 'string' && typeof val !== 'number') return null;
  if (typeof val === 'number' && !Number.isFinite(val)) return null;
  const s = String(val).trim();
  return DECIMAL_RE.test(s) ? s : null;
}

async function fetchSasPayJson(path: string): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(`${SASPAY_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${getSasPaySecret()}` },
      signal: AbortSignal.timeout(7_000),
    });
  } catch {
    throw new HttpError('saspay_unreachable', 503);
  }
  if (!resp.ok) throw new HttpError(`saspay_http_${resp.status}`, 503);
  const raw = await resp.json().catch(() => null);
  if (!raw || raw.success === false) throw new HttpError('saspay_rejected', 503);
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError('saspay_invalid_response', 503);
  }
  return data as Record<string, unknown>;
}

async function settleMatchedPayment(
  serviceClient: ReturnType<typeof getServiceClient>,
  paymentId: string,
  verifiedTx: Record<string, unknown>,
) {
  const { data: row, error } = await serviceClient
    .schema('saas_immobilier')
    .from('online_payments')
    .select('id, agency_id, status, reconciled_at, checkout_session_id, amount, currency')
    .eq('id', paymentId)
    .maybeSingle();

  if (error || !row) throw new HttpError('payment_not_found', 404);
  if (row.status === 'paid' && row.reconciled_at) {
    return { status: 'paid', already_processed: true };
  }
  if (!row.checkout_session_id) {
    return { status: row.status, verified: false };
  }

  const sessionId = String(row.checkout_session_id);
  const sessionData = await fetchSasPayJson(`/checkout-sessions/${encodeURIComponent(sessionId)}/status/`);
  const sessionStatus = String(sessionData.status ?? '').toUpperCase();
  const txId = String(sessionData.transaction_id ?? verifiedTx.id ?? '');

  if (sessionStatus === 'PAID') {
    const reqAmount = parseNumeric(verifiedTx.requested_amount ?? sessionData.amount);
    const currency = String(verifiedTx.currency ?? sessionData.currency ?? '').toUpperCase();
    if (String(verifiedTx.status ?? '').toUpperCase() !== 'SUCCESS' || !reqAmount || !currency || !UUID_RE.test(txId)) {
      throw new HttpError('transaction_not_confirmed', 503);
    }

    const { data: confirmed, error: confirmErr } = await serviceClient.rpc('saspay_confirm_guarded_payment', {
      p_payment_id: row.id,
      p_session_id: sessionId,
      p_transaction_id: txId,
      p_requested_amount: reqAmount,
      p_currency: currency,
      p_transaction_reference: String(verifiedTx.reference ?? sessionData.transaction_reference ?? '') || null,
      p_net_amount: parseNumeric(verifiedTx.net_amount),
      p_charged_amount: parseNumeric(verifiedTx.debited_amount),
    });

    if (confirmErr) {
      await serviceClient.rpc('saspay_record_reconciliation_exception', {
        p_payment_id: row.id,
        p_session_id: sessionId,
        p_transaction_id: txId,
        p_reason: confirmErr.message ?? confirmErr.code ?? 'confirmation_failed',
      });
      throw new HttpError('confirmation_failed', 503);
    }
    return confirmed;
  }

  const isTerminal = ['EXPIRED', 'CANCELLED'].includes(sessionStatus);
  const isTxFailed = sessionStatus === 'FAILED' || String(verifiedTx.status ?? '').toUpperCase() === 'FAILED';
  if (isTerminal || isTxFailed) {
    await serviceClient.rpc('saspay_record_failed', {
      p_payment_id: row.id,
      p_session_id: sessionId,
      p_reason: `saspay_${isTerminal ? sessionStatus.toLowerCase() : 'failed'}`,
      p_terminal: isTerminal || sessionStatus === 'FAILED',
    });
    return { status: isTerminal || sessionStatus === 'FAILED' ? 'failed' : 'pending', verified: true };
  }

  return { status: row.status, verified: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  const webhookSecret = Deno.env.get('SASPAY_WEBHOOK_SECRET')?.trim();
  if (!webhookSecret) return jsonResponse({ error: 'saspay_not_configured' }, 503);

  const rawBody = await req.text();
  if (rawBody.length > 65_536) return jsonResponse({ error: 'payload_too_large' }, 413);

  const signature = req.headers.get('X-Webhook-Signature')?.trim() ?? '';
  const timestamp = req.headers.get('X-Webhook-Timestamp')?.trim() ?? '';

  if (!(await verifyWebhookSignature(webhookSecret, signature, timestamp, rawBody))) {
    return jsonResponse({ error: 'invalid_signature' }, 401);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const eventType = String(parsed?.event ?? req.headers.get('X-Webhook-Event') ?? '').trim();
  if (!HANDLED_EVENTS.has(eventType)) {
    return jsonResponse({ received: true, ignored: true });
  }

  const dataObj = (parsed?.data && typeof parsed.data === 'object' ? parsed.data : {}) as Record<string, unknown>;
  const transactionId = String(dataObj.id ?? '').trim();
  if (!UUID_RE.test(transactionId)) {
    return jsonResponse({ error: 'invalid_transaction' }, 400);
  }

  const serviceClient = getServiceClient();

  const { data: logRow } = await serviceClient
    .schema('saas_immobilier')
    .from('saspay_webhook_events')
    .insert({
      event_type: eventType,
      external_transaction_id: transactionId,
      signature_ts: Number(timestamp),
      payload: { event: eventType, transaction_id: transactionId },
      processing_result: 'received',
    })
    .select('id')
    .maybeSingle();

  const updateLog = async (result: string) => {
    if (!logRow?.id) return;
    await serviceClient
      .schema('saas_immobilier')
      .from('saspay_webhook_events')
      .update({ processing_result: result, processed_at: new Date().toISOString() })
      .eq('id', logRow.id);
  };

  try {
    const verifiedTx = await fetchSasPayJson(`/payments/${encodeURIComponent(transactionId)}/verify/`);
    if (String(verifiedTx.id ?? '').toLowerCase() !== transactionId.toLowerCase()) {
      throw new HttpError('transaction_id_mismatch', 503);
    }

    // 1. Recherche directe O(1) via metadata.payment_id ou transaction_id
    const txMeta = (verifiedTx.metadata && typeof verifiedTx.metadata === 'object' ? verifiedTx.metadata : {}) as Record<string, unknown>;
    const metaPaymentId = typeof txMeta.payment_id === 'string' && UUID_RE.test(txMeta.payment_id) ? txMeta.payment_id : null;

    if (metaPaymentId) {
      const res = await settleMatchedPayment(serviceClient, metaPaymentId, verifiedTx);
      await updateLog('processed');
      return jsonResponse({ received: true, matched: true, result: res });
    }

    const { data: byTx } = await serviceClient
      .schema('saas_immobilier')
      .from('online_payments')
      .select('id')
      .eq('transaction_id', transactionId)
      .maybeSingle();

    if (byTx?.id) {
      const res = await settleMatchedPayment(serviceClient, String(byTx.id), verifiedTx);
      await updateLog('processed');
      return jsonResponse({ received: true, matched: true, result: res });
    }

    // 2. Repli : balayage du lot des sessions en attente
    const { data: batch, error: batchErr } = await serviceClient.rpc('saspay_reconciliation_batch', {
      p_after: null,
      p_limit: 20,
      p_force: true,
    });
    if (batchErr || !Array.isArray(batch)) throw new Error('session_batch_failed');

    let matched = false;
    for (const item of batch) {
      await serviceClient.rpc('saspay_mark_reconcile_attempt', { p_payment_id: item.payment_id });
      const sess = await fetchSasPayJson(`/checkout-sessions/${encodeURIComponent(item.checkout_session_id)}/status/`);
      if (String(sess.transaction_id ?? '').toLowerCase() === transactionId.toLowerCase()) {
        await settleMatchedPayment(serviceClient, String(item.payment_id), verifiedTx);
        matched = true;
        break;
      }
    }

    await updateLog(matched ? 'processed' : 'awaiting_reconciliation');
    return jsonResponse({ received: true, matched, awaiting_reconciliation: !matched });
  } catch (err) {
    await updateLog('temporary_error');
    console.error('saspay_webhook_processing_error', String(err));
    return jsonResponse({ error: 'processing_failed' }, 503);
  }
});
