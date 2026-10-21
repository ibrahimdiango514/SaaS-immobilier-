-- =============================================================================
-- BLOC 10 — WRAPPER public.agence_active  (ADDITIF)
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21 via execute_query
-- Rollback : db/rollback/2026-10-21_bloc10_wrapper_agence_active.sql
--
-- POURQUOI
-- Les Edge Functions appellent `client.rpc('agence_active', …)`. PostgREST
-- résout un appel RPC dans le schéma exposé par défaut, c'est-à-dire `public`.
-- Or `agence_active` n'existait QUE dans `saas_immobilier`
-- (signature `p_agency_id uuid`) : l'appel échouait donc systématiquement
-- (PGRST202 « function public.agence_active not found »).
--
-- Conséquences réelles avant correctif :
--   • create-agency-member  → renvoyait TOUJOURS 403 `agency_suspended`,
--                             la création directe d'un membre était impossible ;
--   • invite-agency-member  → idem, aucun lien d'invitation ne pouvait être créé ;
--   • dashboard-assistant   → aurait renvoyé `agency_suspended` pour toute agence.
-- Ces trois fonctions testaient `if (error || data !== true)` : une erreur RPC
-- était donc interprétée comme « agence suspendue ».
--
-- Ces fonctions passaient en plus `{ agency_id }` au lieu de `{ p_agency_id }`
-- (deuxième cause d'échec). Les deux ont été corrigées et redéployées :
--   create-agency-member v3 → v4   ·   invite-agency-member v2 → v3
--   dashboard-assistant utilisait déjà le bon nom de paramètre.
--
-- Le wrapper respecte la convention du projet : « tables via db() (schéma
-- saas_immobilier), RPC dans public ». Aucune fonction existante n'est modifiée.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.agence_active(p_agency_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT saas_immobilier.agence_active(p_agency_id);
$function$;

-- Même exposition que la fonction d'origine : les membres authentifiés et le
-- service_role peuvent l'appeler, `anon` non.
REVOKE ALL ON FUNCTION public.agence_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agence_active(uuid) TO authenticated, service_role;

-- Vérification attendue :
--   public.agence_active            | auth=true | anon=false | svc=true
--   saas_immobilier.agence_active   | auth=true | anon=false | svc=true
SELECT n.nspname||'.'||p.proname AS fonction,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc_exec
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.proname = 'agence_active' ORDER BY 1;
