-- =============================================================================
-- RETOUR ARRIÈRE — paiement manuel de bout en bout (2026-10-28)
-- Projet Supabase : xbuuhfwobrafcbgtdgjx   ·   schéma métier : saas_immobilier
-- Migration annulée : db/migrations/2026-10-28_paiement_manuel_bout_en_bout.sql
-- =============================================================================
-- À LIRE AVANT D'EXÉCUTER
-- -----------------------
-- Ce script annule la migration de facturation manuelle. Il est écrit pour être
-- exécuté UNE fois, dans une transaction, sur une base où la migration a été
-- appliquée. Il est volontairement PRUDENT :
--   · il refuse de s'exécuter si des données ne peuvent pas être conservées
--     (statuts ajoutés encore utilisés, champs NOT NULL devenus nuls) ;
--   · il ne supprime AUCUNE ligne de `payment_declarations` :
--     les demandes `awaiting_payment` resteraient sinon dans un état
--     incohérent ; le script échoue explicitement dans ce cas plutôt que de
--     perdre des données.
--
-- CE QUI EST RESTAURÉ
--   · les 3 fonctions historiques (agency_payment_access,
--     submit_payment_declaration, review_payment_declaration) — corps repris
--     à l'identique des migrations antérieures citées en commentaire ;
--   · les 3 politiques RLS supprimées par la migration
--     (agency_subscriptions_update_admin, agency_subscriptions_insert_admin,
--     payment_declarations_insert_member) ;
--   · les contraintes et NOT NULL d'origine sur payment_declarations et
--     agency_subscriptions.
--
-- CE QUI EST SUPPRIMÉ
--   · les RPC de la migration, le journal payment_decision_log, la tâche
--     pg_cron des rappels, les colonnes et index ajoutés.
--
-- CE QUI N'EST PAS ANNULÉ
--   · les enregistrements produits par des validations déjà effectuées
--     (lignes de `subscription_payments`, prolongations d'abonnement,
--     notifications). Les annuler reviendrait à effacer des encaissements
--     réels : à traiter manuellement, décision par décision.
-- =============================================================================

BEGIN;

-- #############################################################################
-- §1  Garde-fous : rien ne doit être perdu
-- #############################################################################
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM saas_immobilier.payment_declarations
              WHERE status IN ('awaiting_payment', 'correction_requested', 'cancelled', 'expired')) THEN
    RAISE EXCEPTION
      'Retour arrière impossible : des demandes utilisent des statuts introduits '
      'par la migration (awaiting_payment / correction_requested / cancelled / expired). '
      'Traitez-les (annulation ou décision) avant de revenir en arrière.';
  END IF;

  IF EXISTS (SELECT 1 FROM saas_immobilier.payment_declarations
              WHERE status IN ('pending', 'approved')
                AND (method IS NULL OR transaction_reference IS NULL OR paid_on IS NULL)) THEN
    RAISE EXCEPTION
      'Retour arrière impossible : des déclarations soumises ont des champs '
      '(method / transaction_reference / paid_on) nuls, qui étaient NOT NULL avant la migration.';
  END IF;

  IF EXISTS (SELECT 1 FROM saas_immobilier.agency_subscriptions WHERE status = 'pending') THEN
    RAISE EXCEPTION
      'Retour arrière impossible : des abonnements utilisent le statut ''pending'' ajouté par la migration.';
  END IF;
END
$guard$;

-- #############################################################################
-- §2  Planification
-- #############################################################################
SELECT cron.unschedule('sofia-billing-reminders')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sofia-billing-reminders');

-- #############################################################################
-- §3  Fonctions ajoutées par la migration
-- #############################################################################
DROP FUNCTION IF EXISTS public.admin_save_payment_methods(jsonb, boolean, text);
DROP FUNCTION IF EXISTS public.admin_review_payment(uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_payment_detail(uuid);
DROP FUNCTION IF EXISTS public.admin_payment_queue(text[], uuid, text, date, date, text, integer, integer);
DROP FUNCTION IF EXISTS public.agency_cancel_payment_request(uuid, text);
DROP FUNCTION IF EXISTS public.agency_submit_payment_proof(uuid, text, numeric, text, date, text, text, text, bigint, boolean);
DROP FUNCTION IF EXISTS public.agency_create_payment_request(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.billing_run_reminders();
DROP FUNCTION IF EXISTS saas_immobilier.payment_config();
DROP FUNCTION IF EXISTS saas_immobilier.normalize_payment_config(jsonb);
DROP FUNCTION IF EXISTS saas_immobilier.notify_agency(uuid, text, text, text, jsonb, text);

-- #############################################################################
-- §4  Journal des décisions
-- #############################################################################
DROP TABLE IF EXISTS saas_immobilier.payment_decision_log;

-- #############################################################################
-- §5  Index ajoutés
-- #############################################################################
DROP INDEX IF EXISTS saas_immobilier.subscription_payments_declaration_uniq;
DROP INDEX IF EXISTS saas_immobilier.payment_declarations_one_pending_per_agency;
DROP INDEX IF EXISTS saas_immobilier.payment_declarations_txn_ref_uniq;
DROP INDEX IF EXISTS saas_immobilier.payment_declarations_reference_uniq;
DROP INDEX IF EXISTS saas_immobilier.payment_declarations_agency_status_idx;
DROP INDEX IF EXISTS saas_immobilier.payment_declarations_status_created_idx;

-- #############################################################################
-- §6  Colonnes ajoutées à payment_declarations
-- #############################################################################
ALTER TABLE saas_immobilier.payment_declarations
  DROP COLUMN IF EXISTS transaction_reference_norm,
  DROP COLUMN IF EXISTS reference,
  DROP COLUMN IF EXISTS plan_id,
  DROP COLUMN IF EXISTS plan_name_snapshot,
  DROP COLUMN IF EXISTS expected_amount,
  DROP COLUMN IF EXISTS duration_months,
  DROP COLUMN IF EXISTS payer_name,
  DROP COLUMN IF EXISTS proof_mime,
  DROP COLUMN IF EXISTS proof_size,
  DROP COLUMN IF EXISTS proof_uploaded_at,
  DROP COLUMN IF EXISTS submitted_at,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancel_reason;

-- #############################################################################
-- §7  NOT NULL et contraintes d'origine
-- #############################################################################
ALTER TABLE saas_immobilier.payment_declarations
  ALTER COLUMN method                SET NOT NULL,
  ALTER COLUMN transaction_reference SET NOT NULL,
  ALTER COLUMN paid_on               SET NOT NULL;

ALTER TABLE saas_immobilier.payment_declarations
  DROP CONSTRAINT IF EXISTS payment_declarations_submitted_fields_check;
ALTER TABLE saas_immobilier.payment_declarations
  DROP CONSTRAINT IF EXISTS payment_declarations_status_check;
ALTER TABLE saas_immobilier.payment_declarations
  ADD CONSTRAINT payment_declarations_status_check
  CHECK (status IN ('pending', 'approved', 'rejected'));

-- Le montant d'un paiement est strictement positif (sémantique d'avant migration).
ALTER TABLE saas_immobilier.payment_declarations
  DROP CONSTRAINT IF EXISTS payment_declarations_amount_check;
ALTER TABLE saas_immobilier.payment_declarations
  ADD CONSTRAINT payment_declarations_amount_check CHECK (amount > 0);

ALTER TABLE saas_immobilier.agency_subscriptions
  DROP CONSTRAINT IF EXISTS agency_subscriptions_status_check;
ALTER TABLE saas_immobilier.agency_subscriptions
  ADD CONSTRAINT agency_subscriptions_status_check
  CHECK (status IN ('trial', 'active', 'past_due', 'expired', 'suspended', 'cancelled'));

-- #############################################################################
-- §8  Politiques RLS supprimées par la migration — rétablies
-- #############################################################################
-- Les définitions d'origine n'étaient pas versionnées dans db/migrations ;
-- celles rétablies ci-dessous reproduisent la sémantique documentée au §6 de la
-- migration (un gestionnaire d'agence pouvait écrire sa propre ligne).
DROP POLICY IF EXISTS agency_subscriptions_update_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_update_admin
  ON saas_immobilier.agency_subscriptions
  FOR UPDATE
  USING (public.has_agency_role(agency_id, 'admin'))
  WITH CHECK (public.has_agency_role(agency_id, 'admin'));

DROP POLICY IF EXISTS agency_subscriptions_insert_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_insert_admin
  ON saas_immobilier.agency_subscriptions
  FOR INSERT
  WITH CHECK (public.has_agency_role(agency_id, 'admin'));

DROP POLICY IF EXISTS payment_declarations_insert_member ON saas_immobilier.payment_declarations;
CREATE POLICY payment_declarations_insert_member
  ON saas_immobilier.payment_declarations
  FOR INSERT
  WITH CHECK (public.is_agency_member(agency_id));

-- #############################################################################
-- §9  Fonctions historiques restaurées (corps d'origine)
-- #############################################################################
-- Les trois remplacements ci-dessous sont repris mot pour mot des migrations
-- antérieures. Ils réintroduisent volontairement les limites connues :
--   · agency_payment_access ne renvoie ni `payment_config` normalisé ni `plans` ;
--   · submit_payment_declaration n'impose ni le montant attendu, ni la
--     référence unique, ni la configuration des moyens de paiement ;
--   · review_payment_declaration ne rejoue pas la validation de montant.
-- C'est exactement l'état d'avant migration.

-- ---------------------------------------------------------------------------
-- 9.1 agency_payment_access (corps d'origine — 2026-10-21_bloc1-2_paiements_admin.sql)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_payment_access(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_sub        record;
  v_plan       record;
  v_pay        jsonb;
  v_bill       jsonb;
  v_grace      integer;
  v_decls      jsonb;
  v_is_manager boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;

  -- Le rôle sert uniquement à l'affichage côté client : la RLS reste la vérité.
  v_is_manager := public.has_agency_role(p_agency_id, 'admin');

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_grace IS NULL THEN v_grace := 5; END IF;

  SELECT COALESCE(value, '{}'::jsonb) INTO v_pay
    FROM saas_immobilier.platform_settings WHERE key = 'payment_instructions';
  IF v_pay IS NULL THEN v_pay := '{}'::jsonb; END IF;

  SELECT s.id, s.status, s.starts_at, s.ends_at, s.trial_ends_at, s.plan_id
    INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY (s.status = 'active') DESC, s.created_at DESC
   LIMIT 1;

  IF v_sub.id IS NOT NULL THEN
    SELECT p.id, p.name, p.display_name, p.price_monthly, p.setup_fee, p.currency
      INTO v_plan
      FROM saas_immobilier.plans p WHERE p.id = v_sub.plan_id;
  END IF;

  v_bill := public.agency_billing_state(p_agency_id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', d.id,
           'amount', d.amount,
           'currency', d.currency,
           'method', d.method,
           'transaction_reference', d.transaction_reference,
           'paid_on', d.paid_on,
           'status', d.status,
           'note', d.note,
           'review_note', d.review_note,
           'reviewed_at', d.reviewed_at,
           'created_at', d.created_at,
           'has_proof', (d.proof_path IS NOT NULL)
         ) ORDER BY d.created_at DESC), '[]'::jsonb)
    INTO v_decls
    FROM saas_immobilier.payment_declarations d
   WHERE d.agency_id = p_agency_id;

  RETURN jsonb_build_object(
    'can_manage',       v_is_manager,
    'instructions',     v_pay,
    'grace_days',       v_grace,
    'billing',          v_bill,
    'subscription',     CASE WHEN v_sub.id IS NULL THEN NULL ELSE jsonb_build_object(
                            'id', v_sub.id, 'status', v_sub.status,
                            'starts_at', v_sub.starts_at, 'ends_at', v_sub.ends_at,
                            'trial_ends_at', v_sub.trial_ends_at) END,
    'plan',             CASE WHEN v_plan.id IS NULL THEN NULL ELSE jsonb_build_object(
                            'id', v_plan.id, 'name', v_plan.name,
                            'display_name', v_plan.display_name,
                            'price_monthly', v_plan.price_monthly,
                            'setup_fee', v_plan.setup_fee,
                            'currency', v_plan.currency) END,
    'expected_amount',  COALESCE(v_plan.price_monthly, 0),
    'declarations',     v_decls
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.agency_payment_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_payment_access(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9.2 submit_payment_declaration (corps d'origine — 2026-10-20_lot_a.sql)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_payment_declaration(
  p_agency_id uuid, p_amount numeric, p_method text,
  p_transaction_reference text, p_paid_on date, p_proof_path text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'accès agence refusé' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;
  IF p_method NOT IN ('orange_money','wave') THEN
    RAISE EXCEPTION 'moyen de paiement invalide' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_transaction_reference,'')) = '' THEN
    RAISE EXCEPTION 'référence de transaction obligatoire' USING ERRCODE = '22023';
  END IF;

  INSERT INTO saas_immobilier.payment_declarations
    (agency_id, amount, method, transaction_reference, paid_on, proof_path, declared_by)
  VALUES (p_agency_id, p_amount, p_method, btrim(p_transaction_reference),
          COALESCE(p_paid_on, CURRENT_DATE), NULLIF(btrim(COALESCE(p_proof_path,'')),''), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 9.3 review_payment_declaration (corps d'origine — 2026-10-21_session3_bloc1_bugs_systeme.sql)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.review_payment_declaration(
  p_declaration_id uuid, p_decision text, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_dec record; v_sub record; v_payment uuid;
  v_start date; v_end date; v_plan uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'decision invalide' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_dec FROM saas_immobilier.payment_declarations
   WHERE id = p_declaration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'declaration introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_dec.status <> 'pending' THEN
    RAISE EXCEPTION 'declaration deja traitee' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'rejected' THEN
    UPDATE saas_immobilier.payment_declarations
       SET status='rejected', reviewed_by=auth.uid(), reviewed_at=now(), review_note=p_note
     WHERE id = p_declaration_id;
    RETURN NULL;
  END IF;

  SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions
   WHERE agency_id = v_dec.agency_id
   ORDER BY (status='active') DESC, created_at DESC LIMIT 1 FOR UPDATE;

  -- BLOC 1 (bug n°3) : au lieu de lever une exception, on crée l'abonnement.
  IF NOT FOUND THEN
    SELECT a.pending_plan_id INTO v_plan
      FROM saas_immobilier.agencies a WHERE a.id = v_dec.agency_id;
    IF v_plan IS NULL THEN
      SELECT pl.id INTO v_plan FROM saas_immobilier.plans pl
       ORDER BY pl.price_monthly ASC LIMIT 1;
    END IF;
    IF v_plan IS NULL THEN
      RAISE EXCEPTION 'aucune offre disponible dans le catalogue' USING ERRCODE = '22023';
    END IF;
    INSERT INTO saas_immobilier.agency_subscriptions
      (agency_id, plan_id, status, starts_at, ends_at)
    VALUES (v_dec.agency_id, v_plan, 'active', CURRENT_DATE,
            (CURRENT_DATE + interval '1 month')::date)
    RETURNING * INTO v_sub;
  END IF;

  v_start := CURRENT_DATE;
  v_end   := (GREATEST(COALESCE(v_sub.ends_at, now())::date, CURRENT_DATE) + interval '1 month')::date;

  INSERT INTO saas_immobilier.subscription_payments
    (agency_id, subscription_id, amount, currency, paid_at, period_start, period_end,
     method, recorded_by, note, declaration_id)
  VALUES (v_dec.agency_id, v_sub.id, v_dec.amount, v_dec.currency, v_dec.paid_on,
          v_start, v_end, 'manual', auth.uid(), p_note, v_dec.id)
  RETURNING id INTO v_payment;

  UPDATE saas_immobilier.agency_subscriptions
     SET ends_at = v_end, status = 'active', trial_ends_at = NULL
   WHERE id = v_sub.id;

  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL
   WHERE id = v_dec.agency_id AND status IN ('suspended','pending');

  IF FOUND THEN
    INSERT INTO saas_immobilier.activity_log (agency_id, user_id, action, entity_type, entity_id, summary)
    VALUES (v_dec.agency_id, auth.uid(), 'agency_reactivated', 'agency', v_dec.agency_id,
            'Agence reactivee apres validation du paiement ' || v_payment);
  END IF;

  UPDATE saas_immobilier.payment_declarations
     SET status='approved', reviewed_by=auth.uid(), reviewed_at=now(),
         review_note=p_note, payment_id=v_payment
   WHERE id = p_declaration_id;

  RETURN v_payment;
END
$fn$;

-- Droits d'exécution identiques à l'état d'avant migration
-- (cf. 2026-10-21_bloc10_gardes_isolation.sql).
REVOKE ALL ON FUNCTION public.agency_payment_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_payment_access(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.submit_payment_declaration(uuid, numeric, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_payment_declaration(uuid, numeric, text, text, date, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.review_payment_declaration(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_payment_declaration(uuid, text, text) TO authenticated, service_role;

-- #############################################################################
-- §10  Contrôles
-- #############################################################################
DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (
       'admin_review_payment', 'admin_payment_queue', 'admin_payment_detail',
       'agency_create_payment_request', 'agency_submit_payment_proof',
       'agency_cancel_payment_request', 'admin_save_payment_methods',
       'billing_run_reminders')
  ) THEN
    RAISE EXCEPTION 'retour arrière incomplet : des RPC de la migration existent encore';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'saas_immobilier'
                AND table_name = 'payment_declarations'
                AND column_name IN ('reference', 'expected_amount', 'duration_months',
                                    'transaction_reference_norm', 'submitted_at')) THEN
    RAISE EXCEPTION 'retour arrière incomplet : colonnes de la migration toujours présentes';
  END IF;

  IF to_regclass('saas_immobilier.payment_decision_log') IS NOT NULL THEN
    RAISE EXCEPTION 'retour arrière incomplet : payment_decision_log existe encore';
  END IF;
END
$chk$;

COMMIT;

-- =============================================================================
-- APRÈS LE RETOUR ARRIÈRE
-- =============================================================================
-- 1. Le code du frontend livré avec la migration (src/lib/billing-api.ts,
--    pages/subscription*.tsx, pages/admin/billing.tsx, panneau de réglages
--    des moyens de paiement) appelle les RPC supprimées : il faut revenir au
--    commit précédent du frontend, sinon les écrans de facturation échouent
--    proprement (message d'erreur) mais restent inutilisables.
-- 2. La tâche pg_cron `sofia-billing-reminders` n'existe plus : plus aucun
--    rappel d'échéance n'est envoyé automatiquement.
-- 3. `public.is_platform_admin()` n'est PAS modifié par ce script : le
--    durcissement des droits admin est une migration distincte
--    (2026-10-28_paiement_manuel_durcissement_admin.sql), à annuler séparément
--    et volontairement (l'annuler réintroduit l'élévation de privilèges).
-- =============================================================================
