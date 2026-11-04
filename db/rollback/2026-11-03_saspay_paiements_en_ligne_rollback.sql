-- =============================================================================
-- RETOUR ARRIERE — SASPAY PAIEMENTS EN LIGNE (2026-11-03)
-- Projet : xbuuhfwobrafcbgtdgjx
-- NE PAS EXECUTER sans accord : supprime la couche SasPay ajoutee par
-- db/migrations/2026-11-03_saspay_paiements_en_ligne.sql.
--
-- Aucune donnee existante n'est supprimee : seuls les objets ajoutes par la
-- migration sont retires. Les ecritures d'encaisse deja creees
-- (subscription_payments) sont CONSERVEES — elles sont reelles — mais perdent
-- leur lien online_payment_id (colonne retirees en dernier).
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.agency_invoices(uuid);
DROP FUNCTION IF EXISTS public.admin_activate_pending_agency_paid(uuid);
DROP FUNCTION IF EXISTS public.saspay_recent_pending_sessions(integer);
DROP FUNCTION IF EXISTS public.saspay_payment_state(uuid);
DROP FUNCTION IF EXISTS public.saspay_confirm_payment(uuid, uuid, text, uuid, text, numeric, text);
DROP FUNCTION IF EXISTS public.saspay_attach_checkout(uuid, uuid, text, timestamptz);
DROP FUNCTION IF EXISTS public.saspay_create_checkout(uuid, text, uuid, uuid);

DROP POLICY IF EXISTS saspay_webhook_events_admin_select ON saas_immobilier.saspay_webhook_events;
DROP POLICY IF EXISTS online_payments_platform_admin_select ON saas_immobilier.online_payments;
DROP POLICY IF EXISTS online_payments_member_select ON saas_immobilier.online_payments;
ALTER TABLE saas_immobilier.online_payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.saspay_webhook_events DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS saas_immobilier.saspay_webhook_events;
DROP TABLE IF EXISTS saas_immobilier.online_payments;

ALTER TABLE saas_immobilier.subscription_payments
  DROP COLUMN IF EXISTS online_payment_id;

COMMIT;
