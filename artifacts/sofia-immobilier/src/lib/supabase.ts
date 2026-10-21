import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const supabaseUrl = import.meta.env.VITE_SOFIA_PUBLIC_SUPABASE_URL as string | undefined;
const publishableKey = import.meta.env.VITE_SOFIA_PUBLIC_SUPABASE_KEY as string | undefined;

export const supabaseConfigured = Boolean(supabaseUrl && publishableKey);

let client: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (!supabaseUrl || !publishableKey) {
    throw new Error(
      'La connexion à Supabase n’est pas configurée. Les modules métier restent indisponibles.',
    );
  }

  if (!client) {
    client = createClient<Database>(supabaseUrl, publishableKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    });
  }

  return client;
}

export function getSupabaseErrorMessage(error: unknown, action = 'cette opération'): string {
  const candidate = error as { code?: string; message?: string } | null;
  const message = candidate?.message?.toLowerCase() ?? '';

  if (message.includes('invalid login credentials')) {
    return 'Adresse e-mail ou mot de passe incorrect.';
  }
  if (message.includes('email not confirmed')) {
    return 'Cette adresse e-mail n’a pas encore été confirmée.';
  }
  if (message.includes('violates check constraint')) {
    return `Impossible d’effectuer ${action} : une valeur refusée par la base de données (contrainte de validité). Vérifiez les champs saisis puis réessayez.`;
  }
  if (message.includes('failed to fetch') || message.includes('networkerror') || message.includes('fetch failed')) {
    return `Connexion réseau interrompue pendant ${action}. Vérifiez votre connexion Internet et réessayez.`;
  }
  if (candidate?.code === '42501' || message.includes('permission denied') || message.includes('row-level security')) {
    return 'Supabase a refusé l’accès aux données. Vérifiez votre rôle et les autorisations RLS de votre agence.';
  }
  if (candidate?.code === 'PGRST106' || message.includes('schema') && message.includes('not exposed')) {
    return 'Le schéma métier saas_immobilier n’est pas accessible via l’API Supabase.';
  }
  if (message.includes('jwt expired') || message.includes('session')) {
    return 'Votre session a expiré. Reconnectez-vous pour continuer.';
  }

  const detail = candidate?.message?.trim();
  return detail
    ? `Impossible d’effectuer ${action} : ${detail}`
    : `Impossible d’effectuer ${action}. Réessayez ou contactez l’administrateur de votre espace.`;
}
