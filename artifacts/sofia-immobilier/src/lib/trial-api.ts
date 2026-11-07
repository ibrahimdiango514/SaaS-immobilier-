// =============================================================================
// LOT 1 — ESSAI GRATUIT DE 14 JOURS (DÉCLENCHÉ À L'ACTIVATION ADMINISTRATIVE)
// =============================================================================
// Règles métier validées :
//   • Toute nouvelle agence est créée en `pending` et ne démarre JAMAIS son
//     essai toute seule : c'est l'activation par l'administrateur après
//     l'installation physique (`admin_activate_pending_agency`) qui ouvre
//     automatiquement les 14 jours d'essai gratuit (J0 → J14).
//   • Pendant les 14 jours d'essai, l'agence bénéficie de 100 % des quotas et
//     fonctionnalités de l'offre choisie (`quota_source = 'plan'`).
//   • Pendant `pending` et les 14 jours d'essai, seul l'administrateur peut
//     modifier l'offre lorsque les frais d'installation changent.
// =============================================================================
import { getSupabaseClient } from './supabase';

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export interface SignupSettings {
  require_admin_validation: boolean;
  trial_days: number;
  quota_source?: 'plan';
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

/** Conservé pour compatibilité : renvoie `mode = 'pending_validation'` tant que l'admin n'a pas activé l'agence. */
export async function startAgencyTrial(agencyId: string, planId: string): Promise<StartTrialResult> {
  const { data, error } = await rpc().rpc('agency_start_trial', {
    p_agency_id: agencyId,
    p_plan_id: planId,
  });
  if (error) throw error;
  return data as StartTrialResult;
}

/** Pendant l'essai : bloqué côté base pour un non-admin si les frais d'installation changent. */
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
    p_trial_days: trialDays ?? 14,
  });
  if (error) throw error;
  return data as SignupSettings;
}
