-- =============================================================================
-- LOT 7 — Durcissement global de sécurité : RLS, privilèges RPC `SECURITY DEFINER`,
--         isolation inter-agences et protection anti-contournement
-- Date : 2026-11-05
-- Cible autorisée : Sofia Immobilier Lab (yswsildmbeomjlyofnrk)
-- Production (xbuuhfwobrafcbgtdgjx) : AUCUNE EXÉCUTION SANS VALIDATION EXPLICITE
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Garantie RLS activée sur 100 % des tables du schéma `saas_immobilier`
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl record;
BEGIN
  FOR v_tbl IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'saas_immobilier'
  LOOP
    EXECUTE format('ALTER TABLE saas_immobilier.%I ENABLE ROW LEVEL SECURITY', v_tbl.tablename);
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Politiques RLS complètes et strictement isolées par `agency_id` / rôle
-- -----------------------------------------------------------------------------

-- 2A. `platform_admins` : un utilisateur ne voit que sa propre ligne ; un admin voit l'équipe admin
GRANT SELECT ON saas_immobilier.platform_admins TO authenticated, service_role;
DROP POLICY IF EXISTS platform_admins_select_self_or_admin ON saas_immobilier.platform_admins;
CREATE POLICY platform_admins_select_self_or_admin
  ON saas_immobilier.platform_admins
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()) OR public.is_platform_admin());

-- 2B. `activity_log` : lecture isolée par agence (ou global pour admin plateforme), écriture membre actif uniquement
REVOKE UPDATE, DELETE, TRUNCATE ON saas_immobilier.activity_log FROM anon, authenticated;
GRANT SELECT, INSERT ON saas_immobilier.activity_log TO authenticated, service_role;

DROP POLICY IF EXISTS activity_log_select_isolated ON saas_immobilier.activity_log;
CREATE POLICY activity_log_select_isolated
  ON saas_immobilier.activity_log
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_admin()
    OR (agency_id IS NOT NULL AND public.is_agency_member(agency_id))
  );

DROP POLICY IF EXISTS activity_log_insert_member ON saas_immobilier.activity_log;
CREATE POLICY activity_log_insert_member
  ON saas_immobilier.activity_log
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_platform_admin()
    OR (
      agency_id IS NOT NULL
      AND public.is_agency_member(agency_id)
      AND (user_id IS NULL OR user_id = (SELECT auth.uid()))
    )
  );

-- 2C. `usage_events` : lecture & insertion isolées aux membres d'une agence active (`trial` ou `active`)
REVOKE UPDATE, DELETE, TRUNCATE ON saas_immobilier.usage_events FROM anon, authenticated;
GRANT SELECT, INSERT ON saas_immobilier.usage_events TO authenticated, service_role;

DROP POLICY IF EXISTS usage_events_select_isolated ON saas_immobilier.usage_events;
CREATE POLICY usage_events_select_isolated
  ON saas_immobilier.usage_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_admin()
    OR (agency_id IS NOT NULL AND public.is_agency_member(agency_id))
  );

DROP POLICY IF EXISTS usage_events_insert_member ON saas_immobilier.usage_events;
CREATE POLICY usage_events_insert_member
  ON saas_immobilier.usage_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
    agency_id IS NOT NULL
    AND public.is_agency_member(agency_id)
  );

-- 2D. Tables de facturation en LECTURE SEULE stricte côté client (`SELECT` uniquement ; 0 écriture directe)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  saas_immobilier.subscription_invoices,
  saas_immobilier.subscription_payments,
  saas_immobilier.subscription_events,
  saas_immobilier.online_payments,
  saas_immobilier.billing_notification_keys,
  saas_immobilier.billing_reconciliation_exceptions,
  saas_immobilier.billing_automation_runs,
  saas_immobilier.saspay_webhook_events
FROM anon, authenticated;

GRANT SELECT ON
  saas_immobilier.subscription_invoices,
  saas_immobilier.subscription_payments,
  saas_immobilier.subscription_events,
  saas_immobilier.payment_declarations
TO authenticated, service_role;

GRANT SELECT ON
  saas_immobilier.billing_reconciliation_exceptions,
  saas_immobilier.billing_automation_runs
TO authenticated, service_role;

DROP POLICY IF EXISTS subscription_invoices_select_isolated ON saas_immobilier.subscription_invoices;
CREATE POLICY subscription_invoices_select_isolated
  ON saas_immobilier.subscription_invoices
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin() OR public.billing_has_access(agency_id));

DROP POLICY IF EXISTS subscription_payments_select_isolated ON saas_immobilier.subscription_payments;
CREATE POLICY subscription_payments_select_isolated
  ON saas_immobilier.subscription_payments
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin() OR public.billing_has_access(agency_id));

DROP POLICY IF EXISTS subscription_events_select_isolated ON saas_immobilier.subscription_events;
CREATE POLICY subscription_events_select_isolated
  ON saas_immobilier.subscription_events
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin() OR public.billing_has_access(agency_id));

DROP POLICY IF EXISTS payment_declarations_select_isolated ON saas_immobilier.payment_declarations;
CREATE POLICY payment_declarations_select_isolated
  ON saas_immobilier.payment_declarations
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin() OR public.billing_has_access(agency_id));

DROP POLICY IF EXISTS billing_reconciliation_exceptions_admin_select ON saas_immobilier.billing_reconciliation_exceptions;
CREATE POLICY billing_reconciliation_exceptions_admin_select
  ON saas_immobilier.billing_reconciliation_exceptions
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS billing_automation_runs_admin_select ON saas_immobilier.billing_automation_runs;
CREATE POLICY billing_automation_runs_admin_select
  ON saas_immobilier.billing_automation_runs
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

-- S'assurer que l'administrateur plateforme peut également lire `agencies`, `agency_subscriptions`, `agency_members` et `user_profiles`
DROP POLICY IF EXISTS agencies_select_platform_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_select_platform_admin
  ON saas_immobilier.agencies
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS agency_subscriptions_select_platform_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_select_platform_admin
  ON saas_immobilier.agency_subscriptions
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS agency_members_select_platform_admin ON saas_immobilier.agency_members;
CREATE POLICY agency_members_select_platform_admin
  ON saas_immobilier.agency_members
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS user_profiles_select_platform_admin ON saas_immobilier.user_profiles;
CREATE POLICY user_profiles_select_platform_admin
  ON saas_immobilier.user_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_platform_admin());

-- Empêcher tout `INSERT` ou `DELETE` direct sur `notifications` par un client authentifié
REVOKE INSERT, DELETE, TRUNCATE ON saas_immobilier.notifications FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Nettoyage des surcharges obsolètes et verrouillage `EXECUTE` des fonctions
--    `SECURITY DEFINER` dans `public` et `saas_immobilier`
-- -----------------------------------------------------------------------------

-- Supprimer uniquement toute surcharge accidentelle hors de la signature officielle LOT 2/3
DROP FUNCTION IF EXISTS saas_immobilier.apply_confirmed_subscription_payment(
  uuid, uuid, uuid, uuid, numeric, text, text, text, text, uuid, timestamptz
);

-- Révoquer `PUBLIC` et `anon` sur toutes les fonctions `SECURITY DEFINER` sauf les 2 RPC publiques d'inscription
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT
      n.nspname AS schema_name,
      p.proname AS fn_name,
      pg_get_function_identity_arguments(p.oid) AS fn_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'saas_immobilier')
      AND p.prosecdef = true
      AND NOT (n.nspname = 'public' AND p.proname IN ('public_plans_catalog', 'platform_signup_settings'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon', fn.schema_name, fn.fn_name, fn.fn_args);
  END LOOP;

  -- Interdire tout appel direct par `authenticated` aux primitives internes du schéma `saas_immobilier`
  FOR fn IN
    SELECT
      n.nspname AS schema_name,
      p.proname AS fn_name,
      pg_get_function_identity_arguments(p.oid) AS fn_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'saas_immobilier'
      AND p.prosecdef = true
      AND p.proname NOT IN ('create_agency_for_self', 'mon_etat_compte', 'agence_active')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM authenticated', fn.schema_name, fn.fn_name, fn.fn_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role', fn.schema_name, fn.fn_name, fn.fn_args);
  END LOOP;

  -- Interdire tout appel direct par `authenticated` aux fonctions `public.saspay_*` réservées aux Edge Functions `service_role`
  FOR fn IN
    SELECT
      n.nspname AS schema_name,
      p.proname AS fn_name,
      pg_get_function_identity_arguments(p.oid) AS fn_args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname IN (
        'saspay_attach_checkout',
        'saspay_attach_checkout_checked',
        'saspay_claim_checkout',
        'saspay_release_checkout_claim',
        'saspay_mark_checkout_attempt',
        'saspay_confirm_payment',
        'saspay_confirm_verified_payment',
        'saspay_confirm_guarded_payment',
        'saspay_record_failed',
        'saspay_record_reconciliation_exception',
        'saspay_record_verification_failure',
        'saspay_reconciliation_batch',
        'saspay_mark_reconcile_attempt',
        'saspay_recent_pending_sessions',
        'saspay_automatic_checkout_batch',
        'billing_log_reconciliation_run'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM authenticated', fn.schema_name, fn.fn_name, fn.fn_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO service_role', fn.schema_name, fn.fn_name, fn.fn_args);
  END LOOP;

  -- Garantir explicitement `EXECUTE` à `authenticated` sur les RPC métier appelées par le client
  -- (après `REVOKE ALL ... FROM PUBLIC` qui retire l'héritage implicite)
  GRANT EXECUTE ON FUNCTION public.agency_current_plan(uuid) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION saas_immobilier.agence_active(uuid) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION saas_immobilier.create_agency_for_self(
    text, text, text, text, text, text, text, text, text, text, text, uuid
  ) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION saas_immobilier.mon_etat_compte() TO authenticated, service_role;

  -- Permettre la lecture publique du catalogue d'offres sur `/inscription` avant connexion
  GRANT SELECT ON saas_immobilier.plans TO anon, authenticated, service_role;
  DROP POLICY IF EXISTS plans_select_public_active ON saas_immobilier.plans;
  CREATE POLICY plans_select_public_active ON saas_immobilier.plans
    FOR SELECT TO anon, authenticated
    USING (true);
END;
$$;

COMMIT;
