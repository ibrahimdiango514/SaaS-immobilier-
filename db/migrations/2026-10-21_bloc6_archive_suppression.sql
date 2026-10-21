-- =============================================================================
-- BLOC 6 — ARCHIVAGE ET SUPPRESSION D'UN BIEN
-- =============================================================================
-- Migration strictement additive SAUF un point, validé explicitement :
-- `public.enforce_property_limit()` est recréée pour exclure les biens archivés
-- du décompte de la limite du plan (une seule ligne change : le filtre du
-- COUNT). Le plafond, l'offre, le message d'erreur et le HINT
-- `plan_limit_properties` restent strictement identiques.
-- Rollback : db/rollback/2026-10-21_bloc6_archive_suppression_rollback.sql
--
-- Découverte importante qui a fixé le design :
--   le trigger existant `trg_sync_property_revenue` (AFTER UPDATE OF status, …)
--   ANNULE l'opération de CA automatique dès que le statut quitte 'sold'/'rented'.
--   Passer un bien vendu à status='archived' aurait donc effacé son CA.
--   → L'archivage utilise une colonne dédiée `is_archived` et NE TOUCHE PAS au
--     statut : le CA, l'historique et les revenus sont intégralement conservés,
--     sans modifier aucun trigger existant.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Colonnes d'archivage
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.properties
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

ALTER TABLE saas_immobilier.properties
  ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone;

COMMENT ON COLUMN saas_immobilier.properties.is_archived IS
  'BLOC 6 : bien masqué des listes courantes mais conservé (historique, CA, statistiques). Ne compte pas dans la limite de biens du plan.';
COMMENT ON COLUMN saas_immobilier.properties.archived_at IS
  'BLOC 6 : date d''archivage (NULL quand le bien est actif).';

-- Index partiel : les listes courantes ne parcourent que les biens non archivés.
CREATE INDEX IF NOT EXISTS properties_agency_not_archived_idx
  ON saas_immobilier.properties (agency_id)
  WHERE is_archived = false;

CREATE INDEX IF NOT EXISTS properties_agency_archived_idx
  ON saas_immobilier.properties (agency_id, archived_at DESC)
  WHERE is_archived = true;

-- -----------------------------------------------------------------------------
-- 2. Limite de biens du plan : les biens archivés ne comptent plus
--    (seule la ligne du COUNT change ; le reste est recopié à l'identique)
-- -----------------------------------------------------------------------------
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

  -- BLOC 6 : un bien archivé ne compte pas dans la limite de l'offre.
  SELECT count(*)::int INTO v_count
    FROM saas_immobilier.properties
   WHERE agency_id = NEW.agency_id
     AND is_archived = false;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Limite de % biens atteinte pour l offre % ( % / % ). Passez a l offre superieure pour ajouter un bien.',
      v_limit, COALESCE(v_plan,'actuelle'), v_count, v_limit
      USING HINT = 'plan_limit_properties';
  END IF;
  RETURN NEW;
END
$function$;

-- -----------------------------------------------------------------------------
-- 3. Impact d'une suppression (lecture seule) — alimente l'avertissement UI
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.property_delete_impact(p_property_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency uuid;
  v_row    saas_immobilier.properties;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM saas_immobilier.properties WHERE id = p_property_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bien introuvable.' USING ERRCODE = 'P0002';
  END IF;
  v_agency := v_row.agency_id;

  IF NOT public.is_agency_member(v_agency) THEN
    RAISE EXCEPTION 'Acces refuse a ce bien.' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'property_id',        v_row.id,
    'title',              v_row.title,
    'reference',          v_row.reference,
    'status',             v_row.status,
    'is_archived',        v_row.is_archived,
    'can_delete',         public.has_agency_role(v_agency, 'admin'),
    'can_archive',        public.has_agency_role(v_agency, 'admin'),
    'archive_suggested',  (v_row.status IN ('sold', 'rented')) AND NOT v_row.is_archived,
    'media_count',        (SELECT count(*) FROM saas_immobilier.property_media WHERE property_id = p_property_id),
    'revenue_operations', (SELECT count(*) FROM saas_immobilier.revenue_operations
                            WHERE property_id = p_property_id AND status <> 'cancelled'),
    'revenue_amount',     COALESCE((SELECT sum(commission) FROM saas_immobilier.revenue_operations
                            WHERE property_id = p_property_id AND status <> 'cancelled'), 0),
    'opportunities',      (SELECT count(*) FROM saas_immobilier.sales_pipeline WHERE property_id = p_property_id),
    'visits',             (SELECT count(*) FROM saas_immobilier.property_visits WHERE property_id = p_property_id),
    'appointments',       (SELECT count(*) FROM saas_immobilier.appointments WHERE property_id = p_property_id)
  );
END
$function$;

-- -----------------------------------------------------------------------------
-- 4. Archivage / désarchivage — ne touche PAS au statut, donc le CA est conservé
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_property(p_property_id uuid, p_archived boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency uuid;
  v_row    saas_immobilier.properties;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise.' USING ERRCODE = '42501';
  END IF;

  SELECT agency_id INTO v_agency FROM saas_immobilier.properties WHERE id = p_property_id;
  IF v_agency IS NULL THEN
    RAISE EXCEPTION 'Bien introuvable.' USING ERRCODE = 'P0002';
  END IF;

  -- Réservé au propriétaire et aux administrateurs de l'agence.
  IF NOT public.has_agency_role(v_agency, 'admin') THEN
    RAISE EXCEPTION 'Seuls le proprietaire ou un administrateur de l agence peuvent archiver un bien.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE saas_immobilier.properties
     SET is_archived = p_archived,
         archived_at = CASE WHEN p_archived THEN now() ELSE NULL END
   WHERE id = p_property_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'property_id', v_row.id,
    'title',       v_row.title,
    'status',      v_row.status,
    'is_archived', v_row.is_archived,
    'archived_at', v_row.archived_at
  );
END
$function$;

-- -----------------------------------------------------------------------------
-- 5. Suppression — renvoie les chemins Storage à purger AVANT le CASCADE
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_property_with_media(p_property_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency  uuid;
  v_title   text;
  v_media   jsonb;
  v_impact  jsonb;
  v_deleted uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise.' USING ERRCODE = '42501';
  END IF;

  SELECT agency_id, title INTO v_agency, v_title
    FROM saas_immobilier.properties WHERE id = p_property_id;
  IF v_agency IS NULL THEN
    RAISE EXCEPTION 'Bien introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.has_agency_role(v_agency, 'admin') THEN
    RAISE EXCEPTION 'Seuls le proprietaire ou un administrateur de l agence peuvent supprimer un bien.'
      USING ERRCODE = '42501';
  END IF;

  -- Fichiers à purger du bucket `property-images` côté client (pas d'accès
  -- Storage depuis une fonction SQL). Capturés AVANT la suppression en cascade.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',           m.id,
           'storage_path', m.storage_path,
           'file_name',    m.file_name
         ) ORDER BY m.sort_order), '[]'::jsonb)
    INTO v_media
    FROM saas_immobilier.property_media m
   WHERE m.property_id = p_property_id;

  -- Rappel de l'impact : revenue_operations.property_id est ON DELETE SET NULL
  -- (le CA est CONSERVÉ mais détaché du bien) ; sales_pipeline et
  -- property_visits sont ON DELETE CASCADE (définitivement perdus).
  SELECT jsonb_build_object(
    'revenue_operations', (SELECT count(*) FROM saas_immobilier.revenue_operations
                            WHERE property_id = p_property_id AND status <> 'cancelled'),
    'opportunities',      (SELECT count(*) FROM saas_immobilier.sales_pipeline WHERE property_id = p_property_id),
    'visits',             (SELECT count(*) FROM saas_immobilier.property_visits WHERE property_id = p_property_id),
    'appointments',       (SELECT count(*) FROM saas_immobilier.appointments WHERE property_id = p_property_id)
  ) INTO v_impact;

  DELETE FROM saas_immobilier.properties WHERE id = p_property_id
  RETURNING id INTO v_deleted;

  RETURN jsonb_build_object(
    'deleted',     v_deleted IS NOT NULL,
    'property_id', p_property_id,
    'agency_id',   v_agency,
    'title',       v_title,
    'media',       v_media,
    'impact',      v_impact
  );
END
$function$;

-- -----------------------------------------------------------------------------
-- 6. Droits d'exécution (mêmes règles que les fonctions Bloc 1-2)
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.property_delete_impact(uuid)              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.archive_property(uuid, boolean)           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.delete_property_with_media(uuid)          FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.property_delete_impact(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_property(uuid, boolean)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_property_with_media(uuid)         TO authenticated, service_role;

-- Note : `public.enforce_property_limit()` est une fonction de trigger. Ses
-- droits d'exécution ne sont volontairement PAS modifiés ici (on ne resserre
-- rien sur un mécanisme de déclenchement existant) : appelée directement, elle
-- échoue de toute façon parce que NEW est NULL. Seul son corps a été recréé.
