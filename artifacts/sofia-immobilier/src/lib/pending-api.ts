// =============================================================================
// SESSION 2 — BLOC 2 : PARCOURS D'ABONNEMENT À LA CRÉATION D'UNE AGENCE
// =============================================================================
// Une nouvelle agence n'a PLUS d'offre active automatique : `create_agency_for_self`
// la crée avec `status = 'pending'` et AUCUNE ligne `agency_subscriptions`.
// L'offre choisie est stockée dans `agencies.pending_plan_id`.
//
// Chaîne : inscription → infos agence → choix de l'offre → paiement + attente →
// validation admin (`admin_activate_pending_agency`, qui crée l'abonnement actif
// et calcule l'échéance) → dashboard ouvert avec les modules de l'offre.
//
// Convention du projet : tables via db() (saas_immobilier), RPC dans public.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export type PendingPlan = {
  id: string;
  name: string;
  display_name: string | null;
  price_monthly: number;
  setup_fee: number | null;
  currency: string;
  modules: string[] | null;
};

export type PendingDeclaration = {
  id: string;
  status: string;
  amount: number;
  method: string;
  transaction_reference: string;
  paid_on: string | null;
  review_note: string | null;
  created_at: string;
};

export type PendingState = {
  found: boolean;
  agency_id?: string;
  agency_name?: string;
  agency_status?: string;
  is_pending?: boolean;
  pending_since?: string;
  pending_note?: string | null;
  pending_updated_at?: string | null;
  plan?: PendingPlan | null;
  amount_due?: number;
  payment_instructions?: {
    orange_money?: { name?: string; number?: string };
    wave?: { name?: string; number?: string };
  } | null;
  latest_declaration?: PendingDeclaration | null;
};

export const getPendingStateQueryKey = (agencyId?: string) =>
  ['pending', 'etat', agencyId ?? 'none'] as const;

/** État d'attente de l'agence : offre choisie, montant dû, instructions, statut. */
export function usePendingState(agencyId?: string) {
  return useQuery({
    queryKey: getPendingStateQueryKey(agencyId),
    enabled: Boolean(agencyId),
    // Court : l'agence peut déclarer un paiement et veut voir l'état changer.
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<PendingState> => {
      const { data, error } = await rpc().rpc('agency_pending_state', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return data as PendingState;
    },
  });
}

/** L'agence change l'offre choisie tant que l'administrateur n'a pas validé. */
export function useSelectPendingPlan(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (planId: string) => {
      const { data, error } = await rpc().rpc('agency_select_pending_plan', {
        p_agency_id: agencyId as string,
        p_plan_id: planId,
      });
      if (error) throw error;
      return data as { plan_name: string; amount_due: number; currency: string };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pending'] }),
        queryClient.invalidateQueries({ queryKey: ['offre'] }),
      ]);
    },
  });
}

/* --------------------------------------------------------------------------- */
/* CÔTÉ ADMIN — file des agences en attente de validation                       */
/* --------------------------------------------------------------------------- */

export type PendingAgencyRow = {
  agency_id: string;
  agency_name: string;
  slug: string | null;
  city: string | null;
  created_at: string;
  pending_plan_id: string | null;
  pending_note: string | null;
  pending_updated_at: string | null;
  plan_name: string | null;
  plan_display_name: string | null;
  price_monthly: number | null;
  setup_fee: number | null;
  currency: string | null;
  amount_due: number | null;
  owner_email: string | null;
  latest_declaration: (PendingDeclaration & { proof_path?: string | null }) | null;
  pending_declarations_count: number;
};

export type PendingAgenciesResult = { agencies: PendingAgencyRow[]; total: number };

export const getPendingAgenciesQueryKey = () => ['pending', 'file-admin'] as const;

export function usePendingAgencies(enabled = true) {
  return useQuery({
    queryKey: getPendingAgenciesQueryKey(),
    enabled,
    staleTime: 10_000,
    queryFn: async (): Promise<PendingAgenciesResult> => {
      const { data, error } = await rpc().rpc('pending_agencies');
      if (error) throw error;
      return data as PendingAgenciesResult;
    },
  });
}

export function useActivatePendingAgency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agencyId: string) => {
      const { data, error } = await rpc().rpc('admin_activate_pending_agency', {
        p_agency_id: agencyId,
      });
      if (error) throw error;
      return data as { plan_name: string; ends_at: string; subscription_id: string };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pending'] }),
        queryClient.invalidateQueries({ queryKey: ['admin'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia'] }),
      ]);
    },
  });
}

export function useRejectPendingAgency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ agencyId, reason }: { agencyId: string; reason: string }) => {
      const { data, error } = await rpc().rpc('admin_reject_pending_agency', {
        p_agency_id: agencyId,
        p_reason: reason,
      });
      if (error) throw error;
      return data as { status: string; reason: string };
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pending'] }),
        queryClient.invalidateQueries({ queryKey: ['admin'] }),
      ]);
    },
  });
}

/** Libellé français du statut d'une déclaration, pour l'écran d'attente. */
export function pendingDeclarationLabel(status?: string | null): string {
  switch (status) {
    case 'pending':
      return 'En attente de validation';
    case 'approved':
      return 'Approuvée';
    case 'rejected':
      return 'Refusée';
    default:
      return 'Aucune déclaration';
  }
}

/** Erreur lisible, avec le code technique : jamais d'échec muet. */
export function pendingErrorLabel(error: unknown, action: string): string {
  const base = getSupabaseErrorMessage(error, action);
  const code = (error as { code?: string })?.code;
  return code ? `${base} (code ${code})` : base;
}
