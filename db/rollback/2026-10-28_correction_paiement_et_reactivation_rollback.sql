-- =============================================================================
-- ROLLBACK — 2026-10-28_correction_paiement_et_reactivation.sql
-- =============================================================================
-- Restaure les définitions d'AVANT le correctif. Aucune donnée n'est touchée :
-- ce correctif ne créait ni ne supprimait aucune table, colonne, politique RLS
-- ou index. Les références déjà émises au format SOF-PAY-<date>-XXXXXX restent
-- valides (elles vivent dans `payment_declarations.reference`).
--
-- ATTENTION : après ce rollback, les deux bugs réapparaissent —
--   · `admin_reactivate_agency` ré-offre un mois (ends_at = +1 mois) ;
--   · `admin_assign_plan` ne lève plus la suspension ;
--   · les références repassent au format SI-…
-- À n'utiliser que pour revenir en arrière volontairement.
--
-- Non couvert (volontairement) : `saas_immobilier.raise_admin_alert` garde son
-- nouveau comportement de lien profond (`?demande=<uuid>`), qui est inoffensif
-- et attendu par l'écran /admin/paiements.
-- =============================================================================
BEGIN;

-- §1. Générateur de référence : supprimé (n'existait pas avant).
DROP FUNCTION IF EXISTS public.payment_reference();

-- §2. Création de demande : ancienne version (référence SI-…, pas de verrou).
CREATE OR REPLACE FUNCTION public.agency_create_payment_request(
  p_agency_id uuid,
  p_plan_id uuid,
  p_duration_months integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_plan     record;
  v_exist    record;
  v_id       uuid;
  v_ref      text;
  v_expected numeric(14,2);
  v_months   integer;
  v_ttl      integer := 7;
  v_i        integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'seul le proprietaire ou un administrateur de l''agence peut payer' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plan FROM saas_immobilier.plans p WHERE p.id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.price_monthly IS NULL OR v_plan.price_monthly <= 0 THEN
    RAISE EXCEPTION 'cette offre n''a pas de tarif mensuel : paiement impossible' USING ERRCODE = '22023';
  END IF;

  v_months := LEAST(GREATEST(COALESCE(p_duration_months, 1), 1), 12);
  v_expected := round(v_plan.price_monthly * v_months, 2);

  SELECT COALESCE((value->>'request_ttl_days')::int, 7) INTO v_ttl
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_ttl IS NULL OR v_ttl < 1 THEN v_ttl := 7; END IF;

  SELECT * INTO v_exist
    FROM saas_immobilier.payment_declarations d
   WHERE d.agency_id = p_agency_id
     AND d.status = 'awaiting_payment'
     AND d.plan_id = p_plan_id
     AND d.expected_amount = v_expected
     AND d.expires_at > now()
   ORDER BY d.created_at DESC
   LIMIT 1;

  IF v_exist.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'id', v_exist.id, 'reference', v_exist.reference,
      'expected_amount', v_exist.expected_amount, 'currency', v_exist.currency,
      'duration_months', v_exist.duration_months,
      'expires_at', v_exist.expires_at, 'status', v_exist.status,
      'reused', true);
  END IF;

  FOR v_i IN 1..8 LOOP
    v_ref := 'SI-' || to_char(now(), 'YYYYMMDD') || '-' ||
             upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM saas_immobilier.payment_declarations d WHERE d.reference = v_ref);
  END LOOP;

  INSERT INTO saas_immobilier.payment_declarations (
    agency_id, amount, currency, method, transaction_reference, paid_on,
    declared_by, status, plan_id, plan_name_snapshot, expected_amount,
    duration_months, reference, expires_at
  ) VALUES (
    p_agency_id, v_expected, COALESCE(v_plan.currency, 'XOF'), NULL, NULL, NULL,
    auth.uid(), 'awaiting_payment', p_plan_id,
    COALESCE(v_plan.display_name, v_plan.name), v_expected,
    v_months, v_ref, now() + (v_ttl || ' day')::interval
  ) RETURNING id INTO v_id;

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id, actor_kind, amount)
  VALUES (v_id, p_agency_id, 'created', NULL, 'awaiting_payment', auth.uid(), 'agency', v_expected);

  RETURN jsonb_build_object(
    'id', v_id, 'reference', v_ref, 'expected_amount', v_expected,
    'currency', COALESCE(v_plan.currency, 'XOF'), 'duration_months', v_months,
    'expires_at', now() + (v_ttl || ' day')::interval,
    'status', 'awaiting_payment', 'reused', false);
END
$fn$;

-- §3. Suspension : ancienne version (annulait l'abonnement, exigeait un abonnement).
CREATE OR REPLACE FUNCTION public.admin_suspend_agency(
  p_agency_id uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_sub record; v_plan record; v_event uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 ELSE 1 END, s.created_at DESC
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = 'P0002';
  END IF;
  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly INTO v_plan
    FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
  UPDATE saas_immobilier.agency_subscriptions SET status = 'cancelled', updated_at = now() WHERE id = v_sub.id;
  UPDATE saas_immobilier.agencies SET status = 'suspended', suspended_at = now(),
         suspended_reason = COALESCE(p_reason, 'suspension administrateur'), updated_at = now()
   WHERE id = p_agency_id;
  INSERT INTO saas_immobilier.subscription_events
    (agency_id, event_type, plan_from_id, plan_from_name, mensualite_from, mensualite_to,
     mensualite_variation, reason, actor_id)
  VALUES (p_agency_id, 'suspension', v_sub.plan_id, COALESCE(v_plan.display_name, v_plan.name),
          v_plan.price_monthly, 0, -COALESCE(v_plan.price_monthly, 0),
          COALESCE(p_reason, 'suspension administrateur'), auth.uid())
  RETURNING id INTO v_event;
  RETURN jsonb_build_object('suspended', true, 'event_id', v_event,
                            'mensualite_variation', -COALESCE(v_plan.price_monthly, 0));
END
$fn$;

-- §4. Réactivation : ancienne version (offrait un mois d'abonnement).
CREATE OR REPLACE FUNCTION public.admin_reactivate_agency(
  p_agency_id uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_sub record; v_plan record; v_event uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = 'P0002';
  END IF;
  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly INTO v_plan
    FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
  UPDATE saas_immobilier.agency_subscriptions
     SET status = 'active',
         ends_at = GREATEST(COALESCE(ends_at, CURRENT_DATE), CURRENT_DATE + interval '1 month')::date,
         trial_ends_at = NULL, updated_at = now()
   WHERE id = v_sub.id;
  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
   WHERE id = p_agency_id;
  INSERT INTO saas_immobilier.subscription_events
    (agency_id, event_type, plan_to_id, plan_to_name, mensualite_from, mensualite_to,
     mensualite_variation, reason, actor_id)
  VALUES (p_agency_id, 'reactivation', v_sub.plan_id, COALESCE(v_plan.display_name, v_plan.name),
          0, v_plan.price_monthly, COALESCE(v_plan.price_monthly, 0),
          COALESCE(p_reason, 'reactivation administrateur'), auth.uid())
  RETURNING id INTO v_event;
  RETURN jsonb_build_object('reactivated', true, 'event_id', v_event,
                            'mensualite_variation', COALESCE(v_plan.price_monthly, 0));
END
$fn$;

-- §5. `admin_assign_plan` : plus de levée de suspension implicite.
CREATE OR REPLACE FUNCTION public.admin_assign_plan(
  p_agency_id uuid,
  p_plan_id uuid,
  p_status text DEFAULT 'active'::text,
  p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub_id uuid; v_plan record; v_status text := COALESCE(NULLIF(btrim(p_status),''),'active');
  v_ends date; v_agency record; v_owner uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('active','trial','past_due','cancelled','expired') THEN
    RAISE EXCEPTION 'statut d abonnement invalide : %', v_status USING ERRCODE = '22023';
  END IF;
  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency INTO v_plan
    FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  IF v_plan.id IS NULL THEN RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002'; END IF;
  SELECT a.id, a.name, a.status INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002'; END IF;
  SELECT s.id INTO v_sub_id FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END, s.created_at DESC
   LIMIT 1 FOR UPDATE;
  v_ends := (CURRENT_DATE + interval '1 month')::date;
  IF v_sub_id IS NULL THEN
    INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at, ends_at, trial_ends_at)
    VALUES (p_agency_id, v_plan.id, v_status, now(),
            CASE WHEN v_status IN ('cancelled','expired') THEN NULL ELSE v_ends END, NULL)
    RETURNING id INTO v_sub_id;
  ELSE
    UPDATE saas_immobilier.agency_subscriptions s
       SET plan_id = v_plan.id, status = v_status,
           ends_at = CASE WHEN v_status IN ('cancelled','expired') THEN s.ends_at
                          WHEN s.ends_at IS NULL OR s.ends_at < CURRENT_DATE THEN v_ends
                          ELSE s.ends_at END,
           trial_ends_at = CASE WHEN v_status = 'trial' THEN s.trial_ends_at ELSE NULL END
     WHERE s.id = v_sub_id;
  END IF;
  IF v_agency.status = 'pending' AND v_status <> 'cancelled' THEN
    UPDATE saas_immobilier.agencies a SET status='active', pending_note=NULL, pending_updated_at=now(),
           suspended_at=NULL, suspended_reason=NULL, updated_at=now() WHERE a.id = p_agency_id;
  END IF;
  SELECT am.user_id INTO v_owner FROM saas_immobilier.agency_members am
   WHERE am.agency_id = p_agency_id AND am.role = 'owner' ORDER BY am.created_at ASC LIMIT 1;
  INSERT INTO saas_immobilier.usage_events (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (p_agency_id, auth.uid(), 'admin_plan_assigned', 'agency', p_agency_id,
          jsonb_build_object('plan_id', v_plan.id, 'status', v_status, 'note', p_note, 'subscription_id', v_sub_id),
          'admin_plan_assigned_' || p_agency_id::text || '_' || extract(epoch from now())::bigint::text);
  IF v_owner IS NOT NULL AND v_status = 'active' THEN
    INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
    VALUES (p_agency_id, v_owner, 'system', 'Votre offre est activée',
            'L''offre ' || COALESCE(v_plan.display_name, v_plan.name) || ' est active jusqu''au ' || to_char(v_ends,'DD/MM/YYYY') || '.',
            jsonb_build_object('plan_id', v_plan.id, 'ends_at', v_ends));
  END IF;
  RETURN jsonb_build_object('agency_id', p_agency_id, 'subscription_id', v_sub_id, 'plan_id', v_plan.id,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name), 'status', v_status, 'ends_at', v_ends);
END
$fn$;

-- §6. Ancienne primitive `reactivate_agency` : réécrite de façon autonome.
CREATE OR REPLACE FUNCTION public.reactivate_agency(p_agency_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL,
         auto_suspend_disabled_until = now() + interval '30 days'
   WHERE id = p_agency_id;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO saas_immobilier.activity_log (agency_id, user_id, action, entity_type, entity_id, summary, metadata)
  VALUES (p_agency_id, auth.uid(), 'agency_reactivated', 'agency', p_agency_id,
          'Reactivation manuelle par un administrateur plateforme',
          jsonb_build_object('reason', COALESCE(p_reason,'manual'),
                             'auto_suspend_disabled_until', now() + interval '30 days'));
  RETURN true;
END
$fn$;

-- §7. Contrôles de fin (aucune écriture : vérifie que le rollback a bien pris)
DO $$
DECLARE
  v_create text := pg_get_functiondef('public.agency_create_payment_request(uuid,uuid,integer)'::regprocedure);
  v_react  text := pg_get_functiondef('public.admin_reactivate_agency(uuid,text)'::regprocedure);
  v_assign text := pg_get_functiondef('public.admin_assign_plan(uuid,uuid,text,text)'::regprocedure);
BEGIN
  IF to_regprocedure('public.payment_reference()') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback incomplet : public.payment_reference() existe encore';
  END IF;
  IF position('SI-' in v_create) = 0 THEN
    RAISE EXCEPTION 'rollback incomplet : la creation de demande ne genere pas de reference SI-';
  END IF;
  IF position('agency_plan_state' in v_react) > 0 THEN
    RAISE EXCEPTION 'rollback incomplet : admin_reactivate_agency est encore la version corrigee';
  END IF;
  IF position('agency_reactivated' in v_assign) > 0 THEN
    RAISE EXCEPTION 'rollback incomplet : admin_assign_plan leve encore la suspension';
  END IF;
  IF to_regprocedure('public.admin_suspend_agency(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'rollback incomplet : admin_suspend_agency absent';
  END IF;
END $$;

COMMIT;
