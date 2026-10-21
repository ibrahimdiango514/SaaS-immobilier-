// =============================================================================
// BLOC 8 — ALERTES INTELLIGENTES + « RÉSUMÉ DU JOUR » (vue d'ensemble)
// =============================================================================
// Les alertes sont CALCULÉES, pas générées par l'IA : elles fonctionnent donc
// pour toutes les offres et ne consomment aucun token.
//   • biens sans photo
//   • prospects sans suivi depuis 7 jours
//   • visites / rendez-vous à venir
//   • échéance d'abonnement proche ou dépassée
//   • limites presque atteintes (biens, utilisateurs, photos, tokens IA)
//
// Le « Résumé du jour » est la seule partie qui interroge l'assistant : il est
// déclenché à la demande (jamais au chargement de la page) et réservé aux
// offres Pro/Premium, avec aperçu verrouillé sinon.
// =============================================================================
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  AlertTriangle, Bell, CalendarDays, Camera, CheckCircle2, Clock3, Gauge,
  ImageIcon, Lock, Sparkles, Wallet,
} from 'lucide-react';
import { getSupabaseClient } from '@/lib/supabase';
import { useAgency } from '@/lib/agency-context';
import {
  useAgencyMediaRefs, useContacts, useFollowUps, useProperties,
} from '@/lib/data-hooks';
import { useAgencyAiUsage } from '@/lib/usage-api';
import { useAssistantAccess, askDailySummary, assistantErrorLabel } from '@/lib/assistant-api';

const db = () => getSupabaseClient().schema('saas_immobilier');
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export type AlertLevel = 'info' | 'warning' | 'danger';

export type SmartAlert = {
  id: string;
  level: AlertLevel;
  label: string;
  detail: string;
  href: string;
  cta: string;
  icon: typeof Camera;
};

/* ------------------------------------------------------------------ */
/* Données nécessaires aux alertes                                     */
/* ------------------------------------------------------------------ */

type Snapshot = {
  properties_used: number;
  properties_limit: number | null;
  photos_per_property_max: number;
  photos_per_property_limit: number | null;
  seats?: { seats_used: number; seats_limit: number | null; is_unlimited: boolean };
};

type BillingState = {
  has_due_date: boolean;
  ends_at: string | null;
  days_to_due: number | null;
  grace_days: number | null;
  is_due_soon: boolean;
  is_overdue: boolean;
  is_past_grace: boolean;
};

function useAgencySnapshot(agencyId?: string) {
  return useQuery({
    queryKey: ['sofia', 'usage-snapshot', agencyId],
    enabled: Boolean(agencyId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc().rpc('agency_usage_snapshot', { p_agency_id: agencyId as string });
      if (error) throw error;
      return data as Snapshot;
    },
  });
}

function useBillingState(agencyId?: string) {
  return useQuery({
    queryKey: ['sofia', 'billing-state', agencyId],
    enabled: Boolean(agencyId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc().rpc('agency_billing_state', { p_agency_id: agencyId as string });
      if (error) throw error;
      return data as BillingState;
    },
  });
}

/** Rendez-vous à venir — `property_visits` ne porte pas de date planifiée. */
function useUpcomingAppointments(agencyId?: string) {
  return useQuery({
    queryKey: ['sofia', 'appointments-upcoming', agencyId],
    enabled: Boolean(agencyId),
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await db()
        .from('appointments')
        .select('id, start_at, status, type')
        .eq('agency_id', agencyId as string)
        .gte('start_at', new Date().toISOString())
        .order('start_at', { ascending: true })
        .limit(20);
      if (error) throw error;
      return data as Array<{ id: string; start_at: string; status: string; type: string | null }>;
    },
  });
}

const UNLIMITED = 1_000_000_000;
const isUnlimited = (value: number | null | undefined) => value == null || value >= UNLIMITED;

export function useSmartAlerts(agencyId?: string) {
  const propertiesQ = useProperties(agencyId);
  const mediaRefsQ = useAgencyMediaRefs(agencyId);
  const contactsQ = useContacts(agencyId);
  const followUpsQ = useFollowUps(agencyId);
  const appointmentsQ = useUpcomingAppointments(agencyId);
  const snapshotQ = useAgencySnapshot(agencyId);
  const billingQ = useBillingState(agencyId);
  const aiUsageQ = useAgencyAiUsage(agencyId);

  const alerts = useMemo<SmartAlert[]>(() => {
    const out: SmartAlert[] = [];
    const now = Date.now();
    const sevenDays = 7 * 24 * 3600 * 1000;

    // 1. Biens sans photo.
    const properties = propertiesQ.data ?? [];
    const withPhoto = new Set((mediaRefsQ.data ?? []).map((row) => row.property_id));
    const noPhoto = properties.filter((property) => !withPhoto.has(property.id));
    if (noPhoto.length) {
      out.push({
        id: 'no-photo',
        level: noPhoto.length >= 3 ? 'warning' : 'info',
        label: `${noPhoto.length} bien(s) sans photo`,
        detail: `À commencer par ${noPhoto.slice(0, 3).map((row) => row.reference).join(', ')}${noPhoto.length > 3 ? '…' : ''}. Une annonce sans photo est beaucoup moins consultée.`,
        href: '/biens',
        cta: 'Compléter les photos',
        icon: Camera,
      });
    }

    // 2. Prospects sans suivi depuis 7 jours.
    const contacts = contactsQ.data ?? [];
    const followUps = followUpsQ.data ?? [];
    const followedUp = new Set(
      followUps.filter((row) => row.contact_id && row.status !== 'cancelled').map((row) => row.contact_id as string),
    );
    const stale = contacts.filter((contact) => {
      const isProspect = contact.status === 'lead' || contact.status === 'prospect';
      return isProspect && now - new Date(contact.created_at).getTime() > sevenDays && !followedUp.has(contact.id);
    });
    if (stale.length) {
      out.push({
        id: 'stale-prospects',
        level: stale.length >= 5 ? 'warning' : 'info',
        label: `${stale.length} prospect(s) sans suivi depuis 7 jours`,
        detail: `${stale.slice(0, 3).map((row) => row.first_name).join(', ')}${stale.length > 3 ? '…' : ''} attendent une relance.`,
        href: '/contacts',
        cta: 'Relancer',
        icon: Clock3,
      });
    }

    // 3. Rendez-vous / visites à venir.
    const upcoming = appointmentsQ.data ?? [];
    if (upcoming.length) {
      const next = upcoming[0];
      out.push({
        id: 'upcoming-visits',
        level: 'info',
        label: `${upcoming.length} rendez-vous à venir`,
        detail: `Prochain : ${new Date(next.start_at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}.`,
        href: '/visites',
        cta: 'Voir l’agenda',
        icon: CalendarDays,
      });
    }

    // 4. Échéance d'abonnement.
    const billing = billingQ.data;
    if (billing?.has_due_date) {
      if (billing.is_overdue) {
        out.push({
          id: 'subscription-overdue',
          level: 'danger',
          label: 'Abonnement en retard de paiement',
          detail: `Dépassé de ${Math.abs(billing.days_to_due ?? 0)} jour(s). Délai de grâce : ${billing.grace_days ?? 0} jour(s) avant suspension de l’agence.`,
          href: '/mon-offre',
          cta: 'Déclarer un paiement',
          icon: Wallet,
        });
      } else if (billing.is_due_soon) {
        out.push({
          id: 'subscription-due',
          level: 'warning',
          label: 'Échéance d’abonnement proche',
          detail: `Dans ${billing.days_to_due ?? 0} jour(s). Pensez à déclarer votre paiement Orange Money ou Wave.`,
          href: '/mon-offre',
          cta: 'Voir mon offre',
          icon: Wallet,
        });
      }
    }

    // 5. Limites presque atteintes.
    const snapshot = snapshotQ.data;
    if (snapshot && !isUnlimited(snapshot.properties_limit)) {
      const ratio = snapshot.properties_limit ? snapshot.properties_used / snapshot.properties_limit : 0;
      if (ratio >= 0.8) {
        out.push({
          id: 'limit-properties',
          level: ratio >= 1 ? 'danger' : 'warning',
          label: ratio >= 1 ? 'Limite de biens atteinte' : 'Limite de biens presque atteinte',
          detail: `${snapshot.properties_used}/${snapshot.properties_limit} biens. Archivez un bien vendu ou loué pour libérer une place, ou changez d’offre.`,
          href: '/mon-offre',
          cta: 'Voir mon offre',
          icon: Gauge,
        });
      }
    }
    if (snapshot?.seats && !snapshot.seats.is_unlimited) {
      const ratio = snapshot.seats.seats_limit ? snapshot.seats.seats_used / snapshot.seats.seats_limit : 0;
      if (ratio >= 0.8) {
        out.push({
          id: 'limit-seats',
          level: ratio >= 1 ? 'danger' : 'warning',
          label: ratio >= 1 ? 'Limite d’utilisateurs atteinte' : 'Limite d’utilisateurs presque atteinte',
          detail: `${snapshot.seats.seats_used}/${snapshot.seats.seats_limit} accès utilisés.`,
          href: '/equipe',
          cta: 'Gérer l’équipe',
          icon: Gauge,
        });
      }
    }
    if (snapshot && !isUnlimited(snapshot.photos_per_property_limit)) {
      const limit = snapshot.photos_per_property_limit ?? 0;
      if (limit > 0 && snapshot.photos_per_property_max >= limit) {
        out.push({
          id: 'limit-photos',
          level: 'warning',
          label: 'Limite de photos atteinte sur un bien',
          detail: `${snapshot.photos_per_property_max}/${limit} photos sur le bien le plus fourni.`,
          href: '/mon-offre',
          cta: 'Voir mon offre',
          icon: ImageIcon,
        });
      }
    }

    // 6. Quotas IA (Bloc 7) — uniquement si l'agence a une offre qui les plafonne.
    const aiUsage = aiUsageQ.data;
    if (aiUsage?.alerts.ai_tokens === 'warning' || aiUsage?.alerts.ai_tokens === 'reached') {
      out.push({
        id: 'limit-ai-tokens',
        level: aiUsage.alerts.ai_tokens === 'reached' ? 'danger' : 'warning',
        label: aiUsage.alerts.ai_tokens === 'reached' ? 'Quota de tokens IA atteint' : 'Quota de tokens IA à 80 %',
        detail: `${aiUsage.usage.ai_tokens_total.toLocaleString('fr-FR')} tokens consommés ce mois sur ${Number(aiUsage.plan.monthly_ai_tokens ?? 0).toLocaleString('fr-FR')}.`,
        href: '/mon-offre',
        cta: 'Voir mon offre',
        icon: Sparkles,
      });
    }

    return out;
  }, [
    propertiesQ.data, mediaRefsQ.data, contactsQ.data, followUpsQ.data,
    appointmentsQ.data, snapshotQ.data, billingQ.data, aiUsageQ.data,
  ]);

  const loading = propertiesQ.isLoading || contactsQ.isLoading;
  return { alerts, loading };
}

/* ------------------------------------------------------------------ */
/* Carte « Alertes intelligentes »                                     */
/* ------------------------------------------------------------------ */
export function SmartAlertsCard() {
  const { alerts, loading } = useSmartAlerts(useAgencyId());

  return (
    <section className="panel smart-alerts" data-testid="panel-smart-alerts">
      <div className="panel-head">
        <div>
          <h2>Alertes intelligentes</h2>
          <p>Calculées à partir de vos données, sans consommer de quota IA.</p>
        </div>
        <Bell size={17} />
      </div>

      {loading ? (
        <p className="form-hint">Analyse de votre activité…</p>
      ) : alerts.length ? (
        <ul className="smart-alert-list">
          {alerts.map((alert) => {
            const Icon = alert.icon;
            return (
              <li className={`smart-alert is-${alert.level}`} key={alert.id} data-testid={`alert-${alert.id}`}>
                <span className="smart-alert-icon"><Icon size={15} /></span>
                <div className="smart-alert-copy">
                  <strong>{alert.label}</strong>
                  <p>{alert.detail}</p>
                </div>
                <Link href={alert.href} className="text-action" data-testid={`link-alert-${alert.id}`}>
                  {alert.cta}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="smart-alert-empty" data-testid="empty-smart-alerts">
          <CheckCircle2 size={17} />
          <div>
            <strong>Rien à signaler</strong>
            <p>Vos biens sont illustrés, vos prospects sont suivis et vos limites sont loin d’être atteintes.</p>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Carte « Résumé du jour » — assistant IA, à la demande               */
/* ------------------------------------------------------------------ */
export function DailySummaryCard() {
  const agencyId = useAgencyId();
  const access = useAssistantAccess(agencyId);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);

  // Invalider le résumé quand l'agence active change.
  useEffect(() => {
    setSummary('');
    setError('');
    setGeneratedAt(null);
  }, [agencyId]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const reply = await askDailySummary();
      setSummary(reply.reply);
      setGeneratedAt(Date.now());
    } catch (caught) {
      setError(assistantErrorLabel(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel daily-summary" data-testid="panel-daily-summary">
      <div className="panel-head">
        <div>
          <h2>Résumé du jour</h2>
          <p>
            {access.allowed
              ? 'Généré par l’assistant IA à partir de vos données réelles, à la demande.'
              : `Réservé aux offres Pro et Premium — votre offre : ${access.planName ?? '—'}.`}
          </p>
        </div>
        {access.allowed ? <Sparkles size={17} /> : <Lock size={17} />}
      </div>

      {!access.allowed ? (
        <div className="daily-summary-locked">
          <p>
            Chaque matin, Sofia résume en cinq puces ce qui va bien, ce qui attend une
            action et votre priorité du jour — avec les chiffres exacts de votre agence.
          </p>
          <Link href="/assistant-ia" className="primary-action" data-testid="link-daily-summary-unlock">
            <Sparkles size={15} /> Débloquer avec l’offre Pro
          </Link>
        </div>
      ) : (
        <>
          <div className="daily-summary-actions">
            <button
              type="button"
              className="primary-action"
              onClick={() => void generate()}
              disabled={busy || access.isLoading}
              data-testid="button-daily-summary"
            >
              <Sparkles size={15} /> {busy ? 'Génération…' : summary ? 'Régénérer le résumé' : 'Générer le résumé du jour'}
            </button>
            {generatedAt && (
              <small className="form-hint">
                Généré à {new Date(generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
              </small>
            )}
          </div>

          {error && (
            <p className="form-error" role="alert" data-testid="status-daily-summary-error">
              <AlertTriangle size={13} /> {error}
            </p>
          )}

          {summary && (
            <div className="daily-summary-body" data-testid="box-daily-summary">
              <p>{summary}</p>
              <Link href="/assistant-ia" className="text-action" data-testid="link-daily-summary-chat">
                Poser une question à Sofia
              </Link>
            </div>
          )}

          {!summary && !error && (
            <p className="form-hint">
              Le résumé n’est pas généré automatiquement : il consomme des tokens de votre
              quota mensuel, il est donc déclenché uniquement quand vous le demandez.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Agence active — l'assistant, lui, la déduit toujours du JWT côté serveur. */
function useAgencyId(): string | undefined {
  const { activeAgencyId } = useAgency();
  return activeAgencyId;
}
