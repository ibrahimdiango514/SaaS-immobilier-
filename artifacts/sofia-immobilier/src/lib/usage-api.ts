// =============================================================================
// BLOC 7 — CONSOMMATION IA ET CANAL WHATSAPP (lecture seule)
// =============================================================================
// Aucune table dupliquée : tout vient de `agency_usage`, `usage_events`,
// `whatsapp_connections` et `plans` via trois fonctions SQL créées au Bloc 7 :
//   - public.agency_ai_usage(uuid)   → l'agence lit sa propre consommation
//   - public.platform_agency_usage() → tableau plateforme (admin)
//   - public.record_ai_usage(...)    → service_role uniquement (n8n), jamais
//                                       appelée depuis le navigateur.
// Les autorisations sont tranchées côté serveur ; ce fichier ne fait que lire.
// =============================================================================
import { useQuery } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
const rpcClient = () => getSupabaseClient() as unknown as RpcClient;

/** `unlimited` = l'offre ne plafonne pas cette métrique (ou aucune offre active). */
export type UsageAlert = 'ok' | 'warning' | 'reached' | 'unlimited';

export type WhatsAppConnectionInfo = {
  id: string;
  connection_name: string | null;
  provider: string | null;
  provider_label: string;
  /** false pour Evolution API → badge « non officiel ». */
  official: boolean;
  phone_number: string | null;
  status: string | null;
  last_connected_at: string | null;
  last_activity_at: string | null;
};

export type AgencyAiUsage = {
  agency_id: string;
  period_start: string;
  plan: {
    id: string | null;
    name: string | null;
    display_name: string | null;
    monthly_ai_tokens: number | null;
    monthly_agent_messages: number | null;
    monthly_conversations: number | null;
    max_whatsapp_connections: number | null;
  };
  usage: {
    ai_tokens_input: number;
    ai_tokens_output: number;
    ai_tokens_total: number;
    ai_requests_count: number;
    messages_count: number;
    conversations_count: number;
    storage_bytes: number;
  };
  ratios: { ai_tokens: number; messages: number; conversations: number };
  alerts: { ai_tokens: UsageAlert; messages: UsageAlert; conversations: UsageAlert };
  whatsapp: WhatsAppConnectionInfo[];
};

export type PlatformUsageRow = {
  agency_id: string;
  agency_name: string;
  agency_slug: string | null;
  agency_status: string;
  plan_name: string | null;
  plan_id: string | null;
  ai_tokens_input: number;
  ai_tokens_output: number;
  tokens_total: number;
  tokens_limit: number;
  tokens_ratio: number;
  tokens_alert: UsageAlert;
  ai_requests_count: number;
  messages_count: number;
  messages_limit: number;
  messages_ratio: number;
  messages_alert: UsageAlert;
  conversations_count: number;
  conversations_limit: number;
  conversations_ratio: number;
  whatsapp_provider: string | null;
  whatsapp_provider_label: string | null;
  whatsapp_official: boolean;
  whatsapp_phone_number: string | null;
  whatsapp_status: string | null;
  whatsapp_last_activity_at: string | null;
  whatsapp_connections: number;
};

export type PlatformUsageTotals = {
  agencies: number;
  tokens_total: number;
  requests_total: number;
  messages_total: number;
  conversations_total: number;
  agencies_at_warning: number;
  agencies_at_limit: number;
  agencies_with_whatsapp: number;
};

export type PlatformUsageOverview = {
  period_start: string;
  agencies: PlatformUsageRow[];
  totals: PlatformUsageTotals;
};

export const usageQueryKey = (agencyId?: string) => ['sofia', 'usage', 'agency', agencyId] as const;
export const platformUsageQueryKey = ['sofia', 'usage', 'platform'] as const;

/** Consommation IA du mois en cours pour l'agence active. */
export function useAgencyAiUsage(agencyId?: string) {
  return useQuery({
    queryKey: usageQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<AgencyAiUsage> => {
      const { data, error } = await rpcClient().rpc('agency_ai_usage', { p_agency_id: agencyId });
      if (error) throw error;
      return data as AgencyAiUsage;
    },
  });
}

/** Tableau plateforme : une ligne par agence + totaux. Admin uniquement. */
export function usePlatformAgencyUsage(enabled = true) {
  return useQuery({
    queryKey: platformUsageQueryKey,
    enabled,
    queryFn: async (): Promise<PlatformUsageOverview> => {
      const { data, error } = await rpcClient().rpc('platform_agency_usage', {});
      if (error) throw error;
      return data as PlatformUsageOverview;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Formatage partagé                                                   */
/* ------------------------------------------------------------------ */

const UNLIMITED_THRESHOLD = 1_000_000_000;

export function isUnlimitedLimit(limit: number | null | undefined): boolean {
  return !limit || limit <= 0 || limit >= UNLIMITED_THRESHOLD;
}

export function compactNumber(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)} M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)} k`;
  return String(n);
}

export const WHATSAPP_STATUS_LABELS: Record<string, string> = {
  connected: 'Connecté',
  connecting: 'Connexion…',
  disconnected: 'Déconnecté',
  error: 'Erreur',
  disabled: 'Désactivé',
};

export function whatsappStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Aucun canal';
  return WHATSAPP_STATUS_LABELS[status] ?? status;
}

export const ALERT_LABELS: Record<UsageAlert, string> = {
  ok: 'Sous le seuil',
  warning: '80 % du quota atteint',
  reached: 'Quota atteint',
  unlimited: 'Non plafonné',
};
