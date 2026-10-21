// =============================================================================
// BLOC 2 — ADMIN : offres et paiements
// =============================================================================
// Toutes les écritures passent par des fonctions SQL déjà en base, qui portent
// elles-mêmes leur garde d'autorisation :
//   public.review_payment_declaration  -> validation / rejet (prolonge l'abo,
//                                         réactive l'agence si elle était suspendue)
//   public.admin_handle_plan_change    -> approbation / refus d'une demande
//   public.admin_change_agency_plan    -> changement d'offre en un clic
//   public.admin_update_platform_setting -> réglages (propriétaire plateforme)
//   public.platform_subscription_revenue -> graphique des abonnements
// Cette couche ne fait qu'appeler et rafraîchir le cache : elle n'accorde rien.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';
import { getAllAgenciesQueryKey, getPlatformSummaryQueryKey, getActivityLogQueryKey, getSubscriptionsQueryKey } from './data-hooks';
import { PAYMENT_PROOFS_BUCKET } from './payments-api';

const db = () => getSupabaseClient().schema('saas_immobilier');

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AdminDeclarationRow {
  id: string;
  agency_id: string;
  amount: number;
  currency: string;
  method: string;
  transaction_reference: string;
  paid_on: string;
  proof_path: string | null;
  declared_by: string | null;
  status: 'pending' | 'approved' | 'rejected';
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  payment_id: string | null;
  created_at: string;
}

export interface PlanChangeRequestRow {
  id: string;
  agency_id: string;
  requested_plan_id: string;
  current_plan_id: string | null;
  requested_by: string | null;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  handled_by: string | null;
  handled_at: string | null;
  handle_note: string | null;
  created_at: string;
}

export interface PlatformSettingsRow {
  key: string;
  value: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
}

export interface PaymentInstructions {
  orange_money: { name: string; number: string };
  wave: { name: string; number: string };
  beneficiary?: string;
  note?: string;
}

export interface BillingSettings {
  grace_days: number;
  reminder_days?: number[];
}

export interface SubscriptionRevenue {
  months: Array<{ month_start: string; revenue: number; paying_agencies: number; payments_count: number }>;
  by_plan: Array<{
    id: string;
    name: string;
    display_name: string;
    price_monthly: number;
    currency: string;
    sort_order: number;
    active_agencies: number;
    trial_agencies: number;
    total_agencies: number;
    revenue_total: number;
  }>;
  totals: {
    revenue_period: number;
    revenue_all: number;
    payments_period: number;
    paying_agencies_period: number;
    paying_agencies_all: number;
    paying_agencies_active: number;
    trial_agencies: number;
    suspended_agencies: number;
    expiring_30d: number;
    overdue: number;
    pending_declarations: number;
    pending_plan_changes: number;
  };
}

/* ------------------------------------------------------------------ */
/* Clés de cache                                                       */
/* ------------------------------------------------------------------ */

export const getDeclarationsQueryKey = () => ['admin', 'declarations'] as const;
export const getPlanChangeRequestsQueryKey = () => ['admin', 'plan-change-requests'] as const;
export const getPlatformSettingsQueryKey = () => ['admin', 'platform-settings'] as const;
export const getSubscriptionRevenueQueryKey = (months: number) =>
  ['admin', 'subscription-revenue', months] as const;

const DECLARATION_COLUMNS =
  'id, agency_id, amount, currency, method, transaction_reference, paid_on, proof_path, declared_by, status, note, reviewed_by, reviewed_at, review_note, payment_id, created_at';
const PLAN_CHANGE_COLUMNS =
  'id, agency_id, requested_plan_id, current_plan_id, requested_by, note, status, handled_by, handled_at, handle_note, created_at';

/* ------------------------------------------------------------------ */
/* Lectures                                                            */
/* ------------------------------------------------------------------ */

export function usePaymentDeclarations(status?: 'pending' | 'approved' | 'rejected') {
  return useQuery({
    queryKey: [...getDeclarationsQueryKey(), status ?? 'all'],
    queryFn: async (): Promise<AdminDeclarationRow[]> => {
      let query = db()
        .from('payment_declarations')
        .select(DECLARATION_COLUMNS)
        .order('created_at', { ascending: false });
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw error;
      return data as AdminDeclarationRow[];
    },
  });
}

export function usePlanChangeRequests(status?: 'pending' | 'approved' | 'rejected') {
  return useQuery({
    queryKey: [...getPlanChangeRequestsQueryKey(), status ?? 'all'],
    queryFn: async (): Promise<PlanChangeRequestRow[]> => {
      let query = db()
        .from('plan_change_requests')
        .select(PLAN_CHANGE_COLUMNS)
        .order('created_at', { ascending: false });
      if (status) query = query.eq('status', status);
      const { data, error } = await query;
      if (error) throw error;
      return data as PlanChangeRequestRow[];
    },
  });
}

export function usePlatformSettings() {
  return useQuery({
    queryKey: getPlatformSettingsQueryKey(),
    queryFn: async (): Promise<PlatformSettingsRow[]> => {
      const { data, error } = await db()
        .from('platform_settings')
        .select('key, value, updated_by, updated_at');
      if (error) throw error;
      return data as PlatformSettingsRow[];
    },
  });
}

export function useSubscriptionRevenue(months = 12) {
  return useQuery({
    queryKey: getSubscriptionRevenueQueryKey(months),
    queryFn: async (): Promise<SubscriptionRevenue> => {
      const { data, error } = await rpc().rpc('platform_subscription_revenue', { p_months: months });
      if (error) throw error;
      return data as SubscriptionRevenue;
    },
  });
}

/** URL signée de la capture d'une déclaration (lecture admin via RLS Storage). */
export function useDeclarationProofUrl(proofPath: string | null) {
  return useQuery({
    queryKey: ['admin', 'proof-url', proofPath],
    enabled: Boolean(proofPath),
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<{ url: string | null; error: string | null }> => {
      if (!proofPath) return { url: null, error: null };
      const { data, error } = await getSupabaseClient()
        .storage.from(PAYMENT_PROOFS_BUCKET)
        .createSignedUrl(proofPath, 15 * 60);
      if (error) return { url: null, error: error.message };
      return { url: data.signedUrl, error: null };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Écritures                                                           */
/* ------------------------------------------------------------------ */

function invalidateBilling(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getDeclarationsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getPlanChangeRequestsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getSubscriptionRevenueQueryKey(12) }),
    queryClient.invalidateQueries({ queryKey: getAllAgenciesQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getSubscriptionsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getPlatformSummaryQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
    queryClient.invalidateQueries({ queryKey: ['paiements'] }),
    // Les agences lisent leur état via ces clés : on force le rafraîchissement.
    queryClient.invalidateQueries({ queryKey: ['sofia'] }),
    queryClient.invalidateQueries({ queryKey: ['offre'] }),
    // BLOC 1 (session 3) — cause racine n°3 : les graphiques et KPI ne bougeaient
    // pas après une validation de paiement / un changement d'offre / une
    // suspension. Ces deux clés n'étaient pas invalidées.
    queryClient.invalidateQueries({ queryKey: ['plan'] }),
    queryClient.invalidateQueries({ queryKey: getSubscriptionRevenueQueryKey(12) }),
  ]);
}

/**
 * Valide ou rejette une déclaration.
 * À la validation, la base crée le paiement, prolonge l'abonnement d'un mois
 * et réactive l'agence si elle était suspendue — tout dans la même transaction.
 */
export function useReviewPaymentDeclaration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      declarationId,
      decision,
      note,
    }: {
      declarationId: string;
      decision: 'approved' | 'rejected';
      note: string;
    }) => {
      if (decision === 'rejected' && !note.trim()) {
        throw new Error('Un motif est obligatoire pour rejeter une déclaration.');
      }
      const { data, error } = await rpc().rpc('review_payment_declaration', {
        p_declaration_id: declarationId,
        p_decision: decision,
        p_note: note.trim(),
      });
      if (error) throw error;
      return data as string | null;
    },
    onSuccess: async () => invalidateBilling(queryClient),
  });
}

/** Approuve ou refuse une demande de changement d'offre. */
export function useHandlePlanChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      requestId,
      decision,
      note,
    }: {
      requestId: string;
      decision: 'approved' | 'rejected';
      note: string;
    }) => {
      const { data, error } = await rpc().rpc('admin_handle_plan_change', {
        p_request_id: requestId,
        p_decision: decision,
        p_note: note.trim(),
      });
      if (error) throw error;
      return data as boolean;
    },
    onSuccess: async () => invalidateBilling(queryClient),
  });
}

/** Change l'offre d'une agence en un clic, sans passer par une demande. */
export function useAdminChangeAgencyPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ agencyId, planId }: { agencyId: string; planId: string }) => {
      const { data, error } = await rpc().rpc('admin_change_agency_plan', {
        p_agency_id: agencyId,
        p_plan_id: planId,
      });
      if (error) throw error;
      return data as boolean;
    },
    onSuccess: async () => invalidateBilling(queryClient),
  });
}

/** Écrit un réglage plateforme (propriétaire uniquement — garde côté base). */
export function useUpdatePlatformSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: 'payment_instructions' | 'billing'; value: Record<string, unknown> }) => {
      const { data, error } = await rpc().rpc('admin_update_platform_setting', {
        p_key: key,
        p_value: value,
      });
      if (error) throw error;
      return data as Record<string, unknown>;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPlatformSettingsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ['paiements'] }),
        queryClient.invalidateQueries({ queryKey: ['offre'] }),
      ]);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Helpers d'affichage                                                 */
/* ------------------------------------------------------------------ */

export const METHOD_LABELS: Record<string, string> = {
  orange_money: 'Orange Money',
  wave: 'Wave',
  manual: 'Manuel',
};

export const DECLARATION_LABELS: Record<string, string> = {
  pending: 'En attente',
  approved: 'Validée',
  rejected: 'Rejetée',
};

export const PLAN_CHANGE_LABELS: Record<string, string> = {
  pending: 'En attente',
  approved: 'Approuvée',
  rejected: 'Refusée',
};

export function readPaymentInstructions(rows: PlatformSettingsRow[] | undefined): PaymentInstructions {
  const raw = rows?.find((row) => row.key === 'payment_instructions')?.value ?? {};
  const pick = (block: unknown) => {
    const value = (block ?? {}) as Partial<{ name: unknown; number: unknown }>;
    return { name: String(value.name ?? '').trim(), number: String(value.number ?? '').trim() };
  };
  return {
    orange_money: pick(raw.orange_money),
    wave: pick(raw.wave),
    beneficiary: String(raw.beneficiary ?? '').trim(),
    note: String(raw.note ?? '').trim(),
  };
}

export function readBillingSettings(rows: PlatformSettingsRow[] | undefined): BillingSettings {
  const raw = rows?.find((row) => row.key === 'billing')?.value ?? {};
  const grace = Number((raw as { grace_days?: unknown }).grace_days ?? 5);
  const reminders = (raw as { reminder_days?: unknown }).reminder_days;
  return {
    grace_days: Number.isFinite(grace) ? grace : 5,
    reminder_days: Array.isArray(reminders) ? reminders.map((v) => Number(v)).filter(Number.isFinite) : [5, 0],
  };
}
