-- =============================================================================
-- SESSION 2 — BLOC 2 : PARCOURS D'ABONNEMENT À LA CRÉATION D'UNE AGENCE
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21 via execute_query
-- Rollback : db/rollback/2026-10-21_session2_bloc2_abonnement.sql
--
-- FLUX VOULU
--   inscription (email + mot de passe)
--   → informations de l'agence
--   → choix de l'offre (comparatif des 3 offres)
--   → paiement + attente de validation
--   → validation par l'administrateur
--   → le dashboard s'ouvre avec les fonctionnalités de l'offre
--
-- PRINCIPE
-- Une nouvelle agence n'a PLUS d'offre active automatique. Elle est créée avec
-- `status = 'pending'` et AUCUNE ligne dans `agency_subscriptions`. L'offre
-- choisie est stockée dans `agencies.pending_plan_id`. C'est
-- `public.admin_activate_pending_agency()` qui crée l'abonnement actif et calcule
-- l'échéance, au moment de la validation.
--
-- LES AGENCES EXISTANTES NE CHANGENT PAS : aucune ligne `agencies` n'est
-- modifiée par ce fichier (aucun UPDATE de données). Les 3 agences actuelles
-- gardent leur statut et leur abonnement.
--
-- ⚠️ MODIFICATION D'UNE FONCTION SQL EXISTANTE : `create_agency_for_self`.
--    Signature inchangée (11 paramètres) → simple CREATE OR REPLACE, aucun
--    risque de surcharge ambiguë. Définition d'origine conservée dans le
--    rollback.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. COLONNES ADDITIVES
-- `agencies.status` accepte déjà 'pending' (contrainte agencies_status_check :
-- active, pending, suspended, trial, cancelled) : aucune contrainte modifiée.
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN IF NOT EXISTS pending_plan_id uuid
    REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pending_note text,
  ADD COLUMN IF NOT EXISTS pending_updated_at timestamptz;

COMMENT ON COLUMN saas_immobilier.agencies.pending_plan_id IS
  'BLOC 2 : offre choisie par l''agence pendant l''attente de validation. Aucune ligne agency_subscriptions n''existe tant que l''administrateur n''a pas approuvé.';
COMMENT ON COLUMN saas_immobilier.agencies.pending_note IS
  'BLOC 2 : motif de refus saisi par l''administrateur, ou note interne de la demande.';

CREATE INDEX IF NOT EXISTS agencies_pending_validation_idx
  ON saas_immobilier.agencies (created_at)
  WHERE status = 'pending';


-- -----------------------------------------------------------------------------
-- 2. DURCISSEMENT DU WRAPPER public.agence_active
-- Le wrapper (créé au BLOC 10) est le point d'entrée unique des Edge Functions.
-- Avant : `status <> 'suspended'` → laissait passer 'pending' ET 'cancelled'.
-- Après : 'active' ou 'trial' seulement. Une agence en attente ne peut donc ni
-- créer de membre, ni générer de lien d'invitation, ni utiliser l'assistant IA.
-- `saas_immobilier.agence_active` (l'originale) n'est PAS modifiée.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agence_active(p_agency_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM saas_immobilier.agencies a
     WHERE a.id = p_agency_id
       AND a.status IN ('active', 'trial')
  );
$function$;

REVOKE ALL ON FUNCTION public.agence_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agence_active(uuid) TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3. FONCTION EXISTANTE MODIFIÉE : create_agency_for_self
-- Changements : `status = 'pending'` (au lieu de 'active'), PLUS AUCUN INSERT
-- dans agency_subscriptions, offre la moins chère enregistrée comme SUGGESTION
-- dans pending_plan_id, notification et journal adaptés.
-- Tout le reste est conservé à l'identique : profil utilisateur, slug,
-- adhésion owner, horaires par défaut, usage_events.
-- -----------------------------------------------------------------------------
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

  -- L'offre la moins chère n'est qu'une SUGGESTION par défaut.
  SELECT id INTO v_plan_id FROM saas_immobilier.plans ORDER BY price_monthly ASC LIMIT 1;

  INSERT INTO saas_immobilier.agencies
    (name, slug, legal_name, phone, email, address, city, country, timezone, currency, status, description, logo_url,
     pending_plan_id, pending_updated_at)
  VALUES
    (btrim(p_name), v_slug, NULLIF(btrim(coalesce(p_legal_name,'')), ''), NULLIF(btrim(coalesce(p_phone,'')), ''),
     NULLIF(btrim(coalesce(p_email,'')), ''), NULLIF(btrim(coalesce(p_address,'')), ''), NULLIF(btrim(coalesce(p_city,'')), ''),
     coalesce(nullif(btrim(coalesce(p_country,'')), ''), 'Mali'),
     coalesce(nullif(btrim(coalesce(p_timezone,'')), ''), 'Africa/Bamako'),
     coalesce(nullif(btrim(coalesce(p_currency,'')), ''), 'XOF'),
     'pending', NULLIF(btrim(coalesce(p_description,'')), ''), NULLIF(btrim(coalesce(p_logo_url,'')), ''),
     v_plan_id, now())
  RETURNING * INTO v_agency;

  INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role, status)
  VALUES (v_agency.id, v_uid, 'owner', 'active');

  -- AUCUN INSERT dans agency_subscriptions : c'est
  -- public.admin_activate_pending_agency() qui crée l'abonnement actif.

  INSERT INTO saas_immobilier.agency_business_hours (agency_id, day_of_week, start_time, end_time, enabled)
  SELECT v_agency.id, d, '08:30'::time, '18:00'::time, true
  FROM generate_series(1, 6) AS d
  ON CONFLICT DO NOTHING;

  INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
  VALUES (
    v_agency.id, v_uid, 'system',
    'Choisissez votre offre et déclarez votre paiement',
    'Votre agence ' || v_agency.name || ' est créée. Elle est en attente de validation : choisissez une offre, réglez l''installation et le premier mois, puis déclarez votre paiement. Votre tableau de bord s''ouvrira dès la validation par l''administrateur.',
    jsonb_build_object('onboarding', true, 'pending_validation', true)
  );

  INSERT INTO saas_immobilier.usage_events (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (v_agency.id, v_uid, 'agency_created', 'agency', v_agency.id, jsonb_build_object('name', v_agency.name, 'city', v_agency.city, 'status', 'pending'), 'agency_created_' || v_agency.id::text);

  RETURN v_agency;
END;
$function$;


-- -----------------------------------------------------------------------------
-- 4. FONCTIONS ADDITIVES — côté agence
-- -----------------------------------------------------------------------------

-- 4.1 L'agence change l'offre choisie tant que ce n'est pas validé.
CREATE OR REPLACE FUNCTION public.agency_select_pending_plan(p_agency_id uuid, p_plan_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_status text;
  v_plan   record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.status INTO v_status FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'offre deja validee : passez par une demande de changement d offre' USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  UPDATE saas_immobilier.agencies a
     SET pending_plan_id = v_plan.id,
         pending_note = NULL,
         pending_updated_at = now(),
         updated_at = now()
   WHERE a.id = p_agency_id;

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'plan_id', v_plan.id,
    'plan_name', coalesce(v_plan.display_name, v_plan.name),
    'amount_due', coalesce(v_plan.setup_fee,0) + coalesce(v_plan.price_monthly,0),
    'currency', coalesce(v_plan.currency,'XOF'),
    'status', 'pending'
  );
END;
$function$;

-- 4.2 État d'attente vu par l'agence (écran d'attente).
CREATE OR REPLACE FUNCTION public.agency_pending_state(p_agency_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
  v_plan   record;
  v_decl   record;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF NOT (public.is_agency_member(p_agency_id) OR public.is_platform_admin()) THEN
      RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT a.id, a.name, a.status, a.pending_plan_id, a.pending_note, a.pending_updated_at, a.created_at
    INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency, pl.modules
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_agency.pending_plan_id;

  SELECT d.id, d.status, d.amount, d.method, d.transaction_reference, d.paid_on, d.review_note, d.created_at
    INTO v_decl
    FROM saas_immobilier.payment_declarations d
   WHERE d.agency_id = p_agency_id
   ORDER BY d.created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'agency_id', v_agency.id,
    'agency_name', v_agency.name,
    'agency_status', v_agency.status,
    'is_pending', v_agency.status = 'pending',
    'pending_since', v_agency.created_at,
    'pending_note', v_agency.pending_note,
    'pending_updated_at', v_agency.pending_updated_at,
    'plan', CASE WHEN v_plan.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_plan.id, 'name', v_plan.name, 'display_name', v_plan.display_name,
        'price_monthly', v_plan.price_monthly, 'setup_fee', v_plan.setup_fee,
        'currency', v_plan.currency, 'modules', v_plan.modules) END,
    'amount_due', coalesce(v_plan.setup_fee,0) + coalesce(v_plan.price_monthly,0),
    'payment_instructions', (SELECT ps.value FROM saas_immobilier.platform_settings ps WHERE ps.key = 'payment_instructions'),
    'latest_declaration', CASE WHEN v_decl.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_decl.id, 'status', v_decl.status, 'amount', v_decl.amount,
        'method', v_decl.method, 'transaction_reference', v_decl.transaction_reference,
        'paid_on', v_decl.paid_on, 'review_note', v_decl.review_note,
        'created_at', v_decl.created_at) END
  );
END;
$function$;


-- -----------------------------------------------------------------------------
-- 5. FONCTIONS ADDITIVES — côté administrateur plateforme
-- -----------------------------------------------------------------------------

-- 5.1 VALIDATION : crée l'abonnement actif, échéance = +1 mois, agence active.
CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(p_agency_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
     SET status = 'active',
         pending_note = NULL,
         pending_updated_at = now(),
         suspended_at = NULL,
         suspended_reason = NULL,
         updated_at = now()
   WHERE a.id = v_agency.id;

  SELECT am.user_id INTO v_owner
    FROM saas_immobilier.agency_members am
   WHERE am.agency_id = v_agency.id AND am.role = 'owner'
   ORDER BY am.created_at ASC LIMIT 1;

  IF v_owner IS NOT NULL THEN
    INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
    VALUES (v_agency.id, v_owner, 'system',
            'Votre offre est activée',
            'L''administrateur a validé votre agence. L''offre ' || coalesce(v_plan.display_name, v_plan.name)
              || ' est active jusqu''au ' || to_char(v_ends, 'DD/MM/YYYY') || '. Votre tableau de bord est ouvert.',
            jsonb_build_object('pending_approved', true, 'plan_id', v_plan.id, 'ends_at', v_ends));
  END IF;

  INSERT INTO saas_immobilier.usage_events (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (v_agency.id, v_owner, 'agency_pending_approved', 'agency', v_agency.id,
          jsonb_build_object('plan_id', v_plan.id, 'ends_at', v_ends),
          'agency_pending_approved_' || v_agency.id::text);

  RETURN jsonb_build_object(
    'agency_id', v_agency.id, 'agency_name', v_agency.name, 'status', 'active',
    'subscription_id', v_sub_id, 'plan_id', v_plan.id,
    'plan_name', coalesce(v_plan.display_name, v_plan.name),
    'starts_at', CURRENT_DATE, 'ends_at', v_ends);
END;
$function$;

-- 5.2 REFUS motivé : l'agence reste 'pending' et voit le motif.
CREATE OR REPLACE FUNCTION public.admin_reject_pending_agency(p_agency_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
  v_owner  uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF btrim(coalesce(p_reason,'')) = '' THEN
    RAISE EXCEPTION 'le motif de refus est obligatoire' USING ERRCODE = '22023';
  END IF;

  SELECT a.id, a.name, a.status INTO v_agency
    FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est pas en attente de validation (statut : %)', v_agency.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE saas_immobilier.agencies a
     SET pending_note = btrim(p_reason),
         pending_updated_at = now(),
         updated_at = now()
   WHERE a.id = v_agency.id;

  SELECT am.user_id INTO v_owner
    FROM saas_immobilier.agency_members am
   WHERE am.agency_id = v_agency.id AND am.role = 'owner'
   ORDER BY am.created_at ASC LIMIT 1;

  IF v_owner IS NOT NULL THEN
    INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
    VALUES (v_agency.id, v_owner, 'system',
            'Votre validation a été refusée',
            'Motif : ' || btrim(p_reason) || '. Vous pouvez corriger votre déclaration de paiement ou changer d''offre, puis demander une nouvelle validation.',
            jsonb_build_object('pending_rejected', true, 'reason', btrim(p_reason)));
  END IF;

  RETURN jsonb_build_object('agency_id', v_agency.id, 'status', 'pending', 'reason', btrim(p_reason));
END;
$function$;

-- 5.3 FILE ADMIN : agences en attente, offre choisie, montant dû, paiement déclaré.
CREATE OR REPLACE FUNCTION public.pending_agencies()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.created_at ASC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT a.id AS agency_id, a.name AS agency_name, a.slug, a.city, a.created_at,
             a.pending_plan_id, a.pending_note, a.pending_updated_at,
             pl.name AS plan_name, pl.display_name AS plan_display_name,
             pl.price_monthly, pl.setup_fee, pl.currency,
             coalesce(pl.setup_fee,0) + coalesce(pl.price_monthly,0) AS amount_due,
             (SELECT up.email FROM saas_immobilier.user_profiles up
               JOIN saas_immobilier.agency_members am ON am.user_id = up.id
              WHERE am.agency_id = a.id AND am.role = 'owner'
              ORDER BY am.created_at ASC LIMIT 1) AS owner_email,
             (SELECT jsonb_build_object('id', d.id, 'status', d.status, 'amount', d.amount,
                                        'method', d.method, 'transaction_reference', d.transaction_reference,
                                        'paid_on', d.paid_on, 'proof_path', d.proof_path, 'created_at', d.created_at)
                FROM saas_immobilier.payment_declarations d
               WHERE d.agency_id = a.id ORDER BY d.created_at DESC LIMIT 1) AS latest_declaration,
             (SELECT count(*) FROM saas_immobilier.payment_declarations d2
               WHERE d2.agency_id = a.id AND d2.status = 'pending') AS pending_declarations_count
        FROM saas_immobilier.agencies a
        LEFT JOIN saas_immobilier.plans pl ON pl.id = a.pending_plan_id
       WHERE a.status = 'pending'
    ) t;

  RETURN jsonb_build_object('agencies', v_rows, 'total', jsonb_array_length(v_rows));
END;
$function$;


-- -----------------------------------------------------------------------------
-- 6. DROITS D'EXÉCUTION (jamais `anon` : le navigateur appelle toujours avec JWT)
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.agency_select_pending_plan(uuid,uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.agency_pending_state(uuid)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_activate_pending_agency(uuid)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_reject_pending_agency(uuid,text)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pending_agencies()                      FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.agency_select_pending_plan(uuid,uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_pending_state(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_activate_pending_agency(uuid)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reject_pending_agency(uuid,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pending_agencies()                     TO authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 7. VÉRIFICATIONS (valeurs constatées après application)
-- -----------------------------------------------------------------------------
-- 7.1 Les 4 fonctions existent, `anon` n'a aucun droit.
SELECT p.proname,
       has_function_privilege('anon',p.oid,'EXECUTE')          AS anon,
       has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
       has_function_privilege('service_role',p.oid,'EXECUTE')  AS svc
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN
       ('agency_select_pending_plan','agency_pending_state',
        'admin_activate_pending_agency','admin_reject_pending_agency','pending_agencies')
 ORDER BY 1;

-- 7.2 create_agency_for_self : signature inchangée, statut pending, sans abonnement.
SELECT pg_get_function_identity_arguments(p.oid) AS args,
       (p.prosrc ILIKE '%pending%') AS statut_pending,
       (p.prosrc ILIKE '%INSERT INTO saas_immobilier.agency_subscriptions%') AS cree_abonnement
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='saas_immobilier' AND p.proname='create_agency_for_self';
-- attendu : 11 paramètres | true | false

-- 7.3 CYCLE COMPLET TESTÉ sur une agence jetable, puis supprimée :
--   agence_active(pending)            = false  ✓
--   admin_reject_pending_agency       -> status 'pending' + motif  ✓
--   admin_activate_pending_agency     -> status 'active'  ✓
--   agence_active(après activation)   = true  ✓
--   abonnement actif avec ends_at non nul créé  ✓
--   seconde validation refusée (« pas en attente de validation »)  ✓
--   nettoyage : 0 ligne restante, les 3 agences réelles inchangées  ✓
