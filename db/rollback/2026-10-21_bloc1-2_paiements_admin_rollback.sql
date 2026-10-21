-- =============================================================================
-- RETOUR ARRIÈRE — BLOC 1 + BLOC 2 (paiements & pilotage admin)
-- Annule : db/migrations/2026-10-21_bloc1-2_paiements_admin.sql
-- =============================================================================
-- Ne supprime que les 3 fonctions AJOUTÉES par cette migration.
-- Ne touche à aucune table, aucune donnée, aucune politique RLS existante.
-- =============================================================================

DROP FUNCTION IF EXISTS public.agency_payment_access(uuid);
DROP FUNCTION IF EXISTS public.admin_update_platform_setting(text, jsonb);
DROP FUNCTION IF EXISTS public.platform_subscription_revenue(integer);
