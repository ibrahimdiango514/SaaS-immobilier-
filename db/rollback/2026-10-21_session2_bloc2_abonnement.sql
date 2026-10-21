-- =============================================================================
-- ROLLBACK — SESSION 2 BLOC 2 : parcours d'abonnement à la création
-- Annule db/migrations/2026-10-21_session2_bloc2_abonnement.sql
--
-- ⚠️ Après ce rollback, une nouvelle agence est de nouveau créée
--    `status = 'active'` avec un abonnement automatique sur l'offre la moins
--    chère : elle accède immédiatement au dashboard sans validation ni paiement.
-- ⚠️ Les agences passées en 'pending' par la nouvelle version doivent être
--    rebasculées manuellement (voir §5) — ce rollback ne modifie AUCUNE donnée.
-- =============================================================================

-- --- 1. Fonctions additives : suppression -----------------------------------
DROP FUNCTION IF EXISTS public.pending_agencies();
DROP FUNCTION IF EXISTS public.admin_reject_pending_agency(uuid, text);
DROP FUNCTION IF EXISTS public.admin_activate_pending_agency(uuid);
DROP FUNCTION IF EXISTS public.agency_pending_state(uuid);
DROP FUNCTION IF EXISTS public.agency_select_pending_plan(uuid, uuid);

-- --- 2. Wrapper public.agence_active : retour à `status <> 'suspended'` ------
CREATE OR REPLACE FUNCTION public.agence_active(p_agency_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT saas_immobilier.agence_active(p_agency_id);
$function$;

REVOKE ALL ON FUNCTION public.agence_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agence_active(uuid) TO authenticated, service_role;

-- --- 3. create_agency_for_self : DÉFINITION D'ORIGINE (avant BLOC 2) --------
-- status = 'active' + abonnement automatique sur l'offre la moins chère.
CREATE OR REPLACE FUNCTION saas_immobilier.create_agency_for_self(p_name text, p_legal_name text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_country text DEFAULT 'Mali'::text, p_timezone text DEFAULT 'Africa/Bamako'::text, p_currency text DEFAULT 'XOF'::text, p_description text DEFAULT NULL::text, p_logo_url text DEFAULT NULL::text)
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
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentification requise';
  END IF;
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'le nom de l''agence est obligatoire';
  END IF;

  -- S'assurer que le profil utilisateur existe
  INSERT INTO saas_immobilier.user_profiles (id, email, role)
  SELECT v_uid, u.email, 'agency'
  FROM auth.users u
  WHERE u.id = v_uid
  ON CONFLICT (id) DO NOTHING;

  v_slug := lower(regexp_replace(btrim(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug := btrim(v_slug, '-');
  IF v_slug = '' THEN
    v_slug := 'agence';
  END IF;
  IF EXISTS (SELECT 1 FROM saas_immobilier.agencies a WHERE a.slug = v_slug) THEN
    v_slug := v_slug || '-' || left(gen_random_uuid()::text, 8);
  END IF;

  INSERT INTO saas_immobilier.agencies
    (name, slug, legal_name, phone, email, address, city, country, timezone, currency, status, description, logo_url)
  VALUES
    (btrim(p_name), v_slug, NULLIF(btrim(coalesce(p_legal_name,'')), ''), NULLIF(btrim(coalesce(p_phone,'')), ''),
     NULLIF(btrim(coalesce(p_email,'')), ''), NULLIF(btrim(coalesce(p_address,'')), ''), NULLIF(btrim(coalesce(p_city,'')), ''),
     coalesce(nullif(btrim(coalesce(p_country,'')), ''), 'Mali'),
     coalesce(nullif(btrim(coalesce(p_timezone,'')), ''), 'Africa/Bamako'),
     coalesce(nullif(btrim(coalesce(p_currency,'')), ''), 'XOF'),
     'active', NULLIF(btrim(coalesce(p_description,'')), ''), NULLIF(btrim(coalesce(p_logo_url,'')), ''))
  RETURNING * INTO v_agency;

  INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role, status)
  VALUES (v_agency.id, v_uid, 'owner', 'active');

  -- Abonnement starter par défaut
  SELECT id INTO v_plan_id FROM saas_immobilier.plans ORDER BY price_monthly ASC LIMIT 1;
  IF v_plan_id IS NOT NULL THEN
    INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at)
    VALUES (v_agency.id, v_plan_id, 'active', now());
  END IF;

  -- Horaires par défaut (Lundi à Samedi, 08:30 - 18:00)
  INSERT INTO saas_immobilier.agency_business_hours (agency_id, day_of_week, start_time, end_time, enabled)
  SELECT v_agency.id, d, '08:30'::time, '18:00'::time, true
  FROM generate_series(1, 6) AS d
  ON CONFLICT DO NOTHING;

  -- Notification de bienvenue
  INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
  VALUES (
    v_agency.id,
    v_uid,
    'system',
    'Bienvenue sur Sofia Immobilier',
    'Votre agence ' || v_agency.name || ' est configurée et prête. Ajoutez vos premiers biens et contacts !',
    jsonb_build_object('onboarding', true)
  );

  -- Journal d'activité
  INSERT INTO saas_immobilier.usage_events (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (v_agency.id, v_uid, 'agency_created', 'agency', v_agency.id, jsonb_build_object('name', v_agency.name, 'city', v_agency.city), 'agency_created_' || v_agency.id::text);

  RETURN v_agency;
END;
$function$;

-- --- 4. Index et colonnes additives ----------------------------------------
DROP INDEX IF EXISTS saas_immobilier.agencies_pending_validation_idx;

-- Colonnes laissées en place par défaut : elles ne gênent pas l'ancienne version
-- (create_agency_for_self ne les référence plus). Décommenter pour un retrait
-- complet — ATTENTION, cela détruit les offres choisies en attente.
-- ALTER TABLE saas_immobilier.agencies DROP COLUMN IF EXISTS pending_plan_id;
-- ALTER TABLE saas_immobilier.agencies DROP COLUMN IF EXISTS pending_note;
-- ALTER TABLE saas_immobilier.agencies DROP COLUMN IF EXISTS pending_updated_at;

-- --- 5. DONNÉES : agences laissées en 'pending' (à traiter MANUELLEMENT) ----
-- Ce rollback ne modifie aucune donnée. Lister puis traiter au cas par cas :
--   SELECT id, name, slug, status, pending_plan_id, pending_note
--     FROM saas_immobilier.agencies WHERE status = 'pending';
-- Pour rebasculer une agence vers l'ancien comportement (active + abonnement sur
-- l'offre la moins chère), NE PAS le faire à la main : appeler plutôt
-- public.admin_activate_pending_agency(id) AVANT d'exécuter ce rollback, ou
-- recréer l'abonnement explicitement après.
