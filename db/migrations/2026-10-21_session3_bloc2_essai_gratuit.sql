-- =============================================================================
-- SESSION 3 — BLOC 2 : ESSAI GRATUIT DE 14 JOURS ET FACTURATION
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21
-- Rollback : db/rollback/2026-10-21_session3_bloc2_essai_gratuit_rollback.sql
--
-- PARCOURS APPLIQUÉ
--   inscription → infos agence → choix de l'offre → (contrat, bloc 4)
--   → `agency_start_trial` ouvre le dashboard EN ESSAI pour 14 jours.
--
-- RÈGLES
--   • Réglage `platform_settings.signup.require_admin_validation` = false par
--     défaut. S'il est vrai, l'agence reste 'pending' et attend l'admin.
--   • `agency_subscriptions.status='trial'`, `trial_ends_at = now() + 14 j`,
--     et `ends_at = trial_ends_at` : le compte à rebours payant démarre à la
--     FIN de l'essai. Les jours d'essai ne sont pas déduits du premier mois.
--   • Un seul essai par agence (vérifié par existence d'un abonnement).
--   • Plafond de messages pendant l'essai : 200 (`platform_settings.trial`).
--   • `suspend_overdue_agencies()` ignore déjà les essais valides
--     (`NOT COALESCE(s.trial_ends_at > now(), false)`) : garde-fou existant,
--     non modifié.
--   • Les agences existantes ne reçoivent AUCUN essai : aucune donnée touchée.
-- =============================================================================

-- 1. Réglages (additifs, jamais écrasés s'ils existent déjà)
INSERT INTO saas_immobilier.platform_settings (key, value) VALUES
  ('signup', jsonb_build_object('require_admin_validation', false, 'trial_days', 14)),
  ('trial',  jsonb_build_object('agent_messages', 200))
ON CONFLICT (key) DO NOTHING;

-- 2. Lecture publique des réglages d'inscription (nécessaire avant connexion)
CREATE OR REPLACE FUNCTION public.platform_signup_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_signup jsonb; v_trial jsonb;
BEGIN
  SELECT value INTO v_signup FROM saas_immobilier.platform_settings WHERE key='signup';
  SELECT value INTO v_trial  FROM saas_immobilier.platform_settings WHERE key='trial';
  RETURN jsonb_build_object(
    'require_admin_validation', COALESCE((v_signup->>'require_admin_validation')::boolean, false),
    'trial_days',               COALESCE((v_signup->>'trial_days')::int, 14),
    'trial_agent_messages',     COALESCE((v_trial->>'agent_messages')::int, 200)
  );
END
$fn$;
GRANT EXECUTE ON FUNCTION public.platform_signup_settings() TO authenticated, anon, service_role;

-- 3. Réglage admin
CREATE OR REPLACE FUNCTION public.admin_set_signup_settings(p_require_validation boolean, p_trial_days integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_days int := LEAST(GREATEST(COALESCE(p_trial_days,14),1),90);
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  INSERT INTO saas_immobilier.platform_settings (key, value, updated_by)
  VALUES ('signup', jsonb_build_object('require_admin_validation', p_require_validation, 'trial_days', v_days), auth.uid())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = auth.uid(), updated_at = now();
  RETURN public.platform_signup_settings();
END
$fn$;
REVOKE ALL ON FUNCTION public.admin_set_signup_settings(boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_signup_settings(boolean, integer) TO authenticated, service_role;

-- 4. Démarrage de l'essai (unique écrivain de l'essai)
CREATE OR REPLACE FUNCTION public.agency_start_trial(p_agency_id uuid, p_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_agency record; v_plan record; v_settings jsonb; v_days int;
  v_requires boolean; v_trial_end timestamptz; v_sub_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentification requise' USING ERRCODE='42501'; END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE='42501'; END IF;

  SELECT a.id, a.name, a.status INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN RAISE EXCEPTION 'agence introuvable' USING ERRCODE='P0002'; END IF;

  IF EXISTS (SELECT 1 FROM saas_immobilier.agency_subscriptions s WHERE s.agency_id = p_agency_id) THEN
    RAISE EXCEPTION 'essai deja utilise pour cette agence' USING ERRCODE='22023', HINT='trial_already_used'; END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency INTO v_plan
    FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  IF v_plan.id IS NULL THEN RAISE EXCEPTION 'offre introuvable' USING ERRCODE='P0002'; END IF;

  v_settings := public.platform_signup_settings();
  v_days := COALESCE((v_settings->>'trial_days')::int, 14);
  v_requires := COALESCE((v_settings->>'require_admin_validation')::boolean, false);

  IF v_requires THEN
    UPDATE saas_immobilier.agencies a
       SET pending_plan_id = v_plan.id, pending_updated_at = now(), updated_at = now()
     WHERE a.id = p_agency_id;
    RETURN jsonb_build_object('mode','pending_validation','agency_id',p_agency_id,
      'plan_id',v_plan.id,'plan_name',COALESCE(v_plan.display_name,v_plan.name));
  END IF;

  v_trial_end := now() + (v_days || ' days')::interval;

  INSERT INTO saas_immobilier.agency_subscriptions
    (agency_id, plan_id, status, starts_at, ends_at, trial_ends_at)
  VALUES (p_agency_id, v_plan.id, 'trial', now(), v_trial_end, v_trial_end)
  RETURNING id INTO v_sub_id;

  UPDATE saas_immobilier.agencies a
     SET status='trial', pending_plan_id=v_plan.id, pending_note=NULL,
         pending_updated_at=now(), suspended_at=NULL, suspended_reason=NULL, updated_at=now()
   WHERE a.id = p_agency_id;

  INSERT INTO saas_immobilier.usage_events (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (p_agency_id, auth.uid(), 'agency_trial_started', 'agency', p_agency_id,
          jsonb_build_object('plan_id', v_plan.id, 'trial_ends_at', v_trial_end, 'trial_days', v_days),
          'agency_trial_started_' || p_agency_id::text);

  RETURN jsonb_build_object('mode','trial','agency_id',p_agency_id,'subscription_id',v_sub_id,
    'plan_id',v_plan.id,'plan_name',COALESCE(v_plan.display_name,v_plan.name),
    'trial_days',v_days,'trial_ends_at',v_trial_end,'ends_at',v_trial_end,
    'amount_due', COALESCE(v_plan.setup_fee,0) + COALESCE(v_plan.price_monthly,0),
    'currency', COALESCE(v_plan.currency,'XOF'));
END
$fn$;
REVOKE ALL ON FUNCTION public.agency_start_trial(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_start_trial(uuid, uuid) TO authenticated, service_role;

-- 5. Changement d'offre pendant l'essai : sans validation admin
CREATE OR REPLACE FUNCTION public.agency_change_plan_during_trial(p_agency_id uuid, p_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_sub record; v_plan record;
BEGIN
  IF NOT public.has_agency_role(p_agency_id,'admin') THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE='42501'; END IF;
  SELECT s.* INTO v_sub FROM saas_immobilier.agency_subscriptions s WHERE s.agency_id=p_agency_id
   ORDER BY (s.status='active') DESC, s.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'aucun abonnement' USING ERRCODE='P0002'; END IF;
  IF NOT (v_sub.status='trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now()) THEN
    RAISE EXCEPTION 'changement d offre pendant l essai uniquement' USING ERRCODE='22023', HINT='trial_change_window_closed'; END IF;
  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency INTO v_plan
    FROM saas_immobilier.plans pl WHERE pl.id=p_plan_id;
  IF v_plan.id IS NULL THEN RAISE EXCEPTION 'offre introuvable' USING ERRCODE='P0002'; END IF;
  UPDATE saas_immobilier.agency_subscriptions SET plan_id=v_plan.id, updated_at=now() WHERE id=v_sub.id;
  UPDATE saas_immobilier.agencies SET pending_plan_id=v_plan.id, updated_at=now() WHERE id=p_agency_id;
  RETURN jsonb_build_object('agency_id',p_agency_id,'plan_id',v_plan.id,
    'plan_name',COALESCE(v_plan.display_name,v_plan.name),'mode','trial_changed');
END
$fn$;
REVOKE ALL ON FUNCTION public.agency_change_plan_during_trial(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_change_plan_during_trial(uuid, uuid) TO authenticated, service_role;

-- 6. Administration de l'essai : prolonger / terminer
CREATE OR REPLACE FUNCTION public.admin_extend_trial(p_agency_id uuid, p_days integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_sub record; v_new timestamptz; v_days int := LEAST(GREATEST(COALESCE(p_days,7),1),90);
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  SELECT s.* INTO v_sub FROM saas_immobilier.agency_subscriptions s WHERE s.agency_id=p_agency_id
   ORDER BY (s.status='active') DESC, s.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'aucun abonnement' USING ERRCODE='P0002'; END IF;
  IF v_sub.status <> 'trial' THEN RAISE EXCEPTION 'cet abonnement n''est pas un essai' USING ERRCODE='22023'; END IF;
  v_new := GREATEST(COALESCE(v_sub.trial_ends_at, now()), now()) + (v_days || ' days')::interval;
  UPDATE saas_immobilier.agency_subscriptions
     SET trial_ends_at = v_new, ends_at = v_new, updated_at = now() WHERE id = v_sub.id;
  UPDATE saas_immobilier.agencies SET status='trial', updated_at=now() WHERE id=p_agency_id AND status <> 'suspended';
  RETURN jsonb_build_object('agency_id',p_agency_id,'trial_ends_at',v_new,'days_added',v_days);
END
$fn$;
REVOKE ALL ON FUNCTION public.admin_extend_trial(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_extend_trial(uuid, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_end_trial(p_agency_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_sub record; v_end timestamptz := now() + interval '30 days';
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  SELECT s.* INTO v_sub FROM saas_immobilier.agency_subscriptions s WHERE s.agency_id=p_agency_id
   ORDER BY (s.status='active') DESC, s.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_sub.id IS NULL THEN RAISE EXCEPTION 'aucun abonnement' USING ERRCODE='P0002'; END IF;
  IF v_sub.status <> 'trial' THEN RAISE EXCEPTION 'cet abonnement n''est pas un essai' USING ERRCODE='22023'; END IF;
  UPDATE saas_immobilier.agency_subscriptions
     SET status='active', trial_ends_at=now(), ends_at=v_end, updated_at=now() WHERE id=v_sub.id;
  UPDATE saas_immobilier.agencies SET status='active', updated_at=now()
   WHERE id=p_agency_id AND status IN ('trial','pending');
  RETURN jsonb_build_object('agency_id',p_agency_id,'status','active','ends_at',v_end);
END
$fn$;
REVOKE ALL ON FUNCTION public.admin_end_trial(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_end_trial(uuid, text) TO authenticated, service_role;

-- 7. Plafond effectif (essai = 200 messages, sinon celui de l'offre)
CREATE OR REPLACE FUNCTION public.agency_effective_quota(p_agency_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_state jsonb; v_settings jsonb; v_trial_cap int; v_plan record;
BEGIN
  v_state := public.agency_plan_state(p_agency_id);
  v_settings := public.platform_signup_settings();
  v_trial_cap := COALESCE((v_settings->>'trial_agent_messages')::int, 200);
  SELECT * INTO v_plan FROM public.agency_current_plan(p_agency_id);
  IF v_state->>'state' = 'trial' THEN
    RETURN jsonb_build_object('is_trial', true, 'agent_messages_limit', v_trial_cap,
      'source', 'trial', 'trial_ends_at', v_state->'trial_ends_at');
  END IF;
  RETURN jsonb_build_object('is_trial', false,
    'agent_messages_limit', COALESCE(v_plan.monthly_agent_messages, 0),
    'source', 'plan', 'trial_ends_at', NULL);
END
$fn$;
REVOKE ALL ON FUNCTION public.agency_effective_quota(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agency_effective_quota(uuid) TO authenticated, service_role;
