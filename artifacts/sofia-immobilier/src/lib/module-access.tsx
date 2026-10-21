// =============================================================================
// SESSION 2 — BLOC 3 : SOURCE UNIQUE D'ACCÈS AUX MODULES PAR OFFRE
// =============================================================================
// Le plan de l'agence (`plans.modules`, lu via `agency_current_plan`) décide de
// TOUT : menu, routes, boutons et widgets. Un module non inclus reste VISIBLE
// mais VERROUILLÉ, et n'est jamais accessible — y compris par URL directe.
//
// Répartition appliquée en base :
//   ESSENTIEL : biens, contacts, pipeline, visites, dashboard, ca_chart
//   PRO       : + automatisations, ca_filters, ca_export_csv, assistant_ia
//   PREMIUM   : + stats_avancees, rapports_mensuels, support_prioritaire
//
// Ce qui n'est appliqué QUE côté interface est listé dans docs/ETAT-AVANCEMENT.md
// (§ BLOC 3, « appliqué côté serveur »).
// =============================================================================
import type { ComponentType, ReactNode } from 'react';
import { Lock, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { useAgencyPlan, useUpgradeTargets, type CurrentPlan } from './plan-limits';
import { useAgency } from './agency-context';

/** Clés de modules telles que stockées dans `plans.modules`. */
export const MODULE_KEYS = [
  'biens',
  'contacts',
  'pipeline',
  'visites',
  'dashboard',
  'ca_chart',
  'automatisations',
  'ca_filters',
  'ca_export_csv',
  'assistant_ia',
  'stats_avancees',
  'rapports_mensuels',
  'support_prioritaire',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULE_LABELS: Record<string, string> = {
  biens: 'Biens immobiliers',
  contacts: 'Prospects et contacts',
  pipeline: 'Pipeline commercial',
  visites: 'Visites',
  dashboard: 'Vue d’ensemble',
  ca_chart: 'Graphique du chiffre d’affaires',
  automatisations: 'Automatisations',
  ca_filters: 'CA avec filtres de période',
  ca_export_csv: 'Export CSV du CA',
  assistant_ia: 'Assistant IA du dashboard',
  stats_avancees: 'Statistiques avancées',
  rapports_mensuels: 'Rapports mensuels',
  support_prioritaire: 'Support prioritaire',
};

/** Offre minimale qui contient un module, pour libeller « Passer au Pro ». */
const MODULE_MIN_PLAN: Record<string, string> = {
  automatisations: 'Pro',
  ca_filters: 'Pro',
  ca_export_csv: 'Pro',
  assistant_ia: 'Pro',
  stats_avancees: 'Premium',
  rapports_mensuels: 'Premium',
  support_prioritaire: 'Premium',
};

export function moduleMinPlanLabel(moduleKey: string): string | null {
  return MODULE_MIN_PLAN[moduleKey] ?? null;
}

/** Route → module requis. Une route absente de cette carte n'est pas verrouillée. */
export const ROUTE_MODULE: Array<{ prefix: string; module: ModuleKey }> = [
  { prefix: '/biens', module: 'biens' },
  { prefix: '/contacts', module: 'contacts' },
  { prefix: '/pipeline', module: 'pipeline' },
  { prefix: '/visites', module: 'visites' },
  { prefix: '/automatisations', module: 'automatisations' },
  { prefix: '/assistant-ia', module: 'assistant_ia' },
  { prefix: '/dashboard', module: 'dashboard' },
];

export function moduleForRoute(path: string): ModuleKey | null {
  const hit = ROUTE_MODULE.find((entry) => path === entry.prefix || path.startsWith(`${entry.prefix}/`));
  return hit?.module ?? null;
}

export type ModuleAccess = {
  /** Ensemble des modules inclus dans l'offre active. */
  included: Set<string>;
  /** Vrai si le module est inclus. Pendant le chargement : true (pas de flash). */
  has: (moduleKey?: string | null) => boolean;
  loading: boolean;
  error: Error | null;
  plan: CurrentPlan | null;
  planName: string;
  /** BLOC 1 : aucune offre exploitable → état explicatif, jamais un écran muet. */
  planMissing: boolean;
};

/**
 * Routes qui ne sont JAMAIS verrouillées, même sans offre : l'agence doit
 * pouvoir comprendre sa situation et agir (BLOC 1). « Mon offre » et
 * « Paramètres » ne figurent pas dans ROUTE_MODULE, elles sont donc déjà
 * toujours accessibles.
 */
const NEVER_LOCKED_MODULES = new Set<string>(['dashboard']);

/**
 * Accès aux modules de l'agence active. Une seule source : `agency_current_plan`
 * (RPC public, déjà gardé côté base).
 */
export function useModuleAccess(agencyId?: string): ModuleAccess {
  const planQ = useAgencyPlan(agencyId);
  const plan = (planQ.data ?? null) as CurrentPlan | null;
  const included = new Set<string>(plan?.modules ?? []);
  const loading = planQ.isLoading || planQ.isPending;
  const planMissing = !loading && plan === null;

  return {
    included,
    // Pendant le chargement on ne verrouille pas : évite un écran « Passer au Pro »
    // qui clignote avant de disparaître. Les routes restent protégées dès que
    // l'offre est connue.
    has: (moduleKey?: string | null) => {
      if (!moduleKey) return true;
      if (loading) return true;
      // Une offre introuvable ne verrouille jamais la vue d'ensemble : cette
      // page affiche l'état explicatif et l'action à faire (BLOC 1).
      if (!plan) return NEVER_LOCKED_MODULES.has(moduleKey);
      return included.has(moduleKey);
    },
    loading,
    error: (planQ.error as Error | null) ?? null,
    plan,
    planMissing,
    planName: plan?.display_name ?? plan?.name ?? '—',
  };
}

/** Accès aux modules de l'agence active du contexte. */
export function useActiveModuleAccess(): ModuleAccess {
  const { activeAgencyId } = useAgency();
  return useModuleAccess(activeAgencyId);
}

/**
 * Écran « module verrouillé » : affiché à la place de la page, y compris quand
 * l'utilisateur saisit l'URL directement. Propose l'offre supérieure.
 */
export function ModuleLockedScreen({
  moduleKey,
  onUpgrade,
}: {
  moduleKey: string;
  onUpgrade?: ReactNode;
}) {
  const label = MODULE_LABELS[moduleKey] ?? moduleKey;
  const minPlan = moduleMinPlanLabel(moduleKey);
  return (
    <div className="module-locked" data-testid={`screen-module-locked-${moduleKey}`}>
      <div className="module-locked-icon"><Lock size={20} /></div>
      <h2>{label} n’est pas inclus dans votre offre</h2>
      <p>
        Ce module est disponible à partir de l’offre{' '}
        <strong>{minPlan ?? 'supérieure'}</strong>. Votre offre actuelle reste
        inchangée : rien n’est facturé tant que l’administrateur n’a pas validé un
        changement.
      </p>
      <div className="module-locked-actions">
        {onUpgrade}
        <Link href="/mon-offre" className="button-link" data-testid="link-locked-to-offer">
          <Sparkles size={14} /> Voir les offres
        </Link>
      </div>
      <p className="form-hint">
        Seuls le propriétaire et les administrateurs de l’agence peuvent demander
        un changement d’offre.
      </p>
    </div>
  );
}

/**
 * Garde de route : rend `children` si le module est inclus, sinon l'écran
 * verrouillé. Utilisé pour chaque route sensible afin qu'une URL saisie
 * directement ne contourne pas le menu.
 */
export function RequireModule({
  moduleKey,
  access,
  upgradeAction,
  children,
}: {
  moduleKey?: ModuleKey | null;
  access: ModuleAccess;
  upgradeAction?: ReactNode;
  children: ReactNode;
}) {
  if (moduleKey && !access.has(moduleKey)) {
    return <ModuleLockedScreen moduleKey={moduleKey} onUpgrade={upgradeAction} />;
  }
  return <>{children}</>;
}

/** Icône de cadenas pour un élément de menu verrouillé. */
export const ModuleLockIcon: ComponentType<{ size?: number }> = Lock;
