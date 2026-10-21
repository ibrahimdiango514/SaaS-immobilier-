-- =============================================================================
-- ROLLBACK BLOC 7 — Consommation IA + canal WhatsApp
-- =============================================================================
-- Annule db/migrations/2026-10-21_bloc7_usage_ia_whatsapp.sql.
-- Migration 100 % additive : le rollback se limite à supprimer les 3 fonctions
-- créées. AUCUNE table, colonne, politique RLS ou fonction existante n'a été
-- touchée, il n'y a donc rien d'autre à restaurer.
-- Les données déjà écrites dans `agency_usage` / `usage_events` sont conservées.
-- =============================================================================

DROP FUNCTION IF EXISTS public.platform_agency_usage();
DROP FUNCTION IF EXISTS public.agency_ai_usage(uuid);
DROP FUNCTION IF EXISTS public.record_ai_usage(uuid, bigint, bigint, bigint, bigint, text, uuid, jsonb);
