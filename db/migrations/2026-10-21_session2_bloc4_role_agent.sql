-- =============================================================================
-- SESSION 2 — BLOC 4 : RÔLE AGENT — CA INTERDIT PARTOUT, PHOTOS AUTORISÉES
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21 via execute_query
-- Rollback : db/rollback/2026-10-21_session2_bloc4_role_agent.sql
--
-- ⚠️ DEUX POLITIQUES RLS EXISTANTES MODIFIÉES (nécessaires à ce bloc).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. LE CHIFFRE D'AFFAIRES EST RÉSERVÉ AUX GESTIONNAIRES
--
-- Avant : `revenue_operations_select_member` → USING (is_agency_member(agency_id))
--         donc UN AGENT voyait toutes les opérations de CA, les montants et les
--         commissions de son agence.
-- Après : propriétaire, administrateur d'agence, ou administrateur plateforme.
--
-- `has_agency_role(agency_id, 'admin')` couvre owner ET admin (la fonction
-- contient déjà `required_role='admin' AND am.role='owner'`).
-- La politique `revenue_operations_admin_all` (ALL, is_platform_admin) est
-- inchangée : l'admin plateforme garde la main pour l'exploitation.
--
-- Politique renommée pour que son nom dise la vérité (`_member` → `_manager`).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS revenue_operations_select_member ON saas_immobilier.revenue_operations;
CREATE POLICY revenue_operations_select_manager ON saas_immobilier.revenue_operations
  FOR SELECT TO authenticated
  USING (
    public.has_agency_role(revenue_operations.agency_id, 'admin')
    OR public.is_platform_admin()
  );

-- -----------------------------------------------------------------------------
-- 2. L'AGENT PEUT DE NOUVEAU SUPPRIMER UNE PHOTO
--
-- Avant : `property_media_delete_admin` → USING (has_agency_role(...,'admin'))
--         un agent ne pouvait pas supprimer de photo.
-- Après : tout membre actif de l'agence, cohérent avec INSERT et UPDATE qui
--         étaient déjà à `is_agency_member`.
--
-- Consigne : l'agent ajoute, modifie et supprime biens, photos, contacts,
-- pipeline, visites — SEUL le chiffre d'affaires lui est interdit.
-- L'archivage et la suppression d'un BIEN restent réservés à owner/admin :
-- `properties_delete_admin` (has_agency_role 'admin') n'est PAS modifiée, et
-- `public.archive_property` / `public.delete_property_with_media` gardent leur
-- garde interne `has_agency_role(...,'admin')` (BLOC 6, session 1).
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS property_media_delete_admin ON saas_immobilier.property_media;
CREATE POLICY property_media_delete_member ON saas_immobilier.property_media
  FOR DELETE TO authenticated
  USING (public.is_agency_member(property_media.agency_id));

-- -----------------------------------------------------------------------------
-- VÉRIFICATIONS
-- -----------------------------------------------------------------------------
SELECT tablename, policyname, cmd, coalesce(qual, with_check) AS regle
  FROM pg_policies
 WHERE schemaname = 'saas_immobilier'
   AND (tablename = 'revenue_operations'
        OR (tablename = 'property_media' AND cmd = 'DELETE'))
 ORDER BY tablename, cmd, policyname;
-- attendu :
--   property_media     | property_media_delete_member  | DELETE | is_agency_member(agency_id)
--   revenue_operations | revenue_operations_admin_all  | ALL    | is_platform_admin()
--   revenue_operations | revenue_operations_select_manager | SELECT | (has_agency_role(agency_id,'admin') OR is_platform_admin())

-- Points vérifiés et NON modifiés :
--   • aucune vue ni vue matérialisée dans public / saas_immobilier (donc aucun
--     autre chemin d'exposition du CA) ;
--   • `public.property_delete_impact` expose des montants MAIS sa garde interne
--     `has_agency_role(...,'admin')` interdit déjà l'appel par un agent ;
--   • `public.delete_property_with_media` : garde interne admin, inchangée ;
--   • `saas_immobilier.sync_property_revenue` : trigger interne, inchangé.
