import { createClient } from 'npm:@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SASPAY_API_BASE = 'https://api.saspay.me/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^\d+(?:\.\d{1,2})?$/;

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

function getUserClient(authHeader: string) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    },
  );
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

function parseNumeric(val: unknown): string | null {
  if (typeof val !== 'string' && typeof val !== 'number') return null;
  if (typeof val === 'number' && !Number.isFinite(val)) return null;
  const s = String(val).trim();
  return DECIMAL_RE.test(s) ? s : null;
}

async function fetchSasPayJson(secret: string, path: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${SASPAY_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(7_000),
  });
  if (!resp.ok) throw new Error(`saspay_http_${resp.status}`);
  const raw = await resp.json();
  if (!raw || raw.success === false) throw new Error('saspay_rejected');
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('saspay_invalid_response');
  return data as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  const cronSecret = Deno.env.get('SASPAY_CRON_SECRET')?.trim() ?? '';

  let authorizedByCron = false;
  let authorizedByAdmin = false;

  if (cronSecret.length >= 32 && bearerToken && (await constantTimeEqual(cronSecret, bearerToken))) {
    authorizedByCron = true;
  } else if (authHeader.startsWith('Bearer ')) {
    const callerClient = getUserClient(authHeader);
    const { data: authData } = await callerClient.auth.getUser();
    if (authData?.user) {
      const { data: isAdmin } = await callerClient.rpc('is_platform_admin');
      authorizedByAdmin = Boolean(isAdmin);
    }
  }

  if (!authorizedByCron && !authorizedByAdmin) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const serviceClient = getServiceClient();
  let lifecycleResult: unknown = null;

  if (body?.run_lifecycle !== false) {
    const { data: lc } = await serviceClient.rpc('process_subscription_lifecycle', {});
    lifecycleResult = lc ?? null;
  }

  const saspaySecret = Deno.env.get('SASPAY_SECRET_KEY')?.trim();
  if (!saspaySecret) {
    await serviceClient.rpc('billing_log_reconciliation_run', { p_checked: 0, p_opened: 0, p_errors: 0 });
    return jsonResponse({
      checked: 0,
      confirmed: 0,
      errors: 0,
      saspay_configured: false,
      lifecycle: lifecycleResult,
    });
  }

  let checked = 0;
  let confirmed = 0;
  let errors = 0;

  try {
    const { data: batch, error: batchErr } = await serviceClient.rpc('saspay_reconciliation_batch', {
      p_after: null,
      p_limit: 40,
      p_force: authorizedByAdmin,
    });

    if (batchErr) throw batchErr;
    const items = Array.isArray(batch) ? batch : [];

    for (const item of items) {
      try {
        await serviceClient.rpc('saspay_mark_reconcile_attempt', { p_payment_id: item.payment_id });
        const sessionId = String(item.checkout_session_id);
        const sessionData = await fetchSasPayJson(saspaySecret, `/checkout-sessions/${encodeURIComponent(sessionId)}/status/`);
        const sessionStatus = String(sessionData.status ?? '').toUpperCase();
        const txId = String(sessionData.transaction_id ?? '');

        if (sessionStatus === 'PAID' && UUID_RE.test(txId)) {
          const txData = await fetchSasPayJson(saspaySecret, `/payments/${encodeURIComponent(txId)}/verify/`);
          const reqAmount = parseNumeric(txData.requested_amount ?? sessionData.amount);
          const currency = String(txData.currency ?? sessionData.currency ?? '').toUpperCase();
          if (String(txData.status ?? '').toUpperCase() === 'SUCCESS' && reqAmount && currency) {
            const { error: confErr } = await serviceClient.rpc('saspay_confirm_guarded_payment', {
              p_payment_id: item.payment_id,
              p_session_id: sessionId,
              p_transaction_id: txId,
              p_requested_amount: reqAmount,
              p_currency: currency,
              p_transaction_reference: String(txData.reference ?? sessionData.transaction_reference ?? '') || null,
              p_net_amount: parseNumeric(txData.net_amount),
              p_charged_amount: parseNumeric(txData.debited_amount),
            });
            if (confErr) {
              await serviceClient.rpc('saspay_record_reconciliation_exception', {
                p_payment_id: item.payment_id,
                p_session_id: sessionId,
                p_transaction_id: txId,
                p_reason: confErr.message ?? 'confirmation_failed',
              });
              errors++;
            } else {
              confirmed++;
            }
          }
        } else if (['EXPIRED', 'CANCELLED', 'FAILED'].includes(sessionStatus)) {
          await serviceClient.rpc('saspay_record_failed', {
            p_payment_id: item.payment_id,
            p_session_id: sessionId,
            p_reason: `saspay_${sessionStatus.toLowerCase()}`,
            p_terminal: true,
          });
        }
        checked++;
      } catch (itemErr) {
        errors++;
        const errReason = itemErr instanceof Error ? itemErr.message : String(itemErr);
        await serviceClient.rpc('saspay_record_verification_failure', {
          p_payment_id: item.payment_id,
          p_session_id: item.checkout_session_id,
          p_reason: errReason,
        }).catch(() => undefined);
        console.error('saspay_reconcile_item_error', item.payment_id, errReason);
      }
    }

    await serviceClient.rpc('billing_log_reconciliation_run', {
      p_checked: checked,
      p_opened: confirmed,
      p_errors: errors,
    });

    return jsonResponse({
      checked,
      confirmed,
      errors,
      saspay_configured: true,
      lifecycle: lifecycleResult,
    }, errors > 0 ? 207 : 200);
  } catch (err) {
    errors++;
    await serviceClient.rpc('billing_log_reconciliation_run', {
      p_checked: checked,
      p_opened: confirmed,
      p_errors: errors,
    });
    return jsonResponse({ error: 'reconcile_job_failed', details: String(err), lifecycle: lifecycleResult }, 503);
  }
});
