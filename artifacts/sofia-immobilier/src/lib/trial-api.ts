// =============================================================================
// BLOC 2 (session 3) — ESSAI GRATUIT DE 14 JOURS
// =============================================================================
// Une seule source côté base : `public.agency_start_trial(agency_id, plan_id)`
// crée l'abonnement en statut 'trial' (sauf si l'administrateur exige une
// validation), `trial_ends_at` = maintenant + N jours, et `ends_at` = fin de
// l'essai : le compte à rebours payant démarre donc à la FIN de l'essai, et les
// jours d'essai ne sont jamais déduits de la première période payée.
// =============================================================================
import { getSupabaseClient } from './supabase';

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export interface SignupSettings {
  require_admin_validation: boolean;
  trial_days: number;
  trial_agent_messages: number;
}

export interface StartTrialResult {
  mode: 'trial' | 'pending_validation';
  agency_id: string;
  plan_id: string;
  plan_name: string;
  subscription_id?: string;
  trial_days?: number;
  trial_ends_at?: string;
  ends_at?: string;
  amount_due?: number;
  currency?: string;
}

export async function fetchSignupSettings(): Promise<SignupSettings> {
  const { data, error } = await rpc().rpc('platform_signup_settings', {});
  if (error) throw error;
  return data as SignupSettings;
}

/** Démarre l'essai (ou place l'agence en attente de validation admin). */
export async function startAgencyTrial(agencyId: string, planId: string): Promise<StartTrialResult> {
  const { data, error } = await rpc().rpc('agency_start_trial', {
    p_agency_id: agencyId,
    p_plan_id: planId,
  });
  if (error) throw error;
  return data as StartTrialResult;
}

/** Pendant l'essai : changement d'offre immédiat, sans validation admin. */
export async function changePlanDuringTrial(agencyId: string, planId: string) {
  const { data, error } = await rpc().rpc('agency_change_plan_during_trial', {
    p_agency_id: agencyId,
    p_plan_id: planId,
  });
  if (error) throw error;
  return data as { plan_id: string; plan_name: string; mode: string };
}

export async function adminExtendTrial(agencyId: string, days: number) {
  const { data, error } = await rpc().rpc('admin_extend_trial', {
    p_agency_id: agencyId,
    p_days: days,
  });
  if (error) throw error;
  return data as { trial_ends_at: string; days_added: number };
}

export async function adminEndTrial(agencyId: string, note?: string) {
  const { data, error } = await rpc().rpc('admin_end_trial', {
    p_agency_id: agencyId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as { status: string; ends_at: string };
}

export async function adminSetSignupSettings(requireValidation: boolean, trialDays?: number) {
  const { data, error } = await rpc().rpc('admin_set_signup_settings', {
    p_require_validation: requireValidation,
    p_trial_days: trialDays ?? null,
  });
  if (error) throw error;
  return data as SignupSettings;
}
