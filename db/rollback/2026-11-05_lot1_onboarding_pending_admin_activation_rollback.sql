-- =============================================================================
-- ROLLBACK — LOT 1 : INSCRIPTION, CHOIX DE L'OFFRE ET ACTIVATION ADMINISTRATIVE
-- =============================================================================
-- Rollback non destructif :
--   • Restaure les définitions antérieures des fonctions SQL et policies RLS.
--   • Désactive le trigger `trg_protect_agency_privileged_columns`.
--   • Conserve les colonnes additives et la table `physical_installation_payments`
--     afin de ne jamais détruire de données historisées.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_protect_agency_privileged_columns ON saas_immobilier.agencies;
DROP FUNCTION IF EXISTS saas_immobilier.protect_agency_privileged_columns();

DROP FUNCTION IF EXISTS public.public_plans_catalog();
DROP FUNCTION IF EXISTS public.admin_record_physical_installation(uuid, numeric, text, text, boolean, date, text);
DROP FUNCTION IF EXISTS public.admin_set_pending_agency_plan(uuid, uuid, text);

-- Restauration des fonctions d'autorisation antérieures
CREATE OR REPLACE FUNCTION public.is_agency_member(target_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    JOIN saas_immobilier.agencies a ON a.id = am.agency_id
    WHERE am.agency_id = target_agency_id
      AND am.user_id = (SELECT auth.uid())
      AND am.status = 'active'
      AND a.status <> 'suspended'
  ) OR public.is_platform_admin();
$function$;

CREATE OR REPLACE FUNCTION public.has_agency_role(target_agency_id uuid, required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    JOIN saas_immobilier.agencies a ON a.id = am.agency_id
    WHERE am.agency_id = target_agency_id
      AND am.user_id = (SELECT auth.uid())
      AND am.status = 'active'
      AND (am.role = required_role OR (required_role = 'admin' AND am.role = 'owner'))
      AND a.status <> 'suspended'
  ) OR public.is_platform_admin();
$function$;

CREATE OR REPLACE FUNCTION saas_immobilier.agence_active(p_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agencies a
    WHERE a.id = p_agency_id
      AND a.status <> 'suspended'
  );
$function$;

-- Restauration des policies RLS antérieures
DROP POLICY IF EXISTS agencies_select_member ON saas_immobilier.agencies;
CREATE POLICY agencies_select_member
  ON saas_immobilier.agencies
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member(id));

DROP POLICY IF EXISTS agencies_update_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_update_admin
  ON saas_immobilier.agencies
  FOR UPDATE
  TO authenticated
  USING (public.has_agency_role(id, 'admin'))
  WITH CHECK (public.has_agency_role(id, 'admin'));

DROP POLICY IF EXISTS agency_members_select_member ON saas_immobilier.agency_members;
CREATE POLICY agency_members_select_member
  ON saas_immobilier.agency_members
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS agency_subscriptions_select_member ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_select_member
  ON saas_immobilier.agency_subscriptions
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS notifications_select_member ON saas_immobilier.notifications;
CREATE POLICY notifications_select_member
  ON saas_immobilier.notifications
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS notifications_update_member ON saas_immobilier.notifications;
CREATE POLICY notifications_update_member
  ON saas_immobilier.notifications
  FOR UPDATE
  TO authenticated
  USING (public.is_agency_member(agency_id))
  WITH CHECK (public.is_agency_member(agency_id));

-- Restauration de `create_agency_for_self` (11 paramètres)
DROP FUNCTION IF EXISTS saas_immobilier.create_agency_for_self(
  text, text, text, text, text, text, text, text, text, text, text, uuid
);

CREATE OR REPLACE FUNCTION saas_immobilier.create_agency_for_self(
  p_name text,
  p_legal_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_country text DEFAULT 'Mali',
  p_timezone text DEFAULT 'Africa/Bamako',
  p_currency text DEFAULT 'XOF',
  p_description text DEFAULT NULL,
  p_logo_url text DEFAULT NULL
)
RETURNS saas_immobilier.agencies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'saas_immobilier', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_slug text;
  v_agency saas_immobilier.agencies;
  v_plan_id uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentification requise'; END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN RAISE EXCEPTION 'le nom de l''agence est obligatoire'; END IF;

  INSERT INTO saas_immobilier.user_profiles (id, email, role)
  SELECT v_uid, u.email, 'agency' FROM auth.users u WHERE u.id = v_uid
  ON CONFLICT (id) DO NOTHING;

  v_slug := lower(regexp_replace(btrim(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug := btrim(v_slug, '-');
  IF v_slug = '' THEN v_slug := 'agence'; END IF;
  IF EXISTS (SELECT 1 FROM saas_immobilier.agencies a WHERE a.slug = v_slug) THEN
    v_slug := v_slug || '-' || left(gen_random_uuid()::text, 8);
  END IF;

  SELECT id INTO v_plan_id FROM saas_immobilier.plans ORDER BY price_monthly ASC LIMIT 1;

  INSERT INTO saas_immobilier.agencies (
    name, slug, legal_name, phone, email, address, city, country, timezone, currency,
    status, description, logo_url, pending_plan_id, pending_updated_at
  ) VALUES (
    btrim(p_name), v_slug, NULLIF(btrim(coalesce(p_legal_name,'')), ''),
    NULLIF(btrim(coalesce(p_phone,'')), ''), NULLIF(btrim(coalesce(p_email,'')), ''),
    NULLIF(btrim(coalesce(p_address,'')), ''), NULLIF(btrim(coalesce(p_city,'')), ''),
    coalesce(nullif(btrim(coalesce(p_country,'')), ''), 'Mali'),
    coalesce(nullif(btrim(coalesce(p_timezone,'')), ''), 'Africa/Bamako'),
    coalesce(nullif(btrim(coalesce(p_currency,'')), ''), 'XOF'),
    'pending', NULLIF(btrim(coalesce(p_description,'')), ''),
    NULLIF(btrim(coalesce(p_logo_url,'')), ''), v_plan_id, now()
  )
  RETURNING * INTO v_agency;

  INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role, status)
  VALUES (v_agency.id, v_uid, 'owner', 'active');

  INSERT INTO saas_immobilier.agency_business_hours (agency_id, day_of_week, start_time, end_time, enabled)
  SELECT v_agency.id, d, '08:30'::time, '18:00'::time, true FROM generate_series(1, 6) AS d
  ON CONFLICT DO NOTHING;

  RETURN v_agency;
END;
$function$;

GRANT EXECUTE ON FUNCTION saas_immobilier.create_agency_for_self(
  text, text, text, text, text, text, text, text, text, text, text
) TO authenticated, service_role;

-- Restauration de `admin_activate_pending_agency(uuid)` antérieure
DROP FUNCTION IF EXISTS public.admin_activate_pending_agency(uuid, text);

CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_status text;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  SELECT a.status INTO v_status FROM saas_immobilier.agencies a WHERE a.id=p_agency_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'agence introuvable' USING ERRCODE='P0002'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'cette agence n''est pas en attente de validation (statut : %)', v_status USING ERRCODE='22023'; END IF;
  RETURN public.admin_activate_agency_journaled(p_agency_id, NULL, 'validation administrateur');
END
$function$;

GRANT EXECUTE ON FUNCTION public.admin_activate_pending_agency(uuid) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.is_agency_member_any_status(uuid);

COMMIT;
