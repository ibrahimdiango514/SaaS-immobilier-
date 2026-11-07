-- =============================================================================
-- ROLLBACK NON-DESTRUCTIF — LOT 7 (Sécurité, RLS et privilèges RPC)
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS billing_automation_runs_admin_select ON saas_immobilier.billing_automation_runs;
DROP POLICY IF EXISTS billing_reconciliation_exceptions_admin_select ON saas_immobilier.billing_reconciliation_exceptions;
DROP POLICY IF EXISTS payment_declarations_select_isolated ON saas_immobilier.payment_declarations;
DROP POLICY IF EXISTS subscription_events_select_isolated ON saas_immobilier.subscription_events;
DROP POLICY IF EXISTS subscription_payments_select_isolated ON saas_immobilier.subscription_payments;
DROP POLICY IF EXISTS subscription_invoices_select_isolated ON saas_immobilier.subscription_invoices;
DROP POLICY IF EXISTS usage_events_insert_member ON saas_immobilier.usage_events;
DROP POLICY IF EXISTS usage_events_select_isolated ON saas_immobilier.usage_events;
DROP POLICY IF EXISTS activity_log_insert_member ON saas_immobilier.activity_log;
DROP POLICY IF EXISTS activity_log_select_isolated ON saas_immobilier.activity_log;
DROP POLICY IF EXISTS platform_admins_select_self_or_admin ON saas_immobilier.platform_admins;

COMMIT;
