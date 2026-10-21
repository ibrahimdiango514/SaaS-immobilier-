-- =============================================================================
-- ROLLBACK — SESSION 3 / BLOC 2 (essai gratuit)
-- Retire les fonctions ajoutées et remet les réglages par défaut.
-- Aucune donnée métier n'est supprimée : les essais en cours restent en base
-- (les convertir manuellement en abonnements payants si nécessaire).
-- =============================================================================
DROP FUNCTION IF EXISTS public.agency_effective_quota(uuid);
DROP FUNCTION IF EXISTS public.admin_end_trial(uuid, text);
DROP FUNCTION IF EXISTS public.admin_extend_trial(uuid, integer);
DROP FUNCTION IF EXISTS public.agency_change_plan_during_trial(uuid, uuid);
DROP FUNCTION IF EXISTS public.agency_start_trial(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_set_signup_settings(boolean, integer);
DROP FUNCTION IF EXISTS public.platform_signup_settings();

DELETE FROM saas_immobilier.platform_settings WHERE key IN ('signup','trial');
