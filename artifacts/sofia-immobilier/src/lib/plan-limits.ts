// =============================================================================
// BLOC 3 — LIMITES DE PLAN CÔTÉ CLIENT (photos, et réutilisé par les blocs 6/8)
// =============================================================================
// La vérité reste la base : les triggers `enforce_photo_limit` /
// `enforce_property_limit` / `enforce_member_limit` refusent l'insertion.
// Cette couche sert uniquement à AFFICHER le compteur et à éviter d'envoyer des
// fichiers qui seront refusés.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';

const db = () => getSupabaseClient().schema('saas_immobilier');
type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

/** Toute limite >= ce seuil est affichée « illimité » (convention LOT A). */
export const UNLIMITED_THRESHOLD = 1_000_000_000;
export const isUnlimited = (value: number | null | undefined) =>
  value == null || value >= UNLIMITED_THRESHOLD;

export interface CurrentPlan {
  id: string;
  name: string;
  display_name: string | null;
  price_monthly: number;
  setup_fee: number | null;
  currency: string;
  max_members: number;
  max_properties: number;
  max_photos_per_property: number;
  monthly_agent_messages: number | null;
  monthly_ai_tokens: number | null;
  monthly_conversations: number | null;
  modules: string[] | null;
}

export interface UpgradeTarget {
  id: string;
  name: string;
  display_name: string | null;
  price_monthly: number;
  currency: string;
  max_photos_per_property: number;
}

export const getAgencyPlanQueryKey = (agencyId?: string) => ['plan', 'agence', agencyId] as const;
export const getAgencyPlanStateQueryKey = (agencyId?: string) => ['plan', 'etat', agencyId] as const;
export const getUpgradeTargetsQueryKey = () => ['plan', 'cibles'] as const;

/**
 * BLOC 1 (session 3) — État cohérent de l'offre, lu depuis UNE seule source :
 * `public.agency_plan_state(agency_id)`.
 *
 * `state` peut valoir : active | trial | overdue | suspended_overdue |
 * no_plan | pending | cancelled | suspended | missing.
 *
 * `is_locked` ne vaut vrai QUE pour pending / suspended / suspended_overdue :
 * une agence sans offre ou en retard garde son espace de travail ouvert, avec
 * un état explicatif et l'action à faire. C'est la règle demandée au BLOC 1.
 */
export type AgencyPlanStateValue =
  | 'active'
  | 'trial'
  | 'overdue'
  | 'suspended_overdue'
  | 'no_plan'
  | 'pending'
  | 'cancelled'
  | 'suspended'
  | 'missing';

export interface AgencyPlanState {
  found: boolean;
  agency_id?: string;
  agency_status?: string;
  state: AgencyPlanStateValue;
  has_plan: boolean;
  subscription_id?: string | null;
  subscription_status?: string | null;
  plan_id?: string | null;
  plan_name?: string | null;
  plan_price_monthly?: number | null;
  plan_setup_fee?: number | null;
  currency?: string | null;
  trial_ends_at?: string | null;
  trial_days_left?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  days_to_due?: number | null;
  grace_days?: number;
  is_locked: boolean;
  requires_action: boolean;
}

/** Libellés affichés partout (badges, bandeaux, console admin). */
export const AGENCY_STATE_LABELS: Record<AgencyPlanStateValue, string> = {
  active: 'Active',
  trial: 'Essai',
  overdue: 'En retard',
  suspended_overdue: 'Suspendue (impayé)',
  no_plan: 'Sans offre',
  pending: 'En validation',
  cancelled: 'Résiliée',
  suspended: 'Suspendue',
  missing: 'Introuvable',
};

export function agencyStateLabel(state?: AgencyPlanStateValue | string | null): string {
  if (!state) return '—';
  return AGENCY_STATE_LABELS[state as AgencyPlanStateValue] ?? String(state);
}

/** État de l'offre de l'agence — RPC `agency_plan_state`. */
export function useAgencyPlanState(agencyId?: string) {
  return useQuery({
    queryKey: getAgencyPlanStateQueryKey(agencyId),
    enabled: Boolean(agencyId),
    staleTime: 30_000,
    queryFn: async (): Promise<AgencyPlanState | null> => {
      const { data, error } = await rpc().rpc('agency_plan_state', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return (data as AgencyPlanState | null) ?? null;
    },
  });
}

/** Offre active de l'agence — `public.agency_current_plan`, déjà en base. */
export function useAgencyPlan(agencyId?: string) {
  return useQuery({
    queryKey: getAgencyPlanQueryKey(agencyId),
    enabled: Boolean(agencyId),
    staleTime: 60_000,
    queryFn: async (): Promise<CurrentPlan | null> => {
      const { data, error } = await rpc().rpc('agency_current_plan', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return (data as CurrentPlan | null) ?? null;
    },
  });
}

/** Offres supérieures, pour le bouton « Passer au Pro / Premium ». */
export function useUpgradeTargets() {
  return useQuery({
    queryKey: getUpgradeTargetsQueryKey(),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<UpgradeTarget[]> => {
      const { data, error } = await (db() as unknown as {
        from: (t: string) => {
          select: (c: string) => { order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> };
        };
      })
        .from('plans')
        .select('id, name, display_name, price_monthly, currency, max_photos_per_property')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return (data ?? []) as UpgradeTarget[];
    },
  });
}

export interface PhotoQuota {
  /** Limite de l'offre pour UN bien. */
  limit: number;
  unlimited: boolean;
  /** Photos déjà enregistrées + en cours de préparation. */
  used: number;
  /** Place restante avant refus côté base. */
  remaining: number;
  reached: boolean;
  planName: string;
  loading: boolean;
}

/**
 * Compteur « 7/10 » d'un bien.
 * `staged` = photos déjà choisies mais pas encore envoyées (formulaire de bien).
 */
export function usePhotoQuota(
  agencyId: string | undefined,
  storedCount: number,
  staged = 0,
): PhotoQuota {
  const planQ = useAgencyPlan(agencyId);
  const plan = planQ.data;
  const rawLimit = plan?.max_photos_per_property ?? null;
  const unlimited = isUnlimited(rawLimit);
  const limit = unlimited ? Number.POSITIVE_INFINITY : Number(rawLimit ?? 0);
  const used = Math.max(0, storedCount) + Math.max(0, staged);
  return {
    limit,
    unlimited,
    used,
    remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used),
    reached: !unlimited && used >= limit,
    planName: plan?.display_name ?? plan?.name ?? 'votre offre',
    loading: planQ.isLoading,
  };
}

type PhotoQuotaLike = Pick<PhotoQuota, 'used' | 'limit' | 'unlimited'>;

/** Affiche « 7/10 », ou « 7 · illimité » quand l'offre n'a pas de plafond. */
export function formatQuota(quota: PhotoQuotaLike): string {
  return quota.unlimited ? `${quota.used} · illimité` : `${quota.used}/${quota.limit}`;
}

/**
 * BLOC 3 : découpe un envoi multiple pour ne garder que ce qui rentre.
 * Les fichiers refusés sont rendus pour être annoncés à l'utilisateur.
 */
export function splitByPhotoQuota<T>(files: T[], remaining: number): { accepted: T[]; refused: T[] } {
  if (!Number.isFinite(remaining)) return { accepted: files, refused: [] };
  const slots = Math.max(0, Math.trunc(remaining));
  return { accepted: files.slice(0, slots), refused: files.slice(slots) };
}

/** Demande de passage à une offre supérieure (même RPC que la page Mon offre). */
export function useRequestUpgrade(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; note: string }) => {
      const { data, error } = await rpc().rpc('request_plan_change', {
        p_agency_id: agencyId as string,
        p_plan_id: input.planId,
        p_note: input.note,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['offre'] }),
        queryClient.invalidateQueries({ queryKey: ['plan'] }),
      ]);
    },
  });
}

/**
 * Cible du bouton « Passer au Pro » : la première offre supérieure à l'offre
 * active qui augmente réellement la limite de photos. Retombe sur la première
 * offre plus chère si aucune ne change la limite.
 */
export function pickUpgradeTarget(
  current: CurrentPlan | null | undefined,
  targets: UpgradeTarget[] | undefined,
): UpgradeTarget | null {
  if (!current || !targets?.length) return null;
  const currentPrice = Number(current.price_monthly ?? 0);
  const higher = targets.filter((row) => Number(row.price_monthly) > currentPrice);
  if (!higher.length) return null;
  const morePhotos = higher.find(
    (row) => Number(row.max_photos_per_property) > Number(current.max_photos_per_property ?? 0),
  );
  return morePhotos ?? higher[0];
}

/* --------------------------------------------------------------------------- */
/* BLOC 11 (bug 4) — SUIVI DES DEMANDES DE CHANGEMENT D'OFFRE CÔTÉ AGENCE       */
/* --------------------------------------------------------------------------- */
/* Avant ce correctif, `request_plan_change` envoyait bien la demande mais       */
/* l'agence n'avait AUCUN retour : le seul message était rendu tout en bas de la */
/* page « Mon offre », hors écran au moment du clic. L'agence ne pouvait donc    */
/* jamais savoir si sa demande était en attente, approuvée ou refusée (et avec   */
/* quel motif). La table `plan_change_requests` est déjà lisible par les membres */
/* de l'agence (politique SELECT `is_agency_member`) : aucune modification de    */
/* RLS n'est nécessaire.                                                        */
/* --------------------------------------------------------------------------- */

export type PlanChangeRequestStatus = 'pending' | 'approved' | 'rejected' | string;

export interface PlanChangeRequestRow {
  id: string;
  agency_id: string;
  requested_plan_id: string;
  current_plan_id: string | null;
  requested_by: string | null;
  note: string | null;
  status: PlanChangeRequestStatus;
  handled_by: string | null;
  handled_at: string | null;
  handle_note: string | null;
  created_at: string;
  updated_at: string;
}

/** Libellé français du statut d'une demande. */
export function planChangeStatusLabel(status: PlanChangeRequestStatus): string {
  switch (status) {
    case 'pending':
      return 'En attente de validation';
    case 'approved':
      return 'Approuvée';
    case 'rejected':
      return 'Refusée';
    default:
      return status || 'Inconnue';
  }
}

/**
 * Clé préfixée par `offre` : l'invalidation déjà faite par `useRequestUpgrade`
 * (`queryKey: ['offre']`) la couvre automatiquement.
 */
export const getPlanChangeRequestsQueryKey = (agencyId?: string) =>
  ['offre', 'demandes-changement', agencyId ?? 'none'] as const;

/** Demandes de changement d'offre de l'agence, plus récente d'abord. */
export function usePlanChangeRequests(agencyId?: string) {
  return useQuery({
    queryKey: getPlanChangeRequestsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    staleTime: 15_000,
    queryFn: async (): Promise<PlanChangeRequestRow[]> => {
      const { data, error } = await db()
        .from('plan_change_requests')
        .select(
          'id, agency_id, requested_plan_id, current_plan_id, requested_by, note, status, handled_by, handled_at, handle_note, created_at, updated_at',
        )
        .eq('agency_id', agencyId as string)
        .order('created_at', { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as unknown as PlanChangeRequestRow[];
    },
  });
}


/* --------------------------------------------------------------------------- */
/* CATALOGUE DES OFFRES — source unique (page Mon offre, écran d'attente BLOC 2) */
/* --------------------------------------------------------------------------- */

export interface PlanRow {
  id: string;
  name: string;
  display_name: string;
  price_monthly: number;
  /** BLOC 2 : frais d'installation, ajoutés au premier mois pour le montant dû. */
  setup_fee: number | null;
  currency: string;
  modules: string[] | null;
}

export const getPlansQueryKey = () => ['offre', 'plans'] as const;

/** Les trois offres, de la moins chère à la plus chère. */
export function useAllPlans() {
  return useQuery({
    queryKey: getPlansQueryKey(),
    staleTime: 60_000,
    queryFn: async (): Promise<PlanRow[]> => {
      const { data, error } = await (db() as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }>;
          };
        };
      })
        .from('plans')
        .select('id, name, display_name, price_monthly, setup_fee, currency, modules')
        .order('price_monthly', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PlanRow[];
    },
  });
}
