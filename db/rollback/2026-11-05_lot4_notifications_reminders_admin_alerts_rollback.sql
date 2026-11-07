-- =============================================================================
-- ROLLBACK NON-DESTRUCTIF — LOT 4 (Notifications, rappels et alertes admin)
-- Conserve 100 % des notifications, clés de déduplication et alertes existantes.
-- =============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_lot4_subscription_event_notifications ON saas_immobilier.subscription_events;
DROP TRIGGER IF EXISTS trg_lot4_online_payment_notifications ON saas_immobilier.online_payments;
DROP TRIGGER IF EXISTS trg_lot4_invoice_notifications ON saas_immobilier.subscription_invoices;
DROP TRIGGER IF EXISTS trg_lot4_agency_lifecycle_notifications ON saas_immobilier.agencies;

DROP FUNCTION IF EXISTS public.admin_mark_all_alerts_read(text);
DROP FUNCTION IF EXISTS public.admin_alerts_center(text, text, text, uuid, date, date, integer);
DROP FUNCTION IF EXISTS public.agency_billing_events(uuid, integer);
DROP FUNCTION IF EXISTS public.agency_mark_all_notifications_read(uuid, text);
DROP FUNCTION IF EXISTS public.agency_mark_notification(uuid, uuid, boolean);
DROP FUNCTION IF EXISTS public.agency_notifications_center(uuid, text, boolean, date, date, integer);

COMMIT;
