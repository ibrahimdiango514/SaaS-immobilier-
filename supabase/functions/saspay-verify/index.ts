import { createClient } from 'npm:@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SASPAY_API_BASE = 'https://api.saspay.me/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^\d+(?:\.\d{1,2})?$/;

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

function isLabSandboxMode(): boolean {
  return (
    !Deno.env.get('SASPAY_SECRET_KEY')?.trim() &&
    Deno.env.get('SASPAY_LAB_SANDBOX')?.trim() === 'true'
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

async function reconcileSinglePayment(serviceClient: ReturnType<typeof getServiceClient>, paymentId: string) {
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
  const txId = String(sessionData.transaction_id ?? '');

  if (sessionStatus === 'PAID') {
    if (!UUID_RE.test(txId)) throw new HttpError('missing_transaction_id', 503);

    const txData = await fetchSasPayJson(`/payments/${encodeURIComponent(txId)}/verify/`);
    if (String(txData.id ?? '').toLowerCase() !== txId.toLowerCase()) {
      throw new HttpError('transaction_id_mismatch', 503);
    }

    const reqAmount = parseNumeric(txData.requested_amount ?? sessionData.amount);
    const currency = String(txData.currency ?? sessionData.currency ?? '').toUpperCase();
    if (String(txData.status ?? '').toUpperCase() !== 'SUCCESS' || !reqAmount || !currency) {
      throw new HttpError('transaction_not_confirmed', 503);
    }

    const { data: confirmed, error: confirmErr } = await serviceClient.rpc('saspay_confirm_guarded_payment', {
      p_payment_id: row.id,
      p_session_id: sessionId,
      p_transaction_id: txId,
      p_requested_amount: reqAmount,
      p_currency: currency,
      p_transaction_reference: String(txData.reference ?? sessionData.transaction_reference ?? '') || null,
      p_net_amount: parseNumeric(txData.net_amount),
      p_charged_amount: parseNumeric(txData.debited_amount),
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
  const isTxFailed = sessionStatus === 'FAILED' || String(sessionData.transaction_status ?? '').toUpperCase() === 'FAILED';
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

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'authentication_required' }, 401);
  }

  try {
    const callerClient = getUserClient(authHeader);
    const { data: authData, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !authData.user) {
      return jsonResponse({ error: 'authentication_required' }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'invalid_json' }, 400);
    }

    const paymentId = typeof body?.payment_id === 'string' && UUID_RE.test(body.payment_id) ? body.payment_id : null;
    const sessionId = typeof body?.session_id === 'string' && UUID_RE.test(body.session_id) ? body.session_id : null;
    const labSimulate = typeof body?.lab_simulate === 'string' ? body.lab_simulate.trim().toLowerCase() : null;

    if (!paymentId && !sessionId) {
      return jsonResponse({ error: 'payment_or_session_id_required' }, 400);
    }

    const { data: current, error: accessErr } = await callerClient.rpc('saspay_payment_for_caller', {
      p_payment_id: paymentId,
      p_session_id: sessionId,
    });

    if (accessErr || !current?.payment_id) {
      return jsonResponse({ error: 'acces_refuse' }, 403);
    }

    const labSandbox = isLabSandboxMode();

    // Simulation contrôlée Lab uniquement (ZÉRO encaissement réel)
    if (labSandbox && current.status === 'pending' && current.checkout_session_id && (labSimulate === 'paid' || labSimulate === 'failed')) {
      const svc = getServiceClient();
      if (labSimulate === 'paid') {
        const simTxId = crypto.randomUUID();
        const simRef = `SASPAY-LAB-TEST-${String(current.payment_id).slice(0, 8).toUpperCase()}`;
        await svc.rpc('saspay_confirm_guarded_payment', {
          p_payment_id: current.payment_id,
          p_session_id: current.checkout_session_id,
          p_transaction_id: simTxId,
          p_requested_amount: current.amount,
          p_currency: String(current.currency ?? 'XOF').toUpperCase(),
          p_transaction_reference: simRef,
          p_net_amount: current.amount,
          p_charged_amount: current.amount,
        });
      } else {
        await svc.rpc('saspay_record_failed', {
          p_payment_id: current.payment_id,
          p_session_id: current.checkout_session_id,
          p_reason: 'saspay_lab_simulated_failure',
          p_terminal: true,
        });
      }
    }

    let verifiedWithProvider = false;
    let providerNote: string | null = null;

    if (
      !labSandbox &&
      current.checkout_session_id &&
      (current.status === 'pending' || (current.status === 'paid' && !current.reconciled_at))
    ) {
      try {
        await reconcileSinglePayment(getServiceClient(), String(current.payment_id));
        verifiedWithProvider = true;
      } catch (verifyErr) {
        // Si SasPay signale une anomalie de vérification (hors simple absence de clé Lab), lever une alerte admin
        providerNote = verifyErr instanceof HttpError ? verifyErr.message : 'verification_temporarily_unavailable';
        if (providerNote !== 'saspay_not_configured') {
          await getServiceClient().rpc('saspay_record_verification_failure', {
            p_payment_id: current.payment_id,
            p_session_id: current.checkout_session_id,
            p_reason: providerNote,
          }).catch(() => undefined);
        }
      }
    }

    const { data: updated, error: reloadErr } = await callerClient.rpc('saspay_payment_for_caller', {
      p_payment_id: current.payment_id,
      p_session_id: null,
    });

    if (reloadErr || !updated) {
      return jsonResponse({ error: 'payment_state_failed' }, 503);
    }

    return jsonResponse({
      ...updated,
      verified: verifiedWithProvider || labSandbox,
      provider_note: providerNote,
      lab_sandbox: labSandbox,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    console.error('saspay_verify_unexpected_error', String(err));
    return jsonResponse({ error: 'server_error' }, 500);
  }
});
