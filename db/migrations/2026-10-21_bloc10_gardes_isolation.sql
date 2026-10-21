-- =============================================================================
-- BLOC 10 — AUDIT : GARDES D'ISOLATION ET PRIVILÈGES D'EXÉCUTION
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21 via execute_query
-- Rollback : db/rollback/2026-10-21_bloc10_gardes_isolation.sql
--
-- Trois familles de correctifs. ⚠️ Ce fichier MODIFIE deux fonctions de
-- sécurité existantes (`agency_billing_state`, `agency_usage_snapshot`) et
-- retire des privilèges d'exécution. Tout est réversible via le rollback.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- A. RETRAIT DE `anon` SUR DES FONCTIONS SECURITY DEFINER
--
-- Constat : dix fonctions `SECURITY DEFINER` (propriétaire `postgres`, donc
-- contournant la RLS) étaient exécutables par le rôle `anon`, c'est-à-dire par
-- quiconque possède la clé publique du projet — clé qui est, par conception,
-- embarquée dans le navigateur.
--
-- Le navigateur n'appelle JAMAIS ces fonctions sans JWT : chaque appel vient
-- d'un utilisateur connecté. Retirer `anon` est donc purement réductif et ne
-- casse aucun parcours (vérifié : les appelants sont src/lib/plan-limits.ts,
-- src/lib/payments-api.ts, src/pages/my-offer.tsx, src/components/smart-alerts.tsx,
-- src/pages/admin/*.tsx et les Edge Functions, tous avec un JWT).
--
-- Cas particulier `suspend_overdue_agencies()` : VOLATILE, SECURITY DEFINER,
-- SANS AUCUNE GARDE interne (ni is_platform_admin, ni auth.uid(), ni auth.role())
-- et exécutable par `anon` ET `authenticated`. N'importe qui pouvait donc
-- déclencher à la demande la suspension de toutes les agences en retard de
-- paiement, en écrivant directement en base sous l'identité `postgres`.
-- Elle n'est plus appelée que par le job pg_cron `sofia-lot-a-suspend-overdue`
-- (*/15 * * * *, qui s'exécute en tant que `postgres`, propriétaire) et par
-- `service_role`.
--
-- Les fonctions d'administration (`admin_change_agency_plan`,
-- `admin_handle_plan_change`, `reactivate_agency`, `review_payment_declaration`)
-- conservent `authenticated` : leur garde interne `is_platform_admin()` fait le
-- travail. Le retrait de `anon` reste une défense en profondeur.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.suspend_overdue_agencies()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agency_usage_snapshot(uuid)                    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agency_billing_state(uuid)                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agency_current_plan(uuid)                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_change_agency_plan(uuid,uuid)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_handle_plan_change(uuid,text,text)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reactivate_agency(uuid,text)                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_plan_change(uuid,uuid,text)            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.review_payment_declaration(uuid,text,text)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_payment_declaration(uuid,numeric,text,text,date,text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.suspend_overdue_agencies()                  TO service_role;
GRANT EXECUTE ON FUNCTION public.agency_usage_snapshot(uuid)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_billing_state(uuid)                  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_current_plan(uuid)                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_change_agency_plan(uuid,uuid)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_handle_plan_change(uuid,text,text)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_agency(uuid,text)                TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_plan_change(uuid,uuid,text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_payment_declaration(uuid,text,text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_payment_declaration(uuid,numeric,text,text,date,text) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- B. GARDE D'ISOLATION SUR agency_billing_state ET agency_usage_snapshot
--
-- Constat : ces deux fonctions SECURITY DEFINER n'avaient AUCUN contrôle
-- d'accès. Un membre de l'agence A pouvait lire l'état de facturation, l'offre,
-- les limites et les compteurs d'usage de l'agence B en passant simplement son
-- UUID — violation directe de l'exigence « une agence ne voit jamais les données
-- d'une autre (… paiements …) ».
--
-- Garde ajoutée : `service_role` passe (Edge Functions) ; une connexion DIRECTE
-- sans jeton passe (postgres, pg_cron, console SQL) ; sinon il faut être membre
-- de l'agence ou administrateur plateforme.
--
-- Pourquoi tester `auth.role() IS NOT NULL` : PostgREST pose toujours la
-- revendication `role` (anon / authenticated / service_role). Elle n'est absente
-- que sur une connexion directe, qui exige déjà d'être superutilisateur.
-- Une garde sans ce test bloquait l'administration en base (constaté en test :
-- erreur 42501 « acces agence refuse » depuis la console).
--
-- ⚠️ Piège rappelé : dans une fonction SECURITY DEFINER, `current_user` vaut le
-- PROPRIÉTAIRE (`postgres`), jamais `service_role`. C'est donc `auth.role()`
-- (revendication du JWT) qu'il faut tester, pas `current_user`.
--
-- agency_usage_snapshot passe de LANGUAGE sql à LANGUAGE plpgsql : une fonction
-- SQL ne permet pas d'insérer un contrôle avant l'évaluation des expressions.
-- Sa signature, son nom et la forme de sa réponse JSON sont INCHANGÉS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_billing_state(p_agency_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_sub   record;
  v_grace integer;
  v_due   integer;
  v_role  text;
BEGIN
  -- BLOC 10 : garde d'isolation.
  v_role := auth.role();
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    IF NOT (public.is_agency_member(p_agency_id) OR public.is_platform_admin()) THEN
      RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_grace IS NULL THEN v_grace := 5; END IF;

  SELECT s.status, s.ends_at, s.trial_ends_at
    INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY (s.status = 'active') DESC, s.created_at DESC
   LIMIT 1;

  IF v_sub.ends_at IS NULL THEN
    RETURN jsonb_build_object('has_due_date', false, 'grace_days', v_grace,
                              'is_due_soon', false, 'is_overdue', false,
                              'is_past_grace', false, 'in_valid_trial', false);
  END IF;

  v_due := ceil(extract(epoch from (v_sub.ends_at - now())) / 86400.0)::int;

  RETURN jsonb_build_object(
    'has_due_date',  true,
    'sub_status',    v_sub.status,
    'ends_at',       v_sub.ends_at,
    'trial_ends_at', v_sub.trial_ends_at,
    'days_to_due',   v_due,
    'grace_days',    v_grace,
    'is_due_soon',   v_due <= 5 AND v_due >= 0,
    'is_overdue',    v_due < 0,
    'is_past_grace', v_due < (0 - v_grace),
    'in_valid_trial', COALESCE(v_sub.trial_ends_at > now(), false)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.agency_usage_snapshot(p_agency_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_role text;
BEGIN
  -- BLOC 10 (1) : garde d'isolation.
  v_role := auth.role();
  IF v_role IS NOT NULL AND v_role <> 'service_role' THEN
    IF NOT (public.is_agency_member(p_agency_id) OR public.is_platform_admin()) THEN
      RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'plan', (SELECT jsonb_build_object(
                'id', pl.id, 'name', pl.name, 'display_name', pl.display_name,
                'price_monthly', pl.price_monthly, 'setup_fee', pl.setup_fee,
                'currency', pl.currency, 'max_members', pl.max_members,
                'max_properties', pl.max_properties,
                'max_photos_per_property', pl.max_photos_per_property,
                'monthly_agent_messages', pl.monthly_agent_messages,
                'monthly_follow_ups', pl.monthly_follow_ups,
                'modules', pl.modules)
             FROM public.agency_current_plan(p_agency_id) pl),
    -- BLOC 10 (2) : un bien archivé ne compte PAS dans la limite de l'offre,
    -- aligné sur public.enforce_property_limit() modifiée au BLOC 6. Avant ce
    -- correctif, « Mon offre » et les alertes intelligentes comptaient les biens
    -- archivés dans le quota alors que la base les ignorait : le compteur
    -- affiché pouvait donc bloquer l'utilisateur à tort.
    'properties_used', (SELECT count(*)::int FROM saas_immobilier.properties
                         WHERE agency_id = p_agency_id
                           AND is_archived = false),
    'properties_limit', public.plan_limit_value(p_agency_id,'max_properties'),
    'photos_per_property_max',
        (SELECT COALESCE(max(c),0)::int FROM (
           SELECT count(*) c FROM saas_immobilier.property_media
            WHERE agency_id = p_agency_id AND media_type = 'photo'
            GROUP BY property_id) t),
    'photos_per_property_limit',
        public.plan_limit_value(p_agency_id,'max_photos_per_property'),
    'seats', public.agency_seat_availability(p_agency_id),
    'billing', public.agency_billing_state(p_agency_id)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.agency_billing_state(uuid)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agency_usage_snapshot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_billing_state(uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_usage_snapshot(uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- VÉRIFICATIONS (valeurs constatées après application)
-- -----------------------------------------------------------------------------
-- anon = false partout ; suspend_overdue_agencies : authenticated = false.
-- agency_usage_snapshot : langage = plpgsql.
-- Lecture réelle sur les 3 agences :
--   agence-test-suspendue | suspended | biens 0/0  | offre NULL
--   iango-agengy           | active    | biens 1/30 | offre Essentiel
--   sbc-demo               | active    | biens 5/30 | offre Essentiel
SELECT p.proname,
       has_function_privilege('anon',p.oid,'EXECUTE')          AS anon,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
       has_function_privilege('service_role',p.oid,'EXECUTE')  AS svc
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN
       ('suspend_overdue_agencies','agency_usage_snapshot','agency_billing_state',
        'agency_current_plan','admin_change_agency_plan','admin_handle_plan_change',
        'reactivate_agency','request_plan_change','review_payment_declaration',
        'submit_payment_declaration')
 ORDER BY p.proname;
