import { createClient } from 'npm:@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SASPAY_API_BASE = 'https://api.saspay.me/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^\d+(?:\.\d{1,2})?$/;
const ALLOWED_PURPOSES = new Set([
  'first_subscription',
  'renewal',
  'plan_change',
  'reactivation',
  'invoice',
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

function formatSasPayAmount(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'number' && (!Number.isFinite(raw) || raw <= 0)) return null;
  const str = String(raw).trim();
  if (!DECIMAL_RE.test(str)) return null;
  const [intPart, decPart = ''] = str.split('.');
  return `${intPart.replace(/^0+(?=\d)/, '')}.${decPart.padEnd(2, '0')}`;
}

function resolveSafeReturnOrigin(req: Request, bodyOrigin?: unknown): string | null {
  const configured = Deno.env.get('SOFIA_APP_BASE_URL')?.trim();
  const allowHttpLab = isLabSandboxMode();
  const candidates = [
    configured,
    typeof bodyOrigin === 'string' ? bodyOrigin.trim() : null,
    req.headers.get('Origin')?.trim(),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const validProto =
        parsed.protocol === 'https:' ||
        (allowHttpLab && parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'));
      if (validProto && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch {
      // ignore invalid URL candidate
    }
  }
  return null;
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

    const agencyId = typeof body?.agency_id === 'string' ? body.agency_id.trim() : '';
    const purpose = typeof body?.purpose === 'string' ? body.purpose.trim().toLowerCase() : '';
    const planId = typeof body?.plan_id === 'string' && UUID_RE.test(body.plan_id) ? body.plan_id : null;
    const invoiceId = typeof body?.invoice_id === 'string' && UUID_RE.test(body.invoice_id) ? body.invoice_id : null;

    if (!UUID_RE.test(agencyId) || !ALLOWED_PURPOSES.has(purpose)) {
      return jsonResponse({
        error: 'purpose_invalid',
        details: 'Motifs autorisés : first_subscription, renewal, plan_change, reactivation.',
      }, 400);
    }

    const { data: intent, error: intentErr } = await callerClient.rpc('saspay_create_checkout', {
      p_agency_id: agencyId,
      p_purpose: purpose,
      p_plan_id: planId,
      p_invoice_id: invoiceId,
    });

    if (intentErr || !intent?.payment_id) {
      return jsonResponse({
        error: 'checkout_intent_failed',
        details: intentErr?.message ?? 'Impossible de préparer l’échéance de paiement.',
      }, 400);
    }

    const paymentId = String(intent.payment_id);
    const serviceClient = getServiceClient();

    const { data: row, error: rowErr } = await serviceClient
      .schema('saas_immobilier')
      .from('online_payments')
      .select('id, agency_id, purpose, amount, currency, status, checkout_session_id, checkout_url, expires_at, metadata')
      .eq('id', paymentId)
      .maybeSingle();

    if (rowErr || !row) throw new HttpError('payment_not_found', 404);
    if (row.status !== 'pending') throw new HttpError('intent_not_open', 409);

    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    let quoteExpiresIso: string | undefined;
    if (meta.quote_expires_at) {
      const qDate = new Date(String(meta.quote_expires_at));
      if (!Number.isFinite(qDate.getTime()) || qDate.getTime() <= Date.now()) {
        throw new HttpError('plan_quote_expired', 409);
      }
      quoteExpiresIso = qDate.toISOString();
    }

    if (row.checkout_session_id && row.checkout_url && !meta.checkout_quarantine_reason) {
      return jsonResponse({
        payment_id: row.id,
        session_id: row.checkout_session_id,
        checkout_url: row.checkout_url,
        purpose: row.purpose,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        expires_at: row.expires_at,
        reused: true,
      });
    }

    const appOrigin = resolveSafeReturnOrigin(req, body?.return_origin);
    const formattedAmount = formatSasPayAmount(row.amount);
    const currency = String(row.currency ?? 'XOF').toUpperCase();

    if (!appOrigin || !formattedAmount || !/^[A-Z]{3}$/.test(currency)) {
      throw new HttpError('checkout_configuration_incomplete', 503);
    }

    // Mode Test isolé Sofia Immobilier Lab (ZÉRO encaissement réel, jamais actif si SASPAY_SECRET_KEY est défini)
    if (isLabSandboxMode()) {
      const labSessionId = crypto.randomUUID();
      const labCheckoutUrl = `${appOrigin}/paiement/retour?payment=${encodeURIComponent(paymentId)}&lab_sandbox=1`;
      const labExpiresIso = quoteExpiresIso ?? new Date(Date.now() + 30 * 60_000).toISOString();

      const { data: claimLab } = await serviceClient.rpc('saspay_claim_checkout', {
        p_payment_id: paymentId,
      });
      if (!claimLab?.claimed && claimLab?.attached) {
        return jsonResponse({
          payment_id: paymentId,
          session_id: labSessionId,
          checkout_url: labCheckoutUrl,
          purpose: row.purpose,
          amount: row.amount,
          currency,
          status: 'pending',
          expires_at: labExpiresIso,
          lab_sandbox: true,
        });
      }

      const { data: labAttached, error: labAttachErr } = await serviceClient.rpc('saspay_attach_checkout_checked', {
        p_payment_id: paymentId,
        p_session_id: labSessionId,
        p_checkout_url: labCheckoutUrl,
        p_expires_at: labExpiresIso,
        p_quarantine_reason: null,
      });
      if (labAttachErr || !labAttached) throw new HttpError('checkout_attach_failed', 503);

      return jsonResponse({
        payment_id: paymentId,
        session_id: labAttached.checkout_session_id ?? labSessionId,
        checkout_url: labAttached.checkout_url ?? labCheckoutUrl,
        purpose: row.purpose,
        amount: row.amount,
        currency,
        status: 'pending',
        expires_at: labExpiresIso,
        lab_sandbox: true,
      });
    }

    const saspaySecret = getSasPaySecret();

    const { data: claimData, error: claimErr } = await serviceClient.rpc('saspay_claim_checkout', {
      p_payment_id: paymentId,
    });
    if (claimErr) throw new HttpError('checkout_claim_failed', 503);

    if (!claimData?.claimed) {
      if (claimData?.attached) {
        const { data: attached } = await serviceClient
          .schema('saas_immobilier')
          .from('online_payments')
          .select('id, purpose, amount, currency, status, checkout_session_id, checkout_url, expires_at, metadata')
          .eq('id', paymentId)
          .maybeSingle();

        if (attached?.checkout_url && !(attached.metadata as Record<string, unknown> | null)?.checkout_quarantine_reason) {
          return jsonResponse({
            payment_id: attached.id,
            session_id: attached.checkout_session_id,
            checkout_url: attached.checkout_url,
            purpose: attached.purpose,
            amount: attached.amount,
            currency: attached.currency,
            status: attached.status,
            expires_at: attached.expires_at,
            reused: true,
          });
        }
      }
      throw new HttpError('checkout_creation_pending', 409);
    }

    // Décision 3 : Sofia envoie exclusivement le montant net exact (aucun 4% arbitraire).
    const saspayPayload: Record<string, unknown> = {
      amount: formattedAmount,
      currency,
      description: String(meta.description ?? 'Sofia Immobilier — Abonnement'),
      country: String(meta.country ?? 'ML'),
      customer_email: String(meta.customer_email ?? authData.user.email ?? 'facturation@sofia-immobilier.ml'),
      customer_name: String(meta.customer_name ?? meta.agency_name ?? 'Sofia Immobilier'),
      return_url: `${appOrigin}/paiement/retour?payment=${encodeURIComponent(paymentId)}`,
      metadata: {
        payment_id: paymentId,
        agency_id: row.agency_id,
        purpose: row.purpose,
      },
      ...(quoteExpiresIso ? { expires_at: quoteExpiresIso } : {}),
    };

    let saspayResp: Response;
    try {
      saspayResp = await fetch(`${SASPAY_API_BASE}/checkout-sessions/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${saspaySecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(saspayPayload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError('saspay_unreachable', 503);
    }

    if (!saspayResp.ok) {
      console.error('saspay_checkout_rejected', saspayResp.status, paymentId);
      throw new HttpError('saspay_checkout_rejected', 503);
    }

    const rawJson = await saspayResp.json().catch(() => null);
    const sessionObj = rawJson?.data && typeof rawJson.data === 'object' ? rawJson.data : rawJson;
    const sessionId = String(sessionObj?.id ?? '');
    const checkoutUrl = String(sessionObj?.checkout_url ?? '');

    if (rawJson?.success === false || !UUID_RE.test(sessionId)) {
      throw new HttpError('saspay_invalid_session', 503);
    }

    let quarantineReason: string | null = null;
    try {
      const parsedUrl = new URL(checkoutUrl);
      if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
        quarantineReason = 'session_url_invalid';
      }
    } catch {
      quarantineReason = 'session_url_invalid';
    }

    if (!quarantineReason && sessionObj?.amount != null && formatSasPayAmount(sessionObj.amount) !== formattedAmount) {
      quarantineReason = 'session_amount_mismatch';
    }
    if (!quarantineReason && sessionObj?.currency != null && String(sessionObj.currency).toUpperCase() !== currency) {
      quarantineReason = 'session_currency_mismatch';
    }

    let expiresIso: string | null = null;
    if (sessionObj?.expires_at != null) {
      const exp = new Date(String(sessionObj.expires_at));
      if (Number.isFinite(exp.getTime())) {
        expiresIso = exp.toISOString();
      } else {
        quarantineReason = quarantineReason ?? 'session_expiry_invalid';
      }
    }

    const { data: attached, error: attachErr } = await serviceClient.rpc('saspay_attach_checkout_checked', {
      p_payment_id: paymentId,
      p_session_id: sessionId,
      p_checkout_url: checkoutUrl || null,
      p_expires_at: expiresIso,
      p_quarantine_reason: quarantineReason,
    });

    if (attachErr || !attached) throw new HttpError('checkout_attach_failed', 503);
    if (attached.quarantined || !attached.checkout_url) {
      throw new HttpError('checkout_requires_review', 503);
    }

    return jsonResponse({
      payment_id: paymentId,
      session_id: attached.checkout_session_id,
      checkout_url: attached.checkout_url,
      purpose: row.purpose,
      amount: row.amount,
      currency: row.currency,
      status: 'pending',
      expires_at: expiresIso,
      reused: Boolean(attached.already_attached),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonResponse({ error: err.message }, err.status);
    }
    console.error('saspay_checkout_unexpected_error', String(err));
    return jsonResponse({ error: 'server_error' }, 500);
  }
});
