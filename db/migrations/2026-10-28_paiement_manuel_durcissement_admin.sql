-- =============================================================================
-- DURCISSEMENT — droits d'administration de la plateforme (2026-10-28)
-- Projet Supabase : xbuuhfwobrafcbgtdgjx   ·   schéma métier : saas_immobilier
-- =============================================================================
-- POURQUOI
-- --------
-- Jusqu'ici, `public.is_platform_admin()` renvoyait vrai dans DEUX cas :
--   (1) une ligne active dans `saas_immobilier.platform_admins` ;   ← légitime
--   (2) `saas_immobilier.user_profiles.role = 'admin'`.             ← FAILLE
--
-- Or `user_profiles_update_self` autorise chaque utilisateur à modifier SA
-- propre ligne de profil. N'importe quel compte authentifié pouvait donc
-- exécuter :
--     update saas_immobilier.user_profiles set role = 'admin' where id = auth.uid();
-- et obtenir, sans aucune validation, l'accès complet à la console
-- d'administration : lecture de toutes les agences, de tous les paiements,
-- décision sur les abonnements (donc activation gratuite), justificatifs
-- privés de toutes les agences, réglages de la plateforme…
--
-- C'est exactement ce que la consigne « un champ `role` modifiable par
-- l'utilisateur ne constitue pas une preuve d'autorisation d'administration »
-- interdit. La migration corrige les deux moitiés du problème :
--   §1  la source de vérité des droits admin devient `platform_admins` seul ;
--   §2  la modification de `user_profiles.role` est verrouillée par un trigger
--       (défense en profondeur : même si une politique RLS l'autorisait, la
--       valeur ne peut plus être élevée par l'utilisateur lui-même).
--
-- IMPACT MESURÉ AVANT APPLICATION (base réelle, 2026-10-28) :
--   profils role='admin' ............................ 1
--   administrateurs plateforme actifs ................ 1
--   profils 'admin' SANS ligne platform_admins ....... 0
--   → aucun utilisateur ne perd de droit du fait de §1.
--
-- STRICTEMENT ADDITIF sur les données : aucune ligne n'est supprimée ni
-- modifiée. Retour arrière : voir la fin du fichier.
-- =============================================================================

BEGIN;

-- #############################################################################
-- §1  is_platform_admin() : une seule source de vérité
-- #############################################################################
-- Même signature, même type, mêmes GRANT : aucune fonction appelante ne change.
-- `search_path` vide + références pleinement qualifiées (anti-hijack).
-- `(SELECT auth.uid())` = une seule évaluation par requête (performant en RLS).
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.platform_admins pa
    WHERE pa.user_id = (SELECT auth.uid())
      AND pa.status = 'active'
  );
$function$;

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

COMMENT ON FUNCTION public.is_platform_admin() IS
  'Administrateur plateforme = ligne ACTIVE dans saas_immobilier.platform_admins. '
  'user_profiles.role ne donne AUCUN droit (champ modifiable par l''utilisateur).';

-- #############################################################################
-- §2  Verrou sur l'élévation de `user_profiles.role`
-- #############################################################################
-- Règles :
--   · changement de role par un utilisateur authentifié non admin  → refus (42501) ;
--   · changement de role par un administrateur plateforme          → autorisé ;
--   · contexte sans JWT (migrations, service_role, tâches backend) → autorisé
--     (sinon les scripts d'exploitation seraient bloqués).
-- Aucun impact sur les mises à jour de profil normales (nom, téléphone, avatar) :
-- le trigger ne se déclenche que si `role` change réellement.
CREATE OR REPLACE FUNCTION saas_immobilier.guard_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- Contexte technique : pas de JWT (migration SQL, service_role).
    IF (SELECT auth.uid()) IS NULL THEN
      RETURN NEW;
    END IF;
    IF public.is_platform_admin() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'modification du rôle du profil interdite'
      USING ERRCODE = '42501',
            HINT = 'Les droits d''administration sont portés par saas_immobilier.platform_admins.';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION saas_immobilier.guard_profile_role() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_profile_role_trg ON saas_immobilier.user_profiles;
CREATE TRIGGER guard_profile_role_trg
  BEFORE UPDATE OF role ON saas_immobilier.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.guard_profile_role();

COMMENT ON TRIGGER guard_profile_role_trg ON saas_immobilier.user_profiles IS
  'Un utilisateur ne peut pas s''attribuer role=admin (élévation de privilèges).';

-- #############################################################################
-- §3  Contrôles post-migration (échec = annulation de la transaction)
-- #############################################################################
DO $chk$
DECLARE
  v_def text;
BEGIN
  -- (a) la branche vulnérable a disparu du corps de la fonction
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'is_platform_admin';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'is_platform_admin() introuvable après migration';
  END IF;
  IF v_def ILIKE '%user_profiles%' THEN
    RAISE EXCEPTION 'is_platform_admin() référence encore user_profiles : migration incomplète';
  END IF;
  IF v_def NOT ILIKE '%platform_admins%' THEN
    RAISE EXCEPTION 'is_platform_admin() ne lit plus platform_admins : migration invalide';
  END IF;

  -- (b) le trigger de garde est en place
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'saas_immobilier.user_profiles'::regclass
       AND t.tgname = 'guard_profile_role_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'trigger guard_profile_role_trg absent';
  END IF;

  -- (c) l'administrateur réel conserve ses droits
  IF NOT EXISTS (
    SELECT 1 FROM saas_immobilier.platform_admins pa
     WHERE pa.status = 'active'
  ) THEN
    RAISE EXCEPTION 'aucun administrateur actif : la console serait inaccessible';
  END IF;
END
$chk$;

COMMIT;

-- =============================================================================
-- VÉRIFICATIONS MANUELLES (à exécuter après coup, avec un utilisateur NON admin)
-- =============================================================================
-- 1) L'élévation par le profil échoue :
--      begin;
--      select set_config('request.jwt.claims',
--        '{"sub":"<uuid-utilisateur-simple>","role":"authenticated"}', true);
--      set local role authenticated;
--      update saas_immobilier.user_profiles set role='admin' where id=auth.uid();  -- 42501
--      rollback;
-- 2) Un non-admin n'accède plus à la file de paiements :
--      select public.admin_payment_queue();                                        -- 42501
-- 3) L'administrateur réel (platform_admins actif) fonctionne toujours :
--      select public.admin_payment_queue();                                        -- jsonb
--
-- =============================================================================
-- RETOUR ARRIÈRE (déconseillé : réintroduit la faille)
-- =============================================================================
-- BEGIN;
--   DROP TRIGGER IF EXISTS guard_profile_role_trg ON saas_immobilier.user_profiles;
--   DROP FUNCTION IF EXISTS saas_immobilier.guard_profile_role();
--   CREATE OR REPLACE FUNCTION public.is_platform_admin()
--   RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
--   AS $function$
--     SELECT EXISTS (SELECT 1 FROM saas_immobilier.platform_admins pa
--                     WHERE pa.user_id = (SELECT auth.uid()) AND pa.status = 'active')
--         OR EXISTS (SELECT 1 FROM saas_immobilier.user_profiles up
--                     WHERE up.id = (SELECT auth.uid()) AND up.role = 'admin');
--   $function$;
--   REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon, authenticated, service_role;
--   GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;
-- COMMIT;
-- =============================================================================
