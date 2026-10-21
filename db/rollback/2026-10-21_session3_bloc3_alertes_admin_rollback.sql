-- =============================================================================
-- ROLLBACK — SESSION 3 / BLOC 3 (alertes administrateur)
-- Supprime uniquement les objets créés par ce bloc. Les alertes générées
-- disparaissent avec la table (ce sont des messages, pas des données métier).
-- =============================================================================
DROP TRIGGER IF EXISTS admin_alert_agency_created ON saas_immobilier.agencies;
DROP TRIGGER IF EXISTS admin_alert_agency_status  ON saas_immobilier.agencies;
DROP TRIGGER IF EXISTS admin_alert_subscription   ON saas_immobilier.agency_subscriptions;
DROP TRIGGER IF EXISTS admin_alert_payment        ON saas_immobilier.payment_declarations;

DROP FUNCTION IF EXISTS saas_immobilier.alerts_on_agency_insert();
DROP FUNCTION IF EXISTS saas_immobilier.alerts_on_agency_status();
DROP FUNCTION IF EXISTS saas_immobilier.alerts_on_subscription();
DROP FUNCTION IF EXISTS saas_immobilier.alerts_on_payment();

DROP FUNCTION IF EXISTS public.admin_scan_alerts();
DROP FUNCTION IF EXISTS public.admin_mark_alert(uuid, boolean);
DROP FUNCTION IF EXISTS public.admin_alerts(integer);
DROP FUNCTION IF EXISTS saas_immobilier.raise_admin_alert(text,text,text,text,text,uuid,text,text,jsonb);

DROP TABLE IF EXISTS saas_immobilier.admin_alerts;
