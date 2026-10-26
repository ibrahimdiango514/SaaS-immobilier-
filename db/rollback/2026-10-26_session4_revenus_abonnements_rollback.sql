-- =============================================================================
-- ROLLBACK — SESSION 4 : REVENUS ABONNEMENTS
-- =============================================================================
-- ⚠️  NE PAS EXÉCUTER SANS ACCORD.
--
-- Ce rollback est purement soustractif : il supprime les objets AJOUTÉS par
-- 2026-10-26_session4_revenus_abonnements.sql. Il ne touche à aucune fonction
-- préexistante (platform_subscription_revenue, admin_assign_plan, etc.), qui
-- n'ont pas été modifiées par cette migration.
--
-- ATTENTION : la dernière partie supprime les colonnes plan_id et reference de
-- subscription_payments. Les valeurs qu'elles contiennent seront perdues. Pour
-- un simple retour en arrière fonctionnel, exécuter seulement la partie 1
-- (suppression des fonctions) et conserver les colonnes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Fonctions ajoutées (sans effet sur les données)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.platform_revenue_report(integer);
DROP FUNCTION IF EXISTS public.admin_activate_agency_billed(uuid, uuid, numeric, date, text, text, text);
DROP FUNCTION IF EXISTS public.admin_bill_subscription(uuid, uuid, numeric, date, text, text, text);

-- -----------------------------------------------------------------------------
-- 2. Colonnes ajoutées — DESTRUCTIF, à n'exécuter que si l'on veut vraiment
--    revenir à l'état antérieur (perte des références et des offres figées).
-- -----------------------------------------------------------------------------
-- DROP INDEX IF EXISTS saas_immobilier.subscription_payments_plan_id_idx;
-- ALTER TABLE saas_immobilier.subscription_payments DROP COLUMN IF EXISTS reference;
-- ALTER TABLE saas_immobilier.subscription_payments DROP COLUMN IF EXISTS plan_id;
