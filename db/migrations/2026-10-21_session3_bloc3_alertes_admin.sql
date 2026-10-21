-- =============================================================================
-- SESSION 3 — BLOC 3 : ALERTES ADMINISTRATEUR
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21
-- Rollback : db/rollback/2026-10-21_session3_bloc3_alertes_admin_rollback.sql
--
-- Stockage additif : saas_immobilier.admin_alerts (RLS admin uniquement).
-- Alimentation :
--   • triggers  : nouvelle agence, début d'essai / activation d'offre,
--                 changement d'offre, paiement déclaré, suspension ;
--   • scan      : `public.admin_scan_alerts()` pour les événements datés
--                 (essai à J-3, impayé) — idempotent via `alert_key` UNIQUE.
-- Lecture : `public.admin_alerts(limit)` (liste + compteurs),
--           `public.admin_mark_alert(id, read)` (non lue / traitée).
-- Aucune donnée existante n'est modifiée ni supprimée.
-- =============================================================================

CREATE TABLE IF NOT EXISTS saas_immobilier.admin_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  alert_key text UNIQUE,
  kind text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
  action_href text,
  action_label text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_alerts_created_idx ON saas_immobilier.admin_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_alerts_unread_idx ON saas_immobilier.admin_alerts (is_read) WHERE is_read = false;

ALTER TABLE saas_immobilier.admin_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_alerts_select_admin ON saas_immobilier.admin_alerts;
CREATE POLICY admin_alerts_select_admin ON saas_immobilier.admin_alerts
  FOR SELECT TO authenticated USING (public.is_platform_admin());
DROP POLICY IF EXISTS admin_alerts_update_admin ON saas_immobilier.admin_alerts;
CREATE POLICY admin_alerts_update_admin ON saas_immobilier.admin_alerts
  FOR UPDATE TO authenticated USING (public.is_platform_admin()) WITH CHECK (public.is_platform_admin());

-- Producteur interne (non exposé aux clients).
CREATE OR REPLACE FUNCTION saas_immobilier.raise_admin_alert(
  p_key text, p_kind text, p_title text, p_reason text, p_priority text,
  p_agency_id uuid DEFAULT NULL, p_action_href text DEFAULT NULL, p_action_label text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'saas_immobilier','public'
AS $fn$
BEGIN
  INSERT INTO saas_immobilier.admin_alerts
    (alert_key, kind, title, reason, priority, agency_id, action_href, action_label, metadata)
  VALUES (p_key, p_kind, p_title, p_reason, COALESCE(p_priority,'normal'), p_agency_id, p_action_href, p_action_label, COALESCE(p_metadata,'{}'::jsonb))
  ON CONFLICT (alert_key) DO NOTHING;
END
$fn$;
REVOKE ALL ON FUNCTION saas_immobilier.raise_admin_alert(text,text,text,text,text,uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;

-- Lecture et états non lu / traité.
CREATE OR REPLACE FUNCTION public.admin_alerts(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_rows jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows
    FROM (SELECT al.*, a.name AS agency_name FROM saas_immobilier.admin_alerts al
            LEFT JOIN saas_immobilier.agencies a ON a.id = al.agency_id
           ORDER BY al.created_at DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),200)) t;
  RETURN jsonb_build_object('alerts', v_rows,
    'unread', (SELECT count(*) FROM saas_immobilier.admin_alerts WHERE is_read = false),
    'critical', (SELECT count(*) FROM saas_immobilier.admin_alerts WHERE is_read = false AND priority IN ('high','critical')));
END
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_alerts(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_mark_alert(p_id uuid, p_read boolean DEFAULT true)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  UPDATE saas_immobilier.admin_alerts SET is_read = p_read, read_at = CASE WHEN p_read THEN now() ELSE NULL END WHERE id = p_id;
  RETURN true;
END
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_mark_alert(uuid, boolean) TO authenticated, service_role;

-- Triggers d'événements : voir la base appliquée (fonctions
-- alerts_on_agency_insert / alerts_on_agency_status / alerts_on_subscription /
-- alerts_on_payment, déclarées dans saas_immobilier) — définition identique.

-- Scan des événements datés (essai à J-3, impayé).
CREATE OR REPLACE FUNCTION public.admin_scan_alerts()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE r record; n int := 0;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE='42501'; END IF;
  FOR r IN
    SELECT s.id, s.agency_id, s.trial_ends_at, s.ends_at, a.name, a.status
      FROM saas_immobilier.agency_subscriptions s
      JOIN saas_immobilier.agencies a ON a.id = s.agency_id
     WHERE (s.status = 'trial' AND s.trial_ends_at IS NOT NULL AND s.trial_ends_at <= now() + interval '3 days')
        OR (s.ends_at IS NOT NULL AND s.ends_at < now() AND a.status <> 'suspended')
  LOOP
    IF r.status = 'trial' AND r.trial_ends_at <= now() + interval '3 days' THEN
      PERFORM saas_immobilier.raise_admin_alert(
        'trial_ending_' || r.id::text || '_' || r.trial_ends_at::date::text, 'trial_ending',
        'Essai qui se termine : ' || r.name,
        'L essai se termine le ' || to_char(r.trial_ends_at,'DD/MM/YYYY') || '.',
        'high', r.agency_id, '/admin/agences', 'Voir l essai', jsonb_build_object('trial_ends_at', r.trial_ends_at));
      n := n + 1;
    END IF;
    IF r.ends_at < now() AND r.status <> 'suspended' THEN
      PERFORM saas_immobilier.raise_admin_alert(
        'overdue_' || r.id::text || '_' || r.ends_at::date::text, 'overdue',
        'Impayé : ' || r.name,
        'Échéance dépassée depuis le ' || to_char(r.ends_at,'DD/MM/YYYY') || '.',
        'critical', r.agency_id, '/admin/paiements', 'Voir les paiements', jsonb_build_object('ends_at', r.ends_at));
      n := n + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('generated', n);
END
$fn$;
GRANT EXECUTE ON FUNCTION public.admin_scan_alerts() TO authenticated, service_role;
