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
export const getUpgradeTargetsQueryKey = () => ['plan', 'cibles'] as const;

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
