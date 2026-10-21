-- =============================================================================
-- ROLLBACK — SESSION 2 BLOC 4 : rôle agent
-- Annule db/migrations/2026-10-21_session2_bloc4_role_agent.sql
--
-- ⚠️ Ce rollback RÉTABLIT DEUX COMPORTEMENTS :
--   1. un AGENT peut de nouveau lire toutes les opérations de chiffre
--      d'affaires, les montants et les commissions de son agence ;
--   2. un agent ne peut PLUS supprimer de photo.
-- =============================================================================

-- 1. revenue_operations : retour à la lecture par tout membre.
DROP POLICY IF EXISTS revenue_operations_select_manager ON saas_immobilier.revenue_operations;
CREATE POLICY revenue_operations_select_member ON saas_immobilier.revenue_operations
  FOR SELECT TO authenticated
  USING (public.is_agency_member(revenue_operations.agency_id));

-- 2. property_media : retour à la suppression réservée à owner/admin.
DROP POLICY IF EXISTS property_media_delete_member ON saas_immobilier.property_media;
CREATE POLICY property_media_delete_admin ON saas_immobilier.property_media
  FOR DELETE TO authenticated
  USING (public.has_agency_role(property_media.agency_id, 'admin'));

SELECT tablename, policyname, cmd, coalesce(qual, with_check) AS regle
  FROM pg_policies
 WHERE schemaname = 'saas_immobilier'
   AND (tablename = 'revenue_operations'
        OR (tablename = 'property_media' AND cmd = 'DELETE'))
 ORDER BY tablename, cmd, policyname;
