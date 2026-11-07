-- =============================================================================
-- ROLLBACK NON-DESTRUCTIF — LOT 2 (Cycle d'abonnement & facturation)
-- Conserve 100 % des factures, paiements, événements, notifications et colonnes.
-- Désactive uniquement la tâche planifiée LOT 2 si présente.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('sofia_subscription_lifecycle_15m');
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END
$$;

DROP FUNCTION IF EXISTS public.agency_sync_billing_lifecycle(uuid);

COMMIT;
