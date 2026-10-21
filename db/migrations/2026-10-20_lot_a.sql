-- =============================================================================
-- LOT A — Offres, limites de plan, paiement manuel, équipe, facturation
-- Projet Supabase : xbuuhfwobrafcbgtdgjx
-- Retour arrière : db/rollback/2026-10-20_lot_a_rollback.sql
-- =============================================================================
-- ADDITIF. Aucune ligne métier préexistante n'est supprimée.
-- Seule entorse assumée et autorisée : mise à jour des prix / limites /
-- libellés des 3 lignes existantes de `plans` (§2). Les `plan_id` ne bougent
-- pas, donc aucune agence ne change d'abonnement.
-- =============================================================================


-- #############################################################################
-- §1  COLONNES AJOUTÉES AUX TABLES EXISTANTES
-- #############################################################################

ALTER TABLE saas_immobilier.plans
  ADD COLUMN IF NOT EXISTS display_name            text,
  ADD COLUMN IF NOT EXISTS setup_fee               numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_photos_per_property integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS monthly_agent_messages  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_follow_ups      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS modules                 jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_order              integer NOT NULL DEFAULT 0;

ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS declaration_id     uuid,
  ADD COLUMN IF NOT EXISTS provider           text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS provider_status    text;

ALTER TABLE saas_immobilier.user_profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE saas_immobilier.agencies
  ADD COLUMN IF NOT EXISTS suspended_at              timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason          text,
  ADD COLUMN IF NOT EXISTS auto_suspend_disabled_until timestamptz;

COMMENT ON COLUMN saas_immobilier.agencies.auto_suspend_disabled_until IS
  'Jusqu''à cette date, le job pg_cron ne suspendra pas l''agence pour impayé. Alimenté par reactivate_agency() pour éviter qu''une réactivation manuelle soit immédiatement annulée.';


-- #############################################################################
-- §2  VALEURS DES 3 PLANS EXISTANTS (UPDATE par id, aucun INSERT)
--     Illimité = 2 000 000 000 (tient dans integer). Le front affiche
--     « Illimité » pour toute limite >= 1 000 000 000.
-- #############################################################################

UPDATE saas_immobilier.plans SET
  display_name            = 'Essentiel',
  price_monthly           = 50000.00,
  setup_fee               = 150000.00,
  max_properties          = 30,
  max_photos_per_property = 10,
  max_members             = 3,
  monthly_agent_messages  = 1000,
  monthly_follow_ups      = 100,
  sort_order              = 1,
  modules                 = '["biens","contacts","pipeline","dashboard","ca_chart"]'::jsonb
WHERE id = '4f457a46-b1b2-407f-9c75-30347d6d9ae0';   -- slug stable : starter

UPDATE saas_immobilier.plans SET
  display_name            = 'Pro',
  price_monthly           = 100000.00,
  setup_fee               = 250000.00,
  max_properties          = 150,
  max_photos_per_property = 30,
  max_members             = 10,
  monthly_agent_messages  = 3000,
  monthly_follow_ups      = 300,
  sort_order              = 2,
  modules                 = '["biens","contacts","pipeline","dashboard","ca_chart","visites","automatisations","ca_filters","ca_export_csv"]'::jsonb
WHERE id = '940bb1ac-6116-42f8-a3d1-2c7d9178692f';   -- slug stable : pro

UPDATE saas_immobilier.plans SET
  display_name            = 'Premium',
  price_monthly           = 200000.00,
  setup_fee               = 400000.00,
  max_properties          = 2000000000,
  max_photos_per_property = 2000000000,
  max_members             = 2000000000,
  monthly_agent_messages  = 8000,
  monthly_follow_ups      = 1000,
  sort_order              = 3,
  modules                 = '["biens","contacts","pipeline","dashboard","ca_chart","visites","automatisations","ca_filters","ca_export_csv","stats_avancees","rapports_mensuels","support_prioritaire"]'::jsonb
WHERE id = 'b7a4ea74-7de5-4b99-9dd6-86bf9b03247a';   -- slug stable : enterprise


-- #############################################################################
-- §3  NOUVELLES TABLES
-- #############################################################################

CREATE TABLE IF NOT EXISTS saas_immobilier.agency_invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'agent',
  token_hash  text NOT NULL,
  invited_by  uuid,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by     uuid,
  revoked_at  timestamptz,
  revoked_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agency_invitations_token_hash
  ON saas_immobilier.agency_invitations (token_hash);
CREATE INDEX IF NOT EXISTS ix_agency_invitations_agency
  ON saas_immobilier.agency_invitations (agency_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas_immobilier.payment_declarations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  amount                numeric NOT NULL,
  currency              text NOT NULL DEFAULT 'XOF',
  method                text NOT NULL,
  transaction_reference text NOT NULL,
  paid_on               date NOT NULL,
  proof_path            text,
  declared_by           uuid,
  status                text NOT NULL DEFAULT 'pending',
  note                  text,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_note           text,
  payment_id            uuid,
  provider              text,
  provider_reference    text,
  provider_status       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_declarations_status
  ON saas_immobilier.payment_declarations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_payment_declarations_agency
  ON saas_immobilier.payment_declarations (agency_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas_immobilier.plan_change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  requested_plan_id uuid NOT NULL REFERENCES saas_immobilier.plans(id),
  current_plan_id   uuid REFERENCES saas_immobilier.plans(id),
  requested_by      uuid,
  note              text,
  status            text NOT NULL DEFAULT 'pending',
  handled_by        uuid,
  handled_at        timestamptz,
  handle_note       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_plan_change_requests_status
  ON saas_immobilier.plan_change_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_plan_change_requests_agency
  ON saas_immobilier.plan_change_requests (agency_id, created_at DESC);

CREATE TABLE IF NOT EXISTS saas_immobilier.platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO saas_immobilier.platform_settings (key, value) VALUES
  ('payment_instructions',
   '{"orange_money":{"name":"","number":""},"wave":{"name":"","number":""}}'::jsonb),
  ('billing', '{"grace_days":5,"reminder_days":[5,0]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TRIGGER payment_declarations_set_updated_at
  BEFORE UPDATE ON saas_immobilier.payment_declarations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER plan_change_requests_set_updated_at
  BEFORE UPDATE ON saas_immobilier.plan_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER platform_settings_set_updated_at
  BEFORE UPDATE ON saas_immobilier.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- #############################################################################
-- §4  FONCTIONS — lecture du plan et des limites
-- #############################################################################

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

CREATE OR REPLACE FUNCTION public.plan_limit_value(p_agency_id uuid, p_key text)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT CASE p_key
           WHEN 'max_properties'          THEN pl.max_properties
           WHEN 'max_members'             THEN pl.max_members
           WHEN 'max_photos_per_property' THEN pl.max_photos_per_property
           WHEN 'monthly_agent_messages'  THEN pl.monthly_agent_messages
           WHEN 'monthly_follow_ups'      THEN pl.monthly_follow_ups
           WHEN 'monthly_conversations'   THEN pl.monthly_conversations
           ELSE NULL
         END
    FROM public.agency_current_plan(p_agency_id) pl;
$fn$;

CREATE OR REPLACE FUNCTION public.agency_has_module(p_agency_id uuid, p_module text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT COALESCE(bool_or(pl.modules @> to_jsonb(p_module::text)), false)
    FROM public.agency_current_plan(p_agency_id) pl;
$fn$;

-- Sièges consommés : membres actifs + membres invités + invitations en attente.
CREATE OR REPLACE FUNCTION public.agency_seat_availability(p_agency_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
  WITH lim AS (SELECT COALESCE((SELECT max_members FROM public.agency_current_plan(p_agency_id)),1) AS v),
       mem AS (SELECT count(*)::int AS c FROM saas_immobilier.agency_members
                WHERE agency_id = p_agency_id AND status IN ('active','invited')),
       inv AS (SELECT count(*)::int AS c FROM saas_immobilier.agency_invitations
                WHERE agency_id = p_agency_id AND used_at IS NULL AND revoked_at IS NULL
                  AND expires_at > now())
  SELECT jsonb_build_object(
    'members_active',  (SELECT count(*)::int FROM saas_immobilier.agency_members
                         WHERE agency_id = p_agency_id AND status = 'active'),
    'members_invited', (SELECT count(*)::int FROM saas_immobilier.agency_members
                         WHERE agency_id = p_agency_id AND status = 'invited'),
    'invitations_pending', (SELECT c FROM inv),
    'seats_used',   (SELECT c FROM mem) + (SELECT c FROM inv),
    'seats_limit',  (SELECT v FROM lim),
    'is_unlimited', (SELECT v FROM lim) >= 1000000000,
    'available',    GREATEST(0, (SELECT v FROM lim) - ((SELECT c FROM mem) + (SELECT c FROM inv)))
  );
$fn$;

-- Déclarée AVANT agency_usage_snapshot : les corps de fonctions SQL sont
-- validés à la création (check_function_bodies), l'ordre de création compte.
CREATE OR REPLACE FUNCTION public.agency_billing_state(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
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
$fn$;

CREATE OR REPLACE FUNCTION public.agency_usage_snapshot(p_agency_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
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
$fn$;


-- #############################################################################
-- §5  FONCTIONS TRIGGER — application CÔTÉ BASE des limites de plan
--     INSERT uniquement : l'existant n'est jamais supprimé ni modifié.
-- #############################################################################

CREATE OR REPLACE FUNCTION public.enforce_property_limit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_limit integer; v_count integer; v_plan text;
BEGIN
  SELECT COALESCE(max_properties, 30), COALESCE(display_name, name)
    INTO v_limit, v_plan FROM public.agency_current_plan(NEW.agency_id);
  IF v_limit IS NULL THEN v_limit := 30; END IF;

  SELECT count(*)::int INTO v_count
    FROM saas_immobilier.properties WHERE agency_id = NEW.agency_id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Limite de % biens atteinte pour l''offre % ( % / % ). Passez à l''offre supérieure pour ajouter un bien.',
      v_limit, COALESCE(v_plan,'actuelle'), v_count, v_limit
      USING HINT = 'plan_limit_properties';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_photo_limit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_limit integer; v_count integer; v_plan text;
BEGIN
  IF NEW.media_type IS DISTINCT FROM 'photo' THEN
    RETURN NEW;   -- vidéos et documents hors limite
  END IF;

  SELECT COALESCE(max_photos_per_property, 10), COALESCE(display_name, name)
    INTO v_limit, v_plan FROM public.agency_current_plan(NEW.agency_id);
  IF v_limit IS NULL THEN v_limit := 10; END IF;

  SELECT count(*)::int INTO v_count
    FROM saas_immobilier.property_media
   WHERE property_id = NEW.property_id AND media_type = 'photo';

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Limite de % photos par bien atteinte pour l''offre % ( % / % ). Passez à l''offre supérieure pour ajouter des photos.',
      v_limit, COALESCE(v_plan,'actuelle'), v_count, v_limit
      USING HINT = 'plan_limit_photos';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.enforce_member_limit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_limit integer; v_used integer; v_plan text;
BEGIN
  SELECT COALESCE(max_members, 3), COALESCE(display_name, name)
    INTO v_limit, v_plan FROM public.agency_current_plan(NEW.agency_id);
  IF v_limit IS NULL THEN v_limit := 3; END IF;

  SELECT ((seats->>'seats_used')::int) INTO v_used
    FROM public.agency_seat_availability(NEW.agency_id) seats;

  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Limite de % utilisateurs atteinte pour l''offre % ( % / % , propriétaire et invitations en attente compris). Passez à l''offre supérieure.',
      v_limit, COALESCE(v_plan,'actuelle'), v_used, v_limit
      USING HINT = 'plan_limit_members';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS properties_enforce_plan_limit ON saas_immobilier.properties;
CREATE TRIGGER properties_enforce_plan_limit
  BEFORE INSERT ON saas_immobilier.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_property_limit();

DROP TRIGGER IF EXISTS property_media_enforce_photo_limit ON saas_immobilier.property_media;
CREATE TRIGGER property_media_enforce_photo_limit
  BEFORE INSERT ON saas_immobilier.property_media
  FOR EACH ROW EXECUTE FUNCTION public.enforce_photo_limit();

DROP TRIGGER IF EXISTS agency_members_enforce_plan_limit ON saas_immobilier.agency_members;
CREATE TRIGGER agency_members_enforce_plan_limit
  BEFORE INSERT ON saas_immobilier.agency_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_member_limit();


-- #############################################################################
-- §6  FONCTIONS — invitations d'équipe (jeton haché, usage unique, 48 h)
-- #############################################################################

CREATE OR REPLACE FUNCTION public.create_agency_invitation(p_agency_id uuid, p_role text)
RETURNS TABLE(invitation_id uuid, token_plain text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_token text; v_hash text; v_exp timestamptz; v_id uuid; v_avail jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'propriétaire ou administrateur de l''agence requis' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin','agent') THEN
    RAISE EXCEPTION 'rôle invalide' USING ERRCODE = '22023';
  END IF;

  SELECT public.agency_seat_availability(p_agency_id) INTO v_avail;
  IF (v_avail->>'available')::int <= 0 THEN
    RAISE EXCEPTION 'Limite de % utilisateurs atteinte ( % / % , invitations en attente comprises).',
      (v_avail->>'seats_limit')::int, (v_avail->>'seats_used')::int, (v_avail->>'seats_limit')::int
      USING HINT = 'plan_limit_members';
  END IF;

  v_token := encode(extensions.gen_random_bytes(32), 'base64');
  v_hash  := encode(extensions.digest(v_token, 'sha256'), 'hex');
  v_exp   := now() + interval '48 hours';

  INSERT INTO saas_immobilier.agency_invitations
    (agency_id, role, token_hash, invited_by, expires_at)
  VALUES (p_agency_id, p_role, v_hash, auth.uid(), v_exp)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, v_token, v_exp;
END
$fn$;

-- Appelée par l'Edge Function avec la clé service role (pas de session).
-- Valide le jeton, le marque consommé (usage unique garanti) et renvoie le contexte.
CREATE OR REPLACE FUNCTION public.redeem_agency_invitation(p_token text, p_email text, p_full_name text)
RETURNS TABLE(invitation_id uuid, agency_id uuid, role text, agency_name text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_hash text; v_row record;
BEGIN
  IF p_token IS NULL OR btrim(p_token) = '' THEN
    RAISE EXCEPTION 'jeton manquant' USING ERRCODE = '22023';
  END IF;
  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  SELECT i.id, i.agency_id, i.role, a.name
    INTO v_row
    FROM saas_immobilier.agency_invitations i
    JOIN saas_immobilier.agencies a ON a.id = i.agency_id
   WHERE i.token_hash = v_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation introuvable' USING ERRCODE = 'P0002', HINT = 'invitation_not_found';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation révoquée' USING ERRCODE = 'P0002', HINT = 'invitation_revoked';
  END IF;
  IF v_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation déjà utilisée' USING ERRCODE = 'P0002', HINT = 'invitation_used';
  END IF;
  IF v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation expirée' USING ERRCODE = 'P0002', HINT = 'invitation_expired';
  END IF;

  UPDATE saas_immobilier.agency_invitations
     SET used_at = now() WHERE id = v_row.id;

  RETURN QUERY SELECT v_row.id, v_row.agency_id, v_row.role, v_row.name;
END
$fn$;

CREATE OR REPLACE FUNCTION public.revoke_agency_invitation(p_invitation_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_agency uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  SELECT agency_id INTO v_agency FROM saas_immobilier.agency_invitations
   WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT public.has_agency_role(v_agency, 'admin') THEN
    RAISE EXCEPTION 'propriétaire ou administrateur de l''agence requis' USING ERRCODE = '42501';
  END IF;
  UPDATE saas_immobilier.agency_invitations
     SET revoked_at = now(), revoked_by = auth.uid()
   WHERE id = p_invitation_id AND used_at IS NULL;
  RETURN true;
END
$fn$;


-- #############################################################################
-- §7  FONCTIONS — changement d'offre
-- #############################################################################

CREATE OR REPLACE FUNCTION public.request_plan_change(p_agency_id uuid, p_plan_id uuid, p_note text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'accès agence refusé' USING ERRCODE = '42501';
  END IF;
  INSERT INTO saas_immobilier.plan_change_requests
    (agency_id, requested_plan_id, current_plan_id, requested_by, note)
  VALUES (p_agency_id, p_plan_id,
          (SELECT id FROM public.agency_current_plan(p_agency_id)),
          auth.uid(), p_note)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
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

CREATE OR REPLACE FUNCTION public.admin_handle_plan_change(p_request_id uuid, p_decision text, p_note text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_req record;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM saas_immobilier.plan_change_requests
   WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_decision = 'approved' THEN
    PERFORM public.admin_change_agency_plan(v_req.agency_id, v_req.requested_plan_id);
  ELSIF p_decision <> 'rejected' THEN
    RAISE EXCEPTION 'décision invalide' USING ERRCODE = '22023';
  END IF;

  UPDATE saas_immobilier.plan_change_requests
     SET status = p_decision, handled_by = auth.uid(),
         handled_at = now(), handle_note = p_note
   WHERE id = p_request_id;
  RETURN true;
END
$fn$;


-- #############################################################################
-- §8  FONCTIONS — paiement manuel (déclaration agence + validation admin)
-- #############################################################################

CREATE OR REPLACE FUNCTION public.submit_payment_declaration(
  p_agency_id uuid, p_amount numeric, p_method text,
  p_transaction_reference text, p_paid_on date, p_proof_path text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'accès agence refusé' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;
  IF p_method NOT IN ('orange_money','wave') THEN
    RAISE EXCEPTION 'moyen de paiement invalide' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_transaction_reference,'')) = '' THEN
    RAISE EXCEPTION 'référence de transaction obligatoire' USING ERRCODE = '22023';
  END IF;

  INSERT INTO saas_immobilier.payment_declarations
    (agency_id, amount, method, transaction_reference, paid_on, proof_path, declared_by)
  VALUES (p_agency_id, p_amount, p_method, btrim(p_transaction_reference),
          COALESCE(p_paid_on, CURRENT_DATE), NULLIF(btrim(COALESCE(p_proof_path,'')),''), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

-- Validation admin : écrit dans subscription_payments (method='manual'),
-- prolonge l'abonnement d'un mois et remet l'agence en active.
CREATE OR REPLACE FUNCTION public.review_payment_declaration(p_declaration_id uuid, p_decision text, p_note text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_dec record; v_sub record; v_payment uuid;
        v_start date; v_end date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved','rejected') THEN
    RAISE EXCEPTION 'décision invalide' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_dec FROM saas_immobilier.payment_declarations
   WHERE id = p_declaration_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'déclaration introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_dec.status <> 'pending' THEN
    RAISE EXCEPTION 'déclaration déjà traitée' USING ERRCODE = '22023';
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = '22023';
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
     SET ends_at = v_end, status = 'active'
   WHERE id = v_sub.id;

  -- Réactivation : garde-fou 3 de la validation (D2)
  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL
   WHERE id = v_dec.agency_id AND status = 'suspended';

  IF FOUND THEN
    INSERT INTO saas_immobilier.activity_log (agency_id, user_id, action, entity_type, entity_id, summary)
    VALUES (v_dec.agency_id, auth.uid(), 'agency_reactivated', 'agency', v_dec.agency_id,
            'Agence réactivée après validation du paiement ' || v_payment);
  END IF;

  UPDATE saas_immobilier.payment_declarations
     SET status='approved', reviewed_by=auth.uid(), reviewed_at=now(),
         review_note=p_note, payment_id=v_payment
   WHERE id = p_declaration_id;

  RETURN v_payment;
END
$fn$;


-- #############################################################################
-- §9  FONCTIONS — impayés : suspension automatique et réactivation manuelle
-- #############################################################################

CREATE OR REPLACE FUNCTION public.suspend_overdue_agencies()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_grace integer; v_row record; v_n integer := 0;
BEGIN
  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_grace IS NULL THEN v_grace := 5; END IF;

  FOR v_row IN
    SELECT a.id, a.name, s.ends_at
      FROM saas_immobilier.agencies a
      JOIN LATERAL (
        SELECT s.ends_at, s.trial_ends_at
          FROM saas_immobilier.agency_subscriptions s
         WHERE s.agency_id = a.id
         ORDER BY (s.status='active') DESC, s.created_at DESC LIMIT 1) s ON true
     WHERE a.status <> 'suspended'
       -- garde-fou 1 : jamais sans échéance, jamais en essai valide
       AND s.ends_at IS NOT NULL
       AND NOT COALESCE(s.trial_ends_at > now(), false)
       AND s.ends_at < now() - (v_grace || ' days')::interval
       -- garde-fou 2 : opt-out admin respecté
       AND (a.auto_suspend_disabled_until IS NULL OR a.auto_suspend_disabled_until < now())
       -- garde-fou 5 : agences liées à un admin plateforme exclues
       AND NOT EXISTS (
             SELECT 1 FROM saas_immobilier.agency_members m
               JOIN saas_immobilier.platform_admins pa ON pa.user_id = m.user_id
              WHERE m.agency_id = a.id AND m.status = 'active' AND pa.status = 'active')
  LOOP
    -- garde-fou 6 : uniquement status (+ trace suspended_at / suspended_reason)
    UPDATE saas_immobilier.agencies
       SET status = 'suspended', suspended_at = now(), suspended_reason = 'unpaid'
     WHERE id = v_row.id;

    -- garde-fou 4 : trace dans le journal d'activité avec la raison
    INSERT INTO saas_immobilier.activity_log (agency_id, action, entity_type, entity_id, summary, metadata)
    VALUES (v_row.id, 'agency_auto_suspended', 'agency', v_row.id,
            'Suspension automatique pour impayé (échéance ' || v_row.ends_at::date ||
            ', grâce ' || v_grace || ' j)',
            jsonb_build_object('reason','unpaid','ends_at',v_row.ends_at,'grace_days',v_grace));
    v_n := v_n + 1;
  END LOOP;

  RETURN v_n;
END
$fn$;

CREATE OR REPLACE FUNCTION public.reactivate_agency(p_agency_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL,
         -- garde-fou 2 : 30 jours de tranquillité pour que le job ne
         -- resuspend pas immédiatement une réactivation manuelle
         auto_suspend_disabled_until = now() + interval '30 days'
   WHERE id = p_agency_id;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO saas_immobilier.activity_log (agency_id, user_id, action, entity_type, entity_id, summary, metadata)
  VALUES (p_agency_id, auth.uid(), 'agency_reactivated', 'agency', p_agency_id,
          'Réactivation manuelle par un administrateur plateforme',
          jsonb_build_object('reason', COALESCE(p_reason,'manual'),
                             'auto_suspend_disabled_until', now() + interval '30 days'));
  RETURN true;
END
$fn$;


-- #############################################################################
-- §10  POLITIQUES RLS AJOUTÉES (aucune politique existante modifiée)
-- #############################################################################

ALTER TABLE saas_immobilier.agency_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.payment_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.plan_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY agency_invitations_select_admin ON saas_immobilier.agency_invitations
  FOR SELECT USING (public.has_agency_role(agency_id,'admin'));
CREATE POLICY agency_invitations_insert_admin ON saas_immobilier.agency_invitations
  FOR INSERT WITH CHECK (public.has_agency_role(agency_id,'admin'));
CREATE POLICY agency_invitations_update_admin ON saas_immobilier.agency_invitations
  FOR UPDATE USING (public.has_agency_role(agency_id,'admin'));
CREATE POLICY agency_invitations_delete_admin ON saas_immobilier.agency_invitations
  FOR DELETE USING (public.has_agency_role(agency_id,'admin'));

CREATE POLICY payment_declarations_insert_member ON saas_immobilier.payment_declarations
  FOR INSERT WITH CHECK (public.is_agency_member(agency_id));
CREATE POLICY payment_declarations_select_member ON saas_immobilier.payment_declarations
  FOR SELECT USING (public.is_agency_member(agency_id));
CREATE POLICY payment_declarations_admin_all ON saas_immobilier.payment_declarations
  FOR ALL USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE POLICY plan_change_requests_insert_member ON saas_immobilier.plan_change_requests
  FOR INSERT WITH CHECK (public.is_agency_member(agency_id));
CREATE POLICY plan_change_requests_select_member ON saas_immobilier.plan_change_requests
  FOR SELECT USING (public.is_agency_member(agency_id));
CREATE POLICY plan_change_requests_admin_all ON saas_immobilier.plan_change_requests
  FOR ALL USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

CREATE POLICY platform_settings_select_authenticated ON saas_immobilier.platform_settings
  FOR SELECT TO authenticated USING (true);
CREATE POLICY platform_settings_admin_write ON saas_immobilier.platform_settings
  FOR ALL TO authenticated USING (public.is_platform_owner()) WITH CHECK (public.is_platform_owner());

-- Lecture des paiements par l'agence : aujourd'hui impossible, la seule
-- politique de subscription_payments est réservée à is_platform_admin().
CREATE POLICY subscription_payments_select_member ON saas_immobilier.subscription_payments
  FOR SELECT USING (public.is_agency_member(agency_id));


-- #############################################################################
-- §11  DROITS D'EXÉCUTION
-- #############################################################################

GRANT EXECUTE ON FUNCTION public.agency_current_plan(uuid)                     TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.plan_limit_value(uuid, text)                  TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.agency_has_module(uuid, text)                 TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.agency_seat_availability(uuid)                TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.agency_usage_snapshot(uuid)                   TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.agency_billing_state(uuid)                    TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.create_agency_invitation(uuid, text)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agency_invitation(uuid)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_agency_invitation(text, text, text)    TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.request_plan_change(uuid, uuid, text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_payment_declaration(uuid, numeric, text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_change_agency_plan(uuid, uuid)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_handle_plan_change(uuid, text, text)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_payment_declaration(uuid, text, text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reactivate_agency(uuid, text)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.suspend_overdue_agencies()                    TO postgres, service_role;


-- #############################################################################
-- §12  BUCKET PRIVÉ des captures de paiement
-- #############################################################################

-- Extrait l'agency_id du premier segment du chemin d'objet.
-- Renvoie NULL si le segment n'est pas un UUID : évite qu'un cast text->uuid
-- fasse échouer toute requête sur storage.objects (les clauses USING de RLS
-- ne garantissent pas l'ordre d'évaluation des conditions).
CREATE OR REPLACE FUNCTION public.storage_agency_id(p_path text)
RETURNS uuid
LANGUAGE sql IMMUTABLE
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT CASE
           WHEN (storage.foldername(p_path))[1] ~*
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN ((storage.foldername(p_path))[1])::uuid
         END;
$fn$;

GRANT EXECUTE ON FUNCTION public.storage_agency_id(text) TO authenticated, anon;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('payment-proofs','payment-proofs', false, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS payment_proofs_insert ON storage.objects;
CREATE POLICY payment_proofs_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payment-proofs');

DROP POLICY IF EXISTS payment_proofs_select ON storage.objects;
CREATE POLICY payment_proofs_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'payment-proofs' AND public.is_platform_admin());

DROP POLICY IF EXISTS payment_proofs_owner_select ON storage.objects;
CREATE POLICY payment_proofs_owner_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'payment-proofs'
         AND public.is_agency_member(public.storage_agency_id(name)));
