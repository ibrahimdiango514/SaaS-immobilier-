-- =============================================================================
-- BLOC 1 + BLOC 2 — Paiement manuel agence & pilotage admin (offres/paiements)
-- Projet Supabase : xbuuhfwobrafcbgtdgjx
-- Retour arrière : db/rollback/2026-10-21_bloc1-2_paiements_admin_rollback.sql
-- =============================================================================
-- STRICTEMENT ADDITIF : 3 nouvelles fonctions SECURITY DEFINER dans `public`.
-- Aucune table créée, aucune colonne ajoutée, aucune politique RLS existante
-- modifiée, aucune donnée existante touchée.
--
-- Réutilise ce qui existe déjà :
--   public.submit_payment_declaration (déjà en base)  -> BLOC 1 écriture
--   public.review_payment_declaration  (déjà en base) -> BLOC 2 validation
--   public.admin_handle_plan_change    (déjà en base) -> BLOC 2 demandes
--   public.admin_change_agency_plan    (déjà en base) -> BLOC 2 clic unique
--   saas_immobilier.platform_settings  (déjà en base) -> instructions paiement
-- =============================================================================


-- #############################################################################
-- §1  BLOC 1 — Lecture côté agence : instructions de paiement + échéance
--      + montant attendu + mes déclarations.
--      Un seul aller-retour réseau au lieu de 4 requêtes.
-- #############################################################################

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

-- Sur Supabase, REVOKE ... FROM PUBLIC ne suffit pas : anon / authenticated /
-- service_role portent des privilèges par défaut explicites.
REVOKE ALL ON FUNCTION public.agency_payment_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_payment_access(uuid) TO authenticated, service_role;


-- #############################################################################
-- §2  BLOC 2 (1) — Écriture des réglages plateforme.
--      Même garde que la politique RLS existante `platform_settings_admin_write`
--      (is_platform_owner) : cette fonction n'élargit aucun droit.
-- #############################################################################

CREATE OR REPLACE FUNCTION public.admin_update_platform_setting(p_key text, p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_value jsonb;
BEGIN
  IF NOT public.is_platform_owner() THEN
    RAISE EXCEPTION 'proprietaire plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'cle de reglage obligatoire' USING ERRCODE = '22023';
  END IF;
  IF btrim(p_key) NOT IN ('payment_instructions','billing') THEN
    RAISE EXCEPTION 'cle de reglage non autorisee' USING ERRCODE = '22023';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'valeur obligatoire' USING ERRCODE = '22023';
  END IF;

  INSERT INTO saas_immobilier.platform_settings (key, value, updated_by)
  VALUES (btrim(p_key), p_value, auth.uid())
  ON CONFLICT (key) DO UPDATE
     SET value = p_value, updated_by = auth.uid(), updated_at = now();

  SELECT value INTO v_value FROM saas_immobilier.platform_settings WHERE key = btrim(p_key);
  RETURN v_value;
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_update_platform_setting(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_platform_setting(text, jsonb) TO authenticated, service_role;


-- #############################################################################
-- §3  BLOC 2 (5) — Graphique des abonnements branché sur les VRAIS plans et
--      les paiements VALIDÉS (subscription_payments n'est alimenté que par
--      review_payment_declaration / enregistrement admin).
-- #############################################################################

CREATE OR REPLACE FUNCTION public.platform_subscription_revenue(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_months integer;
  v_from   date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  v_months := LEAST(GREATEST(COALESCE(p_months, 12), 1), 36);
  v_from   := (date_trunc('month', now()) - ((v_months - 1) || ' month')::interval)::date;

  RETURN jsonb_build_object(
    -- Agrégation par mois : les paiements sont regroupés UNE fois côté base,
    -- puis chaque mois du calendrier récupère sa ligne (0 si aucun paiement).
    'months', (
      SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month_start), '[]'::jsonb)
        FROM (
          SELECT g.month_start,
                 COALESCE(agg.revenue, 0)          AS revenue,
                 COALESCE(agg.paying_agencies, 0)  AS paying_agencies,
                 COALESCE(agg.payments_count, 0)   AS payments_count
            FROM generate_series(v_from, date_trunc('month', now())::date, interval '1 month')
                 AS g(month_start)
            LEFT JOIN (
                   SELECT date_trunc('month', sp.paid_at)::date AS month_start,
                          SUM(sp.amount)                        AS revenue,
                          COUNT(DISTINCT sp.agency_id)          AS paying_agencies,
                          COUNT(*)                              AS payments_count
                     FROM saas_immobilier.subscription_payments sp
                    WHERE sp.paid_at >= v_from
                    GROUP BY 1
                 ) agg ON agg.month_start = g.month_start::date
        ) m
    ),
    'by_plan', (
      SELECT COALESCE(jsonb_agg(row_to_json(b)::jsonb ORDER BY b.sort_order), '[]'::jsonb)
        FROM (
          SELECT p.id, p.name, p.display_name, p.price_monthly, p.currency, p.sort_order,
                 (SELECT count(*) FROM saas_immobilier.agency_subscriptions s
                   WHERE s.plan_id = p.id AND s.status = 'active')   AS active_agencies,
                 (SELECT count(*) FROM saas_immobilier.agency_subscriptions s
                   WHERE s.plan_id = p.id AND s.status = 'trial')    AS trial_agencies,
                 (SELECT count(*) FROM saas_immobilier.agency_subscriptions s
                   WHERE s.plan_id = p.id)                           AS total_agencies,
                 (SELECT COALESCE(SUM(sp.amount), 0)
                    FROM saas_immobilier.subscription_payments sp
                    JOIN saas_immobilier.agency_subscriptions s2 ON s2.id = sp.subscription_id
                   WHERE s2.plan_id = p.id)                          AS revenue_total
            FROM saas_immobilier.plans p
        ) b
    ),
    'totals', (
      SELECT jsonb_build_object(
        'revenue_period', COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp
                                     WHERE sp.paid_at >= v_from), 0),
        'revenue_all',    COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp), 0),
        'payments_period', (SELECT count(*) FROM saas_immobilier.subscription_payments sp
                             WHERE sp.paid_at >= v_from),
        'paying_agencies_period', (SELECT count(DISTINCT sp.agency_id)
                                     FROM saas_immobilier.subscription_payments sp
                                    WHERE sp.paid_at >= v_from),
        'paying_agencies_all', (SELECT count(DISTINCT sp.agency_id)
                                  FROM saas_immobilier.subscription_payments sp),
        'paying_agencies_active', (SELECT count(*) FROM saas_immobilier.agency_subscriptions
                                    WHERE status = 'active'),
        'trial_agencies', (SELECT count(*) FROM saas_immobilier.agency_subscriptions
                            WHERE status = 'trial'),
        'suspended_agencies', (SELECT count(*) FROM saas_immobilier.agencies
                                WHERE status = 'suspended'),
        'expiring_30d', (SELECT count(*) FROM saas_immobilier.agency_subscriptions
                          WHERE ends_at IS NOT NULL
                            AND ends_at >= now()
                            AND ends_at <  (now() + interval '30 day')),
        'overdue', (SELECT count(*) FROM saas_immobilier.agency_subscriptions
                     WHERE ends_at IS NOT NULL AND ends_at < now()),
        'pending_declarations', (SELECT count(*) FROM saas_immobilier.payment_declarations
                                  WHERE status = 'pending'),
        'pending_plan_changes', (SELECT count(*) FROM saas_immobilier.plan_change_requests
                                  WHERE status = 'pending')
      )
    )
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.platform_subscription_revenue(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_subscription_revenue(integer) TO authenticated, service_role;
