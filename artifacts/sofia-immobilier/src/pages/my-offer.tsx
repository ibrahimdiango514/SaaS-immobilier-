// LOT B (point B) — PAGE « MON OFFRE ».
// Toute la donnée vient de public.agency_usage_snapshot(agency_id), déjà en base.
// Aucune nouvelle table, aucune nouvelle fonction SQL.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Building2, Check, CreditCard, ImageIcon, Lock, Sparkles, UsersRound,
} from 'lucide-react';
import {
  ButtonPrimary, ErrorState, Heading, LoadingRows, useSafeRetry, cash,
} from '@/lib/workspace-ui';
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
  billing: { grace_days: number; is_overdue: boolean; is_due_soon: boolean; has_due_date: boolean };
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
  const plans = useAllPlans();
  const requestChange = useRequestPlanChange(activeAgencyId);
  const [notice, setNotice] = useState('');

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
            <div><span>Échéance</span><strong>{billing.has_due_date ? 'À venir' : 'Aucune échéance'}</strong></div>
            <div><span>Délai de grâce</span><strong>{billing.grace_days} jour(s)</strong></div>
          </div>
          {canManageAgency && (
            <ButtonPrimary testId="button-pay-subscription" onClick={() => setNotice('Le paiement manuel arrive au point B4. Utilisez la déclaration de paiement dès qu’elle sera disponible.')}>
              <CreditCard size={14} /> Payer mon abonnement
            </ButtonPrimary>
          )}
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

      {notice && <p className="form-feedback" role="status" data-testid="status-offer-message">{notice}</p>}
    </>
  );
}
