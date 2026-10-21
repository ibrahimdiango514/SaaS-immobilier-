-- =============================================================================
-- SESSION 3 — BLOC 1 : BUGS SYSTÈME (cause racine)
-- Projet : xbuuhfwobrafcbgtdgjx — à appliquer via execute_query
-- Rollback : db/rollback/2026-10-21_session3_bloc1_bugs_systeme_rollback.sql
--
-- CAUSES RACINES TROUVÉES (vérifiées sur la base réelle, pas supposées)
--
-- 1. « Offre non reconnue » : le bouton « Activer » de la console admin faisait
--    un UPDATE direct de saas_immobilier.agencies.status = 'active'
--    (useAdminUpdateAgency), SANS créer de ligne agency_subscriptions.
--    Constat en base : l'agence « Immo Diango » est status='active' et n'a
--    AUCUNE ligne d'abonnement. agency_current_plan() ne renvoie donc rien,
--    useModuleAccess().has() renvoie false, et la vue d'ensemble est verrouillée.
--
-- 2. « Seule l'agence de test apparaît » : il n'existe AUCUNE politique RLS de
--    SELECT pour l'administrateur plateforme sur agencies / agency_subscriptions
--    / agency_members. Seule `agencies_select_member` (is_agency_member) existe :
--    l'admin ne voit donc que les agences dont il est membre — l'agence de test.
--    Même cause pour agency_subscriptions : les abonnements des autres agences
--    sont invisibles, donc les KPI et graphiques sont faux (bug 3).
--
-- 3. Facturation : review_payment_declaration() lève « aucun abonnement pour
--    cette agence » quand il n'y a pas encore d'abonnement, ce qui casse le
--    parcours de validation d'une nouvelle agence.
--
-- PRINCIPE DIRECTEUR : UNE SEULE FONCTION ÉCRIT L'OFFRE (admin_assign_plan) et
-- UNE SEULE FONCTION LA LIT (agency_plan_state / agency_current_plan).
--
-- Tout est additif ou en CREATE OR REPLACE. Aucune donnée supprimée.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §1  LECTURE UNIQUE : état complet de l'offre d'une agence
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_plan_state(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_agency record;
  v_sub    record;
  v_plan   record;
  v_grace  integer;
  v_state  text;
BEGIN
  SELECT a.id, a.status INTO v_agency
    FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'state', 'missing', 'has_plan', false);
  END IF;

  -- Un seul abonnement « courant » : active > trial > past_due > autres récents.
  SELECT s.* INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status
              WHEN 'active'   THEN 0
              WHEN 'trial'    THEN 1
              WHEN 'past_due' THEN 2
              ELSE 3
            END,
            s.created_at DESC
   LIMIT 1;

  IF v_sub.id IS NOT NULL THEN
    SELECT pl.* INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_grace IS NULL THEN v_grace := 5; END IF;

  IF v_agency.status = 'pending' THEN
    v_state := 'pending';
  ELSIF v_agency.status = 'suspended' THEN
    v_state := 'suspended';
  ELSIF v_sub.id IS NULL OR v_plan.id IS NULL THEN
    v_state := 'no_plan';
  ELSIF v_sub.status = 'trial'
        AND v_sub.trial_ends_at IS NOT NULL
        AND v_sub.trial_ends_at > now() THEN
    v_state := 'trial';
  ELSIF v_sub.status = 'cancelled' OR v_sub.status = 'expired' THEN
    v_state := 'cancelled';
  ELSIF v_sub.ends_at IS NOT NULL AND v_sub.ends_at < now() THEN
    IF v_sub.ends_at < now() - (v_grace || ' day')::interval THEN
      v_state := 'suspended_overdue';
    ELSE
      v_state := 'overdue';
    END IF;
  ELSE
    v_state := 'active';
  END IF;

  RETURN jsonb_build_object(
    'found',               true,
    'agency_id',           v_agency.id,
    'agency_status',       v_agency.status,
    'state',               v_state,
    'has_plan',            (v_sub.id IS NOT NULL AND v_plan.id IS NOT NULL),
    'subscription_id',     v_sub.id,
    'subscription_status', v_sub.status,
    'plan_id',             v_plan.id,
    'plan_name',           COALESCE(v_plan.display_name, v_plan.name),
    'plan_price_monthly',  v_plan.price_monthly,
    'plan_setup_fee',      v_plan.setup_fee,
    'currency',            COALESCE(v_plan.currency, 'XOF'),
    'trial_ends_at',       v_sub.trial_ends_at,
    'trial_days_left',     CASE WHEN v_sub.trial_ends_at IS NULL THEN NULL
                                ELSE GREATEST(0, ceil(extract(epoch from (v_sub.trial_ends_at - now())) / 86400.0)::int) END,
    'starts_at',           v_sub.starts_at,
    'ends_at',             v_sub.ends_at,
    'days_to_due',         CASE WHEN v_sub.ends_at IS NULL THEN NULL
                                ELSE floor(extract(epoch from (v_sub.ends_at - now())) / 86400.0)::int END,
    'grace_days',          v_grace,
    -- Seuls ces états ferment l'espace de travail. « no_plan » et « overdue »
    -- ne le ferment JAMAIS : ils affichent un état explicatif avec l'action.
    'is_locked',           v_state IN ('pending', 'suspended', 'suspended_overdue'),
    'requires_action',     v_state IN ('no_plan', 'overdue', 'pending')
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.agency_plan_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_plan_state(uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- §2  agency_current_plan : même sélection que §1 (une seule vérité)
--     Avant : ORDER BY (status='active') DESC sans filtre → une ligne
--     'cancelled'/'expired' pouvait être renvoyée comme offre courante.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_current_plan(p_agency_id uuid)
RETURNS saas_immobilier.plans
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT p.*
    FROM saas_immobilier.agency_subscriptions s
    JOIN saas_immobilier.plans p ON p.id = s.plan_id
   WHERE s.agency_id = p_agency_id
     AND s.status IN ('active','trial','past_due')
   ORDER BY CASE s.status
              WHEN 'active'   THEN 0
              WHEN 'trial'    THEN 1
              ELSE 2
            END,
            s.created_at DESC
   LIMIT 1;
$fn$;


-- -----------------------------------------------------------------------------
-- §3  ÉCRITURE UNIQUE : admin_assign_plan
--     Crée l'abonnement s'il n'existe pas, sinon le met à jour. Active l'agence
--     si elle était 'pending'. C'est le SEUL chemin d'écriture de l'offre.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_assign_plan(
  p_agency_id uuid,
  p_plan_id   uuid,
  p_status    text DEFAULT 'active',
  p_note      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub_id  uuid;
  v_plan    record;
  v_status  text := COALESCE(NULLIF(btrim(p_status), ''), 'active');
  v_ends    date;
  v_agency  record;
  v_owner   uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF v_status NOT IN ('active','trial','past_due','cancelled','expired') THEN
    RAISE EXCEPTION 'statut d abonnement invalide : %', v_status USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  SELECT a.id, a.name, a.status INTO v_agency
    FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  SELECT s.id INTO v_sub_id
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status
              WHEN 'active'   THEN 0
              WHEN 'trial'    THEN 1
              WHEN 'past_due' THEN 2
              ELSE 3
            END,
            s.created_at DESC
   LIMIT 1
   FOR UPDATE;

  v_ends := (CURRENT_DATE + interval '1 month')::date;

  IF v_sub_id IS NULL THEN
    INSERT INTO saas_immobilier.agency_subscriptions
      (agency_id, plan_id, status, starts_at, ends_at, trial_ends_at)
    VALUES (
      p_agency_id, v_plan.id, v_status, now(),
      CASE WHEN v_status IN ('cancelled','expired') THEN NULL ELSE v_ends END,
      NULL
    )
    RETURNING id INTO v_sub_id;
  ELSE
    UPDATE saas_immobilier.agency_subscriptions s
       SET plan_id  = v_plan.id,
           status   = v_status,
           -- On ne raccourcit jamais une échéance déjà future.
           ends_at  = CASE
                        WHEN v_status IN ('cancelled','expired') THEN s.ends_at
                        WHEN s.ends_at IS NULL OR s.ends_at < CURRENT_DATE THEN v_ends
                        ELSE s.ends_at
                      END,
           trial_ends_at = CASE WHEN v_status = 'trial' THEN s.trial_ends_at ELSE NULL END
     WHERE s.id = v_sub_id;
  END IF;

  IF v_agency.status = 'pending' AND v_status <> 'cancelled' THEN
    UPDATE saas_immobilier.agencies a
       SET status = 'active',
           pending_note = NULL,
           pending_updated_at = now(),
           suspended_at = NULL,
           suspended_reason = NULL,
           updated_at = now()
     WHERE a.id = p_agency_id;
  END IF;

  SELECT am.user_id INTO v_owner
    FROM saas_immobilier.agency_members am
   WHERE am.agency_id = p_agency_id AND am.role = 'owner'
   ORDER BY am.created_at ASC LIMIT 1;

  INSERT INTO saas_immobilier.usage_events
    (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (
    p_agency_id, auth.uid(), 'admin_plan_assigned', 'agency', p_agency_id,
    jsonb_build_object('plan_id', v_plan.id, 'status', v_status, 'note', p_note,
                       'subscription_id', v_sub_id),
    'admin_plan_assigned_' || p_agency_id::text || '_' || extract(epoch from now())::bigint::text
  );

  IF v_owner IS NOT NULL AND v_status = 'active' THEN
    INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
    VALUES (p_agency_id, v_owner, 'system',
            'Votre offre est activée',
            'L''offre ' || COALESCE(v_plan.display_name, v_plan.name)
              || ' est active jusqu''au ' || to_char(v_ends, 'DD/MM/YYYY') || '.',
            jsonb_build_object('plan_id', v_plan.id, 'ends_at', v_ends));
  END IF;

  RETURN jsonb_build_object(
    'agency_id',       p_agency_id,
    'subscription_id', v_sub_id,
    'plan_id',         v_plan.id,
    'plan_name',       COALESCE(v_plan.display_name, v_plan.name),
    'status',          v_status,
    'ends_at',         v_ends
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_assign_plan(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_plan(uuid, uuid, text, text) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- §4  admin_change_agency_plan : délègue à §3 (signature conservée, boolean)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
BEGIN
  PERFORM public.admin_assign_plan(p_agency_id, p_plan_id, 'active', 'changement direct par administrateur');
  RETURN true;
END
$fn$;


-- -----------------------------------------------------------------------------
-- §5  admin_activate_agency : le bouton « Activer » de la console admin.
--     Corrige le bug n°1 : crée TOUJOURS l'abonnement.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_activate_agency(p_agency_id uuid, p_plan_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_plan uuid := p_plan_id;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  IF v_plan IS NULL THEN
    SELECT a.pending_plan_id INTO v_plan
      FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  END IF;
  IF v_plan IS NULL THEN
    SELECT s.plan_id INTO v_plan
      FROM saas_immobilier.agency_subscriptions s
     WHERE s.agency_id = p_agency_id
     ORDER BY s.created_at DESC LIMIT 1;
  END IF;
  IF v_plan IS NULL THEN
    SELECT pl.id INTO v_plan FROM saas_immobilier.plans pl
     ORDER BY pl.price_monthly ASC LIMIT 1;
  END IF;
  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'aucune offre disponible dans le catalogue' USING ERRCODE = '22023';
  END IF;

  RETURN public.admin_assign_plan(p_agency_id, v_plan, 'active', 'activation administrateur');
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_activate_agency(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_activate_agency(uuid, uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- §6  admin_activate_pending_agency : conserve son contrat, délègue à §5
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_status text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  SELECT a.status INTO v_status FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est pas en attente de validation (statut : %)', v_status
      USING ERRCODE = '22023';
  END IF;
  RETURN public.admin_activate_agency(p_agency_id, NULL);
END
$fn$;


-- -----------------------------------------------------------------------------
-- §7  review_payment_declaration : crée l'abonnement s'il manque (bug n°3)
--     Signature et comportement conservés pour le reste.
-- -----------------------------------------------------------------------------
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


-- -----------------------------------------------------------------------------
-- §8  RLS : l'administrateur plateforme voit ET gère TOUTES les agences.
--     Cause racine du bug n°2 : aucune politique de SELECT admin n'existait.
--     Les politiques sont PERMISSIVES (OR) : rien n'est retiré aux agences.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS agencies_select_platform_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_select_platform_admin ON saas_immobilier.agencies
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS agencies_update_platform_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_update_platform_admin ON saas_immobilier.agencies
  FOR UPDATE TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS agencies_insert_platform_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_insert_platform_admin ON saas_immobilier.agencies
  FOR INSERT TO authenticated WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS agency_subscriptions_select_platform_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_select_platform_admin ON saas_immobilier.agency_subscriptions
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS agency_subscriptions_insert_platform_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_insert_platform_admin ON saas_immobilier.agency_subscriptions
  FOR INSERT TO authenticated WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS agency_subscriptions_update_platform_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_update_platform_admin ON saas_immobilier.agency_subscriptions
  FOR UPDATE TO authenticated
  USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS agency_members_select_platform_admin ON saas_immobilier.agency_members;
CREATE POLICY agency_members_select_platform_admin ON saas_immobilier.agency_members
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS payment_declarations_select_platform_admin ON saas_immobilier.payment_declarations;
CREATE POLICY payment_declarations_select_platform_admin ON saas_immobilier.payment_declarations
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS plans_select_platform_admin ON saas_immobilier.plans;
CREATE POLICY plans_select_platform_admin ON saas_immobilier.plans
  FOR SELECT TO authenticated USING (public.is_platform_admin());


-- -----------------------------------------------------------------------------
-- §9  RÉPARATION DES DONNÉES EXISTANTES (additif, aucune suppression)
--     Les agences 'active' sans abonnement (cas « Immo Diango ») reçoivent
--     l'offre la moins chère pour ne plus afficher un dashboard verrouillé.
--     Les agences en 'pending' ne sont PAS touchées : leur parcours est normal.
-- -----------------------------------------------------------------------------
INSERT INTO saas_immobilier.agency_subscriptions
  (agency_id, plan_id, status, starts_at, ends_at)
SELECT a.id,
       COALESCE(a.pending_plan_id,
                (SELECT pl.id FROM saas_immobilier.plans pl ORDER BY pl.price_monthly ASC LIMIT 1)),
       'active',
       now(),
       (CURRENT_DATE + interval '1 month')::date
  FROM saas_immobilier.agencies a
 WHERE a.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM saas_immobilier.agency_subscriptions s WHERE s.agency_id = a.id
   )
   AND (a.pending_plan_id IS NOT NULL OR EXISTS (SELECT 1 FROM saas_immobilier.plans));


-- -----------------------------------------------------------------------------
-- §10  VÉRIFICATION POST-APPLICATION
-- -----------------------------------------------------------------------------
DO $$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM saas_immobilier.agencies a
   WHERE a.status IN ('active','trial')
     AND NOT EXISTS (SELECT 1 FROM saas_immobilier.agency_subscriptions s WHERE s.agency_id = a.id);
  RAISE NOTICE 'BLOC 1 — agences actives sans abonnement restantes : %', v_missing;
END $$;
