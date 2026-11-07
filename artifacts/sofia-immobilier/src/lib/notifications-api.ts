// =============================================================================
// LOT 4 — API & Hooks Temps Réel du Centre de Notifications Agence et de
//         l'Historique des Événements de Facturation (`Africa/Bamako`)
// =============================================================================
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient } from './supabase';

export type AgencyNotificationCategory =
  | 'all'
  | 'onboarding'
  | 'trial'
  | 'billing'
  | 'payment'
  | 'suspension'
  | 'plan'
  | 'system';

export interface AgencyNotificationItem {
  id: string;
  agency_id: string;
  user_id: string | null;
  type: string;
  category: string;
  priority: 'low' | 'normal' | 'high' | 'critical' | string;
  title: string;
  message: string;
  action_href: string | null;
  action_label: string | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface AgencyNotificationsCenterPayload {
  agency_id: string;
  unread_count: number;
  total_count: number;
  category_counts: Record<string, number>;
  timezone: string;
  notifications: AgencyNotificationItem[];
}

export interface AgencyBillingEvent {
  id: string;
  agency_id: string;
  event_type: string;
  plan_from_name: string | null;
  plan_to_name: string | null;
  mensualite_from: number | null;
  mensualite_to: number | null;
  mensualite_variation: number | null;
  invoice_id: string | null;
  invoice_reference: string | null;
  invoice_status: string | null;
  payment_id: string | null;
  online_payment_id: string | null;
  amount: number | null;
  reference: string | null;
  reason: string | null;
  created_at: string;
  action_href: string | null;
}

export interface AgencyNotificationsFilters {
  category?: AgencyNotificationCategory;
  unreadOnly?: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
}

export const AGENCY_NOTIFICATION_CATEGORY_LABELS: Record<string, string> = {
  all: 'Toutes les catégories',
  onboarding: 'Mise en service',
  trial: 'Essai gratuit 14j',
  billing: 'Factures & échéances',
  payment: 'Paiements SasPay',
  suspension: 'Grâce & réactivation',
  plan: 'Changement d’offre',
  system: 'Système',
};

export const BILLING_EVENT_LABELS: Record<string, string> = {
  installation_completed: 'Installation physique validée',
  trial_started: 'Ouverture de l’essai gratuit (14 jours)',
  trial_ended: 'Fin d’essai — 1er mois ouvert',
  invoice_generated: 'Nouvelle facture émise',
  payment_validated: 'Paiement d’abonnement confirmé',
  plan_change: 'Changement d’offre',
  suspension: 'Suspension automatique pour impayé',
  reactivation: 'Réactivation automatique après régularisation',
};

const rpc = () => getSupabaseClient() as unknown as {
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

function normalizeFallbackRow(raw: Record<string, unknown>): AgencyNotificationItem {
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : {}) as Record<string, unknown>;
  const type = String(raw.type ?? 'billing');
  const category = typeof data.category === 'string' && data.category ? data.category : type;
  const priority = typeof data.priority === 'string' && data.priority ? data.priority : 'normal';
  return {
    id: String(raw.id ?? ''),
    agency_id: String(raw.agency_id ?? ''),
    user_id: typeof raw.user_id === 'string' ? raw.user_id : null,
    type,
    category,
    priority,
    title: String(raw.title ?? ''),
    message: String(raw.message ?? ''),
    action_href: typeof data.action_href === 'string' ? data.action_href : '/mon-offre',
    action_label: typeof data.action_label === 'string' ? data.action_label : 'Consulter',
    data,
    read_at: typeof raw.read_at === 'string' ? raw.read_at : null,
    created_at: String(raw.created_at ?? new Date().toISOString()),
  };
}

let agencyRealtimeSeq = 0;

/** Souscription Supabase Realtime sur `saas_immobilier.notifications` filtrée par agence. */
export function useAgencyNotificationsRealtime(agencyId: string | null | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!agencyId) return;
    let channel: ReturnType<ReturnType<typeof getSupabaseClient>['channel']> | null = null;
    const client = getSupabaseClient();
    const topic = `sofia-agency-notifs-${agencyId}-${++agencyRealtimeSeq}`;

    try {
      channel = client
        .channel(topic)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'saas_immobilier',
            table: 'notifications',
            filter: `agency_id=eq.${agencyId}`,
          },
          () => {
            void qc.invalidateQueries({ queryKey: ['agency-notifications-center', agencyId] });
            void qc.invalidateQueries({ queryKey: ['notifications', agencyId] });
          },
        )
        .subscribe();
    } catch (err) {
      console.warn('useAgencyNotificationsRealtime subscribe warning:', err);
    }

    return () => {
      if (channel) {
        void client.removeChannel(channel).catch(() => undefined);
      }
    };
  }, [agencyId, qc]);
}

export function useAgencyNotificationsCenter(
  agencyId: string | null | undefined,
  filters: AgencyNotificationsFilters = {},
) {
  const category = filters.category && filters.category !== 'all' ? filters.category : null;
  const unreadOnly = Boolean(filters.unreadOnly);
  const fromDate = filters.fromDate || null;
  const toDate = filters.toDate || null;
  const limit = filters.limit ?? 100;

  return useQuery<AgencyNotificationsCenterPayload>({
    queryKey: ['agency-notifications-center', agencyId, category, unreadOnly, fromDate, toDate, limit],
    enabled: Boolean(agencyId),
    staleTime: 10_000,
    refetchInterval: 25_000,
    queryFn: async () => {
      const client = getSupabaseClient();
      const { data, error } = await rpc().rpc('agency_notifications_center', {
        p_agency_id: agencyId,
        p_category: category,
        p_unread_only: unreadOnly,
        p_from_date: fromDate,
        p_to_date: toDate,
        p_limit: limit,
      });

      if (!error && data) {
        return data as AgencyNotificationsCenterPayload;
      }

      // Repli compatible si la migration LOT 4 n'est pas encore passée sur l'environnement cible
      const { data: rows, error: fallbackErr } = await client
        .schema('saas_immobilier')
        .from('notifications')
        .select('*')
        .eq('agency_id', agencyId!)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (fallbackErr) throw fallbackErr;
      const mapped = (rows ?? []).map((r) => normalizeFallbackRow(r as Record<string, unknown>));
      const categoryCounts: Record<string, number> = {};
      for (const item of mapped) {
        categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
      }
      const filtered = mapped.filter((item) => {
        if (unreadOnly && item.read_at) return false;
        if (category && item.category !== category) return false;
        const day = item.created_at.slice(0, 10);
        if (fromDate && day < fromDate) return false;
        if (toDate && day > toDate) return false;
        return true;
      });

      return {
        agency_id: agencyId!,
        unread_count: mapped.filter((i) => !i.read_at).length,
        total_count: mapped.length,
        category_counts: categoryCounts,
        timezone: 'Africa/Bamako',
        notifications: filtered,
      };
    },
  });
}

export function useMarkAgencyNotification(agencyId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ notificationId, read }: { notificationId: string; read: boolean }) => {
      if (!agencyId) return false;
      const client = getSupabaseClient();
      const { error } = await rpc().rpc('agency_mark_notification', {
        p_agency_id: agencyId,
        p_notification_id: notificationId,
        p_read: read,
      });
      if (!error) return true;

      const { error: fallbackErr } = await client
        .schema('saas_immobilier')
        .from('notifications')
        .update({ read_at: read ? new Date().toISOString() : null })
        .eq('id', notificationId)
        .eq('agency_id', agencyId);
      if (fallbackErr) throw fallbackErr;
      return true;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agency-notifications-center', agencyId] });
      void qc.invalidateQueries({ queryKey: ['notifications', agencyId] });
    },
  });
}

export function useMarkAllAgencyNotifications(agencyId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (category?: string | null) => {
      if (!agencyId) return 0;
      const client = getSupabaseClient();
      const { data, error } = await rpc().rpc('agency_mark_all_notifications_read', {
        p_agency_id: agencyId,
        p_category: category ?? null,
      });
      if (!error) return Number(data ?? 0);

      const { error: fallbackErr } = await client
        .schema('saas_immobilier')
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('agency_id', agencyId)
        .is('read_at', null);
      if (fallbackErr) throw fallbackErr;
      return 1;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agency-notifications-center', agencyId] });
      void qc.invalidateQueries({ queryKey: ['notifications', agencyId] });
    },
  });
}

export function useAgencyBillingEvents(agencyId: string | null | undefined, limit = 60) {
  return useQuery<AgencyBillingEvent[]>({
    queryKey: ['agency-billing-events', agencyId, limit],
    enabled: Boolean(agencyId),
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await rpc().rpc('agency_billing_events', {
        p_agency_id: agencyId,
        p_limit: limit,
      });
      if (!error && Array.isArray(data)) {
        return data as AgencyBillingEvent[];
      }
      return [];
    },
  });
}
