// =============================================================================
// STAGING SASPAY — suite de tests isolee (PostgreSQL local via PGlite).
// Charge : baseline (miroir production) -> fonctions production extraites ->
// fonctions du depot -> MIGRATION SasPay -> scenarios.
// Aucun reseau, aucune donnee reelle, aucun impact production.
//
//   node db/staging/run-tests.mjs
// =============================================================================
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const A1 = 'aaaaaaa1-0000-0000-0000-000000000001'; // pending, offre choisie
const A2 = 'aaaaaaa1-0000-0000-0000-000000000002'; // active, Pro
const A3 = 'aaaaaaa1-0000-0000-0000-000000000003'; // essai valide
const A4 = 'aaaaaaa1-0000-0000-0000-000000000004'; // tierce agence
const A5 = 'aaaaaaa1-0000-0000-0000-000000000005'; // cree en cours (essai unique)
const PLAN_STARTER = '4f457a46-b1b2-407f-9c75-30347d6d9ae0';
const PLAN_ENTERPRISE = 'b7a4ea74-7de5-4b99-9dd6-86bf9b03247a';
const OWNER = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const OUTSIDER = '44444444-4444-4444-4444-444444444444';
const ADMIN = '99999999-9999-9999-9999-999999999999';
const SESSION1 = 'dddddddd-0000-0000-0000-000000000001';
const SESSION2 = 'dddddddd-0000-0000-0000-000000000002';
const SESSION4 = 'dddddddd-0000-0000-0000-000000000004';

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, label, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  KO  ${label}${extra ? ` — ${extra}` : ''}`);
  }
}
async function expectError(promise, substr, label) {
  try {
    const r = await promise;
    ok(false, label, `aucune erreur, resultat=${JSON.stringify(r)}`);
  } catch (e) {
    const msg = String(e.message ?? e);
    ok(msg.includes(substr), label, `erreur: ${msg}`);
  }
}

const db = new PGlite();
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;

async function asUser(uid, role = 'authenticated') {
  await db.query(
    `SELECT set_config('request.jwt.claim.sub', $1, false),
            set_config('request.jwt.claim.role', $2, false)`,
    [uid, role],
  );
}
const asService = () => asUser('', 'service_role');
const asAnon = () => asUser('', 'anon');
const asPostgres = () => asUser('', '');

console.log('== Chargement du staging (miroir production) ==');
await db.exec(read('db/staging/baseline.sql'));
await db.exec(read('db/staging/baseline-prod-functions.sql'));
const extracted = execFileSync(process.execPath, [join(here, 'extract-functions.mjs')], {
  encoding: 'utf8',
});
await db.exec(extracted.slice(extracted.indexOf('\n') + 1));
console.log('== Application de la migration SasPay (staging) ==');
await db.exec(read('db/migrations/2026-11-03_saspay_paiements_en_ligne.sql'));

// -----------------------------------------------------------------------------
console.log('\n-- SETUP : intention d installation (agence en attente)');
await asUser(OWNER);
const c1 = await one(`SELECT public.saspay_create_checkout($1,'setup',NULL,NULL) AS r`, [A1]);
ok(c1.r.reused === false, 'T01 premiere creation setup');
ok(Number(c1.r.amount) === 350000, 'T02 montant = installation 250000 + 1er mois 100000', String(c1.r.amount));
ok(c1.r.currency === 'XOF', 'T03 devise XOF');
const pay1 = c1.r.payment_id;
ok(Boolean(pay1), 'T04 payment_id renvoye');
const c1b = await one(`SELECT public.saspay_create_checkout($1,'setup',NULL,NULL) AS r`, [A1]);
ok(c1b.r.reused === true && c1b.r.payment_id === pay1, 'T05 doublon setup reutilise (pas de 2e checkout)');
const openSetup = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.online_payments
    WHERE agency_id=$1 AND purpose='setup' AND status='pending'`, [A1]);
ok(openSetup.n === 1, 'T06 une seule intention setup ouverte', String(openSetup.n));

console.log('\n-- ATTACH : session SasPay (service_role seul)');
await asService();
const att = await one(
  `SELECT public.saspay_attach_checkout($1,$2,$3,NULL) AS r`, [pay1, SESSION1, 'https://pay.saspay.me/checkout/TEST1']);
ok(att.r.already_attached === false && att.r.checkout_session_id === SESSION1, 'T07 attach initiale');
const att2 = await one(
  `SELECT public.saspay_attach_checkout($1,$2,$3,NULL) AS r`, [pay1, SESSION2, 'https://pay.saspay.me/checkout/TEST2']);
ok(att2.r.already_attached === true && att2.r.checkout_session_id === SESSION1,
  'T08 re-attach refusee : session initiale conservee');
await db.query(`SET ROLE authenticated`);
await asUser(OWNER);
await expectError(
  db.query(`SELECT public.saspay_attach_checkout($1,$2,$3,NULL)`, [pay1, SESSION1, 'x']),
  'permission denied',
  'T09 attach interdite aux utilisateurs (service_role seul)');
await db.query(`RESET ROLE`);

console.log('\n-- CONFIRM : barriere de montant + idempotence (setup)');
await asService();
const badAmount = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-1',$4,NULL) AS r`,
  [pay1, SESSION1, 'eeeeeeee-0000-0000-0000-000000000001', 100000]);
ok(badAmount.r.status === 'failed', 'T10 montant different -> echec, aucun credit', JSON.stringify(badAmount.r));
let row = await one(`SELECT status, fail_reason FROM saas_immobilier.online_payments WHERE id=$1`, [pay1]);
ok(row.status === 'failed' && String(row.fail_reason).includes('amount_mismatch'),
  'T11 echec amount_mismatch trace', row.fail_reason ?? '');
const good = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-1',$4,NULL) AS r`,
  [pay1, SESSION1, 'eeeeeeee-0000-0000-0000-000000000001', 350000]);
ok(good.r.status === 'paid' && good.r.requires_admin_validation === true,
  'T12 paiement setup confirme, validation admin requise', JSON.stringify(good.r));
ok(good.r.effects_applied === false, 'T13 setup : aucun encaissement automatique');
let nPay = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments WHERE online_payment_id=$1`, [pay1]);
ok(nPay.n === 0, 'T14 setup : 0 encaissement avant validation admin');
const again = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-1',$4,NULL) AS r`,
  [pay1, SESSION1, 'eeeeeeee-0000-0000-0000-000000000001', 350000]);
ok(again.r.already_processed === true && again.r.effects_applied === false,
  'T15 re-confirm idempotent (webhook rejoue)');
nPay = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments WHERE online_payment_id=$1`, [pay1]);
ok(nPay.n === 0, 'T16 toujours 0 encaissement apres re-confirm');

console.log('\n-- ACTIVATION ADMIN apres paiement en ligne confirme');
await asUser(ADMIN);
const act = await one(`SELECT public.admin_activate_pending_agency_paid($1) AS r`, [A1]);
ok(Number(act.r.encaisse) === 350000, 'T17 activation + encaisse 350000', JSON.stringify(act.r));
let ag = await one(`SELECT status FROM saas_immobilier.agencies WHERE id=$1`, [A1]);
ok(ag.status === 'active', 'T18 agence activee', ag.status);
nPay = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments WHERE online_payment_id=$1`, [pay1]);
ok(nPay.n === 1, 'T19 exactement UN encaissement rattache', String(nPay.n));
row = await one(`SELECT reconciled_at FROM saas_immobilier.online_payments WHERE id=$1`, [pay1]);
ok(row.reconciled_at != null, 'T20 intention marquee rapprochee');
await expectError(
  db.query(`SELECT public.admin_activate_pending_agency_paid($1)`, [A1]),
  'plus en attente',
  'T21 double activation refusee (agence deja activee)');
await asService();
await expectError(
  db.query(`INSERT INTO saas_immobilier.subscription_payments
            (agency_id, subscription_id, amount, online_payment_id)
            SELECT agency_id, subscription_id, amount, id FROM saas_immobilier.online_payments WHERE id=$1`, [pay1]),
  'duplicate key',
  'T22 barriere unique online_payment_id sur subscription_payments');

console.log('\n-- GARDES : roles et essai 14 jours');
await asUser(AGENT);
await expectError(
  db.query(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL)`, [A2]),
  'administrateur',
  'T23 un agent ne peut pas creer un paiement');
await asUser(OUTSIDER);
await expectError(
  db.query(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL)`, [A2]),
  'acces agence refuse',
  'T24 hors-agence bloque');
await asUser(OWNER);
await expectError(
  db.query(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL)`, [A3]),
  'essai gratuit en cours',
  'T25 pas de renouvellement pendant l essai valide (essai preserve)');
await asAnon();
await expectError(
  db.query(`SELECT public.saspay_create_checkout($1,'setup',NULL,NULL)`, [A1]),
  'authentification requise',
  'T26 jeton absent refuse');
await asUser(OWNER);
await expectError(
  db.query(`SELECT public.saspay_create_checkout($1,'bidule',NULL,NULL)`, [A2]),
  'objectif de paiement invalide',
  'T27 objectif inconnu refuse');

console.log('\n-- ESSAI UNIQUE 14 JOURS (regle existante preservee)');
await asPostgres();
await one(
  `INSERT INTO saas_immobilier.agencies (id, name, slug, status, country)
   VALUES ($1, 'Agence Essai Unique', 'agence-essai-unique', 'pending', 'ML')`, [A5]);
await one(
  `INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role)
   VALUES ($1, $2, 'owner')`, [A5, OWNER]);
await one(`UPDATE saas_immobilier.platform_settings
             SET value = jsonb_set(value, '{require_admin_validation}', 'false')
             WHERE key = 'signup'`);
await asUser(OWNER);
const tr = await one(`SELECT public.agency_start_trial($1,$2) AS r`, [A5, PLAN_STARTER]);
ok(tr.r.mode === 'trial' && Number(tr.r.trial_days) === 14,
  'T28 essai de 14 jours cree', JSON.stringify(tr.r));
await expectError(
  db.query(`SELECT public.agency_start_trial($1,$2)`, [A5, PLAN_STARTER]),
  'essai deja utilise',
  'T29 essai UNIQUE : second essai refuse');
await asPostgres();
await one(`UPDATE saas_immobilier.platform_settings
             SET value = jsonb_set(value, '{require_admin_validation}', 'true')
             WHERE key = 'signup'`);

console.log('\n-- RENOUVELLEMENT : encaisse + prolongation + journal');
await asUser(OWNER);
const r1 = await one(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL) AS r`, [A2]);
ok(r1.r.reused === false && Number(r1.r.amount) === 100000,
  'T30 creation renouvellement au prix de l offre', JSON.stringify(r1.r));
const pay2 = r1.r.payment_id;
await asService();
await one(`SELECT public.saspay_attach_checkout($1,$2,$3,NULL)`, [pay2, SESSION2, 'https://pay.saspay.me/checkout/TEST3']);
const before = await one(
  `SELECT s.ends_at FROM saas_immobilier.agency_subscriptions s
    WHERE s.agency_id=$1 ORDER BY (s.status='active') DESC, s.created_at DESC LIMIT 1`, [A2]);
const rc = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-2',$4,NULL) AS r`,
  [pay2, SESSION2, 'eeeeeeee-0000-0000-0000-000000000002', 100000]);
ok(rc.r.effects_applied === true && rc.r.purpose === 'renewal',
  'T31 renouvellement confirme avec effets', JSON.stringify(rc.r));
const after = await one(
  `SELECT s.ends_at, s.status FROM saas_immobilier.agency_subscriptions s
    WHERE s.agency_id=$1 ORDER BY (s.status='active') DESC, s.created_at DESC LIMIT 1`, [A2]);
ok(new Date(after.ends_at) > new Date(before.ends_at),
  'T32 echeance prolongee', `${before.ends_at} -> ${after.ends_at}`);
nPay = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments
    WHERE online_payment_id=$1 AND method='saspay'`, [pay2]);
ok(nPay.n === 1, 'T33 UN encaissement saspay', String(nPay.n));
const ev = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_events
    WHERE agency_id=$1 AND event_type='payment_validated' AND payment_id IS NOT NULL`, [A2]);
ok(ev.n >= 1, 'T34 journal payment_validated ecrit', String(ev.n));
const notif = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.notifications WHERE agency_id=$1`, [A2]);
ok(notif.n >= 1, 'T35 proprietaire notifie du paiement');
const rc2 = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-2',$4,NULL) AS r`,
  [pay2, SESSION2, 'eeeeeeee-0000-0000-0000-000000000002', 100000]);
ok(rc2.r.already_processed === true, 'T36 double webhook renouvellement idempotent');
nPay = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments WHERE online_payment_id=$1`, [pay2]);
ok(nPay.n === 1, 'T37 toujours 1 encaissement (pas de double)', String(nPay.n));

console.log('\n-- GRACE 5 JOURS, suspension, puis paiement qui reactive');
await asPostgres();
await one(
  `INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at, ends_at)
   VALUES ($1, $2, 'active', now() - interval '40 days', now() - interval '2 days')`, [A4, PLAN_STARTER]);
await asUser(OUTSIDER);
const r4 = await one(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL) AS r`, [A4]);
ok(r4.r.reused === false && Number(r4.r.amount) === 50000,
  'T38 intention de renouvellement creee dans la grace', JSON.stringify(r4.r));
const pay4 = r4.r.payment_id;
await asService();
await one(`SELECT public.saspay_attach_checkout($1,$2,$3,NULL)`, [pay4, SESSION4, 'https://pay.saspay.me/checkout/TEST4']);
await asPostgres();
let susp = await one(`SELECT public.suspend_overdue_agencies() AS n`);
ok(susp.n === 0, 'T39 dans la grace (2 j) : aucune suspension', String(susp.n));
await one(`UPDATE saas_immobilier.agency_subscriptions
             SET ends_at = now() - interval '6 days' WHERE agency_id=$1`, [A4]);
susp = await one(`SELECT public.suspend_overdue_agencies() AS n`);
ok(susp.n === 1, 'T40 hors grace (6 j) : suspension automatique', String(susp.n));
ag = await one(`SELECT status, suspended_reason FROM saas_immobilier.agencies WHERE id=$1`, [A4]);
ok(ag.status === 'suspended' && ag.suspended_reason === 'unpaid',
  'T41 statut suspendu / impaye', `${ag.status}/${ag.suspended_reason}`);
// L intention creee avant la suspension se confirme : l argent est entre.
await asService();
const rc4 = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-4',$4,NULL) AS r`,
  [pay4, SESSION4, 'eeeeeeee-0000-0000-0000-000000000004', 50000]);
ok(rc4.r.effects_applied === true, 'T42 paiement confirme malgre la suspension', JSON.stringify(rc4.r));
ag = await one(`SELECT status, suspended_reason FROM saas_immobilier.agencies WHERE id=$1`, [A4]);
ok(ag.status === 'active' && ag.suspended_reason == null,
  'T43 agence reactivee par le paiement (impaye)', `${ag.status}/${ag.suspended_reason}`);

console.log('\n-- CHANGEMENT D OFFRE : facture au prorata payee en ligne');
await asUser(ADMIN);
const ch = await one(
  `SELECT public.admin_change_agency_plan_journaled($1,$2,CURRENT_DATE,'test',NULL) AS r`, [A2, PLAN_ENTERPRISE]);
ok(ch.r.changed === true && Number(ch.r.invoice_amount) > 0,
  'T44 changement d offre -> facture prorata', JSON.stringify({ id: ch.r.invoice_id, amount: ch.r.invoice_amount }));
const invId = ch.r.invoice_id;
await asUser(OWNER);
const ci = await one(
  `SELECT public.saspay_create_checkout($1,'invoice',NULL,$2) AS r`, [A2, invId]);
ok(ci.r.reused === false && Number(ci.r.amount) === Number(ch.r.invoice_amount),
  'T45 checkout facture au montant exact', JSON.stringify(ci.r));
const pay5 = ci.r.payment_id;
const ci2 = await one(
  `SELECT public.saspay_create_checkout($1,'invoice',NULL,$2) AS r`, [A2, invId]);
ok(ci2.r.reused === true && ci2.r.payment_id === pay5, 'T46 doublon facture reutilise');
await asService();
await one(`SELECT public.saspay_attach_checkout($1,$2,$3,NULL)`,
  [pay5, 'dddddddd-0000-0000-0000-000000000005', 'https://pay.saspay.me/checkout/TEST5']);
const rc5 = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-5',$4,NULL) AS r`,
  [pay5, 'dddddddd-0000-0000-0000-000000000005', 'eeeeeeee-0000-0000-0000-000000000005',
   Number(ch.r.invoice_amount)]);
ok(rc5.r.effects_applied === true && rc5.r.invoice_id === invId,
  'T47 facture payee en ligne', JSON.stringify(rc5.r));
let inv = await one(`SELECT status, paid_payment_id FROM saas_immobilier.subscription_invoices WHERE id=$1`, [invId]);
ok(inv.status === 'paid' && inv.paid_payment_id != null, 'T48 facture marquee payee', inv.status);
const rc5b = await one(
  `SELECT public.saspay_confirm_payment($1,$2,'paid',$3,'TXN-5',$4,NULL) AS r`,
  [pay5, 'dddddddd-0000-0000-0000-000000000005', 'eeeeeeee-0000-0000-0000-000000000005',
   Number(ch.r.invoice_amount)]);
ok(rc5b.r.already_processed === true, 'T49 double webhook facture idempotent');
inv = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments WHERE invoice_id=$1`, [invId]);
ok(inv.n === 1, 'T50 un seul encaissement sur la facture', String(inv.n));

console.log('\n-- CHEMIN MANUEL Orange Money / Wave : conserve + corrige');
await asUser(OWNER);
const decl = await one(
  `SELECT public.submit_payment_declaration($1, $2, 'wave', 'MANUAL-TEST-1', CURRENT_DATE, '') AS id`,
  [A2, 150000]);
ok(Boolean(decl.id), 'T51 declaration manuelle acceptee', String(decl.id));
await expectError(
  db.query(`SELECT public.submit_payment_declaration($1, 1000, 'stripe', 'X', CURRENT_DATE, '')`, [A2]),
  'moyen de paiement invalide',
  'T52 moyen hors liste refuse (orange_money/wave seuleiment)');
let dRow = await one(`SELECT plan_id FROM saas_immobilier.payment_declarations WHERE id=$1`, [decl.id]);
ok(dRow.plan_id != null, 'T53 CORRECTIF : plan_id fige sur la declaration (validation possible)');
await asUser(ADMIN);
const rev = await one(
  `SELECT public.review_payment_declaration($1,'approved','ok') AS p`, [decl.id]);
ok(rev.p != null, 'T54 validation manuelle aboutit (bug « offre introuvable » corrige)', String(rev.p));
nPay = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.subscription_payments
    WHERE declaration_id=$1 AND method='wave'`, [decl.id]);
ok(nPay.n === 1, 'T55 encaissement manuel enregistre (method wave preservee)', String(nPay.n));

console.log('\n-- RLS : isolation des agences sur online_payments');
await asPostgres();
await one(`INSERT INTO saas_immobilier.saspay_webhook_events (event_type, signature, signature_ts, payload)
           VALUES ('transaction.success', 'sig-test', extract(epoch from now())::bigint, '{"event":"transaction.success"}'::jsonb)`);
await db.query(`SET ROLE authenticated`);
await asUser(OWNER);
let rls = await one(`SELECT count(*)::int AS n FROM saas_immobilier.online_payments WHERE agency_id=$1`, [A1]);
ok(rls.n >= 1, 'T56 membre : lit ses intentions', String(rls.n));
await asUser(OUTSIDER);
rls = await one(`SELECT count(*)::int AS n FROM saas_immobilier.online_payments WHERE agency_id=$1`, [A1]);
ok(rls.n === 0, 'T57 hors-agence : 0 ligne visible', String(rls.n));
await expectError(
  db.query(`UPDATE saas_immobilier.online_payments SET amount = 1 WHERE agency_id=$1`, [A1]),
  'permission denied',
  'T58 ecriture interdite au navigateur (SELECT seul)');
await expectError(
  db.query(`INSERT INTO saas_immobilier.saspay_webhook_events (event_type, payload) VALUES ('x','{}')`),
  'permission denied',
  'T59 boite webhooks en ecriture exclusive service_role');
await asUser(OUTSIDER);
rls = await one(`SELECT count(*)::int AS n FROM saas_immobilier.saspay_webhook_events`);
ok(rls.n === 0, 'T60 webhooks invisibles pour un non-admin', String(rls.n));
await asUser(ADMIN);
rls = await one(`SELECT count(*)::int AS n FROM saas_immobilier.saspay_webhook_events`);
ok(rls.n === 1, 'T61 webhooks visibles par l admin plateforme', String(rls.n));
await db.query(`RESET ROLE`);

console.log('\n-- Retour de paiement & factures cote agence');
await asUser(OWNER);
const st = await one(`SELECT public.saspay_payment_state($1) AS r`, [SESSION2]);
ok(st.r.found === true && st.r.status === 'paid', 'T62 etat accessible par session (retour)', JSON.stringify(st.r));
await asUser(OUTSIDER);
await expectError(
  db.query(`SELECT public.saspay_payment_state($1)`, [SESSION2]),
  'acces refuse',
  'T63 etat refuse hors-agence');
await asUser(OWNER);
const invs = await one(`SELECT public.agency_invoices($1) AS r`, [A2]);
ok(Array.isArray(invs.r) && invs.r.length >= 1 && invs.r[0].has_online_payment === true,
  'T64 factures de l agence lisibles + paiement en ligne marque', JSON.stringify(invs.r?.[0]));
await asUser(OUTSIDER);
await expectError(
  db.query(`SELECT public.agency_invoices($1)`, [A2]),
  'acces agence refuse',
  'T65 factures refusees hors-agence');

console.log('\n-- Expiration des intentions ouvertes');
await asPostgres();
await one(`UPDATE saas_immobilier.online_payments
             SET expires_at = now() - interval '1 minute'
           WHERE status='pending' AND agency_id=$1`, [A2]);
await asUser(OWNER);
const r6 = await one(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL) AS r`, [A2]);
ok(r6.r.reused === false, 'T66 intention creee', JSON.stringify(r6.r));
// Vieillir l intention ouverte puis en creer une autre : l ancienne perimee
// doit etre marquee expiree et il ne doit rester qu une intention ouverte.
await asPostgres();
await one(`UPDATE saas_immobilier.online_payments
             SET expires_at = now() - interval '1 minute'
           WHERE status='pending' AND agency_id=$1 AND purpose='renewal'`, [A2]);
await asUser(OWNER);
const r6b = await one(`SELECT public.saspay_create_checkout($1,'renewal',NULL,NULL) AS r`, [A2]);
ok(r6b.r.reused === false && r6b.r.payment_id !== r6.r.payment_id,
  'T66b nouvelle intention apres expiration', JSON.stringify(r6b.r));
const openR = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.online_payments
    WHERE agency_id=$1 AND purpose='renewal' AND status='pending'`, [A2]);
ok(openR.n === 1, 'T67 ancienne expiree, une seule ouverte', String(openR.n));
const exp = await one(
  `SELECT count(*)::int AS n FROM saas_immobilier.online_payments
    WHERE agency_id=$1 AND purpose='renewal' AND status='expired'`, [A2]);
ok(exp.n >= 1, 'T68 intention perimee marquee expiree', String(exp.n));

// -----------------------------------------------------------------------------
console.log(`\n== RESULTAT : ${passed} ok, ${failed} KO ==`);
if (failed > 0) {
  console.log('Echecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
await db.close();
