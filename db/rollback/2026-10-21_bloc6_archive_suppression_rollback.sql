-- =============================================================================
-- ROLLBACK BLOC 6 — Archivage et suppression d'un bien
-- =============================================================================
-- Annule db/migrations/2026-10-21_bloc6_archive_suppression.sql.
-- Ordre : fonctions supprimées, limite restaurée à l'identique, colonnes ôtées.
--
-- ATTENTION : `ALTER TABLE … DROP COLUMN is_archived` efface l'information
-- d'archivage. Les biens archivés redeviennent visibles partout et recomptent
-- dans la limite du plan. Les données métier (CA, statuts) ne sont pas touchées
-- puisque l'archivage ne modifiait jamais `status`.
-- =============================================================================

-- 1. Fonctions ajoutées par le Bloc 6
DROP FUNCTION IF EXISTS public.delete_property_with_media(uuid);
DROP FUNCTION IF EXISTS public.archive_property(uuid, boolean);
DROP FUNCTION IF EXISTS public.property_delete_impact(uuid);

-- 2. Restauration À L'IDENTIQUE de la fonction de limite existante
--    (définition relevée avant migration, sans le filtre is_archived).
CREATE OR REPLACE FUNCTION public.enforce_property_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_limit integer; v_count integer; v_plan text;
BEGIN
  SELECT COALESCE(max_properties, 30), COALESCE(display_name, name)
    INTO v_limit, v_plan FROM public.agency_current_plan(NEW.agency_id);
  IF v_limit IS NULL THEN v_limit := 30; END IF;

  SELECT count(*)::int INTO v_count
    FROM saas_immobilier.properties WHERE agency_id = NEW.agency_id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Limite de % biens atteinte pour l offre % ( % / % ). Passez a l offre superieure pour ajouter un bien.',
      v_limit, COALESCE(v_plan,'actuelle'), v_count, v_limit
      USING HINT = 'plan_limit_properties';
  END IF;
  RETURN NEW;
END
$function$;

-- 3. Index et colonnes d'archivage
DROP INDEX IF EXISTS saas_immobilier.properties_agency_archived_idx;
DROP INDEX IF EXISTS saas_immobilier.properties_agency_not_archived_idx;

ALTER TABLE saas_immobilier.properties DROP COLUMN IF EXISTS archived_at;
ALTER TABLE saas_immobilier.properties DROP COLUMN IF EXISTS is_archived;
