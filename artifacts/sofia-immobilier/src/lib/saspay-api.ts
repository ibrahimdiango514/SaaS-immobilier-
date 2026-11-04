// =============================================================================
// SASPAY — PAIEMENT EN LIGNE (côté navigateur)
// =============================================================================
// Trois Edge Functions, jamais de clé secrète dans le navigateur :
//   • saspay-checkout : crée l'intention (RPC saspay_create_checkout) puis la
//     session SasPay côté serveur et renvoie l'URL de paiement.
//   • saspay-verify   : appelée par /paiement/retour — rapproche le statut
//     côté SasPay (filet de sécurité si le webhook n'est pas arrivé).
//   • saspay-webhook  : serveur uniquement (signé HMAC) — aucun appel client.
//
// Le paiement manuel Orange Money / Wave (payments-api) reste intégralement
// disponible : ce module n'ajoute qu'un second canal.
// =============================================================================
import { useQuery } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';
import { EdgeFunctionError } from './agency-team-api';

export type SaspayPurpose = 'setup' | 'renewal' | 'invoice';

export interface SaspayCheckoutIntent {
  payment_id: string;
  session_id?: string | null;
  checkout_url: string;
  amount: number | string;
  currency: string;
  status?: string;
  reused?: boolean;
}

export interface SaspayPaymentState {
  found: boolean;
  payment_id?: string;
  agency_id?: string;
  purpose?: SaspayPurpose;
  amount?: number;
  currency?: string;
  status?: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | string;
  checkout_session_id?: string | null;
  transaction_reference?: string | null;
  fail_reason?: string | null;
  paid_at?: string | null;
  expires_at?: string | null;
  verified?: boolean;
  error?: string;
}

type EdgeErrorPayload = { error?: string; details?: string | null; code?: string | null };

/**
 * Invocation d'une Edge Function avec la même gestion d'erreurs que
 * agency-team-api : FunctionsHttpError → payload { error, details, code } ;
 * FunctionsFetchError (fonction qui ne démarre pas, CORS, réseau) → motif réel.
 */
async function invoke<T>(slug: string, body: Record<string, unknown>): Promise<T> {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke(slug, { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    const response = context instanceof Response ? context : null;
    if (response) {
      const payload = (await response.json().catch(() => null)) as EdgeErrorPayload | null;
      throw new EdgeFunctionError(
        payload?.error ?? 'edge_function_failed',
        payload?.details ?? null,
        payload?.code ?? null,
        response.status,
      );
    }
    const name = (error as { name?: string }).name ?? '';
    const raw = (error as { message?: string }).message ?? '';
    const reason = context instanceof Error && context.message ? context.message : raw;
    throw new EdgeFunctionError(
      'edge_function_unreachable',
      reason || `La fonction « ${slug} » n'a pas pu être jointe.`,
      name || null,
      null,
    );
  }
  const payload = data as EdgeErrorPayload & T;
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new EdgeFunctionError(payload.error, payload.details ?? null, payload.code ?? null, null);
  }
  return payload;
}

/**
 * Crée (ou réutilise) l'intention de paiement et renvoie l'URL SasPay.
 * `origin` sert au retour navigateur (/paiement/retour?payment=…).
 */
export function createSaspayCheckout(input: {
  agencyId: string;
  purpose: SaspayPurpose;
  planId?: string | null;
  invoiceId?: string | null;
}): Promise<SaspayCheckoutIntent> {
  return invoke<SaspayCheckoutIntent>('saspay-checkout', {
    agency_id: input.agencyId,
    purpose: input.purpose,
    plan_id: input.planId ?? null,
    invoice_id: input.invoiceId ?? null,
    origin: typeof window !== 'undefined' ? window.location.origin : undefined,
  });
}

/** Rapproche le statut côté SasPay puis renvoie l'état courant de l'intention. */
export function verifySaspayPayment(input: {
  paymentId?: string;
  sessionId?: string;
}): Promise<SaspayPaymentState> {
  return invoke<SaspayPaymentState>('saspay-verify', {
    payment_id: input.paymentId ?? null,
    session_id: input.sessionId ?? null,
  });
}

const LABELS: Record<string, string> = {
  saspay_not_configured:
    'Le paiement en ligne n’est pas encore configuré sur cette plateforme. Utilisez le paiement manuel (Orange Money / Wave) ci-dessous.',
  checkout_intent_failed: 'Impossible de préparer le paiement en ligne.',
  intent_not_open: 'Cette intention de paiement n’est plus ouverte.',
  saspay_session_failed: 'La passerelle de paiement n’a pas répondu. Réessayez dans un instant.',
  checkout_attach_failed: 'La session de paiement n’a pas pu être enregistrée.',
  checkout_intent_read_failed: 'Impossible de lire l’intention de paiement.',
  agency_id_required: 'Aucune agence sélectionnée.',
  purpose_invalid: 'Type de paiement invalide.',
  origin_invalid: 'Adresse de retour invalide.',
  authentication_required: 'Votre session a expiré : reconnectez-vous pour payer.',
  acces_refuse: 'Vous n’avez pas accès au paiement de cette agence.',
  agency_admin_or_owner_required: 'Seul le propriétaire ou un administrateur peut payer.',
  payment_id_or_session_id_required: 'Paiement introuvable dans l’adresse de retour.',
  payment_not_found: 'Paiement introuvable.',
  payment_read_failed: 'Impossible de lire le paiement.',
  access_check_failed: 'Impossible de vérifier vos accès.',
  payment_state_failed: 'Impossible de lire l’état du paiement.',
  confirm_failed: 'La confirmation du paiement a échoué. Réessayez.',
  edge_function_unreachable: 'Le service de paiement est injoignable (réseau ou fonction non déployée).',
  edge_function_failed: 'Le service de paiement a répondu par une erreur.',
  method_not_allowed: 'Méthode non autorisée.',
  invalid_json: 'Requête malformée.',
  server_configuration_error: 'Configuration serveur incomplète.',
};

/* --------------------------------------------------------------------------- */
/* FACTURES DE L'AGENCE — prorata dû après un changement d'offre (RPC           */
/* agency_invoices, testée en staging : T64 lecture / T65 hors-agence refusée). */
/* --------------------------------------------------------------------------- */

export interface AgencyInvoice {
  id: string;
  agency_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'cancelled' | string;
  reference: string | null;
  plan_from_name: string | null;
  plan_to_name: string | null;
  prorata_applied: boolean;
  prorata_days: number | null;
  prorata_days_in_month: number | null;
  note: string | null;
  created_at: string;
  paid_at: string | null;
  has_online_payment: boolean;
}

/** Factures de l'agence (lecture seule, contrôle d'accès côté serveur). */
export function useAgencyInvoices(agencyId?: string) {
  return useQuery({
    queryKey: ['saspay', 'invoices', agencyId ?? ''],
    enabled: Boolean(agencyId),
    staleTime: 30_000,
    queryFn: async (): Promise<AgencyInvoice[]> => {
      const targetAgencyId = agencyId;
      if (!targetAgencyId) throw new Error('agency_id manquant');
      // Meme motif que pending-api : RPC non infere par les types generated.
      const client = getSupabaseClient() as unknown as {
        rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      };
      const { data, error } = await client.rpc('agency_invoices', {
        p_agency_id: targetAgencyId,
      });
      if (error) throw error;
      return (data ?? []) as unknown as AgencyInvoice[];
    },
  });
}

/** Libellé français : code métier + détail technique exact, jamais un échec muet. */
export function saspayErrorLabel(error: unknown, action: string): string {
  if (error instanceof EdgeFunctionError) {
    const base = LABELS[error.errorCode] ?? error.errorCode;
    const parts = [base];
    if (error.details && error.errorCode !== 'saspay_not_configured') {
      parts.push(`Détail : ${error.details}`);
    }
    const codes = [error.technicalCode, error.httpStatus ? `HTTP ${error.httpStatus}` : null]
      .filter(Boolean)
      .join(', ');
    if (codes && error.errorCode !== 'saspay_not_configured') parts.push(`(${codes})`);
    return parts.join(' ');
  }
  const message = (error as { message?: string } | null)?.message ?? '';
  const known = Object.keys(LABELS).find((key) => message.includes(key));
  if (known) return LABELS[known];
  return message || `Impossible de ${action}. Réessayez.`;
}
