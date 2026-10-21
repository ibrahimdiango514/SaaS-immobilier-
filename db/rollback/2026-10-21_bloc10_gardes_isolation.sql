-- =============================================================================
-- ROLLBACK — BLOC 10 gardes d'isolation et privilèges d'exécution
-- Annule db/migrations/2026-10-21_bloc10_gardes_isolation.sql
--
-- ⚠️ Ce rollback RÉTABLIT TROIS FAILLES :
--   1. `anon` (donc toute personne ayant la clé publique du navigateur) peut
--      appeler `suspend_overdue_agencies()` et suspendre toutes les agences en
--      retard de paiement, en écrivant en base sous l'identité `postgres` ;
--   2. tout utilisateur authentifié peut lire l'offre, les limites, l'usage et
--      l'état de facturation d'UNE AUTRE agence en passant son UUID ;
--   3. `properties_used` recompte les biens archivés, en désaccord avec
--      `enforce_property_limit()`.
-- Ne l'exécuter que si une garde casse un parcours réel.
-- =============================================================================

-- --- B. Remise des deux fonctions dans leur définition d'origine -------------

-- agency_billing_state : définition d'origine, SANS garde d'isolation.
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
BEGIN
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

-- agency_usage_snapshot : définition d'origine, LANGUAGE sql, SANS garde,
-- et comptant les biens archivés dans properties_used.
CREATE OR REPLACE FUNCTION public.agency_usage_snapshot(p_agency_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
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
    'properties_used', (SELECT count(*)::int FROM saas_immobilier.properties
                         WHERE agency_id = p_agency_id),
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
$function$;

-- --- A. Rétablissement des privilèges d'exécution d'origine ------------------
GRANT EXECUTE ON FUNCTION public.suspend_overdue_agencies()                  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_usage_snapshot(uuid)                 TO anon;
GRANT EXECUTE ON FUNCTION public.agency_billing_state(uuid)                  TO anon;
GRANT EXECUTE ON FUNCTION public.agency_current_plan(uuid)                   TO anon;
GRANT EXECUTE ON FUNCTION public.admin_change_agency_plan(uuid,uuid)         TO anon;
GRANT EXECUTE ON FUNCTION public.admin_handle_plan_change(uuid,text,text)    TO anon;
GRANT EXECUTE ON FUNCTION public.reactivate_agency(uuid,text)                TO anon;
GRANT EXECUTE ON FUNCTION public.request_plan_change(uuid,uuid,text)         TO anon;
GRANT EXECUTE ON FUNCTION public.review_payment_declaration(uuid,text,text)  TO anon;
GRANT EXECUTE ON FUNCTION public.submit_payment_declaration(uuid,numeric,text,text,date,text) TO anon;
