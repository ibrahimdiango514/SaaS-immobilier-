// =============================================================================
// LOT 2 & LOT 3 — CYCLE DE FACTURATION & INTÉGRATION SASPAY COMPLÈTE
// =============================================================================
// • 4 motifs officiels SasPay :
//     1. 'first_subscription' : 1re mensualité générée à J14 après essai (0 frais d'installation)
//     2. 'renewal'            : renouvellement mensuel récurrent
//     3. 'plan_change'        : montée d'offre en cours d'abonnement payant (prorata serveur)
//     4. 'reactivation'       : régularisation et réactivation immédiate d'une agence suspendue
// • Décision 3 : Sofia envoie exclusivement le montant net exact ; les frais éventuels
//   de transaction dépendent du moyen de paiement choisi côté SasPay (jamais de 4% codé en dur).
// • Décision 4 : Les frais d'installation physique ne transitent jamais par SasPay.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export type SasPayPurpose =
  | 'first_subscription'
  | 'renewal'
  | 'plan_change'
  | 'reactivation';

export type SubscriptionInvoiceKind =
  | 'first_subscription'
  | 'renewal'
  | 'plan_change'
  | 'reactivation';

export const SASPAY_PURPOSE_LABELS: Record<string, string> = {
  first_subscription: '1er mois d’abonnement',
  renewal: 'Renouvellement mensuel',
  plan_change: 'Montée d’offre (prorata)',
  reactivation: 'Régularisation & réactivation',
  invoice: 'Règlement de facture',
  setup: 'Installation (historique)',
};

export const INVOICE_KIND_LABELS: Record<string, string> = {
  first_subscription: '1re mensualité (post-essai 14j)',
  renewal: 'Échéance mensuelle',
  plan_change: 'Prorata montée d’offre',
  reactivation: 'Régularisation d’abonnement',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  pending: 'À régler',
  paid: 'Payée',
  cancelled: 'Annulée',
};

export const ONLINE_PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: 'En attente de confirmation',
  paid: 'Payé et vérifié',
  failed: 'Échec',
  expired: 'Session expirée',
  cancelled: 'Annulé',
};

export interface SubscriptionInvoiceRow {
  id: string;
  agency_id: string;
  invoice_kind: SubscriptionInvoiceKind | string;
  billing_kind?: string | null;
  plan_from_id: string | null;
  plan_to_id: string | null;
  plan_from_name: string | null;
  plan_to_name: string | null;
  amount: number;
  currency: string;
  prorata_applied: boolean;
  prorata_days: number | null;
  prorata_days_in_month: number | null;
  period_start: string | null;
  period_end: string | null;
  due_at: string | null;
  grace_ends_at: string | null;
  status: 'pending' | 'paid' | 'cancelled';
  reference: string | null;
  note: string | null;
  created_at: string;
  paid_at: string | null;
  paid_payment_id: string | null;
}

export interface AgencyOnlinePaymentRow {
  id: string;
  agency_id: string;
  invoice_id: string | null;
  plan_id: string | null;
  plan_name: string | null;
  purpose: string;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
  provider: string;
  checkout_session_id: string | null;
  transaction_reference: string | null;
  fail_reason: string | null;
  paid_at: string | null;
  reconciled_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface PlanUpgradePreview {
  eligible: boolean;
  reason?: string;
  blocking_invoice_id?: string | null;
  agency_id?: string;
  subscription_id?: string;
  current_plan_id?: string;
  current_plan_name?: string;
  current_price_monthly?: number;
  target_plan_id?: string;
  target_plan_name?: string;
  target_price_monthly?: number;
  monthly_delta?: number;
  days_remaining?: number;
  total_days?: number;
  prorata_amount?: number;
  currency?: string;
  period_start?: string;
  period_end?: string;
}

export interface SasPayRegularisationState {
  agency_id: string;
  agency_name: string;
  agency_status: string;
  suspended_at: string | null;
  suspended_reason: string | null;
  can_manage: boolean;
  can_pay: boolean;
  plan_id: string | null;
  plan_name: string | null;
  price_monthly: number | null;
  due_at: string | null;
  grace_ends_at: string | null;
  invoice_id: string | null;
  invoice_reference: string | null;
  amount: number | null;
  currency: string;
}

export interface SasPayCheckoutResponse {
  payment_id: string;
  session_id: string;
  checkout_url: string;
  purpose: string;
  amount: number;
  currency: string;
  status: string;
  expires_at?: string | null;
  reused?: boolean;
}

export interface SasPayVerifiedPaymentState {
  found: boolean;
  payment_id: string;
  agency_id: string;
  agency_name: string;
  agency_status: string;
  purpose: string;
  plan_id: string | null;
  plan_name: string | null;
  invoice_id: string | null;
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
  checkout_session_id: string | null;
  transaction_reference: string | null;
  fail_reason: string | null;
  paid_at: string | null;
  expires_at: string | null;
  reconciled_at: string | null;
  subscription_ends_at: string | null;
  paid_through_at: string | null;
  verified?: boolean;
  provider_note?: string | null;
}

export interface AdminSasPayOverview {
  kpis: {
    paid_count: number;
    paid_volume_xof: number;
    pending_count: number;
    failed_count: number;
    exceptions_count: number;
    webhooks_24h: number;
  };
  payments: Array<{
    id: string;
    agency_id: string;
    agency_name: string | null;
    purpose: string;
    plan_name: string | null;
    amount: number;
    currency: string;
    status: string;
    checkout_session_id: string | null;
    transaction_reference: string | null;
    provider_net_amount: number | null;
    provider_charged_amount: number | null;
    fail_reason: string | null;
    paid_at: string | null;
    reconciled_at: string | null;
    expires_at: string | null;
    created_at: string;
  }>;
  exceptions: Array<{
    payment_id: string;
    agency_id: string | null;
    agency_name: string | null;
    session_id: string | null;
    transaction_id: string | null;
    reason: string;
    first_seen_at: string;
    last_seen_at: string;
  }>;
  webhooks: Array<{
    id: string;
    event_type: string;
    processing_result: string | null;
    processed_at: string | null;
    created_at: string;
    payload: Record<string, unknown> | null;
  }>;
  automation_runs: Array<{
    id: string;
    kind: string;
    result: Record<string, unknown>;
    created_at: string;
  }>;
}

const SASPAY_ERROR_MESSAGES: Record<string, string> = {
  saspay_not_configured:
    'Le service de paiement en ligne SasPay est en cours de configuration sur cet environnement. Utilisez temporairement la déclaration de paiement ci-dessous ou contactez l’administrateur.',
  saspay_unreachable:
    'Le serveur SasPay ne répond pas momentanément. Réessayez dans quelques instants.',
  saspay_checkout_rejected:
    'SasPay n’a pas pu ouvrir la session de paiement. Vérifiez votre offre ou réessayez.',
  plan_quote_expired:
    'Le devis de prorata a expiré. Rouvrez la fenêtre de montée d’offre pour recalculer le montant à jour.',
  checkout_configuration_incomplete:
    'Configuration de retour SasPay incomplète. Contactez l’administrateur Sofia Immobilier.',
  purpose_invalid:
    'Ce motif de paiement n’est pas autorisé en ligne.',
};

export function translateSasPayError(error: unknown, fallbackAction = 'lancer le paiement SasPay'): string {
  if (error && typeof error === 'object') {
    const maybeCode = (error as { error?: string; details?: string; message?: string });
    if (maybeCode.details && typeof maybeCode.details === 'string') {
      return maybeCode.details;
    }
    if (maybeCode.error && SASPAY_ERROR_MESSAGES[maybeCode.error]) {
      return SASPAY_ERROR_MESSAGES[maybeCode.error];
    }
    if (maybeCode.message && SASPAY_ERROR_MESSAGES[maybeCode.message]) {
      return SASPAY_ERROR_MESSAGES[maybeCode.message];
    }
  }
  return getSupabaseErrorMessage(error, fallbackAction);
}

export function useAgencyInvoices(agencyId?: string) {
  return useQuery({
    queryKey: ['saspay', 'invoices', agencyId],
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<SubscriptionInvoiceRow[]> => {
      const { data, error } = await rpc().rpc('agency_invoices', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return Array.isArray(data) ? (data as SubscriptionInvoiceRow[]) : [];
    },
  });
}

export function useAgencyOnlinePayments(agencyId?: string) {
  return useQuery({
    queryKey: ['saspay', 'online-payments', agencyId],
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<AgencyOnlinePaymentRow[]> => {
      const { data, error } = await rpc().rpc('agency_online_payments', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return Array.isArray(data) ? (data as AgencyOnlinePaymentRow[]) : [];
    },
  });
}

export function useSyncAgencyBillingLifecycle(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!agencyId) return null;
      const { data, error } = await rpc().rpc('agency_sync_billing_lifecycle', {
        p_agency_id: agencyId,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['plan'] }),
        queryClient.invalidateQueries({ queryKey: ['saspay'] }),
        queryClient.invalidateQueries({ queryKey: ['offre'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia'] }),
      ]);
    },
  });
}

export function usePlanUpgradePreview(agencyId?: string, targetPlanId?: string | null) {
  return useQuery({
    queryKey: ['saspay', 'upgrade-preview', agencyId, targetPlanId],
    enabled: Boolean(agencyId && targetPlanId),
    staleTime: 15_000,
    queryFn: async (): Promise<PlanUpgradePreview> => {
      const { data, error } = await rpc().rpc('saspay_preview_plan_upgrade', {
        p_agency_id: agencyId as string,
        p_target_plan_id: targetPlanId as string,
      });
      if (error) throw error;
      return data as PlanUpgradePreview;
    },
  });
}

export function useSasPayRegularisationState(agencyId?: string, enabled = true) {
  return useQuery({
    queryKey: ['saspay', 'regularisation', agencyId],
    enabled: Boolean(agencyId) && enabled,
    refetchInterval: 20_000,
    queryFn: async (): Promise<SasPayRegularisationState> => {
      const { data, error } = await rpc().rpc('saspay_regularisation_state', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return data as SasPayRegularisationState;
    },
  });
}

export interface CreateSasPayCheckoutInput {
  agencyId: string;
  purpose: SasPayPurpose | 'invoice';
  planId?: string | null;
  invoiceId?: string | null;
}

export function useCreateSasPayCheckout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSasPayCheckoutInput): Promise<SasPayCheckoutResponse> => {
      const client = getSupabaseClient();
      const returnOrigin =
        typeof window !== 'undefined' && window.location.origin.startsWith('https://')
          ? window.location.origin
          : undefined;

      const { data, error } = await client.functions.invoke('saspay-checkout', {
        body: {
          agency_id: input.agencyId,
          purpose: input.purpose,
          plan_id: input.planId ?? null,
          invoice_id: input.invoiceId ?? null,
          return_origin: returnOrigin,
        },
      });

      if (error) {
        let parsedBody: Record<string, unknown> | null = null;
        try {
          const ctx = (error as { context?: Response }).context;
          if (ctx && typeof ctx.json === 'function') {
            parsedBody = await ctx.json();
          }
        } catch {
          parsedBody = null;
        }
        if (parsedBody) {
          throw new Error(translateSasPayError(parsedBody));
        }
        throw new Error(translateSasPayError(error));
      }

      const payload = (data ?? {}) as Partial<SasPayCheckoutResponse> & { error?: string; details?: string };
      if (payload.error || !payload.checkout_url) {
        throw new Error(translateSasPayError(payload));
      }

      return payload as SasPayCheckoutResponse;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['saspay'] });
    },
  });
}

export async function verifySasPayPaymentStatus(params: {
  paymentId?: string | null;
  sessionId?: string | null;
  labSimulate?: 'paid' | 'failed' | null;
}): Promise<SasPayVerifiedPaymentState & { lab_sandbox?: boolean }> {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke('saspay-verify', {
    body: {
      payment_id: params.paymentId ?? null,
      session_id: params.sessionId ?? null,
      ...(params.labSimulate ? { lab_simulate: params.labSimulate } : {}),
    },
  });

  if (!error && data && (data as SasPayVerifiedPaymentState).payment_id) {
    return data as SasPayVerifiedPaymentState & { lab_sandbox?: boolean };
  }

  // Repli lecture directe sécurisée si l'Edge Function est momentanément indisponible
  const { data: fallback, error: rpcErr } = await rpc().rpc('saspay_payment_for_caller', {
    p_payment_id: params.paymentId ?? null,
    p_session_id: params.sessionId ?? null,
  });
  if (rpcErr) throw rpcErr;
  return fallback as SasPayVerifiedPaymentState & { lab_sandbox?: boolean };
}

export function useAdminSasPayOverview(limit = 50) {
  return useQuery({
    queryKey: ['admin', 'saspay', 'overview', limit],
    refetchInterval: 30_000,
    queryFn: async (): Promise<AdminSasPayOverview> => {
      const { data, error } = await rpc().rpc('admin_saspay_overview', {
        p_limit: limit,
      });
      if (error) throw error;
      return data as AdminSasPayOverview;
    },
  });
}

export function useAdminReconcileSasPay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (runLifecycle: boolean = true) => {
      const client = getSupabaseClient();
      const { data, error } = await client.functions.invoke('saspay-reconcile', {
        body: { run_lifecycle: runLifecycle },
      });
      if (error) throw error;
      return data as {
        checked: number;
        confirmed: number;
        errors: number;
        saspay_configured?: boolean;
        lifecycle?: Record<string, unknown> | null;
      };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'saspay'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia'] }),
      ]);
    },
  });
}

export function useAdminRunBillingLifecycle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await rpc().rpc('process_subscription_lifecycle', {});
      if (error) throw error;
      return data as {
        evaluated_at: string;
        trials_converted: number;
        renewals_opened: number;
        entered_grace: number;
        suspended: number;
        notifications_sent: number;
        alerts_created: number;
        errors: number;
      };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'saspay'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia'] }),
      ]);
    },
  });
}
