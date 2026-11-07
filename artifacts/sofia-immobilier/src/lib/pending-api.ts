// =============================================================================
// LOT 1 — INSCRIPTION, CHOIX DE L'OFFRE, INSTALLATION PHYSIQUE & ACTIVATION ADMIN
// =============================================================================
// Cycle officiel Sofia Immobilier :
//   1. Choix obligatoire d'une offre (Essentiel / Pro / Premium) à l'inscription
//      via `public.public_plans_catalog` (accessible même avant authentification).
//   2. Création de l'agence en statut `pending` (`create_agency_for_self`), sans
//      aucun abonnement actif ni accès aux tables opérationnelles.
//   3. Encaissement physique des frais d'installation sur site (hors SasPay,
//      hors factures d'abonnement) enregistré via `admin_record_physical_installation`.
//   4. Clic sur « Activer l'agence » (`admin_activate_pending_agency`) : démarre
//      automatiquement les 14 jours d'essai gratuit (J0 → J14) avec 100 % des
//      quotas et modules de l'offre choisie.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;
const db = () => getSupabaseClient().schema('saas_immobilier');

const SIGNUP_PLAN_STORAGE_KEY = 'sofia.signup.selected_plan_id';

export function saveSignupSelectedPlanId(planId: string): void {
  try {
    if (planId && planId.trim()) {
      window.localStorage.setItem(SIGNUP_PLAN_STORAGE_KEY, planId.trim());
    }
  } catch {
    // Stockage local indisponible (navigation privée stricte) : ignoré sans blocage.
  }
}

export function loadSignupSelectedPlanId(): string | null {
  try {
    const raw = window.localStorage.getItem(SIGNUP_PLAN_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function clearSignupSelectedPlanId(): void {
  try {
    window.localStorage.removeItem(SIGNUP_PLAN_STORAGE_KEY);
  } catch {
    // Ignoré
  }
}

export type PublicPlanCatalogItem = {
  id: string;
  name: string;
  display_name: string;
  description?: string | null;
  price_monthly: number;
  setup_fee: number;
  currency: string;
  max_members: number;
  max_properties: number;
  max_photos_per_property: number;
  max_whatsapp_connections?: number;
  monthly_agent_messages: number;
  monthly_follow_ups: number;
  monthly_conversations?: number;
  modules: string[] | null;
  sort_order?: number;
};

/** Catalogue public des 3 offres (Essentiel, Pro, Premium), accessible en `anon` et `authenticated`. */
export function usePublicPlansCatalog() {
  return useQuery({
    queryKey: ['public-plans-catalog'],
    staleTime: 60_000,
    queryFn: async (): Promise<PublicPlanCatalogItem[]> => {
      const { data, error } = await rpc().rpc('public_plans_catalog');
      if (!error && Array.isArray(data)) {
        return (data as PublicPlanCatalogItem[]).map((item) => ({
          ...item,
          display_name: item.display_name || item.name,
          price_monthly: Number(item.price_monthly ?? 0),
          setup_fee: Number(item.setup_fee ?? 0),
          currency: item.currency || 'XOF',
        }));
      }
      // Repli si l'utilisateur est déjà authentifié
      const { data: rows, error: tableErr } = await db()
        .from('plans')
        .select(
          'id, name, display_name, description, price_monthly, setup_fee, currency, max_members, max_properties, max_photos_per_property, max_whatsapp_connections, monthly_agent_messages, monthly_follow_ups, monthly_conversations, modules, sort_order',
        )
        .in('name', ['starter', 'pro', 'enterprise'])
        .order('sort_order', { ascending: true });
      if (tableErr) throw error ?? tableErr;
      return ((rows ?? []) as unknown as PublicPlanCatalogItem[]).map((item) => ({
        ...item,
        display_name: item.display_name || item.name,
        price_monthly: Number(item.price_monthly ?? 0),
        setup_fee: Number(item.setup_fee ?? 0),
        currency: item.currency || 'XOF',
      }));
    },
  });
}

export type PhysicalInstallationMethod =
  | 'cash'
  | 'orange_money_physical'
  | 'wave_physical'
  | 'bank_transfer'
  | 'check'
  | 'other';

export const PHYSICAL_INSTALLATION_METHODS: Array<{
  value: PhysicalInstallationMethod;
  label: string;
}> = [
  { value: 'cash', label: 'Espèces (sur site)' },
  { value: 'orange_money_physical', label: 'Orange Money (réglé lors de l’installation)' },
  { value: 'wave_physical', label: 'Wave (réglé lors de l’installation)' },
  { value: 'bank_transfer', label: 'Virement bancaire' },
  { value: 'check', label: 'Chèque' },
  { value: 'other', label: 'Autre mode physique' },
];

export function physicalInstallationMethodLabel(method?: string | null): string {
  const found = PHYSICAL_INSTALLATION_METHODS.find((m) => m.value === method);
  return found ? found.label : method || 'Espèces (sur site)';
}

export type InstallationStateInfo = {
  status: 'pending' | 'paid_pending_setup' | 'completed' | string;
  fee_expected: number;
  amount_collected: number | null;
  collected_at: string | null;
  completed_at: string | null;
  payment_method: string | null;
  receipt_reference: string | null;
  note: string | null;
};

export type PendingPlan = {
  id: string;
  name: string;
  display_name: string | null;
  price_monthly: number;
  setup_fee: number | null;
  currency: string;
  max_members?: number;
  max_properties?: number;
  max_photos_per_property?: number;
  monthly_agent_messages?: number;
  monthly_follow_ups?: number;
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
  legal_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  agency_status?: string;
  is_pending?: boolean;
  pending_since?: string;
  pending_note?: string | null;
  pending_updated_at?: string | null;
  trial_days?: number;
  plan?: PendingPlan | null;
  setup_fee?: number;
  price_monthly_after_trial?: number;
  amount_due?: number;
  installation?: InstallationStateInfo | null;
  latest_declaration?: PendingDeclaration | null;
};

export const getPendingStateQueryKey = (agencyId?: string) =>
  ['pending', 'etat', agencyId ?? 'none'] as const;

/** État d'attente de l'agence : offre choisie, installation physique et statut d'activation. */
export function usePendingState(agencyId?: string) {
  return useQuery({
    queryKey: getPendingStateQueryKey(agencyId),
    enabled: Boolean(agencyId),
    staleTime: 5_000,
    refetchInterval: 15_000,
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

/** Conservé pour compatibilité : côté base, seul l'admin peut changer d'offre si les frais d'installation diffèrent. */
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
/* CÔTÉ ADMIN — file des agences en attente d'installation et d'activation      */
/* --------------------------------------------------------------------------- */

export type PendingAgencyRow = {
  agency_id: string;
  agency_name: string;
  legal_name?: string | null;
  slug: string | null;
  agency_phone?: string | null;
  agency_email?: string | null;
  address?: string | null;
  city: string | null;
  country?: string | null;
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
  installation_status?: 'pending' | 'paid_pending_setup' | 'completed' | string;
  installation_amount_collected?: number | null;
  installation_collected_at?: string | null;
  installation_completed_at?: string | null;
  installation_payment_method?: string | null;
  installation_receipt_reference?: string | null;
  installation_note?: string | null;
  owner_name?: string | null;
  owner_email: string | null;
  owner_phone?: string | null;
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

export type RecordPhysicalInstallationInput = {
  agencyId: string;
  collectedAmount?: number | null;
  paymentMethod: PhysicalInstallationMethod;
  receiptReference?: string | null;
  installationCompleted: boolean;
  collectedOn?: string | null;
  note?: string | null;
};

export function useAdminRecordPhysicalInstallation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordPhysicalInstallationInput) => {
      const { data, error } = await rpc().rpc('admin_record_physical_installation', {
        p_agency_id: input.agencyId,
        p_collected_amount: input.collectedAmount ?? null,
        p_payment_method: input.paymentMethod,
        p_receipt_reference: input.receiptReference ?? null,
        p_installation_completed: input.installationCompleted,
        p_collected_on: input.collectedOn ?? null,
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return data as {
        agency_id: string;
        installation_payment_id: string;
        installation_status: string;
        expected_amount: number;
        collected_amount: number;
        payment_method: string;
        receipt_reference: string;
        currency: string;
      };
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

export function useAdminSetPendingAgencyPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { agencyId: string; planId: string; note?: string | null }) => {
      const { data, error } = await rpc().rpc('admin_set_pending_agency_plan', {
        p_agency_id: input.agencyId,
        p_plan_id: input.planId,
        p_note: input.note ?? null,
      });
      if (error) throw error;
      return data as {
        agency_id: string;
        plan_id: string;
        plan_name: string;
        setup_fee: number;
        price_monthly: number;
      };
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

export type ActivatePendingAgencyResult = {
  agency_id: string;
  subscription_id: string;
  status: string;
  subscription_status: string;
  plan_id: string;
  plan_name: string;
  trial_days: number;
  starts_at: string;
  trial_ends_at: string;
  ends_at: string;
  price_monthly: number;
  setup_fee_collected: number | null;
};

export function useActivatePendingAgency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | { agencyId: string; note?: string | null }) => {
      const agencyId = typeof input === 'string' ? input : input.agencyId;
      const note = typeof input === 'string' ? null : (input.note ?? null);
      const { data, error } = await rpc().rpc('admin_activate_pending_agency', {
        p_agency_id: agencyId,
        p_note: note,
      });
      if (error) throw error;
      return data as ActivatePendingAgencyResult;
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

export function installationStatusLabel(status?: string | null): string {
  switch (status) {
    case 'completed':
      return 'Installation physique réalisée';
    case 'paid_pending_setup':
      return 'Frais encaissés · installation en cours';
    case 'pending':
    default:
      return 'En attente d’installation physique';
  }
}

/** Libellé français du statut d'une déclaration historique éventuelle. */
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
