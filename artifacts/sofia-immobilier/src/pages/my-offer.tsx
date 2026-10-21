// LOT B (point B) — PAGE « MON OFFRE ».
// Toute la donnée vient de public.agency_usage_snapshot(agency_id), déjà en base.
// Aucune nouvelle table, aucune nouvelle fonction SQL.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Building2, Check, ImageIcon, Lock, Sparkles, UsersRound,
} from 'lucide-react';
import {
  ErrorState, Heading, LoadingRows, useSafeRetry, cash, dateLabel,
} from '@/lib/workspace-ui';
import { PaymentSection } from '@/components/payment-panel';
// BLOC 7 : jauge « Utilisation IA ce mois » (lecture seule, quotas de l'offre).
import { useAgencyAiUsage, compactNumber } from '@/lib/usage-api';
import { UsageGauge, WhatsAppBadge } from '@/components/usage-gauge';
import { whatsappStatusLabel } from '@/lib/usage-api';
import { useAgency } from '@/lib/agency-context';
import { getSupabaseClient, getSupabaseErrorMessage } from '@/lib/supabase';

const db = () => getSupabaseClient().schema('saas_immobilier');

interface UsagePlan {
  id: string;
  name: string;
  display_name: string;
  currency: string;
  setup_fee: number;
  price_monthly: number;
  max_members: number;
  max_properties: number;
  max_photos_per_property: number;
  monthly_agent_messages: number;
  monthly_follow_ups: number;
  modules: string[];
}

interface UsageSnapshot {
  plan: UsagePlan;
  seats: { seats_used: number; seats_limit: number; is_unlimited: boolean; invitations_pending: number };
  billing: {
    grace_days: number;
    is_overdue: boolean;
    is_due_soon: boolean;
    has_due_date: boolean;
    is_past_grace?: boolean;
    days_to_due?: number;
    ends_at?: string | null;
    sub_status?: string;
  };
  properties_used: number;
  properties_limit: number;
  photos_per_property_max: number;
  photos_per_property_limit: number;
}

interface PlanRow {
  id: string;
  name: string;
  display_name: string;
  price_monthly: number;
  currency: string;
  modules: string[];
}

const MODULE_LABELS: Record<string, string> = {
  biens: 'Biens immobiliers',
  contacts: 'Prospects et contacts',
  pipeline: 'Pipeline commercial',
  dashboard: 'Tableau de bord',
  ca_chart: 'Graphique du CA',
  visits: 'Visites',
  whatsapp: 'WhatsApp',
  assistant: 'Assistant IA',
  automations: 'Automatisations',
  payments: 'Paiements',
};

const unlimited = (value: number) => value >= 1_000_000_000;

function useUsageSnapshot(agencyId?: string) {
  return useQuery({
    queryKey: ['offre', 'usage', agencyId],
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<UsageSnapshot> => {
      // RPC dans public, tables dans saas_immobilier : le client nu est correct ici.
      // Cast : database.types.ts est incomplet et n'expose pas les signatures RPC.
      const { data, error } = await (getSupabaseClient() as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc('agency_usage_snapshot', { p_agency_id: agencyId as string });
      if (error) throw error;
      return data as UsageSnapshot;
    },
  });
}

function useAllPlans() {
  return useQuery({
    queryKey: ['offre', 'plans'],
    queryFn: async (): Promise<PlanRow[]> => {
      const { data, error } = await (db() as unknown as {
        from: (t: string) => { select: (c: string) => { order: (c: string, o: { ascending: boolean }) => Promise<{ data: unknown; error: unknown }> } };
      })
        .from('plans')
        .select('id, name, display_name, price_monthly, currency, modules')
        .order('price_monthly', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PlanRow[];
    },
  });
}

function useRequestPlanChange(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; note: string }) => {
      const { data, error } = await (getSupabaseClient() as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc('request_plan_change', {
        p_agency_id: agencyId as string,
        p_plan_id: input.planId,
        p_note: input.note,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['offre'] });
    },
  });
}

function Meter({ label, used, limit, icon: Icon }: { label: string; used: number; limit: number; icon: typeof ImageIcon }) {
  const isUnlimited = unlimited(limit);
  const pct = isUnlimited ? 6 : Math.min(100, limit ? (used / limit) * 100 : 0);
  const full = !isUnlimited && used >= limit;
  return (
    <div className="usage-meter" data-testid={`meter-${label}`}>
      <div className="usage-meter-head">
        <span><Icon size={14} /> {label}</span>
        <strong data-testid={`text-${label}-count`}>
          {isUnlimited ? `${used} · illimité` : `${used}/${limit}`}
        </strong>
      </div>
      <div className="usage-bar" aria-hidden="true">
        <span className={full ? 'is-full' : ''} style={{ width: `${pct}%` }} />
      </div>
      {full && <p className="usage-limit-note">Limite atteinte.</p>}
    </div>
  );
}

export default function MyOfferPage() {
  const { activeAgencyId, canManageAgency } = useAgency();
  const usage = useUsageSnapshot(activeAgencyId);
  // BLOC 7 : appelé avant tout return anticipé (règle des hooks).
  const aiUsage = useAgencyAiUsage(activeAgencyId);
  const plans = useAllPlans();
  const requestChange = useRequestPlanChange(activeAgencyId);
  const [notice, setNotice] = useState('');

  // BLOC 10 (roles) : « Mon offre » regroupe l'abonnement, les declarations de
  // paiement et la consommation. Reserve au proprietaire et aux administrateurs.
  // Garde placee apres tous les hooks (regle des hooks de React).
  if (!canManageAgency) {
    return (
      <>
        <Heading eyebrow="Abonnement" title="Mon offre" description="Offre active, limites et paiement." />
        <div className="permission-note" role="status" data-testid="status-offer-permission">
          <Lock size={15} />
          <span>
            L’offre, les paiements et la consommation de l’agence sont réservés au
            propriétaire et aux administrateurs. Votre rôle ne permet pas d’y
            accéder. Les règles d’accès définies côté base restent prioritaires.
          </span>
        </div>
      </>
    );
  }

  if (usage.isLoading) {
    return <><Heading eyebrow="Abonnement" title="Mon offre" description="Offre active, limites et paiement." /><LoadingRows label="Chargement de l’offre" /></>;
  }
  if (usage.error) {
    return <><Heading eyebrow="Abonnement" title="Mon offre" description="Offre active, limites et paiement." /><ErrorState error={usage.error as Error} retry={useSafeRetry(usage)} /></>;
  }

  const snapshot = usage.data as UsageSnapshot;
  const { plan, seats, billing } = snapshot;
  const included = new Set(plan.modules ?? []);
  // Catalogue réel : union des modules de tous les plans présents en base.
  const catalog = Array.from(new Set((plans.data ?? []).flatMap((row) => row.modules ?? [])));
  const locked = catalog.filter((key) => !included.has(key));
  const upgrades = (plans.data ?? []).filter((row) => row.price_monthly > plan.price_monthly);

  const askUpgrade = async (target: PlanRow) => {
    setNotice('');
    try {
      await requestChange.mutateAsync({
        planId: target.id,
        note: `Demande depuis la page Mon offre : passage de ${plan.display_name} à ${target.display_name}.`,
      });
      setNotice(`Demande de passage à ${target.display_name} envoyée à l’administrateur.`);
    } catch (error) {
      setNotice(getSupabaseErrorMessage(error, 'envoyer la demande'));
    }
  };

  return (
    <>
      {/* 6. Bandeau d'alerte : 5 jours avant l'échéance, et le jour même. */}
      {billing.has_due_date && (billing.is_due_soon || billing.is_overdue) && (
        <div className={`offer-alert${billing.is_overdue ? ' is-overdue' : ''}`} role="status" data-testid="banner-due-alert">
          <AlertTriangle size={17} />
          <div>
            <strong>{billing.is_overdue ? 'Abonnement en retard de paiement' : 'Échéance proche'}</strong>
            <p>
              {billing.is_overdue
                ? `Votre agence sera suspendue après le délai de grâce de ${billing.grace_days} jour(s).`
                : `Votre abonnement arrive à échéance dans moins de 5 jours. Pensez à régler.`}
            </p>
          </div>
        </div>
      )}

      <Heading
        eyebrow="Abonnement"
        title="Mon offre"
        description="Offre active, utilisation par rapport aux limites et paiement."
      />

      <div className="offer-layout">
        <section className="panel offer-current" data-testid="panel-current-offer">
          <div className="offer-plan-head">
            <div className="offer-plan-mark"><Sparkles size={20} /></div>
            <div>
              <span className="form-kicker">Offre active</span>
              <h2 data-testid="text-plan-name">{plan.display_name}</h2>
              <p className="offer-price" data-testid="text-plan-price">
                {cash(Number(plan.price_monthly), plan.currency)} <span>/ mois</span>
              </p>
            </div>
          </div>
          <div className="offer-facts">
            <div><span>Frais d’installation</span><strong>{cash(Number(plan.setup_fee), plan.currency)}</strong></div>
            <div><span>Échéance</span><strong>{billing.has_due_date ? (billing.ends_at ? dateLabel(billing.ends_at as string) : 'À venir') : 'Aucune échéance'}</strong></div>
            <div><span>Délai de grâce</span><strong>{billing.grace_days} jour(s)</strong></div>
          </div>
          {/* BLOC 1 : le bouton « Payer mon abonnement » vit désormais dans la
              section de paiement ci-dessous (déclaration + suivi d'état). */}
        </section>

        <section className="panel" data-testid="panel-usage">
          <div className="panel-head">
            <div><h2>Utilisation</h2><p>Par rapport aux limites de votre offre</p></div>
            <Building2 size={18} />
          </div>
          <Meter label="biens" used={snapshot.properties_used} limit={snapshot.properties_limit} icon={Building2} />
          <Meter label="utilisateurs" used={seats.seats_used} limit={seats.seats_limit} icon={UsersRound} />
          <Meter label="photos" used={snapshot.photos_per_property_max} limit={snapshot.photos_per_property_limit} icon={ImageIcon} />
          <p className="usage-caption">
            « photos » = maximum atteint sur un seul bien.
            {seats.invitations_pending > 0 && ` ${seats.invitations_pending} invitation(s) en attente déjà comptée(s).`}
          </p>
        </section>

        {/* ----------------------------------------------------------------- */}
        {/* BLOC 7 : consommation IA du mois + état du canal WhatsApp          */}
        {/* ----------------------------------------------------------------- */}
        <section className="panel ai-usage-panel" data-testid="panel-ai-usage">
          <div className="panel-head">
            <div>
              <h2>Utilisation IA ce mois</h2>
              <p>
                {aiUsage.data?.period_start
                  ? `Période du ${new Date(aiUsage.data.period_start).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}`
                  : 'Période en cours'}
                {' · '}alerte à 80 % puis à 100 % du quota de votre offre.
              </p>
            </div>
            <Sparkles size={18} />
          </div>

          {aiUsage.isLoading && <p className="form-hint">Chargement des compteurs IA…</p>}
          {aiUsage.error && (
            <p className="form-error" role="alert" data-testid="status-ai-usage-error">
              {getSupabaseErrorMessage(aiUsage.error, 'charger l’utilisation IA')}
            </p>
          )}

          {aiUsage.data && (
            <>
              <div className="ai-gauges">
                <UsageGauge
                  label="Tokens IA"
                  used={aiUsage.data.usage.ai_tokens_total}
                  limit={aiUsage.data.plan.monthly_ai_tokens}
                  ratio={aiUsage.data.ratios.ai_tokens}
                  alert={aiUsage.data.alerts.ai_tokens}
                  testId="ai-tokens"
                />
                <UsageGauge
                  label="Messages"
                  used={aiUsage.data.usage.messages_count}
                  limit={aiUsage.data.plan.monthly_agent_messages}
                  ratio={aiUsage.data.ratios.messages}
                  alert={aiUsage.data.alerts.messages}
                  testId="ai-messages"
                />
                <UsageGauge
                  label="Conversations"
                  used={aiUsage.data.usage.conversations_count}
                  limit={aiUsage.data.plan.monthly_conversations}
                  ratio={aiUsage.data.ratios.conversations}
                  alert={aiUsage.data.alerts.conversations}
                  testId="ai-conversations"
                />
              </div>

              <p className="usage-caption" data-testid="text-ai-requests">
                {aiUsage.data.usage.ai_requests_count} requête(s) IA ce mois ·{' '}
                {compactNumber(aiUsage.data.usage.ai_tokens_input)} tokens en entrée,{' '}
                {compactNumber(aiUsage.data.usage.ai_tokens_output)} en sortie.
              </p>

              {aiUsage.data.alerts.ai_tokens !== 'ok' && aiUsage.data.alerts.ai_tokens !== 'unlimited' && (
                <div className={`notice-box${aiUsage.data.alerts.ai_tokens === 'reached' ? ' is-danger' : ' is-warning'}`} role="status" data-testid="status-ai-quota-alert">
                  <AlertTriangle size={15} />
                  <span>
                    {aiUsage.data.alerts.ai_tokens === 'reached'
                      ? `Quota de tokens IA atteint pour ${aiUsage.data.plan.display_name ?? 'votre offre'}. L’assistant IA ne répondra plus jusqu’au mois prochain.`
                      : `Vous avez consommé ${Math.round(aiUsage.data.ratios.ai_tokens)} % du quota de tokens IA de ${aiUsage.data.plan.display_name ?? 'votre offre'}.`}
                    {canManageAgency && ' Envisagez une offre supérieure.'}
                  </span>
                </div>
              )}

              {/* Canal WhatsApp de l'agence : fournisseur, numéro, état. */}
              <div className="ai-whatsapp">
                <h3>Canal WhatsApp</h3>
                {aiUsage.data.whatsapp.length ? (
                  <div className="ai-whatsapp-list">
                    {aiUsage.data.whatsapp.map((connection) => (
                      <div key={connection.id} data-testid={`row-my-whatsapp-${connection.id}`}>
                        <WhatsAppBadge
                          providerLabel={connection.provider_label}
                          official={connection.official}
                          status={whatsappStatusLabel(connection.status)}
                          phoneNumber={connection.phone_number}
                          testId={connection.id}
                        />
                        <small>
                          Dernière activité :{' '}
                          {connection.last_activity_at
                            ? new Date(connection.last_activity_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
                            : 'jamais'}
                          {aiUsage.data?.plan.max_whatsapp_connections != null && (
                            <> · {aiUsage.data.whatsapp.length}/{aiUsage.data.plan.max_whatsapp_connections} canal(aux) inclus</>
                          )}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="usage-caption">
                    Aucun canal WhatsApp connecté. Votre offre {aiUsage.data.plan.display_name ?? ''} inclut{' '}
                    {aiUsage.data.plan.max_whatsapp_connections ?? 0} canal(aux).
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        <section className="panel" data-testid="panel-modules">
          <div className="panel-head">
            <div><h2>Modules</h2><p>Inclus dans {plan.display_name}, et disponibles au-dessus</p></div>
            <Check size={18} />
          </div>
          <div className="module-list">
            {catalog.map((key) => {
              const isIncluded = included.has(key);
              return (
                <div className={`module-row${isIncluded ? '' : ' is-locked'}`} key={key} data-testid={`module-${key}`}>
                  {isIncluded ? <Check size={14} /> : <Lock size={14} />}
                  <span>{MODULE_LABELS[key] ?? key}</span>
                  {!isIncluded && <em>Non inclus</em>}
                </div>
              );
            })}
          </div>

          {locked.length > 0 && canManageAgency && upgrades.length > 0 && (
            <div className="upgrade-block">
              <p className="privacy-note-text">
                {locked.length} module(s) verrouillé(s) dans {plan.display_name}.
              </p>
              <div className="upgrade-options">
                {upgrades.map((target) => (
                  <button
                    type="button"
                    key={target.id}
                    className="button-link"
                    onClick={() => void askUpgrade(target)}
                    disabled={requestChange.isPending}
                    data-testid={`button-upgrade-${target.name}`}
                  >
                    <Sparkles size={14} /> Passer au {target.display_name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* BLOC 1 : déclaration de paiement manuel (Orange Money / Wave) et
          suivi de l'état des déclarations de l'agence. */}
      <PaymentSection agencyId={activeAgencyId} />

      {notice && <p className="form-feedback" role="status" data-testid="status-offer-message">{notice}</p>}
    </>
  );
}
