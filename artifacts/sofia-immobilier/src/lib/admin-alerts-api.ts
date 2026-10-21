// =============================================================================
// BLOC 3 (session 3) — ALERTES ADMINISTRATEUR
// =============================================================================
// Source : `saas_immobilier.admin_alerts`, alimentée par des triggers
// (nouvelle agence, début d'essai, changement d'offre, paiement déclaré,
// suspension) et par `public.admin_scan_alerts()` pour les événements datés
// (essai à J-3, impayé). Rafraîchissement toutes les 30 secondes.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export type AlertPriority = 'low' | 'normal' | 'high' | 'critical';

export interface AdminAlert {
  id: string;
  agency_id: string | null;
  agency_name: string | null;
  kind: string;
  title: string;
  reason: string;
  priority: AlertPriority;
  action_href: string | null;
  action_label: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface AdminAlertsPayload {
  alerts: AdminAlert[];
  unread: number;
  critical: number;
}

export const getAdminAlertsQueryKey = () => ['sofia', 'admin', 'alerts'] as const;

export const PRIORITY_LABELS: Record<AlertPriority, string> = {
  low: 'Faible',
  normal: 'Normale',
  high: 'Haute',
  critical: 'Critique',
};

/**
 * Charge les alertes. `admin_scan_alerts()` régénère d'abord les alertes
 * datées (idempotent : la clé unique empêche les doublons).
 */
export function useAdminAlerts(enabled = true) {
  return useQuery({
    queryKey: getAdminAlertsQueryKey(),
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    queryFn: async (): Promise<AdminAlertsPayload> => {
      // Le scan est best-effort : une erreur ici ne doit pas masquer la liste.
      const scan = await rpc().rpc('admin_scan_alerts', {});
      if (scan.error) console.warn('admin_scan_alerts', scan.error);
      const { data, error } = await rpc().rpc('admin_alerts', { p_limit: 50 });
      if (error) throw error;
      return data as AdminAlertsPayload;
    },
  });
}

export function useMarkAdminAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, read = true }: { id: string; read?: boolean }) => {
      const { error } = await rpc().rpc('admin_mark_alert', { p_id: id, p_read: read });
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getAdminAlertsQueryKey() });
    },
  });
}

export function useMarkAllAdminAlerts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        const { error } = await rpc().rpc('admin_mark_alert', { p_id: id, p_read: true });
        if (error) throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getAdminAlertsQueryKey() });
    },
  });
}
