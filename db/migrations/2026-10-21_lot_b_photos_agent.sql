-- =============================================================================
-- LOT B (point A) — LIENS PHOTOS POUR L'AGENT SOFIA (n8n)
--
-- NON APPLIQUÉ : en attente d'accord explicite.
-- Additif uniquement : aucune table, colonne ou politique existante modifiée.
-- Retour arrière : db/rollback/2026-10-21_lot_b_photos_agent_rollback.sql
--
-- CONSTAT (vérifié en base avant rédaction) :
--   saas_immobilier.property_media contient DÉJÀ les colonnes nécessaires :
--     id, agency_id, property_id, media_type, storage_path, public_url,
--     file_name, mime_type, file_size, sort_order, metadata, created_at
--   Il n'y a PAS de colonne is_cover : la couverture est la photo de
--   sort_order le plus bas (c'est déjà le comportement de l'application).
--   => Aucune nouvelle colonne n'est nécessaire. Aucun doublon créé.
--
--   21 photos existent : 20 ont public_url rempli, 1 ne l'a pas.
--   Format réel observé (à reproduire exactement) :
--     https://xbuuhfwobrafcbgtdgjx.supabase.co/storage/v1/object/public/
--       property-images/properties/A001/A001_01_Salon.png
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Fonction de lecture pour l'agent Sofia
--    - renvoie les liens du bien, couverture d'abord
--    - renvoie RIEN si l'agence est suspendue
--    - EXECUTE accordé à service_role uniquement : n8n utilise la clé
--      service_role (RLS contournée), donc le garde-fou doit être DANS la
--      fonction et non pas seulement dans les politiques RLS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.property_photos_for_agent(
  p_agency_id   uuid,
  p_property_id uuid
)
RETURNS TABLE (
  property_id  uuid,
  reference    text,
  title        text,
  sort_order   integer,
  is_cover     boolean,
  media_type   text,
  mime_type    text,
  public_url   text,
  storage_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
  SELECT
    m.property_id,
    p.reference,
    p.title,
    m.sort_order,
    -- Pas de colonne is_cover en base : la couverture est le sort_order minimal.
    m.sort_order = min(m.sort_order) OVER (PARTITION BY m.property_id) AS is_cover,
    m.media_type,
    m.mime_type,
    m.public_url,
    m.storage_path
  FROM saas_immobilier.property_media m
  JOIN saas_immobilier.properties p ON p.id = m.property_id
  WHERE m.agency_id   = p_agency_id
    AND m.property_id = p_property_id
    -- Le bien doit bien appartenir à cette agence : empêche de demander les
    -- photos d'un bien d'une autre agence en forged p_agency_id.
    AND p.agency_id   = p_agency_id
    -- Agence suspendue => aucun lien ne sort.
    AND saas_immobilier.agence_active(p_agency_id)
    -- Un lien absent n'est pas exploitable sur WhatsApp : on l'écarte plutôt
    -- que de renvoyer une ligne vide.
    AND m.public_url IS NOT NULL
  ORDER BY m.sort_order, m.created_at;
$fn$;

REVOKE ALL ON FUNCTION public.property_photos_for_agent(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.property_photos_for_agent(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.property_photos_for_agent(uuid, uuid) IS
  'LOT B (point A) — liens publics des photos d''un bien pour l''agent Sofia. service_role uniquement, rien si agence suspendue.';

-- -----------------------------------------------------------------------------
-- 2. Remplissage rétroactif — NON EXÉCUTÉ, à valider séparément.
--    Ne concerne que les lignes dont public_url est NULL (1 ligne sur 21 au
--    moment de la rédaction). Ne touche jamais une ligne déjà remplie.
--
--    UPDATE saas_immobilier.property_media
--       SET public_url = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/storage/v1'
--                        || '/object/public/property-images/' || storage_path
--     WHERE public_url IS NULL;
--
--    Contrôle avant / après :
--      SELECT count(*) FROM saas_immobilier.property_media WHERE public_url IS NULL;
-- -----------------------------------------------------------------------------
