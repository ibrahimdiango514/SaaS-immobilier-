-- =============================================================================
-- ROLLBACK — SESSION 3 / BLOC 1 (bugs système)
-- Remet les fonctions dans leur état d'avant la migration et retire les
-- politiques RLS ajoutées. Ne supprime AUCUNE donnée métier.
-- ⚠️ Les abonnements créés par §9 ne sont PAS supprimés (ce serait une
--    suppression de données) : les retirer manuellement si nécessaire.
-- =============================================================================

-- Politiques RLS ajoutées au BLOC 1
DROP POLICY IF EXISTS agencies_select_platform_admin            ON saas_immobilier.agencies;
DROP POLICY IF EXISTS agencies_update_platform_admin            ON saas_immobilier.agencies;
DROP POLICY IF EXISTS agencies_insert_platform_admin            ON saas_immobilier.agencies;
DROP POLICY IF EXISTS agency_subscriptions_select_platform_admin ON saas_immobilier.agency_subscriptions;
DROP POLICY IF EXISTS agency_subscriptions_insert_platform_admin ON saas_immobilier.agency_subscriptions;
DROP POLICY IF EXISTS agency_subscriptions_update_platform_admin ON saas_immobilier.agency_subscriptions;
DROP POLICY IF EXISTS agency_members_select_platform_admin      ON saas_immobilier.agency_members;
DROP POLICY IF EXISTS payment_declarations_select_platform_admin ON saas_immobilier.payment_declarations;
DROP POLICY IF EXISTS plans_select_platform_admin               ON saas_immobilier.plans;

-- Fonctions ajoutées
DROP FUNCTION IF EXISTS public.admin_assign_plan(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_activate_agency(uuid, uuid);
DROP FUNCTION IF EXISTS public.agency_plan_state(uuid);

-- agency_current_plan : définition d'origine (LOT A)
CREATE OR REPLACE FUNCTION public.agency_current_plan(p_agency_id uuid)
RETURNS saas_immobilier.plans
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT p.*
    FROM saas_immobilier.agency_subscriptions s
    JOIN saas_immobilier.plans p ON p.id = s.plan_id
   WHERE s.agency_id = p_agency_id
   ORDER BY (s.status = 'active') DESC, s.created_at DESC
   LIMIT 1;
$fn$;

-- admin_change_agency_plan : définition d'origine
CREATE OR REPLACE FUNCTION public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_sub uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_sub FROM saas_immobilier.agency_subscriptions
   WHERE agency_id = p_agency_id
   ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1 FOR UPDATE;

  IF v_sub IS NULL THEN
    INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at)
    VALUES (p_agency_id, p_plan_id, 'active', now());
  ELSE
    UPDATE saas_immobilier.agency_subscriptions
       SET plan_id = p_plan_id, status = 'active' WHERE id = v_sub;
  END IF;
  RETURN true;
END
$fn$;

-- admin_activate_pending_agency : définition d'origine (SESSION 2 / BLOC 2)
-- Voir db/migrations/2026-10-21_session2_bloc2_abonnement.sql §5.1 pour le corps
-- complet ; ce rollback restaure la version qui crée l'abonnement + 1 mois.
CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_agency  record;
  v_plan    record;
  v_sub_id  uuid;
  v_owner   uuid;
  v_ends    date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.name, a.status, a.pending_plan_id
    INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est pas en attente de validation (statut : %)', v_agency.status
      USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.modules
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_agency.pending_plan_id;
  IF v_plan.id IS NULL THEN
    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.modules
      INTO v_plan FROM saas_immobilier.plans pl ORDER BY pl.price_monthly ASC LIMIT 1;
  END IF;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'aucune offre disponible dans le catalogue' USING ERRCODE = '22023';
  END IF;

  v_ends := (CURRENT_DATE + interval '1 month')::date;

  INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at, ends_at)
  VALUES (v_agency.id, v_plan.id, 'active', CURRENT_DATE, v_ends)
  RETURNING id INTO v_sub_id;

  UPDATE saas_immobilier.agencies a
     SET status = 'active', pending_note = NULL, pending_updated_at = now(),
         suspended_at = NULL, suspended_reason = NULL, updated_at = now()
   WHERE a.id = v_agency.id;

  SELECT am.user_id INTO v_owner
    FROM saas_immobilier.agency_members am
   WHERE am.agency_id = v_agency.id AND am.role = 'owner'
   ORDER BY am.created_at ASC LIMIT 1;

  IF v_owner IS NOT NULL THEN
    INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
    VALUES (v_agency.id, v_owner, 'system', 'Votre offre est activée',
            'L''administrateur a validé votre agence.',
            jsonb_build_object('pending_approved', true, 'plan_id', v_plan.id, 'ends_at', v_ends));
  END IF;

  RETURN jsonb_build_object(
    'agency_id', v_agency.id, 'agency_name', v_agency.name, 'status', 'active',
    'subscription_id', v_sub_id, 'plan_id', v_plan.id,
    'plan_name', coalesce(v_plan.display_name, v_plan.name),
    'starts_at', CURRENT_DATE, 'ends_at', v_ends);
END
$fn$;

-- review_payment_declaration : retour à la version qui exige un abonnement.
-- (Corps d'origine conservé dans db/migrations/2026-10-21_bloc1-2_paiements_admin.sql)
