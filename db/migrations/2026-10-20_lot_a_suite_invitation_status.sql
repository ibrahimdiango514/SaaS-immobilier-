-- =============================================================================
-- LOT A (suite) — POINT 4 : diagnostic d'invitation + limitation de tentatives
--
-- VERSION DURCIE : 3 écarts avec le texte initialement approuvé, demandés par la
-- revue de sécurité (b) et (c) :
--   1. plus aucune donnée d'agence renvoyée pour un jeton invalide/expiré/utilisé
--      (états fusionnés en 'invalid' — pas d'oracle),
--   2. EXECUTE accordé à service_role SEULEMENT (plus à anon/authenticated) :
--      seule l'Edge Function, qui limite les tentatives, peut l'appeler,
--   3. ajout d'une table de tentatives + fonction de contrôle (exigence (c)).
--
-- Additif uniquement : aucune table, colonne ou politique existante modifiée.
-- Retour arrière : db/rollback/2026-10-20_lot_a_suite_rollback.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Diagnostic d'un jeton SANS le consommer
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_invitation_status(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_hash text;
  v_inv  record;
  v_ag   record;
BEGIN
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RETURN jsonb_build_object('state','invalid');
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  SELECT id, agency_id, role, expires_at, used_at, revoked_at
    INTO v_inv
    FROM saas_immobilier.agency_invitations
   WHERE token_hash = v_hash;

  -- Invalide, révoqué, déjà utilisé et expiré renvoient le MÊME état.
  -- Distinguer ces cas créerait un oracle permettant de sonder des jetons.
  IF NOT FOUND
     OR v_inv.revoked_at IS NOT NULL
     OR v_inv.used_at   IS NOT NULL
     OR v_inv.expires_at < now() THEN
    RETURN jsonb_build_object('state','invalid');
  END IF;

  SELECT id, name, status INTO v_ag
    FROM saas_immobilier.agencies
   WHERE id = v_inv.agency_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state','invalid');
  END IF;

  -- Agence suspendue : l'agent doit le savoir, c'est une information qui le
  -- concerne directement et qu'il découvrira de toute façon à la connexion.
  IF v_ag.status = 'suspended' THEN
    RETURN jsonb_build_object('state','agency_suspended');
  END IF;

  -- Jeton valable : le nom de l'agence et le rôle sont NÉCESSAIRES à l'agent
  -- (il doit savoir où il met les pieds avant de choisir un mot de passe).
  -- agency_id n'est PAS renvoyé : il ne sert qu'au traitement serveur.
  RETURN jsonb_build_object(
    'state',       'valid',
    'agency_name', v_ag.name,
    'role',        v_inv.role,
    'expires_at',  v_inv.expires_at,
    -- champs internes, non exposés par l'Edge Function
    '_agency_id',  v_inv.agency_id,
    '_invitation_id', v_inv.id
  );
END
$fn$;

-- service_role SEULEMENT. La fonction n'est pas appelable depuis le navigateur :
-- l'Edge Function redeem-agency-invitation est le seul point d'entrée et c'est
-- elle qui applique la limitation de tentatives.
-- REVOKE ... FROM PUBLIC ne suffit PAS : Supabase accorde des privilèges par
-- défaut EXPLICITES à anon et authenticated, que PUBLIC ne couvre pas.
-- Vérifié en base : sans la ligne ci-dessous, les droits restaient
-- « postgres, anon, authenticated, service_role ».
REVOKE ALL ON FUNCTION public.agency_invitation_status(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agency_invitation_status(text) TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Limitation de tentatives (exigence (c)) — par jeton ET par IP
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.invitation_attempts (
  id           uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  token_hash   text,
  ip_hash      text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- Aucune donnée personnelle en clair : le jeton et l'IP sont hachés.
CREATE INDEX IF NOT EXISTS invitation_attempts_token_idx
  ON saas_immobilier.invitation_attempts (token_hash, attempted_at);
CREATE INDEX IF NOT EXISTS invitation_attempts_ip_idx
  ON saas_immobilier.invitation_attempts (ip_hash, attempted_at);

COMMENT ON TABLE saas_immobilier.invitation_attempts IS
  'LOT A — tentatives de rachat d''invitation, pour limitation de débit. Jeton et IP hachés (sha256).';

-- Journalise une tentative et indique si elle est autorisée.
-- Seuils : 5 tentatives par jeton / heure, 20 par IP / heure.
CREATE OR REPLACE FUNCTION public.register_invitation_attempt(
  p_token text,
  p_ip    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_token_hash text;
  v_ip_hash    text;
  v_by_token   integer;
  v_by_ip      integer;
  v_window     interval := interval '1 hour';
  v_max_token  integer := 5;
  v_max_ip     integer := 20;
BEGIN
  v_token_hash := encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
  v_ip_hash    := encode(extensions.digest(coalesce(p_ip,'inconnue'), 'sha256'), 'hex');

  -- Purge au-delà de la fenêtre : la table ne grossit pas indéfiniment.
  DELETE FROM saas_immobilier.invitation_attempts
   WHERE attempted_at < now() - v_window;

  SELECT count(*) INTO v_by_token
    FROM saas_immobilier.invitation_attempts
   WHERE token_hash = v_token_hash AND attempted_at >= now() - v_window;

  SELECT count(*) INTO v_by_ip
    FROM saas_immobilier.invitation_attempts
   WHERE ip_hash = v_ip_hash AND attempted_at >= now() - v_window;

  IF v_by_token >= v_max_token THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'too_many_attempts_for_this_link');
  END IF;

  IF v_by_ip >= v_max_ip THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'too_many_attempts_from_this_address');
  END IF;

  INSERT INTO saas_immobilier.invitation_attempts (token_hash, ip_hash)
  VALUES (v_token_hash, v_ip_hash);

  RETURN jsonb_build_object('allowed', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.register_invitation_attempt(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_invitation_attempt(text, text) TO service_role;
