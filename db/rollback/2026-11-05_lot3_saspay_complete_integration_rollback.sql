-- =============================================================================
-- ROLLBACK NON-DESTRUCTIF — LOT 3 (Intégration SasPay complète)
-- Conserve 100 % des tables, paiements en ligne, événements webhook et exceptions.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_saspay_overview(integer);
DROP FUNCTION IF EXISTS public.agency_online_payments(uuid);
DROP FUNCTION IF EXISTS public.saspay_preview_plan_upgrade(uuid, uuid);
DROP FUNCTION IF EXISTS saas_immobilier.prepare_plan_change_invoice(uuid, uuid);

COMMIT;
