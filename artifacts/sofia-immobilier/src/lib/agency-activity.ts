// =============================================================================
// BLOC 4 — Traçabilité des modifications des informations de l'agence.
// =============================================================================
// Le trigger `activity_log_agencies` journalise déjà toute modification
// (« Agence « X » modifiée »). Cette couche ajoute une entrée PRÉCISE listant
// les champs réellement changés, pour que le journal d'activité soit exploitable.
// L'insertion respecte la politique existante `activity_log_insert_auth`.
// =============================================================================
import { getSupabaseClient } from './supabase';

const db = () => getSupabaseClient().schema('saas_immobilier');

export const AGENCY_FIELD_LABELS: Record<string, string> = {
  name: 'nom commercial',
  legal_name: 'raison sociale',
  phone: 'téléphone',
  email: 'e-mail',
  address: 'adresse',
  city: 'ville',
  country: 'pays',
  timezone: 'fuseau horaire',
  currency: 'devise',
  description: 'description',
  commission_rate: 'taux de commission vente',
  rental_commission_rate: 'taux de commission location',
  logo_url: 'logo',
};

type AgencySnapshot = Record<string, unknown> | null | undefined;

function normalize(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  return String(value).trim();
}

/**
 * Liste les libellés des champs dont la valeur change réellement.
 * Les champs absents de `after` (non fournis) sont ignorés.
 */
export function diffAgencyFields(before: AgencySnapshot, after: AgencySnapshot): string[] {
  if (!after) return [];
  const changed: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (value === undefined) continue;
    if (!(key in AGENCY_FIELD_LABELS)) continue;
    if (normalize(before?.[key]) !== normalize(value)) changed.push(AGENCY_FIELD_LABELS[key]);
  }
  return changed;
}

/**
 * Écrit une entrée de journal. Un échec de journalisation ne doit jamais faire
 * échouer l'enregistrement lui-même : la base journalise de toute façon via le
 * trigger.
 */
export async function traceAgencySettingsChange(
  agencyId: string | undefined,
  changed: string[],
): Promise<void> {
  if (!agencyId || !changed.length) return;
  const summary =
    changed.length === 1
      ? `Informations de l’agence modifiées : ${changed[0]}`
      : `Informations de l’agence modifiées : ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? '…' : ''}`;
  try {
    await db().from('activity_log').insert({
      agency_id: agencyId,
      user_id: null,
      action: 'updated',
      entity_type: 'agencies',
      entity_id: agencyId,
      summary,
      metadata: { fields: changed },
    });
  } catch {
    /* journalisation secondaire : on ignore volontairement */
  }
}
