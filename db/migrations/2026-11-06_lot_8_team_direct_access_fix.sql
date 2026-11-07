-- =============================================================================
-- LOT 8 — Correctif définitif Espace Équipe (/equipe) : création directe d'agent
-- =============================================================================
-- 1. Aligne agency_seat_availability(uuid) avec agency_current_plan(uuid) -> jsonb
--    et ne décompte que les membres actifs (suppression du flux lien d'invitation).
-- 2. Crée / consolide public.create_agency_member(...) avec provisionnement
--    défensif de saas_immobilier.user_profiles et activation directe ('active').
-- 3. Étend la contrainte agency_members_status_check pour accepter 'inactive'
--    (utilisé par la bascule Activer/Désactiver de /equipe) en plus de 'suspended'.
-- 4. Ajoute les politiques RLS manquantes sur user_profiles (lecture collègues,
--    mise à jour self pour must_change_password) et agency_members (UPDATE admin).
-- =============================================================================

-- 1. Contrainte de statut sur agency_members ('inactive' + 'suspended')
ALTER TABLE saas_immobilier.agency_members
  DROP CONSTRAINT IF EXISTS agency_members_status_check;

ALTER TABLE saas_immobilier.agency_members
  ADD CONSTRAINT agency_members_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'invited'::text, 'suspended'::text, 'inactive'::text, 'removed'::text]));

-- 2. Trigger handle_new_user_profile prenant aussi en charge must_change_password
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_must_change boolean := false;
BEGIN
  BEGIN
    IF jsonb_typeof(NEW.raw_user_meta_data -> 'must_change_password') = 'boolean' THEN
      v_must_change := (NEW.raw_user_meta_data ->> 'must_change_password')::boolean;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_must_change := false;
  END;

  INSERT INTO saas_immobilier.user_profiles (
    id, email, full_name, phone, avatar_url, role, must_change_password
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
    COALESCE(NEW.phone, NEW.raw_user_meta_data ->> 'phone'),
    NEW.raw_user_meta_data ->> 'avatar_url',
    'agency',
    v_must_change
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = COALESCE(EXCLUDED.email, saas_immobilier.user_profiles.email),
    full_name = COALESCE(EXCLUDED.full_name, saas_immobilier.user_profiles.full_name),
    phone = COALESCE(EXCLUDED.phone, saas_immobilier.user_profiles.phone),
    avatar_url = COALESCE(EXCLUDED.avatar_url, saas_immobilier.user_profiles.avatar_url),
    must_change_password = saas_immobilier.user_profiles.must_change_password OR EXCLUDED.must_change_password,
    updated_at = now();

  RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND t.tgname = 'on_auth_user_created_profile'
  ) THEN
    CREATE TRIGGER on_auth_user_created_profile
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user_profile();
  END IF;
END;
$$;

-- 3. Compteur de places : compatible avec agency_current_plan(uuid) -> jsonb
--    et basé exclusivement sur les accès actifs de l'agence.
CREATE OR REPLACE FUNCTION public.agency_seat_availability(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_plan jsonb;
  v_limit int := 1;
  v_active int := 0;
BEGIN
  v_plan := to_jsonb(public.agency_current_plan(p_agency_id));
  IF v_plan IS NOT NULL AND (v_plan ->> 'max_members') IS NOT NULL THEN
    v_limit := GREATEST(1, (v_plan ->> 'max_members')::int);
  ELSE
    SELECT COALESCE(sp.max_members, 1)
      INTO v_limit
      FROM saas_immobilier.agency_subscriptions s
      JOIN saas_immobilier.plans sp ON sp.id = s.plan_id
     WHERE s.agency_id = p_agency_id
       AND s.status IN ('active', 'trial', 'past_due')
     ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
     LIMIT 1;
    v_limit := COALESCE(v_limit, 1);
  END IF;

  SELECT count(*)::int
    INTO v_active
    FROM saas_immobilier.agency_members am
   WHERE am.agency_id = p_agency_id
     AND am.status = 'active';

  RETURN jsonb_build_object(
    'members_active', v_active,
    'members_invited', 0,
    'invitations_pending', 0,
    'seats_used', v_active,
    'seats_limit', v_limit,
    'is_unlimited', v_limit >= 1000000000,
    'available', GREATEST(0, v_limit - v_active)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agency_seat_availability(uuid) TO authenticated, service_role;

-- 4. Provisionnement atomique d'un membre d'agence (création directe)
CREATE OR REPLACE FUNCTION public.create_agency_member(
  p_actor_user_id uuid,
  p_agency_id uuid,
  p_invited_user_id uuid,
  p_role text
)
RETURNS TABLE(membership_id uuid, agency_id uuid, user_id uuid, role text, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_membership_id uuid;
  v_role text;
  v_auth_user record;
BEGIN
  IF p_actor_user_id IS NULL OR p_agency_id IS NULL OR p_invited_user_id IS NULL THEN
    RAISE EXCEPTION 'actor, agency and invited user are required' USING ERRCODE = '22023';
  END IF;

  v_role := lower(btrim(COALESCE(p_role, '')));
  IF v_role NOT IN ('admin', 'manager', 'agent', 'viewer') THEN
    RAISE EXCEPTION 'role is not allowed for agency member creation' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    WHERE am.agency_id = p_agency_id
      AND am.user_id = p_actor_user_id
      AND am.status = 'active'
      AND am.role IN ('owner', 'admin')
  ) AND NOT EXISTS (
    SELECT 1
    FROM saas_immobilier.platform_admins pa
    WHERE pa.user_id = p_actor_user_id
      AND pa.status = 'active'
  ) THEN
    RAISE EXCEPTION 'agency_admin_or_owner_required' USING ERRCODE = '42501';
  END IF;

  SELECT u.id, u.email, u.phone, u.raw_user_meta_data
    INTO v_auth_user
    FROM auth.users u
   WHERE u.id = p_invited_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invited auth user does not exist' USING ERRCODE = '23503';
  END IF;

  -- Garantit l'existence de user_profiles avant l'insertion dans agency_members
  INSERT INTO saas_immobilier.user_profiles (
    id, email, full_name, phone, role, must_change_password
  )
  VALUES (
    v_auth_user.id,
    v_auth_user.email,
    COALESCE(v_auth_user.raw_user_meta_data ->> 'full_name', v_auth_user.raw_user_meta_data ->> 'name'),
    COALESCE(v_auth_user.phone, v_auth_user.raw_user_meta_data ->> 'phone'),
    'agency',
    true
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = COALESCE(EXCLUDED.email, saas_immobilier.user_profiles.email),
    full_name = COALESCE(EXCLUDED.full_name, saas_immobilier.user_profiles.full_name),
    phone = COALESCE(EXCLUDED.phone, saas_immobilier.user_profiles.phone),
    must_change_password = true,
    updated_at = now();

  IF EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    WHERE am.agency_id = p_agency_id
      AND am.user_id = p_invited_user_id
  ) THEN
    RAISE EXCEPTION 'user is already a member of this agency' USING ERRCODE = '23505';
  END IF;

  INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role, status)
  VALUES (p_agency_id, p_invited_user_id, v_role, 'active')
  RETURNING id INTO v_membership_id;

  RETURN QUERY
  SELECT v_membership_id, p_agency_id, p_invited_user_id, v_role, 'active'::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_agency_member(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_agency_member(uuid, uuid, uuid, text) TO service_role;

-- 5. Politiques RLS et droits sur le schéma saas_immobilier (service_role + authenticated)
GRANT USAGE ON SCHEMA saas_immobilier TO service_role, authenticated, anon;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA saas_immobilier TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA saas_immobilier TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA saas_immobilier TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA saas_immobilier GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA saas_immobilier GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA saas_immobilier GRANT EXECUTE ON FUNCTIONS TO service_role;

GRANT SELECT, INSERT, UPDATE ON saas_immobilier.user_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.agency_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.agency_business_hours TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.payment_declarations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.plan_change_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.platform_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.notification_dismissals TO authenticated;

DROP POLICY IF EXISTS user_profiles_select_agency_colleagues ON saas_immobilier.user_profiles;
CREATE POLICY user_profiles_select_agency_colleagues
  ON saas_immobilier.user_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM saas_immobilier.agency_members m1
      JOIN saas_immobilier.agency_members m2 ON m1.agency_id = m2.agency_id
      WHERE m1.user_id = (SELECT auth.uid())
        AND m1.status = 'active'
        AND m2.user_id = saas_immobilier.user_profiles.id
    )
  );

DROP POLICY IF EXISTS user_profiles_insert_self ON saas_immobilier.user_profiles;
CREATE POLICY user_profiles_insert_self
  ON saas_immobilier.user_profiles
  FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS user_profiles_update_self ON saas_immobilier.user_profiles;
CREATE POLICY user_profiles_update_self
  ON saas_immobilier.user_profiles
  FOR UPDATE
  USING ((SELECT auth.uid()) = id)
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS user_profiles_update_admin ON saas_immobilier.user_profiles;
CREATE POLICY user_profiles_update_admin
  ON saas_immobilier.user_profiles
  FOR UPDATE
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS agency_members_insert_admin ON saas_immobilier.agency_members;
CREATE POLICY agency_members_insert_admin
  ON saas_immobilier.agency_members
  FOR INSERT
  WITH CHECK (public.has_agency_role(agency_id, 'admin'));

DROP POLICY IF EXISTS agency_members_update_admin ON saas_immobilier.agency_members;
CREATE POLICY agency_members_update_admin
  ON saas_immobilier.agency_members
  FOR UPDATE
  USING (public.has_agency_role(agency_id, 'admin'))
  WITH CHECK (
    public.has_agency_role(agency_id, 'admin')
    AND (role <> 'owner' OR status = 'active')
  );

DROP POLICY IF EXISTS agency_members_delete_admin ON saas_immobilier.agency_members;
CREATE POLICY agency_members_delete_admin
  ON saas_immobilier.agency_members
  FOR DELETE
  USING (public.has_agency_role(agency_id, 'admin') AND role <> 'owner');

-- 6. Harmonisation des droits RPC (authenticated / anon / service_role) et désambiguïsation PostgREST
DROP FUNCTION IF EXISTS public.admin_alerts(integer, boolean, text);

GRANT EXECUTE ON FUNCTION public.agency_current_plan(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agence_active(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION saas_immobilier.agence_active(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION saas_immobilier.create_agency_for_self(
  text, text, text, text, text, text, text, text, text, text, text, uuid
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION saas_immobilier.mon_etat_compte() TO authenticated, service_role;
GRANT SELECT ON saas_immobilier.plans TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';
