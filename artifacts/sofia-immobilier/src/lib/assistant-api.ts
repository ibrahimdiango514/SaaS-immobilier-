// =============================================================================
// BLOC 8 — CLIENT DE L'ASSISTANT IA (Edge Function `dashboard-assistant`)
// =============================================================================
// Aucune autorisation n'est décidée ici : l'Edge Function déduit l'agence du JWT,
// vérifie l'offre Pro/Premium, le quota de tokens, la limite par minute et le
// rôle (un agent n'obtient ni CA ni paiements). Ce module n'envoie JAMAIS
// d'`agency_id`.
// =============================================================================
import { getSupabaseClient } from './supabase';
import { useAgencyPlan, type CurrentPlan } from './plan-limits';

export const ASSISTANT_SLUG = 'dashboard-assistant';

/** Offres donnant accès à l'assistant — même liste que côté serveur. */
export const ASSISTANT_PLANS = new Set(['pro', 'enterprise']);

export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  /** Outils en lecture seule qui ont produit les chiffres de la réponse. */
  tools?: string[];
  tokens?: number;
  pending?: boolean;
  error?: boolean;
};

export type AssistantReply = {
  reply: string;
  message_id: string;
  agency_id: string;
  agency_name: string;
  role: string;
  plan: string;
  tools: string[];
  alerts: string[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  read_only: true;
};

const errorLabels: Record<string, string> = {
  authentication_required: 'Session expirée. Reconnectez-vous puis réessayez.',
  no_agency_membership: 'Aucune agence active n’est rattachée à votre compte.',
  agency_suspended:
    'Votre agence est suspendue : l’assistant IA est indisponible. Réglez votre abonnement pour la réactiver.',
  assistant_requires_pro_plan:
    'L’assistant IA est réservé aux offres Pro et Premium. Passez à une offre supérieure pour l’utiliser.',
  ai_quota_exceeded:
    'Quota mensuel de tokens IA atteint. Il sera réinitialisé le mois prochain, ou passez à une offre supérieure.',
  rate_limit_exceeded: 'Vous envoyez trop de messages. Patientez quelques secondes puis réessayez.',
  message_too_long: 'Message trop long : 1 200 caractères maximum.',
  message_required: 'Écrivez une question avant d’envoyer.',
  assistant_not_configured:
    'L’assistant n’est pas encore configuré côté serveur (clé du fournisseur d’IA manquante).',
  assistant_upstream_error: 'Le service d’IA n’a pas répondu. Réessayez dans un instant.',
  assistant_empty_response: 'Le service d’IA a renvoyé une réponse vide. Reformulez votre question.',
  context_unavailable: 'Vos données n’ont pas pu être lues. Réessayez.',
  plan_check_failed: 'L’offre de votre agence n’a pas pu être vérifiée. Réessayez.',
  server_configuration_error: 'Configuration serveur incomplète. Contactez le support.',
  server_error: 'Erreur serveur. Réessayez.',
  method_not_allowed: 'Méthode non autorisée.',
  invalid_json: 'Requête malformée.',
};

export function assistantErrorLabel(error: unknown): string {
  const candidate = error as { code?: string; message?: string } | null;
  const code = candidate?.code ?? candidate?.message ?? '';
  if (code && errorLabels[code]) return errorLabels[code];
  const message = candidate?.message ?? '';
  const known = Object.keys(errorLabels).find((key) => message.includes(key));
  if (known) return errorLabels[known];
  return message || 'Une erreur est survenue. Réessayez.';
}

/** Code d'erreur brut, pour distinguer « offre insuffisante » des autres refus. */
export function assistantErrorCode(error: unknown): string {
  const candidate = error as { code?: string; message?: string } | null;
  const raw = candidate?.code ?? candidate?.message ?? '';
  return Object.keys(errorLabels).find((key) => raw.includes(key)) ?? '';
}

async function invokeAssistant(body: Record<string, unknown>): Promise<AssistantReply> {
  const client = getSupabaseClient();
  const { data, error } = await client.functions.invoke(ASSISTANT_SLUG, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context) {
      const payload = (await context.json().catch(() => null)) as { error?: string; message?: string } | null;
      const code = payload?.error ?? payload?.message;
      if (code) throw new Error(code);
    }
    throw error;
  }
  const payload = data as { error?: string } & AssistantReply;
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new Error(payload.error);
  }
  return payload;
}

/** Envoie une question à l'assistant. L'historique est borné côté serveur. */
export function askAssistant(input: {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}) {
  return invokeAssistant({
    message: input.message,
    history: (input.history ?? []).map((item) => ({ role: item.role, content: item.content })),
  });
}

/** Demande le « Résumé du jour » — même fonction, question figée. */
export const DAILY_SUMMARY_PROMPT =
  'Fais le résumé du jour de mon agence en 5 puces maximum : ce qui va bien, ce qui nécessite une action aujourd’hui, et une priorité. Utilise uniquement les chiffres disponibles.';

export function askDailySummary(history?: Array<{ role: 'user' | 'assistant'; content: string }>) {
  return askAssistant({ message: DAILY_SUMMARY_PROMPT, history });
}

/**
 * Garde d'affichage : l'assistant n'est proposé que pour Pro/Premium.
 * Le contrôle décisif reste côté serveur — ceci sert uniquement à montrer un
 * aperçu verrouillé avec « Passer au Pro » au lieu d'un chat inutilisable.
 */
export function useAssistantAccess(agencyId?: string) {
  const planQ = useAgencyPlan(agencyId);
  const plan = planQ.data ?? null;
  const allowed = Boolean(plan && ASSISTANT_PLANS.has(String(plan.name).toLowerCase()));
  return {
    isLoading: planQ.isLoading,
    error: planQ.error,
    plan,
    allowed,
    planName: plan?.display_name ?? plan?.name ?? null,
  };
}

/** Offres supérieures à proposer pour débloquer l'assistant. */
export function assistantUpgradeTargets(plan: CurrentPlan | null, plans: CurrentPlan[]): CurrentPlan[] {
  if (!plan) return plans;
  return plans
    .filter((row) => ASSISTANT_PLANS.has(String(row.name).toLowerCase()))
    .filter((row) => Number(row.price_monthly) > Number(plan.price_monthly))
    .sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly));
}

export const ASSISTANT_SUGGESTIONS = [
  'Combien de biens ai-je et dans quels statuts ?',
  'Quels biens n’ont pas encore de photo ?',
  'Quels prospects n’ont pas été relancés depuis 7 jours ?',
  'Quelles sont mes prochaines visites ?',
  'Où en est mon pipeline ?',
  'Quelle est la valeur de mon portefeuille disponible ?',
  'Que dois-je faire en priorité aujourd’hui ?',
];

export const ASSISTANT_SUGGESTIONS_MANAGER = [
  'Quel est mon chiffre d’affaires du mois ?',
  'Où en est mon abonnement ?',
];
