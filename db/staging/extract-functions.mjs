// Extrait, depuis les migrations du depot, les DEFINITIONS de fonctions
// necessaires au staging (ordre chronologique : les CREATE OR REPLACE plus
// tardifs ecrasent les precedents, comme en production).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// [fichier, noms de fonctions retenus]
const SOURCES = [
  ['db/migrations/2026-10-20_lot_a.sql', ['suspend_overdue_agencies', 'reactivate_agency']],
  ['db/migrations/2026-10-21_bloc10_gardes_isolation.sql', ['agency_billing_state']],
  ['db/migrations/2026-10-21_bloc1-2_paiements_admin.sql', ['agency_payment_access']],
  ['db/migrations/2026-10-21_session2_bloc2_abonnement.sql', [
    'agency_select_pending_plan', 'agency_pending_state',
    'admin_activate_pending_agency', 'admin_reject_pending_agency', 'pending_agencies',
  ]],
  ['db/migrations/2026-10-21_session3_bloc1_bugs_systeme.sql', [
    'agency_plan_state', 'agency_current_plan', 'admin_assign_plan',
    'admin_change_agency_plan', 'admin_activate_agency',
  ]],
  ['db/migrations/2026-10-21_session3_bloc2_essai_gratuit.sql', [
    'agency_start_trial', 'admin_end_trial',
  ]],
  ['db/migrations/2026-10-26_session5_factures_journal.sql', [
    'subscription_prorata', 'subscription_reference',
    'admin_activate_agency_journaled', 'admin_change_agency_plan_journaled',
    'admin_validate_payment', 'admin_suspend_agency', 'admin_reactivate_agency',
    'admin_activate_pending_agency', 'admin_change_agency_plan',
  ]],
  ['db/migrations/2026-10-26_session5b_fix_validate_payment.sql', ['admin_validate_payment']],
];

/** Extrait un bloc CREATE OR REPLACE FUNCTION ... $tag$...$tag$; pour `name`. */
function extractFunction(sql, name) {
  const re = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public|saas_immobilier)\.${name}\s*\(`,
    'i',
  );
  const m = re.exec(sql);
  if (!m) return null;
  const start = m.index;
  // Cherche "AS $tag$" dans la declaration (l'espace peut etre un retour ligne)
  const head = sql.slice(start, start + 6000);
  const tagMatch = /\bAS\s+(\$(?:fn|function|body)\$)/.exec(head);
  if (!tagMatch) throw new Error(`dollar-quote introuvable pour ${name}`);
  const tag = tagMatch[1];
  const bodyStart = start + tagMatch.index + tagMatch[0].length - tag.length;
  const bodyEnd = sql.indexOf(tag + ';', bodyStart);
  if (bodyEnd < 0) throw new Error(`fin de corps introuvable pour ${name}`);
  return sql.slice(start, bodyEnd + tag.length + 1);
}

let out = '-- Extrait automatique des fonctions existantes (staging) — ne pas editer.\n';
let count = 0;
for (const [file, names] of SOURCES) {
  const sql = readFileSync(join(root, file), 'utf8');
  for (const name of names) {
    const def = extractFunction(sql, name);
    if (!def) {
      console.warn(`  [absent] ${name} dans ${file}`);
      continue;
    }
    out += `\n-- source : ${file}\n${def}\n`;
    count += 1;
  }
}
console.log(`extract-functions : ${count} fonctions extraites`);
process.stdout.write(out);
