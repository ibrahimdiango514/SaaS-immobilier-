-- =============================================================================
-- RETOUR ARRIÈRE — LOT A (suite), point 4
-- Annule db/migrations/2026-10-20_lot_a_suite_invitation_status.sql
-- =============================================================================

DROP FUNCTION IF EXISTS public.register_invitation_attempt(text, text);

DROP INDEX IF EXISTS saas_immobilier.invitation_attempts_ip_idx;
DROP INDEX IF EXISTS saas_immobilier.invitation_attempts_token_idx;
DROP TABLE IF EXISTS saas_immobilier.invitation_attempts;

DROP FUNCTION IF EXISTS public.agency_invitation_status(text);

-- Aucune autre modification : cette migration était strictement additive.
-- Les tables agency_invitations / payment_declarations / plan_change_requests /
-- platform_settings et toutes les fonctions du run précédent sont inchangées.
