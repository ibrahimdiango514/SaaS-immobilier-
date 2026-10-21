-- =============================================================================
-- FICHIER DE RETOUR ARRIÈRE — CA automatique + paiements d'abonnements
-- Projet : xbuuhfwobrafcbgtdgjx  ·  Date : 2026-10-20
--
-- Ce fichier contient l'état EXACT d'avant ce lot pour :
--   1. Les politiques RLS de saas_immobilier.revenue_operations (verbatim)
--   2. Les colonnes ajoutées (commission agence/bien, source)
--   3. Le trigger + fonction de synchronisation automatique du CA
--   4. La table saas_immobilier.subscription_payments
--
-- Pour revenir en arrière : exécuter TOUT ce fichier dans l'ordre
-- (SQL Editor Supabase ou psql). Aucune donnée existante AVANT ce lot
-- n'est touchée : la suppression des colonnes retire uniquement les
-- colonnes créées par ce lot ; les lignes revenue_operations créées par
-- le trigger (source='auto') restent en place (section facultative en
-- fin de fichier, commentée, pour les retirer si souhaité).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. RLS : remise en place des 4 politiques d'origine (verbatim relevé le
--    2026-10-20 AVANT modification) et suppression de la nouvelle politique.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS revenue_operations_admin_all ON saas_immobilier.revenue_operations;
DROP POLICY IF EXISTS revenue_operations_select_member ON saas_immobilier.revenue_operations;
DROP POLICY IF EXISTS revenue_operations_insert_member ON saas_immobilier.revenue_operations;
DROP POLICY IF EXISTS revenue_operations_update_member ON saas_immobilier.revenue_operations;
DROP POLICY IF EXISTS revenue_operations_delete_admin ON saas_immobilier.revenue_operations;

CREATE POLICY revenue_operations_select_member
  ON saas_immobilier.revenue_operations
  FOR SELECT
  USING (is_agency_member(agency_id));

CREATE POLICY revenue_operations_insert_member
  ON saas_immobilier.revenue_operations
  FOR INSERT
  WITH CHECK (is_agency_member(agency_id));

CREATE POLICY revenue_operations_update_member
  ON saas_immobilier.revenue_operations
  FOR UPDATE
  USING (is_agency_member(agency_id))
  WITH CHECK (is_agency_member(agency_id));

CREATE POLICY revenue_operations_delete_admin
  ON saas_immobilier.revenue_operations
  FOR DELETE
  USING (has_agency_role(agency_id, 'admin'::text));

-- -----------------------------------------------------------------------------
-- 2. Trigger de CA automatique : suppression (fonction + déclencheur).
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_sync_property_revenue ON saas_immobilier.properties;
DROP FUNCTION IF EXISTS saas_immobilier.sync_property_revenue();

-- -----------------------------------------------------------------------------
-- 3. Colonnes ajoutées par ce lot (suppression pure — additif d'origine).
--    Les CHECK associés tombent avec les colonnes.
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.revenue_operations DROP COLUMN IF EXISTS source;
ALTER TABLE saas_immobilier.properties DROP COLUMN IF EXISTS commission_rate;
ALTER TABLE saas_immobilier.properties DROP COLUMN IF EXISTS rental_commission_rate;
ALTER TABLE saas_immobilier.agencies DROP COLUMN IF EXISTS commission_rate;
ALTER TABLE saas_immobilier.agencies DROP COLUMN IF EXISTS rental_commission_rate;
-- L'index unique partiel (revenu_source_auto_uniq) est supprimé automatiquement
-- avec la colonne revenue_operations.source.

-- -----------------------------------------------------------------------------
-- 4. Table des paiements d'abonnements (créée par ce lot).
--    Attention : supprime aussi l'historique de paiements enregistrés.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS saas_immobilier.subscription_payments;

-- -----------------------------------------------------------------------------
-- 5. FACULTATIF — Lignes de CA créées par le trigger/le rétroactif.
--    Par défaut ELLES SONT CONSERVÉES (ce sont de vraies données issues des
--    statuts des biens). Décommenter UNIQUEMENT si vous voulez les retirer.
-- -----------------------------------------------------------------------------
-- DELETE FROM saas_immobilier.revenue_operations WHERE source = 'auto';

-- =============================================================================
-- FIN DU RETOUR ARRIÈRE
-- =============================================================================
