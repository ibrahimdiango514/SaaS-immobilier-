-- =============================================================================
-- LOT 4 — Système centralisé de notifications agence, rappels automatisés et
--         alertes de supervision administrateur (idempotence stricte)
-- Date : 2026-11-05
-- Cible autorisée : Sofia Immobilier Lab (yswsildmbeomjlyofnrk)
-- Production (xbuuhfwobrafcbgtdgjx) : AUCUNE EXÉCUTION SANS VALIDATION EXPLICITE
--
-- Garanties LOT 4 :
--   • Implémentation de `billing_notify_once` et `admin_alert_once` avec clés
--     d'idempotence uniques (zéro doublon même après relances multiples du cron).
--   • Séparation stricte entre `saas_immobilier.notifications` (espace agence,
--     isolé par RLS `agency_id`) et `saas_immobilier.admin_alerts` (supervision
--     plateforme réservée à `is_platform_admin()`).
--   • Couverture complète des 17 événements côté agence et des 12 familles
--     d'alertes côté administrateur, avec liens d'action directe et fuseau
--     horaire de référence `Africa/Bamako`.
--   • Conservation intégrale de tous les historiques existants.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Index de performance et protection d'immutabilité sur `notifications`
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS notifications_agency_created_idx
  ON saas_immobilier.notifications (agency_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_agency_unread_idx
  ON saas_immobilier.notifications (agency_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_alerts_unread_priority_created_idx
  ON saas_immobilier.admin_alerts (is_read, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS subscription_events_agency_created_idx
  ON saas_immobilier.subscription_events (agency_id, created_at DESC);

-- Empêcher tout membre authentifié de modifier autre chose que `read_at` sur une notification
CREATE OR REPLACE FUNCTION saas_immobilier.protect_notification_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
BEGIN
  IF v_jwt_role = 'service_role' OR v_privileged OR current_setting('sofia.internal_notification_mutation', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agency_id IS DISTINCT FROM OLD.agency_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.data IS DISTINCT FROM OLD.data
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Modification non autorisée : seul l''état de lecture (read_at) peut être mis à jour.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_notification_immutable_fields ON saas_immobilier.notifications;
CREATE TRIGGER trg_protect_notification_immutable_fields
  BEFORE UPDATE ON saas_immobilier.notifications
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.protect_notification_immutable_fields();

-- Renforcer l'isolation RLS sur `notifications` : lecture et marquage lu réservés
-- strictement aux membres actifs de l'agence concernée (jamais une autre agence)
DROP POLICY IF EXISTS notifications_select_member ON saas_immobilier.notifications;
CREATE POLICY notifications_select_member
  ON saas_immobilier.notifications
  FOR SELECT
  TO authenticated
  USING (
    public.is_agency_member_any_status(agency_id)
    AND (user_id IS NULL OR user_id = (SELECT auth.uid()) OR public.billing_has_access(agency_id))
  );

DROP POLICY IF EXISTS notifications_update_member ON saas_immobilier.notifications;
CREATE POLICY notifications_update_member
  ON saas_immobilier.notifications
  FOR UPDATE
  TO authenticated
  USING (
    public.is_agency_member_any_status(agency_id)
    AND (user_id IS NULL OR user_id = (SELECT auth.uid()) OR public.billing_has_access(agency_id))
  )
  WITH CHECK (
    public.is_agency_member_any_status(agency_id)
    AND (user_id IS NULL OR user_id = (SELECT auth.uid()) OR public.billing_has_access(agency_id))
  );

-- -----------------------------------------------------------------------------
-- 2. Primitives centrales idempotentes : `billing_notify_once` & `admin_alert_once`
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.billing_notify_once(
  p_agency_id uuid,
  p_event_key text,
  p_category text,
  p_title text,
  p_message text,
  p_action_href text DEFAULT '/mon-offre',
  p_action_label text DEFAULT 'Voir mon offre',
  p_priority text DEFAULT 'normal',
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_clean_key text := NULLIF(btrim(COALESCE(p_event_key, '')), '');
  v_inserted_key text;
  v_notif_id uuid;
  v_cat text := lower(COALESCE(NULLIF(btrim(p_category), ''), 'billing'));
  v_prio text := CASE WHEN p_priority IN ('low', 'normal', 'high', 'critical') THEN p_priority ELSE 'normal' END;
  v_payload jsonb;
BEGIN
  IF p_agency_id IS NULL OR v_clean_key IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO saas_immobilier.billing_notification_keys (event_key, agency_id)
  VALUES (v_clean_key, p_agency_id)
  ON CONFLICT (event_key) DO NOTHING
  RETURNING event_key INTO v_inserted_key;

  IF v_inserted_key IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_cat NOT IN ('onboarding', 'trial', 'billing', 'payment', 'suspension', 'plan', 'system') THEN
    v_cat := 'billing';
  END IF;

  v_payload := COALESCE(p_data, '{}'::jsonb) || jsonb_build_object(
    'dedup_key', v_clean_key,
    'category', v_cat,
    'priority', v_prio,
    'action_href', COALESCE(NULLIF(btrim(p_action_href), ''), '/mon-offre'),
    'action_label', COALESCE(NULLIF(btrim(p_action_label), ''), 'Consulter'),
    'timezone', 'Africa/Bamako',
    'bamako_time', to_char(now() AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI')
  );

  PERFORM set_config('sofia.internal_notification_mutation', 'on', true);

  INSERT INTO saas_immobilier.notifications (
    agency_id,
    user_id,
    type,
    title,
    message,
    data
  ) VALUES (
    p_agency_id,
    NULL,
    v_cat,
    p_title,
    p_message,
    v_payload
  )
  RETURNING id INTO v_notif_id;

  PERFORM set_config('sofia.internal_notification_mutation', 'off', true);

  RETURN v_notif_id;
END;
$$;

-- Exposition sécurisée de `public.billing_notify_once` (réservée au système ou admin plateforme)
CREATE OR REPLACE FUNCTION public.billing_notify_once(
  p_agency_id uuid,
  p_event_key text,
  p_category text DEFAULT 'billing',
  p_title text DEFAULT '',
  p_message text DEFAULT '',
  p_action_href text DEFAULT '/mon-offre',
  p_action_label text DEFAULT 'Voir mon offre',
  p_priority text DEFAULT 'normal',
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_notif_id uuid;
BEGIN
  IF NOT (
    v_jwt_role = 'service_role'
    OR v_privileged
    OR (v_jwt_role = 'authenticated' AND public.is_platform_admin())
  ) THEN
    RAISE EXCEPTION 'Accès refusé : émission réservée au système ou à un administrateur plateforme.' USING ERRCODE = '42501';
  END IF;

  v_notif_id := saas_immobilier.billing_notify_once(
    p_agency_id    => p_agency_id,
    p_event_key    => p_event_key,
    p_category     => p_category,
    p_title        => p_title,
    p_message      => p_message,
    p_action_href  => p_action_href,
    p_action_label => p_action_label,
    p_priority     => p_priority,
    p_data         => p_data
  );

  RETURN jsonb_build_object(
    'created', (v_notif_id IS NOT NULL),
    'notification_id', v_notif_id,
    'event_key', p_event_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_notify_once(uuid, text, text, text, text, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_notify_once(uuid, text, text, text, text, text, text, text, jsonb) TO authenticated, service_role;

-- Rétrocompatibilité de `saas_immobilier.billing_notify` vers `billing_notify_once`
CREATE OR REPLACE FUNCTION saas_immobilier.billing_notify(
  p_agency_id uuid,
  p_event_key text,
  p_title text,
  p_message text,
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cat text := COALESCE(NULLIF(p_data->>'category', ''), 'billing');
  v_href text := COALESCE(NULLIF(p_data->>'action_href', ''), '/mon-offre');
  v_label text := COALESCE(NULLIF(p_data->>'action_label', ''), 'Voir mon offre');
  v_prio text := COALESCE(NULLIF(p_data->>'priority', ''), 'normal');
  v_id uuid;
BEGIN
  v_id := saas_immobilier.billing_notify_once(
    p_agency_id, p_event_key, v_cat, p_title, p_message, v_href, v_label, v_prio, p_data
  );
  RETURN (v_id IS NOT NULL);
END;
$$;

-- Primitive centrale idempotente des alertes administrateur
CREATE OR REPLACE FUNCTION saas_immobilier.admin_alert_once(
  p_agency_id uuid,
  p_alert_key text,
  p_kind text,
  p_priority text,
  p_title text,
  p_reason text,
  p_action_href text DEFAULT '/admin/abonnements',
  p_action_label text DEFAULT 'Ouvrir',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_full_key text := CASE
    WHEN p_alert_key LIKE 'admin:%' THEN p_alert_key
    ELSE 'admin:' || p_alert_key
  END;
  v_alert_id uuid;
  v_prio text := CASE WHEN p_priority IN ('low', 'normal', 'high', 'critical') THEN p_priority ELSE 'normal' END;
BEGIN
  IF NULLIF(btrim(COALESCE(p_alert_key, '')), '') IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO saas_immobilier.billing_notification_keys (event_key, agency_id)
  VALUES (v_full_key, p_agency_id)
  ON CONFLICT (event_key) DO NOTHING;

  INSERT INTO saas_immobilier.admin_alerts (
    agency_id,
    alert_key,
    kind,
    title,
    reason,
    priority,
    action_href,
    action_label,
    metadata
  ) VALUES (
    p_agency_id,
    v_full_key,
    COALESCE(NULLIF(btrim(p_kind), ''), 'billing_event'),
    p_title,
    p_reason,
    v_prio,
    COALESCE(NULLIF(btrim(p_action_href), ''), '/admin/abonnements'),
    COALESCE(NULLIF(btrim(p_action_label), ''), 'Ouvrir'),
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'dedup_key', v_full_key,
      'timezone', 'Africa/Bamako',
      'bamako_time', to_char(now() AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI')
    )
  )
  ON CONFLICT (alert_key) DO NOTHING
  RETURNING id INTO v_alert_id;

  RETURN v_alert_id;
END;
$$;

-- Aligner `billing_admin_alert_once` (LOT 2) sur `admin_alert_once`
CREATE OR REPLACE FUNCTION saas_immobilier.billing_admin_alert_once(
  p_agency_id uuid,
  p_event_key text,
  p_type text,
  p_priority text,
  p_title text,
  p_message text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_href text := COALESCE(NULLIF(p_metadata->>'action_href', ''), '/admin/abonnements');
  v_label text := COALESCE(NULLIF(p_metadata->>'action_label', ''), 'Voir l''abonnement');
BEGIN
  RETURN saas_immobilier.admin_alert_once(
    p_agency_id, p_event_key, p_type, p_priority, p_title, p_message, v_href, v_label, p_metadata
  ) IS NOT NULL;
END;
$$;

-- Enregistrement par les Edge Functions SasPay d'un échec de vérification serveur-à-serveur
CREATE OR REPLACE FUNCTION public.saspay_record_verification_failure(
  p_payment_id uuid,
  p_session_id uuid DEFAULT NULL,
  p_reason text DEFAULT 'saspay_verification_failed'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_ag_name text;
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT name INTO v_ag_name FROM saas_immobilier.agencies WHERE id = v_row.agency_id;

  PERFORM saas_immobilier.admin_alert_once(
    v_row.agency_id,
    'saspay-verify-fail:' || v_row.id::text || ':' || to_char(now() AT TIME ZONE 'Africa/Bamako', 'YYYYMMDDHH24'),
    'saspay_verification_failed',
    'high',
    format('Échec de vérification SasPay (%s)', COALESCE(v_ag_name, 'Agence')),
    format('La vérification serveur-à-serveur de la session %s (%s FCFA) a signalé : %s.', COALESCE(p_session_id, v_row.checkout_session_id), to_char(v_row.amount, 'FM999G999G990'), COALESCE(p_reason, 'erreur fournisseur')),
    '/admin/paiements',
    'Contrôler SasPay',
    jsonb_build_object('payment_id', v_row.id, 'session_id', COALESCE(p_session_id, v_row.checkout_session_id), 'reason', p_reason, 'category', 'saspay')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.saspay_record_verification_failure(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.saspay_record_verification_failure(uuid, uuid, text) TO service_role;

-- Enrichir `saspay_record_reconciliation_exception` pour lever immédiatement une alerte admin critique
CREATE OR REPLACE FUNCTION public.saspay_record_reconciliation_exception(
  p_payment_id uuid,
  p_session_id uuid,
  p_transaction_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_ag_name text;
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  INSERT INTO saas_immobilier.billing_reconciliation_exceptions (
    payment_id, session_id, transaction_id, reason
  ) VALUES (
    p_payment_id, p_session_id, p_transaction_id, left(COALESCE(p_reason, 'confirmation_failed'), 200)
  )
  ON CONFLICT (payment_id) DO UPDATE
  SET transaction_id = EXCLUDED.transaction_id,
      reason = EXCLUDED.reason,
      last_seen_at = now(),
      resolved_at = NULL;

  SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id;
  IF FOUND THEN
    SELECT name INTO v_ag_name FROM saas_immobilier.agencies WHERE id = v_row.agency_id;
    PERFORM saas_immobilier.admin_alert_once(
      v_row.agency_id,
      'saspay-reconcile-exc:' || v_row.id::text || ':' || left(md5(COALESCE(p_reason, '')), 8),
      'saspay_reconciliation_exception',
      'critical',
      format('Exception de réconciliation SasPay (%s)', COALESCE(v_ag_name, 'Agence')),
      format('Transaction %s bloquée en rapprochement (%s FCFA) — motif : %s.', COALESCE(p_transaction_id::text, '—'), to_char(v_row.amount, 'FM999G999G990'), left(COALESCE(p_reason, 'confirmation_failed'), 120)),
      '/admin/paiements',
      'Traiter l''exception',
      jsonb_build_object('payment_id', v_row.id, 'session_id', p_session_id, 'transaction_id', p_transaction_id, 'reason', p_reason, 'category', 'saspay')
    );
  END IF;
END;
$$;

-- Enrichir `saspay_record_failed` avec notification agence catégorisée + alerte admin
CREATE OR REPLACE FUNCTION public.saspay_record_failed(
  p_payment_id uuid,
  p_session_id uuid,
  p_reason text,
  p_terminal boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_ag_name text;
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_next_status text;
  v_is_expired boolean := (COALESCE(p_reason, '') ILIKE '%expired%');
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR v_row.checkout_session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'Session incohérente.' USING ERRCODE = '22023';
  END IF;

  IF v_row.status = 'paid' THEN
    RETURN;
  END IF;

  IF p_terminal THEN
    v_next_status := CASE
      WHEN v_is_expired THEN 'expired'
      WHEN COALESCE(p_reason, '') ILIKE '%cancelled%' THEN 'cancelled'
      ELSE 'failed'
    END;
    UPDATE saas_immobilier.online_payments
    SET status = v_next_status, fail_reason = p_reason, updated_at = now()
    WHERE id = p_payment_id;
  ELSE
    UPDATE saas_immobilier.online_payments
    SET fail_reason = p_reason, updated_at = now()
    WHERE id = p_payment_id;
  END IF;

  SELECT name INTO v_ag_name FROM saas_immobilier.agencies WHERE id = v_row.agency_id;

  PERFORM saas_immobilier.billing_notify_once(
    p_agency_id    => v_row.agency_id,
    p_event_key    => 'payment-failed:' || v_row.id::text || ':' || COALESCE(v_next_status, 'failed'),
    p_category     => 'payment',
    p_title        => CASE WHEN v_is_expired THEN 'Session de paiement SasPay expirée' ELSE 'Paiement SasPay non abouti' END,
    p_message      => format(
      'Votre tentative de règlement de %s FCFA n''a pas été finalisée (%s). Vous pouvez relancer un paiement sécurisé à tout moment depuis Mon offre.',
      to_char(v_row.amount, 'FM999G999G990'),
      CASE WHEN v_is_expired THEN 'session expirée' ELSE 'paiement interrompu ou refusé' END
    ),
    p_action_href  => '/mon-offre',
    p_action_label => 'Relancer le paiement',
    p_priority     => 'high',
    p_data         => jsonb_build_object('event_kind', 'payment_failed_or_expired', 'payment_id', v_row.id, 'status', COALESCE(v_next_status, 'failed'), 'reason', p_reason)
  );

  PERFORM saas_immobilier.admin_alert_once(
    v_row.agency_id,
    'payment-failed:' || v_row.id::text || ':' || COALESCE(v_next_status, 'failed'),
    CASE WHEN v_is_expired THEN 'saspay_payment_expired' ELSE 'saspay_payment_failed' END,
    CASE WHEN v_is_expired THEN 'normal' ELSE 'high' END,
    format('Paiement SasPay %s (%s)', CASE WHEN v_is_expired THEN 'expiré' ELSE 'échoué' END, COALESCE(v_ag_name, 'Agence')),
    format('Tentative de %s FCFA (%s) marquée %s.', to_char(v_row.amount, 'FM999G999G990'), v_row.purpose, COALESCE(v_next_status, 'failed')),
    '/admin/paiements',
    'Voir les transactions',
    jsonb_build_object('payment_id', v_row.id, 'purpose', v_row.purpose, 'reason', p_reason, 'category', 'saspay')
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Triggers automatiques couvrant 100 % des événements métier temps réel
-- -----------------------------------------------------------------------------

-- 3A. Inscription agence + Installation physique + Suspension
CREATE OR REPLACE FUNCTION saas_immobilier.trg_fn_agency_lifecycle_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan_label text;
  v_setup_fee numeric;
  v_monthly numeric;
BEGIN
  IF NEW.pending_plan_id IS NOT NULL THEN
    SELECT COALESCE(display_name, name), setup_fee, price_monthly
    INTO v_plan_label, v_setup_fee, v_monthly
    FROM saas_immobilier.plans WHERE id = NEW.pending_plan_id;
  END IF;

  -- 1) Nouvelle inscription et création du dossier (`pending`)
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.id,
      p_event_key    => 'onboarding-created:' || NEW.id::text,
      p_category     => 'onboarding',
      p_title        => 'Dossier d''inscription enregistré',
      p_message      => format(
        'Bienvenue chez Sofia Immobilier ! Votre dossier pour « %s » (offre %s) est bien créé. Notre équipe vous contactera pour réaliser l''installation physique sur site avant l''ouverture de vos 14 jours d''essai gratuit.',
        NEW.name,
        COALESCE(v_plan_label, 'choisie')
      ),
      p_action_href  => '/dashboard',
      p_action_label => 'Suivre mon dossier',
      p_priority     => 'normal',
      p_data         => jsonb_build_object(
        'event_kind', 'agency_registered',
        'plan_id', NEW.pending_plan_id,
        'plan_name', v_plan_label,
        'setup_fee', v_setup_fee
      )
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.id,
      'onboarding-created:' || NEW.id::text,
      'agency_signup_pending',
      'high',
      format('Nouvelle inscription agence : %s', NEW.name),
      format(
        'Offre demandée : %s (%s FCFA installation physique · %s FCFA/mois après essai 14j). Planifier l''intervention sur site.',
        COALESCE(v_plan_label, 'À définir'),
        to_char(COALESCE(v_setup_fee, 0), 'FM999G999G990'),
        to_char(COALESCE(v_monthly, 0), 'FM999G999G990')
      ),
      '/admin/validations',
      'Ouvrir le dossier',
      jsonb_build_object('category', 'onboarding', 'plan_id', NEW.pending_plan_id, 'city', NEW.city)
    );
  END IF;

  -- 2) Confirmation de l'installation physique
  IF TG_OP = 'UPDATE'
     AND OLD.installation_status IS DISTINCT FROM NEW.installation_status
     AND NEW.installation_status = 'completed' THEN
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.id,
      p_event_key    => 'installation-completed:' || NEW.id::text,
      p_category     => 'onboarding',
      p_title        => 'Installation physique confirmée',
      p_message      => format(
        'L''installation sur site de votre agence « %s » a été validée (%s FCFA reçus). L''administrateur procède à l''activation de votre espace et de vos 14 jours d''essai gratuit.',
        NEW.name,
        to_char(COALESCE(NEW.installation_amount_collected, NEW.installation_fee_expected, 0), 'FM999G999G990')
      ),
      p_action_href  => '/dashboard',
      p_action_label => 'Voir l''avancement',
      p_priority     => 'normal',
      p_data         => jsonb_build_object(
        'event_kind', 'physical_installation_confirmed',
        'amount_collected', COALESCE(NEW.installation_amount_collected, NEW.installation_fee_expected),
        'receipt_reference', NEW.installation_receipt_reference
      )
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.id,
      'installation-completed:' || NEW.id::text,
      'physical_installation_recorded',
      'normal',
      format('Installation physique enregistrée (%s)', NEW.name),
      format(
        'Montant encaissé : %s FCFA (réf. %s). L''agence est prête à être activée.',
        to_char(COALESCE(NEW.installation_amount_collected, NEW.installation_fee_expected, 0), 'FM999G999G990'),
        COALESCE(NEW.installation_receipt_reference, '—')
      ),
      '/admin/validations',
      'Activer l''agence',
      jsonb_build_object('category', 'onboarding', 'amount_collected', NEW.installation_amount_collected)
    );
  END IF;

  -- 3) Suspension (filet de sécurité également pour toute suspension manuelle admin)
  IF TG_OP = 'UPDATE'
     AND OLD.status IS DISTINCT FROM NEW.status
     AND NEW.status = 'suspended' THEN
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.id,
      p_event_key    => 'agency-suspended:' || NEW.id::text || ':' || to_char(COALESCE(NEW.suspended_at, now()) AT TIME ZONE 'UTC', 'YYYYMMDDHH24'),
      p_category     => 'suspension',
      p_title        => CASE WHEN COALESCE(NEW.suspended_reason, 'unpaid') = 'unpaid' THEN 'Agence suspendue pour échéance impayée' ELSE 'Accès agence suspendu' END,
      p_message      => CASE
        WHEN COALESCE(NEW.suspended_reason, 'unpaid') = 'unpaid' THEN
          'Votre délai de grâce de 5 jours a expiré sans règlement confirmé. Régularisez votre mensualité via SasPay pour réactiver immédiatement votre espace.'
        ELSE
          format('Votre agence a été suspendue par l''administration (%s).', COALESCE(NEW.suspended_reason, 'contactez le support'))
      END,
      p_action_href  => '/dashboard',
      p_action_label => 'Régulariser mon accès',
      p_priority     => 'critical',
      p_data         => jsonb_build_object('event_kind', 'agency_suspended', 'reason', COALESCE(NEW.suspended_reason, 'unpaid'))
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.id,
      'agency-suspended:' || NEW.id::text || ':' || to_char(COALESCE(NEW.suspended_at, now()) AT TIME ZONE 'UTC', 'YYYYMMDDHH24'),
      'agency_suspended',
      'critical',
      format('Agence suspendue : %s', NEW.name),
      format('Motif : %s.', CASE WHEN COALESCE(NEW.suspended_reason, 'unpaid') = 'unpaid' THEN 'impayé après 5 jours de grâce' ELSE NEW.suspended_reason END),
      '/admin/abonnements',
      'Voir l''abonnement',
      jsonb_build_object('category', 'suspension', 'reason', COALESCE(NEW.suspended_reason, 'unpaid'))
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot4_agency_lifecycle_notifications ON saas_immobilier.agencies;
CREATE TRIGGER trg_lot4_agency_lifecycle_notifications
  AFTER INSERT OR UPDATE OF status, installation_status ON saas_immobilier.agencies
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.trg_fn_agency_lifecycle_notifications();

-- 3B. Génération d'une nouvelle facture (`subscription_invoices`)
CREATE OR REPLACE FUNCTION saas_immobilier.trg_fn_invoice_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag_name text;
  v_kind_label text;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_ag_name FROM saas_immobilier.agencies WHERE id = NEW.agency_id;

  v_kind_label := CASE NEW.invoice_kind
    WHEN 'first_subscription' THEN '1re mensualité post-essai'
    WHEN 'renewal' THEN 'renouvellement mensuel'
    WHEN 'plan_change' THEN 'prorata de montée d''offre'
    WHEN 'reactivation' THEN 'régularisation d''abonnement'
    ELSE 'abonnement'
  END;

  PERFORM saas_immobilier.billing_notify_once(
    p_agency_id    => NEW.agency_id,
    p_event_key    => 'invoice-generated:' || NEW.id::text,
    p_category     => 'billing',
    p_title        => format('Nouvelle facture disponible (%s)', COALESCE(NEW.reference, v_kind_label)),
    p_message      => format(
      'Une facture de %s FCFA (%s — offre %s) a été émise%s. Vous pouvez la régler en ligne via SasPay depuis Mon offre.',
      to_char(NEW.amount, 'FM999G999G990'),
      v_kind_label,
      COALESCE(NEW.plan_to_name, 'active'),
      CASE WHEN NEW.due_at IS NOT NULL THEN ' avec échéance au ' || to_char(NEW.due_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY') ELSE '' END
    ),
    p_action_href  => '/mon-offre',
    p_action_label => 'Voir et payer la facture',
    p_priority     => 'normal',
    p_data         => jsonb_build_object(
      'event_kind', 'invoice_generated',
      'invoice_id', NEW.id,
      'invoice_kind', NEW.invoice_kind,
      'reference', NEW.reference,
      'amount', NEW.amount,
      'due_at', NEW.due_at
    )
  );

  PERFORM saas_immobilier.admin_alert_once(
    NEW.agency_id,
    'invoice-generated:' || NEW.id::text,
    'invoice_generated',
    'low',
    format('Facture émise : %s (%s FCFA)', COALESCE(v_ag_name, 'Agence'), to_char(NEW.amount, 'FM999G999G990')),
    format('Réf. %s · %s · échéance %s.', COALESCE(NEW.reference, '—'), v_kind_label, CASE WHEN NEW.due_at IS NOT NULL THEN to_char(NEW.due_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY') ELSE 'immédiate' END),
    '/admin/abonnements',
    'Voir les abonnements',
    jsonb_build_object('category', 'billing', 'invoice_id', NEW.id, 'invoice_kind', NEW.invoice_kind, 'amount', NEW.amount)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot4_invoice_notifications ON saas_immobilier.subscription_invoices;
CREATE TRIGGER trg_lot4_invoice_notifications
  AFTER INSERT ON saas_immobilier.subscription_invoices
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.trg_fn_invoice_notifications();

-- 3C. Paiement SasPay initié (`online_payments`)
CREATE OR REPLACE FUNCTION saas_immobilier.trg_fn_online_payment_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag_name text;
  v_purpose_label text;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  SELECT name INTO v_ag_name FROM saas_immobilier.agencies WHERE id = NEW.agency_id;

  v_purpose_label := CASE NEW.purpose
    WHEN 'first_subscription' THEN '1er mois d''abonnement'
    WHEN 'renewal' THEN 'renouvellement mensuel'
    WHEN 'plan_change' THEN 'montée d''offre au prorata'
    WHEN 'reactivation' THEN 'régularisation et réactivation'
    ELSE 'règlement de facture'
  END;

  PERFORM saas_immobilier.billing_notify_once(
    p_agency_id    => NEW.agency_id,
    p_event_key    => 'saspay-initiated:' || NEW.id::text,
    p_category     => 'payment',
    p_title        => 'Paiement SasPay initié',
    p_message      => format(
      'Une session de paiement sécurisée de %s FCFA (%s) a été ouverte. Finalisez votre règlement ou vérifiez son statut à tout moment.',
      to_char(NEW.amount, 'FM999G999G990'),
      v_purpose_label
    ),
    p_action_href  => '/paiement/retour?payment=' || NEW.id::text,
    p_action_label => 'Suivre ce paiement',
    p_priority     => 'low',
    p_data         => jsonb_build_object(
      'event_kind', 'saspay_payment_initiated',
      'payment_id', NEW.id,
      'invoice_id', NEW.invoice_id,
      'purpose', NEW.purpose,
      'amount', NEW.amount
    )
  );

  PERFORM saas_immobilier.admin_alert_once(
    NEW.agency_id,
    'saspay-initiated:' || NEW.id::text,
    'saspay_payment_initiated',
    'low',
    format('Session SasPay initiée (%s)', COALESCE(v_ag_name, 'Agence')),
    format('Montant : %s FCFA · Motif : %s.', to_char(NEW.amount, 'FM999G999G990'), v_purpose_label),
    '/admin/paiements',
    'Suivre dans SasPay',
    jsonb_build_object('category', 'saspay', 'payment_id', NEW.id, 'purpose', NEW.purpose, 'amount', NEW.amount)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot4_online_payment_notifications ON saas_immobilier.online_payments;
CREATE TRIGGER trg_lot4_online_payment_notifications
  AFTER INSERT ON saas_immobilier.online_payments
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.trg_fn_online_payment_notifications();

-- 3D. Événements du journal d'abonnement (`subscription_events`) :
--     Activation + Essai 14j, Paiement confirmé, Réactivation, Changement d'offre
CREATE OR REPLACE FUNCTION saas_immobilier.trg_fn_subscription_event_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag_name text;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
BEGIN
  SELECT name INTO v_ag_name FROM saas_immobilier.agencies WHERE id = NEW.agency_id;
  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = NEW.agency_id
  ORDER BY updated_at DESC LIMIT 1;

  -- Activation de l'agence + Début de l'essai gratuit de 14 jours
  IF NEW.event_type = 'trial_started' THEN
    -- Notification distincte d'activation d'agence
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.agency_id,
      p_event_key    => 'agency-activated:' || NEW.agency_id::text || ':' || COALESCE(v_sub.id::text, NEW.id::text),
      p_category     => 'onboarding',
      p_title        => 'Votre agence est officiellement activée',
      p_message      => format(
        'Félicitations ! L''espace de travail de « %s » est désormais ouvert sur l''offre %s.',
        COALESCE(v_ag_name, 'votre agence'),
        COALESCE(NEW.plan_to_name, 'sélectionnée')
      ),
      p_action_href  => '/dashboard',
      p_action_label => 'Ouvrir mon tableau de bord',
      p_priority     => 'normal',
      p_data         => jsonb_build_object('event_kind', 'agency_activated', 'plan_id', NEW.plan_to_id)
    );

    -- Notification dédiée au début des 14 jours d'essai gratuit (clé unifiée avec admin_activate_pending_agency)
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.agency_id,
      p_event_key    => 'trial-14d-started:' || COALESCE(v_sub.id::text, NEW.id::text),
      p_category     => 'trial',
      p_title        => 'Début de votre essai gratuit de 14 jours',
      p_message      => format(
        'Vous bénéficiez de 100 %% des quotas et modules de l''offre %s gratuitement jusqu''au %s. Aucun paiement n''est requis avant la fin de l''essai.',
        COALESCE(NEW.plan_to_name, 'active'),
        CASE WHEN v_sub.trial_ends_at IS NOT NULL THEN to_char(v_sub.trial_ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY') ELSE 'J+14' END
      ),
      p_action_href  => '/mon-offre',
      p_action_label => 'Consulter mon essai',
      p_priority     => 'normal',
      p_data         => jsonb_build_object('event_kind', 'trial_started', 'trial_ends_at', v_sub.trial_ends_at, 'plan_id', NEW.plan_to_id)
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.agency_id,
      'agency-activated-trial:' || COALESCE(v_sub.id::text, NEW.id::text),
      'agency_activated_trial_started',
      'normal',
      format('Agence activée — Essai 14j démarré (%s)', COALESCE(v_ag_name, 'Agence')),
      format(
        'Offre %s active en essai gratuit jusqu''au %s.',
        COALESCE(NEW.plan_to_name, '—'),
        CASE WHEN v_sub.trial_ends_at IS NOT NULL THEN to_char(v_sub.trial_ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY') ELSE 'J+14' END
      ),
      '/admin/abonnements',
      'Voir l''abonnement',
      jsonb_build_object('category', 'trial', 'trial_ends_at', v_sub.trial_ends_at, 'plan_id', NEW.plan_to_id)
    );

  -- Paiement confirmé (alerte admin systématique + notification agence si pas déjà créée sous la même clé)
  ELSIF NEW.event_type = 'payment_validated' AND NEW.payment_id IS NOT NULL THEN
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.agency_id,
      p_event_key    => 'payment-confirmed:' || NEW.payment_id::text,
      p_category     => 'payment',
      p_title        => 'Paiement d''abonnement confirmé',
      p_message      => format(
        'Votre règlement de %s FCFA (%s) a été validé. Prochaine échéance : %s.',
        to_char(COALESCE(NEW.amount, 0), 'FM999G999G990'),
        COALESCE(NEW.plan_to_name, 'abonnement'),
        CASE WHEN v_sub.ends_at IS NOT NULL THEN to_char(v_sub.ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY') ELSE 'à jour' END
      ),
      p_action_href  => '/mon-offre',
      p_action_label => 'Voir mes factures',
      p_priority     => 'normal',
      p_data         => jsonb_build_object('event_kind', 'payment_confirmed', 'payment_id', NEW.payment_id, 'invoice_id', NEW.invoice_id, 'amount', NEW.amount)
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.agency_id,
      'payment-confirmed:' || NEW.payment_id::text,
      'payment_confirmed',
      'normal',
      format('Paiement confirmé : %s (%s FCFA)', COALESCE(v_ag_name, 'Agence'), to_char(COALESCE(NEW.amount, 0), 'FM999G999G990')),
      format('Réf. %s · Offre %s.', COALESCE(NEW.reference, '—'), COALESCE(NEW.plan_to_name, '—')),
      '/admin/paiements',
      'Voir l''encaissement',
      jsonb_build_object('category', 'saspay', 'payment_id', NEW.payment_id, 'invoice_id', NEW.invoice_id, 'amount', NEW.amount)
    );

  -- Réactivation après régularisation
  ELSIF NEW.event_type = 'reactivation' THEN
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.agency_id,
      p_event_key    => 'reactivated:' || COALESCE(NEW.payment_id::text, NEW.id::text),
      p_category     => 'suspension',
      p_title        => 'Agence réactivée — accès complet rétabli',
      p_message      => format(
        'Suite à votre régularisation, tous les modules et quotas de votre agence « %s » sont de nouveau actifs%s.',
        COALESCE(v_ag_name, ''),
        CASE WHEN v_sub.ends_at IS NOT NULL THEN ' jusqu''au ' || to_char(v_sub.ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY') ELSE '' END
      ),
      p_action_href  => '/dashboard',
      p_action_label => 'Accéder au tableau de bord',
      p_priority     => 'normal',
      p_data         => jsonb_build_object('event_kind', 'agency_reactivated', 'payment_id', NEW.payment_id, 'ends_at', v_sub.ends_at)
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.agency_id,
      'reactivated:' || COALESCE(NEW.payment_id::text, NEW.id::text),
      'agency_reactivated',
      'normal',
      format('Agence réactivée (%s)', COALESCE(v_ag_name, 'Agence')),
      format('Réactivation effective sur l''offre %s.', COALESCE(NEW.plan_to_name, 'active')),
      '/admin/abonnements',
      'Voir l''abonnement',
      jsonb_build_object('category', 'suspension', 'payment_id', NEW.payment_id, 'ends_at', v_sub.ends_at)
    );

  -- Changement d'offre (admin ou prorata SasPay)
  ELSIF NEW.event_type = 'plan_change' THEN
    PERFORM saas_immobilier.billing_notify_once(
      p_agency_id    => NEW.agency_id,
      p_event_key    => CASE WHEN NEW.payment_id IS NOT NULL THEN 'plan-upgraded:' || NEW.payment_id::text ELSE 'plan-changed:' || NEW.id::text END,
      p_category     => 'plan',
      p_title        => format('Changement d''offre confirmé : %s', COALESCE(NEW.plan_to_name, 'Nouvelle offre')),
      p_message      => format(
        'Votre agence est passée de l''offre %s à l''offre %s (%s FCFA/mois). Vos nouveaux quotas et modules sont actifs immédiatement.',
        COALESCE(NEW.plan_from_name, 'précédente'),
        COALESCE(NEW.plan_to_name, 'actuelle'),
        to_char(COALESCE(NEW.mensualite_to, 0), 'FM999G999G990')
      ),
      p_action_href  => '/mon-offre',
      p_action_label => 'Découvrir mes nouveaux quotas',
      p_priority     => 'normal',
      p_data         => jsonb_build_object(
        'event_kind', 'plan_changed',
        'plan_from_id', NEW.plan_from_id,
        'plan_to_id', NEW.plan_to_id,
        'plan_from_name', NEW.plan_from_name,
        'plan_to_name', NEW.plan_to_name,
        'payment_id', NEW.payment_id,
        'invoice_id', NEW.invoice_id
      )
    );

    PERFORM saas_immobilier.admin_alert_once(
      NEW.agency_id,
      CASE WHEN NEW.payment_id IS NOT NULL THEN 'plan-upgraded:' || NEW.payment_id::text ELSE 'plan-changed:' || NEW.id::text END,
      'agency_plan_changed',
      'low',
      format('Changement d''offre : %s → %s (%s)', COALESCE(NEW.plan_from_name, '—'), COALESCE(NEW.plan_to_name, '—'), COALESCE(v_ag_name, 'Agence')),
      COALESCE(NEW.reason, 'Offre mise à jour.'),
      '/admin/abonnements',
      'Voir l''abonnement',
      jsonb_build_object('category', 'plan', 'plan_from_id', NEW.plan_from_id, 'plan_to_id', NEW.plan_to_id, 'payment_id', NEW.payment_id)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lot4_subscription_event_notifications ON saas_immobilier.subscription_events;
CREATE TRIGGER trg_lot4_subscription_event_notifications
  AFTER INSERT ON saas_immobilier.subscription_events
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.trg_fn_subscription_event_notifications();

-- Aligner `admin_activate_pending_agency` pour ne pas créer de seconde notification `trial-started` différente du trigger
CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(
  p_agency_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_agency saas_immobilier.agencies%ROWTYPE;
  v_plan saas_immobilier.plans%ROWTYPE;
  v_existing_sub_id uuid;
  v_sub_id uuid;
  v_now timestamptz := now();
  v_trial_days integer := 14;
  v_trial_ends_at timestamptz;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Accès refusé : administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_agency FROM saas_immobilier.agencies WHERE id = p_agency_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002'; END IF;
  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'Cette agence n''est plus en attente d''activation (statut actuel : %).', v_agency.status USING ERRCODE = '22023';
  END IF;
  IF v_agency.pending_plan_id IS NULL THEN
    RAISE EXCEPTION 'Aucune offre choisie pour cette agence.' USING ERRCODE = '22023';
  END IF;
  IF v_agency.installation_status <> 'completed' THEN
    RAISE EXCEPTION 'Activation refusée : l''installation physique doit être marquée comme réalisée avant l''activation.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_agency.pending_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Offre sélectionnée introuvable.' USING ERRCODE = 'P0002'; END IF;

  v_trial_ends_at := v_now + make_interval(days => v_trial_days);

  SELECT id INTO v_existing_sub_id
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF v_existing_sub_id IS NOT NULL THEN
    UPDATE saas_immobilier.agency_subscriptions
    SET plan_id = v_plan.id, status = 'trial', starts_at = v_now, trial_ends_at = v_trial_ends_at,
        ends_at = v_trial_ends_at, current_period_start = v_now, current_period_end = v_trial_ends_at,
        grace_ends_at = NULL, paid_through_at = NULL, updated_at = v_now
    WHERE id = v_existing_sub_id RETURNING id INTO v_sub_id;
  ELSE
    INSERT INTO saas_immobilier.agency_subscriptions (
      agency_id, plan_id, status, starts_at, trial_ends_at, ends_at, current_period_start, current_period_end
    ) VALUES (
      p_agency_id, v_plan.id, 'trial', v_now, v_trial_ends_at, v_trial_ends_at, v_now, v_trial_ends_at
    ) RETURNING id INTO v_sub_id;
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
  UPDATE saas_immobilier.agencies
  SET status = 'trial', activated_at = v_now, activated_by = v_admin_id,
      suspended_at = NULL, suspended_reason = NULL,
      pending_note = COALESCE(NULLIF(btrim(p_note), ''), pending_note), updated_at = v_now
  WHERE id = p_agency_id;
  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  -- Le trigger `trg_lot4_subscription_event_notifications` émet automatiquement
  -- et de façon idempotente : (1) Activation agence, (2) Début essai 14j, (3) Alerte admin !
  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, plan_to_name, mensualite_to, actor_id, reason
  ) VALUES (
    p_agency_id, 'trial_started', v_plan.id, COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly, v_admin_id,
    COALESCE(NULLIF(btrim(p_note), ''), format('Activation admin après installation physique — essai gratuit %s jours (%s)', v_trial_days, COALESCE(v_plan.display_name, v_plan.name)))
  );

  INSERT INTO saas_immobilier.activity_log (
    agency_id, user_id, action, entity_type, entity_id, summary, metadata
  ) VALUES (
    p_agency_id, v_admin_id, 'agency_activated_trial_started', 'agency', p_agency_id,
    format('Agence activée — essai gratuit de %s jours démarré sur l''offre %s', v_trial_days, COALESCE(v_plan.display_name, v_plan.name)),
    jsonb_build_object('subscription_id', v_sub_id, 'plan_id', v_plan.id, 'trial_days', v_trial_days, 'trial_ends_at', v_trial_ends_at)
  );

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'subscription_id', v_sub_id,
    'status', 'trial',
    'plan_id', v_plan.id,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name),
    'trial_starts_at', v_now,
    'trial_ends_at', v_trial_ends_at,
    'trial_days', v_trial_days
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RPCs Centre de Notifications Agence, Historique Facturation & Centre Alertes Admin
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_notifications_center(
  p_agency_id uuid,
  p_category text DEFAULT NULL,
  p_unread_only boolean DEFAULT false,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 300);
  v_cat text := NULLIF(lower(btrim(COALESCE(p_category, ''))), '');
  v_rows jsonb;
  v_unread integer;
  v_total integer;
  v_cat_counts jsonb;
BEGIN
  IF p_agency_id IS NULL THEN
    RAISE EXCEPTION 'Identifiant d''agence obligatoire.' USING ERRCODE = '22023';
  END IF;

  -- Isolation stricte inter-agences : un utilisateur ne peut JAMAIS lire les notifications d'une autre agence
  IF NOT (public.is_agency_member_any_status(p_agency_id) OR public.billing_has_access(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé aux notifications de cette agence.' USING ERRCODE = '42501';
  END IF;

  IF v_cat = 'all' THEN v_cat := NULL; END IF;

  SELECT COUNT(*) FILTER (WHERE read_at IS NULL), COUNT(*)
  INTO v_unread, v_total
  FROM saas_immobilier.notifications n
  WHERE n.agency_id = p_agency_id
    AND (n.user_id IS NULL OR n.user_id = v_uid OR public.billing_has_access(p_agency_id));

  SELECT COALESCE(jsonb_object_agg(cat_key, cnt), '{}'::jsonb)
  INTO v_cat_counts
  FROM (
    SELECT COALESCE(NULLIF(n.data->>'category', ''), n.type, 'billing') AS cat_key, COUNT(*)::int AS cnt
    FROM saas_immobilier.notifications n
    WHERE n.agency_id = p_agency_id
      AND (n.user_id IS NULL OR n.user_id = v_uid OR public.billing_has_access(p_agency_id))
    GROUP BY 1
  ) c;

  SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      n.id,
      n.agency_id,
      n.user_id,
      n.type,
      COALESCE(NULLIF(n.data->>'category', ''), n.type, 'billing') AS category,
      COALESCE(NULLIF(n.data->>'priority', ''), 'normal') AS priority,
      n.title,
      n.message,
      n.data->>'action_href' AS action_href,
      n.data->>'action_label' AS action_label,
      n.data,
      n.read_at,
      n.created_at
    FROM saas_immobilier.notifications n
    WHERE n.agency_id = p_agency_id
      AND (n.user_id IS NULL OR n.user_id = v_uid OR public.billing_has_access(p_agency_id))
      AND (NOT COALESCE(p_unread_only, false) OR n.read_at IS NULL)
      AND (
        v_cat IS NULL
        OR COALESCE(NULLIF(n.data->>'category', ''), n.type) = v_cat
      )
      AND (p_from_date IS NULL OR (n.created_at AT TIME ZONE 'Africa/Bamako')::date >= p_from_date)
      AND (p_to_date IS NULL OR (n.created_at AT TIME ZONE 'Africa/Bamako')::date <= p_to_date)
    ORDER BY n.created_at DESC
    LIMIT v_lim
  ) x;

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'unread_count', COALESCE(v_unread, 0),
    'total_count', COALESCE(v_total, 0),
    'category_counts', COALESCE(v_cat_counts, '{}'::jsonb),
    'timezone', 'Africa/Bamako',
    'notifications', v_rows
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_notifications_center(uuid, text, boolean, date, date, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agency_mark_notification(
  p_agency_id uuid,
  p_notification_id uuid,
  p_read boolean DEFAULT true
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_agency_id IS NULL OR p_notification_id IS NULL THEN
    RAISE EXCEPTION 'Identifiants obligatoires.' USING ERRCODE = '22023';
  END IF;

  IF NOT (public.is_agency_member_any_status(p_agency_id) OR public.billing_has_access(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé.' USING ERRCODE = '42501';
  END IF;

  UPDATE saas_immobilier.notifications
  SET read_at = CASE WHEN COALESCE(p_read, true) THEN COALESCE(read_at, now()) ELSE NULL END
  WHERE id = p_notification_id
    AND agency_id = p_agency_id;

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_mark_notification(uuid, uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agency_mark_all_notifications_read(
  p_agency_id uuid,
  p_category text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cat text := NULLIF(lower(btrim(COALESCE(p_category, ''))), '');
  v_updated integer := 0;
BEGIN
  IF p_agency_id IS NULL THEN
    RAISE EXCEPTION 'Agence obligatoire.' USING ERRCODE = '22023';
  END IF;

  IF NOT (public.is_agency_member_any_status(p_agency_id) OR public.billing_has_access(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé.' USING ERRCODE = '42501';
  END IF;

  IF v_cat = 'all' THEN v_cat := NULL; END IF;

  UPDATE saas_immobilier.notifications n
  SET read_at = now()
  WHERE n.agency_id = p_agency_id
    AND n.read_at IS NULL
    AND (v_cat IS NULL OR COALESCE(NULLIF(n.data->>'category', ''), n.type) = v_cat);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_mark_all_notifications_read(uuid, text) TO authenticated, service_role;

-- Historique structuré des événements de facturation d'une agence (avec liens factures / paiements)
CREATE OR REPLACE FUNCTION public.agency_billing_events(
  p_agency_id uuid,
  p_limit integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 60), 1), 200);
BEGIN
  IF p_agency_id IS NULL THEN
    RAISE EXCEPTION 'Agence obligatoire.' USING ERRCODE = '22023';
  END IF;

  IF NOT (public.billing_has_access(p_agency_id) OR public.is_agency_member_any_status(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé.' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(e)), '[]'::jsonb)
    FROM (
      SELECT
        se.id,
        se.agency_id,
        se.event_type,
        se.plan_from_name,
        se.plan_to_name,
        se.mensualite_from,
        se.mensualite_to,
        se.mensualite_variation,
        se.invoice_id,
        inv.reference AS invoice_reference,
        inv.status AS invoice_status,
        se.payment_id,
        sp.online_payment_id,
        se.amount,
        se.reference,
        se.reason,
        se.created_at,
        CASE
          WHEN sp.online_payment_id IS NOT NULL THEN '/paiement/retour?payment=' || sp.online_payment_id::text
          ELSE '/mon-offre'
        END AS action_href
      FROM saas_immobilier.subscription_events se
      LEFT JOIN saas_immobilier.subscription_invoices inv ON inv.id = se.invoice_id
      LEFT JOIN saas_immobilier.subscription_payments sp ON sp.id = se.payment_id
      WHERE se.agency_id = p_agency_id
      ORDER BY se.created_at DESC
      LIMIT v_lim
    ) e
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_billing_events(uuid, integer) TO authenticated, service_role;

-- Scan idempotent des alertes administrateur datées + expiration des sessions SasPay périmées
CREATE OR REPLACE FUNCTION public.admin_scan_alerts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_expired_op record;
  v_expired_count int := 0;
  v_scanned int := 0;
BEGIN
  IF NOT (
    v_jwt_role = 'service_role'
    OR v_privileged
    OR (v_jwt_role = 'authenticated' AND public.is_platform_admin())
  ) THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  -- Expirer proprement les sessions SasPay dont expires_at est dépassé
  FOR v_expired_op IN
    SELECT id, checkout_session_id, agency_id, amount, purpose
    FROM saas_immobilier.online_payments
    WHERE status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at < now()
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_expired_op.checkout_session_id IS NOT NULL THEN
      PERFORM public.saspay_record_failed(
        v_expired_op.id,
        v_expired_op.checkout_session_id,
        'saspay_session_expired',
        true
      );
    ELSE
      UPDATE saas_immobilier.online_payments
      SET status = 'expired', fail_reason = 'intent_expired', updated_at = now()
      WHERE id = v_expired_op.id;
    END IF;
    v_expired_count := v_expired_count + 1;
  END LOOP;

  -- Alerter si des agences sont en attente d'installation physique depuis plus de 48h
  PERFORM saas_immobilier.admin_alert_once(
    a.id,
    'pending-48h:' || a.id::text,
    'pending_installation_delayed',
    'high',
    format('Installation physique en attente > 48h (%s)', a.name),
    format('Inscrite le %s — installation physique toujours en statut %s.', to_char(a.created_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY'), a.installation_status),
    '/admin/validations',
    'Traiter le dossier',
    jsonb_build_object('category', 'onboarding', 'installation_status', a.installation_status)
  )
  FROM saas_immobilier.agencies a
  WHERE a.status = 'pending'
    AND a.installation_status <> 'completed'
    AND a.created_at < now() - interval '48 hours';

  GET DIAGNOSTICS v_scanned = ROW_COUNT;

  RETURN jsonb_build_object(
    'expired_sessions', v_expired_count,
    'delayed_onboarding_checked', v_scanned,
    'scanned_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_scan_alerts() TO authenticated, service_role;

-- Centre complet de supervision & d'alertes administrateur avec filtres serveur
CREATE OR REPLACE FUNCTION public.admin_alerts_center(
  p_category text DEFAULT NULL,
  p_priority text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_agency_id uuid DEFAULT NULL,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_limit integer DEFAULT 150
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 150), 1), 300);
  v_cat text := NULLIF(lower(btrim(COALESCE(p_category, ''))), '');
  v_prio text := NULLIF(lower(btrim(COALESCE(p_priority, ''))), '');
  v_stat text := lower(btrim(COALESCE(p_status, 'all')));
  v_rows jsonb;
  v_unread integer;
  v_critical integer;
  v_saspay_unread integer;
  v_grace_susp_unread integer;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  IF v_cat = 'all' THEN v_cat := NULL; END IF;
  IF v_prio = 'all' THEN v_prio := NULL; END IF;

  SELECT
    COUNT(*) FILTER (WHERE NOT is_read),
    COUNT(*) FILTER (WHERE NOT is_read AND priority IN ('high', 'critical')),
    COUNT(*) FILTER (WHERE NOT is_read AND (kind LIKE 'saspay%' OR kind LIKE 'payment%')),
    COUNT(*) FILTER (WHERE NOT is_read AND (kind LIKE '%grace%' OR kind LIKE '%suspended%'))
  INTO v_unread, v_critical, v_saspay_unread, v_grace_susp_unread
  FROM saas_immobilier.admin_alerts;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT
      al.id,
      al.agency_id,
      a.name AS agency_name,
      al.kind,
      CASE
        WHEN COALESCE(al.metadata->>'category', '') <> '' THEN al.metadata->>'category'
        WHEN al.kind LIKE 'saspay%' OR al.kind LIKE 'payment_amount%' THEN 'saspay'
        WHEN al.kind LIKE '%signup%' OR al.kind LIKE '%installation%' THEN 'onboarding'
        WHEN al.kind LIKE '%trial%' THEN 'trial'
        WHEN al.kind LIKE '%suspended%' OR al.kind LIKE '%reactivated%' OR al.kind LIKE '%grace%' THEN 'suspension'
        ELSE 'billing'
      END AS category,
      al.title,
      al.reason,
      al.priority,
      al.action_href,
      al.action_label,
      al.metadata,
      al.is_read,
      al.read_at,
      al.created_at
    FROM saas_immobilier.admin_alerts al
    LEFT JOIN saas_immobilier.agencies a ON a.id = al.agency_id
    WHERE (p_agency_id IS NULL OR al.agency_id = p_agency_id)
      AND (v_prio IS NULL OR al.priority = v_prio)
      AND (
        v_stat = 'all'
        OR (v_stat = 'unread' AND al.is_read = false)
        OR (v_stat = 'read' AND al.is_read = true)
      )
      AND (p_from_date IS NULL OR (al.created_at AT TIME ZONE 'Africa/Bamako')::date >= p_from_date)
      AND (p_to_date IS NULL OR (al.created_at AT TIME ZONE 'Africa/Bamako')::date <= p_to_date)
      AND (
        v_cat IS NULL
        OR (
          CASE
            WHEN COALESCE(al.metadata->>'category', '') <> '' THEN al.metadata->>'category'
            WHEN al.kind LIKE 'saspay%' OR al.kind LIKE 'payment_amount%' THEN 'saspay'
            WHEN al.kind LIKE '%signup%' OR al.kind LIKE '%installation%' THEN 'onboarding'
            WHEN al.kind LIKE '%trial%' THEN 'trial'
            WHEN al.kind LIKE '%suspended%' OR al.kind LIKE '%reactivated%' OR al.kind LIKE '%grace%' THEN 'suspension'
            ELSE 'billing'
          END
        ) = v_cat
      )
    ORDER BY al.is_read ASC, al.created_at DESC
    LIMIT v_lim
  ) t;

  RETURN jsonb_build_object(
    'alerts', v_rows,
    'unread', COALESCE(v_unread, 0),
    'critical', COALESCE(v_critical, 0),
    'saspay_unread', COALESCE(v_saspay_unread, 0),
    'grace_or_suspended_unread', COALESCE(v_grace_susp_unread, 0),
    'timezone', 'Africa/Bamako'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_alerts_center(text, text, text, uuid, date, date, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_mark_all_alerts_read(p_category text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cat text := NULLIF(lower(btrim(COALESCE(p_category, ''))), '');
  v_updated integer := 0;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  IF v_cat = 'all' THEN v_cat := NULL; END IF;

  UPDATE saas_immobilier.admin_alerts al
  SET is_read = true,
      read_at = COALESCE(read_at, now())
  WHERE al.is_read = false
    AND (
      v_cat IS NULL
      OR COALESCE(al.metadata->>'category', '') = v_cat
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_mark_all_alerts_read(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Activation de Supabase Realtime sur les notifications, alertes et paiements
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH v_tbl IN ARRAY ARRAY['notifications', 'admin_alerts', 'online_payments', 'agency_subscriptions']
    LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_rel pr
        JOIN pg_publication p ON p.oid = pr.prpubid
        JOIN pg_class c ON c.oid = pr.prrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE p.pubname = 'supabase_realtime'
          AND n.nspname = 'saas_immobilier'
          AND c.relname = v_tbl
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE saas_immobilier.%I', v_tbl);
      END IF;
    END LOOP;
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Unification des helpers historiques `emit_agency_notification_once` et
--    `emit_admin_alert_once` vers `billing_notify_once` / `admin_alert_once`
--    afin d'éviter tout doublon lors de la création d'agence (`create_agency_for_self`).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.emit_agency_notification_once(
  p_agency_id uuid,
  p_event_key text,
  p_title text,
  p_message text,
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_norm_key text := CASE
    WHEN p_event_key LIKE 'onboarding_created:%' OR p_event_key LIKE 'agency_registered:%' THEN 'onboarding-created:' || p_agency_id::text
    ELSE p_event_key
  END;
  v_id uuid;
BEGIN
  v_id := saas_immobilier.billing_notify_once(
    p_agency_id    => p_agency_id,
    p_event_key    => v_norm_key,
    p_category     => COALESCE(NULLIF(p_data->>'category', ''), CASE WHEN COALESCE((p_data->>'onboarding')::boolean, false) THEN 'onboarding' ELSE 'billing' END),
    p_title        => p_title,
    p_message      => p_message,
    p_action_href  => COALESCE(p_data->>'action_href', '/dashboard'),
    p_action_label => COALESCE(p_data->>'action_label', 'Suivre mon dossier'),
    p_priority     => COALESCE(p_data->>'priority', 'normal'),
    p_data         => COALESCE(p_data, '{}'::jsonb)
  );
  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION saas_immobilier.emit_agency_notification_once(
  p_agency_id uuid,
  p_event_key text,
  p_type text,
  p_title text,
  p_message text,
  p_data jsonb DEFAULT '{}'::jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_norm_key text := CASE
    WHEN p_event_key LIKE 'onboarding_created:%' OR p_event_key LIKE 'agency_registered:%' THEN 'onboarding-created:' || p_agency_id::text
    ELSE p_event_key
  END;
  v_id uuid;
BEGIN
  v_id := saas_immobilier.billing_notify_once(
    p_agency_id    => p_agency_id,
    p_event_key    => v_norm_key,
    p_category     => COALESCE(NULLIF(p_data->>'category', ''), p_type, 'onboarding'),
    p_title        => p_title,
    p_message      => p_message,
    p_action_href  => COALESCE(p_data->>'action_href', '/mon-offre'),
    p_action_label => COALESCE(p_data->>'action_label', 'Consulter mon dossier'),
    p_priority     => COALESCE(p_data->>'priority', 'normal'),
    p_data         => COALESCE(p_data, '{}'::jsonb)
  );
  RETURN v_id IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION saas_immobilier.emit_admin_alert_once(
  p_alert_key text,
  p_kind text,
  p_title text,
  p_reason text,
  p_priority text DEFAULT 'normal',
  p_agency_id uuid DEFAULT NULL,
  p_action_href text DEFAULT '/admin/validations',
  p_action_label text DEFAULT 'Ouvrir',
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_norm_key text := CASE
    WHEN (p_alert_key LIKE 'agency_created:%' OR p_alert_key LIKE 'agency_created_%') AND p_agency_id IS NOT NULL
      THEN 'onboarding-created:' || p_agency_id::text
    ELSE p_alert_key
  END;
BEGIN
  RETURN saas_immobilier.admin_alert_once(
    p_agency_id    => p_agency_id,
    p_alert_key    => v_norm_key,
    p_kind         => p_kind,
    p_priority     => p_priority,
    p_title        => p_title,
    p_reason       => p_reason,
    p_action_href  => COALESCE(p_action_href, '/admin/validations'),
    p_action_label => COALESCE(p_action_label, 'Ouvrir'),
    p_metadata     => COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION saas_immobilier.emit_admin_alert_once(
  p_agency_id uuid,
  p_event_key text,
  p_kind text,
  p_priority text,
  p_title text,
  p_reason text,
  p_action_href text DEFAULT NULL,
  p_action_label text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_norm_key text := CASE
    WHEN p_event_key LIKE 'agency_created:%' OR p_event_key LIKE 'agency_created_%' THEN 'onboarding-created:' || p_agency_id::text
    ELSE p_event_key
  END;
BEGIN
  RETURN saas_immobilier.admin_alert_once(
    p_agency_id    => p_agency_id,
    p_alert_key    => v_norm_key,
    p_kind         => p_kind,
    p_priority     => p_priority,
    p_title        => p_title,
    p_reason       => p_reason,
    p_action_href  => COALESCE(p_action_href, '/admin/validations'),
    p_action_label => COALESCE(p_action_label, 'Ouvrir'),
    p_metadata     => COALESCE(p_metadata, '{}'::jsonb)
  );
END;
$$;

COMMIT;
