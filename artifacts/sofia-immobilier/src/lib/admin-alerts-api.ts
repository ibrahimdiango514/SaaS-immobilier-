// =============================================================================
// LOT 4 & LOT 5 — Alertes de supervision Administrateur (Temps Réel, Filtres
//                 Serveur, Santé Cron & Bouclier Anti-Suspension)
// =============================================================================
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';

export type AlertPriority = 'low' | 'normal' | 'high' | 'critical';

export type AdminAlertCategory =
  | 'all'
  | 'onboarding'
  | 'trial'
  | 'billing'
  | 'saspay'
  | 'suspension'
  | 'plan';

export interface AdminAlert {
  id: string;
  agency_id: string | null;
  agency_name: string | null;
  kind: string;
  category?: string;
  title: string;
  reason: string;
  priority: AlertPriority;
  action_href: string | null;
  action_label: string | null;
  metadata?: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

export interface AdminAlertsPayload {
  alerts: AdminAlert[];
  unread: number;
  critical: number;
  saspay_unread?: number;
  grace_or_suspended_unread?: number;
  timezone?: string;
}

export interface AdminAlertsFilters {
  category?: AdminAlertCategory;
  priority?: AlertPriority | 'all';
  status?: 'all' | 'unread' | 'read';
  agencyId?: string | 'all';
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
}

export interface BillingAutomationHealth {
  pg_cron_active: boolean;
  cron_jobs: Array<{ jobid: number; jobname: string; schedule: string; active: boolean }>;
  last_cycle_run: {
    id: string;
    kind: string;
    created_at: string;
    result: Record<string, unknown>;
  } | null;
  last_reconciliation_run: {
    id: string;
    kind: string;
    created_at: string;
    result: Record<string, unknown>;
  } | null;
  checked_at: string;
  timezone: string;
}

export const PRIORITY_LABELS: Record<AlertPriority, string> = {
  low: 'Info',
  normal: 'Normal',
  high: 'Haute',
  critical: 'Critique',
};

export const ADMIN_ALERT_CATEGORY_LABELS: Record<string, string> = {
  all: 'Toutes catégories',
  onboarding: 'Inscriptions & installations',
  trial: 'Essais 14 jours',
  billing: 'Factures & échéances',
  saspay: 'SasPay & réconciliation',
  suspension: 'Grâce, suspensions & réactivations',
  plan: 'Changements d’offre',
};

const rpc = () => getSupabaseClient() as unknown as {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

function inferCategory(kind: string, metadata?: Record<string, unknown>): string {
  if (typeof metadata?.category === 'string' && metadata.category) return metadata.category;
  if (kind.startsWith('saspay') || kind.startsWith('payment_amount')) return 'saspay';
  if (kind.includes('signup') || kind.includes('installation') || kind === 'agency_created') return 'onboarding';
  if (kind.includes('trial')) return 'trial';
  if (kind.includes('suspended') || kind.includes('reactivated') || kind.includes('grace')) return 'suspension';
  if (kind.includes('plan')) return 'plan';
  return 'billing';
}

let adminRealtimeSeq = 0;

/** Souscription Supabase Realtime sur `saas_immobilier.admin_alerts` pour l'espace Admin. */
export function useAdminAlertsRealtime(enabled = true) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let channel: ReturnType<ReturnType<typeof getSupabaseClient>['channel']> | null = null;
    const client = getSupabaseClient();
    const topic = `sofia-admin-alerts-realtime-${++adminRealtimeSeq}`;

    try {
      channel = client
        .channel(topic)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'saas_immobilier',
            table: 'admin_alerts',
          },
          () => {
            void qc.invalidateQueries({ queryKey: ['admin-alerts'] });
            void qc.invalidateQueries({ queryKey: ['admin-alerts-center'] });
          },
        )
        .subscribe();
    } catch (err) {
      console.warn('useAdminAlertsRealtime subscribe warning:', err);
    }

    return () => {
      if (channel) {
        void client.removeChannel(channel).catch(() => undefined);
      }
    };
  }, [enabled, qc]);
}

export function useAdminAlerts(limit = 50) {
  return useQuery<AdminAlertsPayload>({
    queryKey: ['admin-alerts', limit],
    staleTime: 12_000,
    refetchInterval: 25_000,
    queryFn: async () => {
      const scan = await rpc().rpc('admin_scan_alerts');
      if (scan.error) {
        console.warn('admin_scan_alerts', scan.error);
      }
      const center = await rpc().rpc('admin_alerts_center', {
        p_category: null,
        p_priority: null,
        p_status: 'all',
        p_agency_id: null,
        p_from_date: null,
        p_to_date: null,
        p_limit: limit,
      });
      if (!center.error && center.data) {
        return center.data as AdminAlertsPayload;
      }

      const { data, error } = await rpc().rpc('admin_alerts', { p_limit: limit });
      if (error) throw new Error(error.message);
      const payload = (data ?? { alerts: [], unread: 0, critical: 0 }) as AdminAlertsPayload;
      payload.alerts = (payload.alerts ?? []).map((a) => ({
        ...a,
        category: a.category ?? inferCategory(a.kind, a.metadata),
      }));
      return payload;
    },
  });
}

export function useAdminAlertsCenter(filters: AdminAlertsFilters = {}) {
  const category = filters.category && filters.category !== 'all' ? filters.category : null;
  const priority = filters.priority && filters.priority !== 'all' ? filters.priority : null;
  const status = filters.status ?? 'all';
  const agencyId = filters.agencyId && filters.agencyId !== 'all' ? filters.agencyId : null;
  const fromDate = filters.fromDate || null;
  const toDate = filters.toDate || null;
  const limit = filters.limit ?? 150;

  return useQuery<AdminAlertsPayload>({
    queryKey: ['admin-alerts-center', category, priority, status, agencyId, fromDate, toDate, limit],
    staleTime: 10_000,
    refetchInterval: 25_000,
    queryFn: async () => {
      const res = await rpc().rpc('admin_alerts_center', {
        p_category: category,
        p_priority: priority,
        p_status: status,
        p_agency_id: agencyId,
        p_from_date: fromDate,
        p_to_date: toDate,
        p_limit: limit,
      });

      if (!res.error && res.data) {
        return res.data as AdminAlertsPayload;
      }

      // Repli compatible si `admin_alerts_center` n'est pas encore déployé sur Prod
      const fallback = await rpc().rpc('admin_alerts', { p_limit: limit });
      if (fallback.error) throw new Error(fallback.error.message);
      const raw = (fallback.data ?? { alerts: [], unread: 0, critical: 0 }) as AdminAlertsPayload;
      const enriched = (raw.alerts ?? []).map((a) => ({
        ...a,
        category: a.category ?? inferCategory(a.kind, a.metadata),
      }));
      const filtered = enriched.filter((a) => {
        if (category && a.category !== category) return false;
        if (priority && a.priority !== priority) return false;
        if (status === 'unread' && a.is_read) return false;
        if (status === 'read' && !a.is_read) return false;
        if (agencyId && a.agency_id !== agencyId) return false;
        const day = a.created_at.slice(0, 10);
        if (fromDate && day < fromDate) return false;
        if (toDate && day > toDate) return false;
        return true;
      });

      return {
        ...raw,
        alerts: filtered,
      };
    },
  });
}

export function useMarkAdminAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; read?: boolean }) => {
      const { error } = await rpc().rpc('admin_mark_alert', {
        p_id: input.id,
        p_read: input.read ?? true,
      });
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-alerts'] });
      void qc.invalidateQueries({ queryKey: ['admin-alerts-center'] });
    },
  });
}

export function useMarkAllAdminAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (idsOrCategory?: string[] | string | null) => {
      const category = typeof idsOrCategory === 'string' ? idsOrCategory : null;
      const bulk = await rpc().rpc('admin_mark_all_alerts_read', { p_category: category });
      if (!bulk.error) return true;

      if (Array.isArray(idsOrCategory)) {
        for (const id of idsOrCategory) {
          const { error } = await rpc().rpc('admin_mark_alert', { p_id: id, p_read: true });
          if (error) throw new Error(error.message);
        }
      }
      return true;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-alerts'] });
      void qc.invalidateQueries({ queryKey: ['admin-alerts-center'] });
    },
  });
}

export function useBillingAutomationHealth() {
  return useQuery<BillingAutomationHealth | null>({
    queryKey: ['billing-automation-health'],
    staleTime: 20_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc().rpc('billing_automation_health');
      if (error || !data) return null;
      return data as BillingAutomationHealth;
    },
  });
}

export function useSetSuspensionShield() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { agencyId: string; days: number; note?: string }) => {
      const { data, error } = await rpc().rpc('admin_set_suspension_shield', {
        p_agency_id: input.agencyId,
        p_days: input.days,
        p_note: input.note ?? null,
      });
      if (error) throw new Error(error.message);
      return data as { agency_id: string; auto_suspend_disabled_until: string | null };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['all-agencies'] });
      void qc.invalidateQueries({ queryKey: ['admin-saspay-overview'] });
    },
  });
}
