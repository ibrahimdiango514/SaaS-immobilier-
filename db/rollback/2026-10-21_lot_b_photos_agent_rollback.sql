-- =============================================================================
-- RETOUR ARRIÈRE — LOT B (point A), liens photos pour l'agent Sofia
-- Annule db/migrations/2026-10-21_lot_b_photos_agent.sql
-- =============================================================================

DROP FUNCTION IF EXISTS public.property_photos_for_agent(uuid, uuid);

-- Le remplissage rétroactif de public_url (s'il a été appliqué) se défait ainsi.
-- Il ne concerne que les lignes qui étaient NULL avant intervention :
--
--   UPDATE saas_immobilier.property_media
--      SET public_url = NULL
--    WHERE public_url LIKE
--      'https://xbuuhfwobrafcbgtdgjx.supabase.co/storage/v1/object/public/property-images/%'
--      AND id IN ( /* les ids relevés avant l'UPDATE */ );
--
-- Aucune table, colonne ou politique n'ayant été créée ni modifiée par cette
-- migration, il n'y a rien d'autre à annuler.
