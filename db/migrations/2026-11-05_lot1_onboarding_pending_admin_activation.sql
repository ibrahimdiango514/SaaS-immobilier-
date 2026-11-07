-- =============================================================================
-- LOT 1 — INSCRIPTION, CHOIX OBLIGATOIRE DE L'OFFRE, INSTALLATION PHYSIQUE
--         ET ACTIVATION ADMINISTRATIVE (DÉMARRAGE ESSAI GRATUIT 14 JOURS)
-- =============================================================================
-- Principes garantis :
--   1. Migration 100 % additive : aucune suppression de table ni de donnée
--      historique (SBC AI Agency Demo, paiements, factures, déclarations,
--      événements SasPay, notifications et alertes intégralement préservés).
--   2. Choix obligatoire de l'offre (Essentiel / Pro / Premium) dès la création
--      de l'agence, enregistrée en statut `pending` sans aucun accès métier.
--   3. Encaissement des frais d'installation réalisé exclusivement de manière
--      physique (hors SasPay, hors factures d'abonnement), tracé dans une table
--      dédiée `saas_immobilier.physical_installation_payments` et exposé dans
--      une ligne financière distincte « Installations physiques ».
--   4. Activation administrative (« Activer l'agence ») après installation
--      physique : ouvre automatiquement 14 jours d'essai gratuit (J0 -> J14)
--      avec accès 100 % complet aux modules et quotas de l'offre choisie.
--   5. Règle métier de changement d'offre : pendant `pending` et les 14 jours
--      d'essai, seul l'administrateur peut modifier l'offre lorsque les frais
--      d'installation changent.
--   6. Durcissement sécurité / RLS :
--      - Les agences `pending` (comme `suspended` / `cancelled`) n'ont aucun
--        accès aux tables opérationnelles (`is_agency_member`, `has_agency_role`,
--        `agence_active` exigent `status IN ('active', 'trial')`).
--      - `is_agency_member_any_status` et `billing_has_access` permettent
--        uniquement la lecture du dossier d'agence, de l'abonnement et des
--        notifications pour éviter toute boucle de routage.
--      - Trigger `trg_protect_agency_privileged_columns` interdisant toute
--        auto-activation ou altération des colonnes administratives par un
--        membre d'agence.
--      - Suppression des policies permettant à un `owner` de supprimer son
--        agence ou son abonnement.
--      - Neutralisation des anciens parcours contournant `pending`
--        (`onboard_agency`, `agency_create_with_trial`, `agency_start_trial`,
--        trigger prototype `enforce_automatic_signup_settings`).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Neutralisation du trigger prototype Lab forçant require_admin_validation=false
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS enforce_automatic_signup_settings ON saas_immobilier.platform_settings;

-- Réglages plateforme : validation administrative obligatoire + essai 14 jours
-- + quotas complets de l'offre pendant l'essai + 5 jours de grâce.
INSERT INTO saas_immobilier.platform_settings (key, value)
VALUES
  ('signup', '{"require_admin_validation": true, "trial_days": 14}'::jsonb),
  ('trial',  '{"quota_source": "plan"}'::jsonb),
  ('billing', '{"grace_days": 5, "reminder_days": [5, 2, 0]}'::jsonb)
ON CONFLICT (key) DO UPDATE
SET value = CASE saas_immobilier.platform_settings.key
  WHEN 'signup' THEN COALESCE(saas_immobilier.platform_settings.value, '{}'::jsonb)
                     || '{"require_admin_validation": true, "trial_days": 14}'::jsonb
  WHEN 'trial'  THEN (COALESCE(saas_immobilier.platform_settings.value, '{}'::jsonb) - 'agent_messages')
                     || '{"quota_source": "plan"}'::jsonb
  WHEN 'billing' THEN jsonb_build_object(
                     'grace_days', 5,
                     'reminder_days', COALESCE(saas_immobilier.platform_settings.value->'reminder_days', '[5, 2, 0]'::jsonb)
                   )
  ELSE EXCLUDED.value
END,
updated_at = now();

-- -----------------------------------------------------------------------------
-- 2. Colonnes additives sur `saas_immobilier.agencies` pour le suivi physique
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN IF NOT EXISTS installation_fee_expected numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS installation_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS installation_amount_collected numeric(14,2),
  ADD COLUMN IF NOT EXISTS installation_collected_at timestamptz,
  ADD COLUMN IF NOT EXISTS installation_collected_by uuid REFERENCES saas_immobilier.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS installation_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS installation_completed_by uuid REFERENCES saas_immobilier.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS installation_payment_method text,
  ADD COLUMN IF NOT EXISTS installation_receipt_reference text,
  ADD COLUMN IF NOT EXISTS installation_note text,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS activated_by uuid REFERENCES saas_immobilier.user_profiles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agencies_installation_fee_expected_check'
      AND conrelid = 'saas_immobilier.agencies'::regclass
  ) THEN
    ALTER TABLE saas_immobilier.agencies
      ADD CONSTRAINT agencies_installation_fee_expected_check
      CHECK (installation_fee_expected >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agencies_installation_amount_collected_check'
      AND conrelid = 'saas_immobilier.agencies'::regclass
  ) THEN
    ALTER TABLE saas_immobilier.agencies
      ADD CONSTRAINT agencies_installation_amount_collected_check
      CHECK (installation_amount_collected IS NULL OR installation_amount_collected >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agencies_installation_status_check'
      AND conrelid = 'saas_immobilier.agencies'::regclass
  ) THEN
    ALTER TABLE saas_immobilier.agencies
      ADD CONSTRAINT agencies_installation_status_check
      CHECK (installation_status IN ('pending', 'paid_pending_setup', 'completed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agencies_installation_payment_method_check'
      AND conrelid = 'saas_immobilier.agencies'::regclass
  ) THEN
    ALTER TABLE saas_immobilier.agencies
      ADD CONSTRAINT agencies_installation_payment_method_check
      CHECK (
        installation_payment_method IS NULL
        OR installation_payment_method IN (
          'cash', 'orange_money_physical', 'wave_physical', 'bank_transfer', 'check', 'other'
        )
      );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Table dédiée aux encaissements d'installations physiques (hors SasPay)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.physical_installation_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_name text,
  install_stage text NOT NULL DEFAULT 'initial'
    CHECK (install_stage IN ('initial', 'upgrade_supplement', 'adjustment')),
  expected_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (expected_amount >= 0),
  collected_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
  currency text NOT NULL DEFAULT 'XOF',
  payment_method text NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'orange_money_physical', 'wave_physical', 'bank_transfer', 'check', 'other')),
  receipt_reference text,
  installation_completed boolean NOT NULL DEFAULT true,
  installed_at timestamptz,
  collected_on date NOT NULL DEFAULT CURRENT_DATE,
  recorded_by uuid REFERENCES saas_immobilier.user_profiles(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS physical_installation_payments_initial_uniq
  ON saas_immobilier.physical_installation_payments (agency_id)
  WHERE install_stage = 'initial';

CREATE INDEX IF NOT EXISTS physical_installation_payments_collected_on_idx
  ON saas_immobilier.physical_installation_payments (collected_on DESC);

ALTER TABLE saas_immobilier.physical_installation_payments ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON saas_immobilier.physical_installation_payments TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON saas_immobilier.physical_installation_payments TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Tables d'alertes et de déduplication de notifications (idempotent : déjà
--    présentes en Production, garanties en Lab)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.admin_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  alert_key text UNIQUE,
  kind text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  action_href text,
  action_label text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE saas_immobilier.admin_alerts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.admin_alerts TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'saas_immobilier' AND tablename = 'admin_alerts' AND policyname = 'admin_alerts_platform_admin'
  ) THEN
    CREATE POLICY admin_alerts_platform_admin
      ON saas_immobilier.admin_alerts
      FOR ALL
      TO authenticated
      USING (public.is_platform_admin())
      WITH CHECK (public.is_platform_admin());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS saas_immobilier.notification_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES saas_immobilier.user_profiles(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('agency', 'admin')),
  item_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, item_id)
);

ALTER TABLE saas_immobilier.notification_dismissals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON saas_immobilier.notification_dismissals TO authenticated, service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'saas_immobilier' AND tablename = 'notification_dismissals' AND policyname = 'notification_dismissals_self'
  ) THEN
    CREATE POLICY notification_dismissals_self
      ON saas_immobilier.notification_dismissals
      FOR ALL
      TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS saas_immobilier.billing_notification_keys (
  agency_id uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  event_key text NOT NULL PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS billing_notification_keys_agency_event_uniq
  ON saas_immobilier.billing_notification_keys (agency_id, event_key);

ALTER TABLE saas_immobilier.billing_notification_keys ENABLE ROW LEVEL SECURITY;

-- Extension additive des types d'événements du journal d'opérations
ALTER TABLE saas_immobilier.subscription_events
  DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;

ALTER TABLE saas_immobilier.subscription_events
  ADD CONSTRAINT subscription_events_event_type_check
  CHECK (
    event_type IN (
      'activation',
      'plan_change',
      'suspension',
      'reactivation',
      'payment_validated',
      'payment_reclassified',
      'installation_completed',
      'trial_started',
      'trial_ended',
      'invoice_generated'
    )
  );

-- -----------------------------------------------------------------------------
-- 5. Fonctions d'autorisation & RLS durcies (blocage complet de `pending` et
--    `suspended` sur les données métier ; lecture contrôlée de l'identité)
-- -----------------------------------------------------------------------------

-- Membre actif de l'agence quel que soit le statut de l'agence (uniquement pour
-- lire la fiche agence, l'adhésion, l'abonnement et les notifications système).
CREATE OR REPLACE FUNCTION public.is_agency_member_any_status(target_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    WHERE am.agency_id = target_agency_id
      AND am.user_id = (SELECT auth.uid())
      AND am.status = 'active'
  ) OR public.is_platform_admin();
$function$;

REVOKE ALL ON FUNCTION public.is_agency_member_any_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_agency_member_any_status(uuid) TO authenticated, service_role;

-- Propriétaire ou administrateur actif de l'agence quel que soit son statut
-- (utilisé pour le suivi d'attente, la facturation et la régularisation SasPay).
CREATE OR REPLACE FUNCTION public.billing_has_access(p_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members m
    WHERE m.agency_id = p_agency_id
      AND m.user_id = (SELECT auth.uid())
      AND m.status = 'active'
      AND m.role IN ('owner', 'admin')
  ) OR public.is_platform_admin();
$function$;

REVOKE ALL ON FUNCTION public.billing_has_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_has_access(uuid) TO authenticated, service_role;

-- Accès métier opérationnel : UNIQUEMENT `active` ou `trial` !
-- Bloque intégralement `pending`, `suspended` et `cancelled` sur toutes les
-- tables métier (biens, contacts, conversations, pipeline, visites, équipe…).
CREATE OR REPLACE FUNCTION public.is_agency_member(target_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    JOIN saas_immobilier.agencies a ON a.id = am.agency_id
    WHERE am.agency_id = target_agency_id
      AND am.user_id = (SELECT auth.uid())
      AND am.status = 'active'
      AND a.status IN ('active', 'trial')
  ) OR public.is_platform_admin();
$function$;

CREATE OR REPLACE FUNCTION public.has_agency_role(target_agency_id uuid, required_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agency_members am
    JOIN saas_immobilier.agencies a ON a.id = am.agency_id
    WHERE am.agency_id = target_agency_id
      AND am.user_id = (SELECT auth.uid())
      AND am.status = 'active'
      AND (am.role = required_role OR (required_role = 'admin' AND am.role = 'owner'))
      AND a.status IN ('active', 'trial')
  ) OR public.is_platform_admin();
$function$;

CREATE OR REPLACE FUNCTION public.agence_active(p_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agencies a
    WHERE a.id = p_agency_id
      AND a.status IN ('active', 'trial')
  );
$function$;

CREATE OR REPLACE FUNCTION saas_immobilier.agence_active(p_agency_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agencies a
    WHERE a.id = p_agency_id
      AND a.status IN ('active', 'trial')
  );
$function$;

-- Si les tables de médias immobiliers existent (Production), durcir aussi le
-- stockage des photos de biens pour refuser `pending` et `suspended`.
DO $$
BEGIN
  IF to_regclass('saas_immobilier.properties') IS NOT NULL
     AND to_regclass('saas_immobilier.property_media') IS NOT NULL THEN
    EXECUTE $storage_fn$
      CREATE OR REPLACE FUNCTION saas_immobilier.can_write_property_object(object_path text)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'public'
      AS $fn$
        SELECT
          public.is_platform_admin()
          OR (
            split_part(object_path, '/', 1) = 'properties'
            AND object_path NOT LIKE '%..%'
            AND (
              EXISTS (
                SELECT 1
                FROM saas_immobilier.property_media pm
                JOIN saas_immobilier.agency_members m ON m.agency_id = pm.agency_id
                JOIN saas_immobilier.agencies a ON a.id = pm.agency_id
                WHERE pm.storage_path = object_path
                  AND m.user_id = auth.uid()
                  AND m.status = 'active'
                  AND a.status IN ('active', 'trial')
              )
              OR EXISTS (
                SELECT 1
                FROM saas_immobilier.properties p
                JOIN saas_immobilier.agency_members m ON m.agency_id = p.agency_id
                JOIN saas_immobilier.agencies a ON a.id = p.agency_id
                WHERE left(
                        coalesce(
                          nullif(
                            upper(regexp_replace(btrim(p.reference), '[^A-Za-z0-9_-]+', '', 'g')),
                            ''
                          ),
                          'BIEN'
                        ),
                        24
                      ) = split_part(object_path, '/', 2)
                  AND m.user_id = auth.uid()
                  AND m.status = 'active'
                  AND a.status IN ('active', 'trial')
              )
            )
          );
      $fn$;
    $storage_fn$;
  END IF;
END $$;

-- Policies RLS de lecture d'identité & verrouillage des suppressions
GRANT SELECT, UPDATE, DELETE ON saas_immobilier.agencies TO authenticated, service_role;
GRANT SELECT ON saas_immobilier.agency_members TO authenticated, service_role;
GRANT SELECT, DELETE ON saas_immobilier.agency_subscriptions TO authenticated, service_role;
GRANT SELECT, UPDATE ON saas_immobilier.notifications TO authenticated, service_role;
GRANT SELECT ON saas_immobilier.online_payments TO authenticated, service_role;

DROP POLICY IF EXISTS agencies_delete_owner ON saas_immobilier.agencies;
DROP POLICY IF EXISTS agencies_delete_platform_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_delete_platform_admin
  ON saas_immobilier.agencies
  FOR DELETE
  TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS agencies_select_member ON saas_immobilier.agencies;
DROP POLICY IF EXISTS lab_agencies_member ON saas_immobilier.agencies;
CREATE POLICY agencies_select_member
  ON saas_immobilier.agencies
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member_any_status(id));

DROP POLICY IF EXISTS agencies_update_admin ON saas_immobilier.agencies;
CREATE POLICY agencies_update_admin
  ON saas_immobilier.agencies
  FOR UPDATE
  TO authenticated
  USING (public.billing_has_access(id))
  WITH CHECK (public.billing_has_access(id));

DROP POLICY IF EXISTS agency_members_select_member ON saas_immobilier.agency_members;
DROP POLICY IF EXISTS lab_members_member ON saas_immobilier.agency_members;
CREATE POLICY agency_members_select_member
  ON saas_immobilier.agency_members
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member_any_status(agency_id));

DROP POLICY IF EXISTS agency_subscriptions_delete_owner ON saas_immobilier.agency_subscriptions;
DROP POLICY IF EXISTS agency_subscriptions_delete_platform_admin ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_delete_platform_admin
  ON saas_immobilier.agency_subscriptions
  FOR DELETE
  TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS agency_subscriptions_select_member ON saas_immobilier.agency_subscriptions;
DROP POLICY IF EXISTS lab_subscriptions_member ON saas_immobilier.agency_subscriptions;
CREATE POLICY agency_subscriptions_select_member
  ON saas_immobilier.agency_subscriptions
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member_any_status(agency_id));

DROP POLICY IF EXISTS notifications_select_member ON saas_immobilier.notifications;
DROP POLICY IF EXISTS lab_notifications_member ON saas_immobilier.notifications;
CREATE POLICY notifications_select_member
  ON saas_immobilier.notifications
  FOR SELECT
  TO authenticated
  USING (public.is_agency_member_any_status(agency_id));

DROP POLICY IF EXISTS notifications_update_member ON saas_immobilier.notifications;
CREATE POLICY notifications_update_member
  ON saas_immobilier.notifications
  FOR UPDATE
  TO authenticated
  USING (public.is_agency_member_any_status(agency_id))
  WITH CHECK (public.is_agency_member_any_status(agency_id));

DROP POLICY IF EXISTS online_payments_member_select ON saas_immobilier.online_payments;
CREATE POLICY online_payments_member_select
  ON saas_immobilier.online_payments
  FOR SELECT
  TO authenticated
  USING (public.billing_has_access(agency_id));

DROP POLICY IF EXISTS physical_installations_admin_all ON saas_immobilier.physical_installation_payments;
CREATE POLICY physical_installations_admin_all
  ON saas_immobilier.physical_installation_payments
  FOR ALL
  TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

DROP POLICY IF EXISTS physical_installations_agency_select ON saas_immobilier.physical_installation_payments;
CREATE POLICY physical_installations_agency_select
  ON saas_immobilier.physical_installation_payments
  FOR SELECT
  TO authenticated
  USING (public.billing_has_access(agency_id));

-- Trigger BEFORE UPDATE sur `agencies` : interdit toute auto-activation ou
-- falsification des colonnes administratives/facturation/installation par un
-- membre d'agence non administrateur plateforme.
CREATE OR REPLACE FUNCTION saas_immobilier.protect_agency_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_internal boolean := COALESCE(current_setting('sofia.internal_agency_mutation', true), '') = 'on';
  v_jwt_role text := auth.role();
  v_direct_superuser boolean := (v_jwt_role IS NULL AND session_user IN ('postgres', 'supabase_admin'));
BEGIN
  IF v_internal OR v_jwt_role = 'service_role' OR v_direct_superuser OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;

  -- Une agence suspendue ou résiliée ne peut modifier aucune colonne directement.
  IF OLD.status IN ('suspended', 'cancelled') THEN
    RAISE EXCEPTION 'modification directe interdite sur une agence suspendue ou resiliee'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at
     OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
     OR NEW.auto_suspend_disabled_until IS DISTINCT FROM OLD.auto_suspend_disabled_until
     OR NEW.pending_plan_id IS DISTINCT FROM OLD.pending_plan_id
     OR NEW.pending_note IS DISTINCT FROM OLD.pending_note
     OR NEW.pending_updated_at IS DISTINCT FROM OLD.pending_updated_at
     OR NEW.installation_fee_expected IS DISTINCT FROM OLD.installation_fee_expected
     OR NEW.installation_status IS DISTINCT FROM OLD.installation_status
     OR NEW.installation_amount_collected IS DISTINCT FROM OLD.installation_amount_collected
     OR NEW.installation_collected_at IS DISTINCT FROM OLD.installation_collected_at
     OR NEW.installation_collected_by IS DISTINCT FROM OLD.installation_collected_by
     OR NEW.installation_completed_at IS DISTINCT FROM OLD.installation_completed_at
     OR NEW.installation_completed_by IS DISTINCT FROM OLD.installation_completed_by
     OR NEW.installation_payment_method IS DISTINCT FROM OLD.installation_payment_method
     OR NEW.installation_receipt_reference IS DISTINCT FROM OLD.installation_receipt_reference
     OR NEW.installation_note IS DISTINCT FROM OLD.installation_note
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
  THEN
    RAISE EXCEPTION 'modification non autorisee des champs administratifs ou d activation de l agence'
      USING ERRCODE = '42501';
  END IF;

  -- Pendant `pending`, seuls le logo et les coordonnées de dossier peuvent être ajustés.
  IF OLD.status = 'pending' AND (
       NEW.commission_rate IS DISTINCT FROM OLD.commission_rate
    OR NEW.rental_commission_rate IS DISTINCT FROM OLD.rental_commission_rate
  ) THEN
    RAISE EXCEPTION 'modification des parametres metier interdite avant activation de l agence'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_protect_agency_privileged_columns ON saas_immobilier.agencies;
CREATE TRIGGER trg_protect_agency_privileged_columns
  BEFORE UPDATE ON saas_immobilier.agencies
  FOR EACH ROW
  EXECUTE FUNCTION saas_immobilier.protect_agency_privileged_columns();

-- -----------------------------------------------------------------------------
-- 6. Helpers d'alertes administrateur & notifications dédupliquées
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
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_key text := NULLIF(btrim(COALESCE(p_event_key, '')), '');
  v_inserted integer := 0;
  v_owner uuid;
BEGIN
  IF p_agency_id IS NULL OR v_key IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO saas_immobilier.billing_notification_keys (agency_id, event_key)
  VALUES (p_agency_id, v_key)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  SELECT am.user_id INTO v_owner
  FROM saas_immobilier.agency_members am
  WHERE am.agency_id = p_agency_id
    AND am.status = 'active'
    AND am.role IN ('owner', 'admin')
  ORDER BY (am.role = 'owner') DESC, am.created_at ASC
  LIMIT 1;

  INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
  VALUES (
    p_agency_id,
    v_owner,
    'system',
    p_title,
    p_message,
    COALESCE(p_data, '{}'::jsonb) || jsonb_build_object('event_key', v_key)
  );

  RETURN true;
END;
$function$;

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
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO saas_immobilier.admin_alerts (
    alert_key, kind, title, reason, priority, agency_id, action_href, action_label, metadata
  ) VALUES (
    p_alert_key,
    p_kind,
    p_title,
    p_reason,
    CASE WHEN p_priority IN ('low', 'normal', 'high', 'critical') THEN p_priority ELSE 'normal' END,
    p_agency_id,
    p_action_href,
    p_action_label,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (alert_key) DO UPDATE
    SET title        = EXCLUDED.title,
        reason       = EXCLUDED.reason,
        priority     = EXCLUDED.priority,
        action_href  = EXCLUDED.action_href,
        action_label = EXCLUDED.action_label,
        metadata     = EXCLUDED.metadata,
        is_read      = false,
        read_at      = NULL
  RETURNING id INTO v_id;

  DELETE FROM saas_immobilier.notification_dismissals d
  WHERE d.scope = 'admin' AND d.item_id = v_id;

  RETURN v_id;
END;
$function$;

-- Compatibilité lecture alertes admin (si absentes du Lab)
CREATE OR REPLACE FUNCTION public.admin_alerts(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT al.*, a.name AS agency_name
      FROM saas_immobilier.admin_alerts al
      LEFT JOIN saas_immobilier.agencies a ON a.id = al.agency_id
      WHERE (v_uid IS NULL OR NOT EXISTS (
        SELECT 1 FROM saas_immobilier.notification_dismissals nd
        WHERE nd.user_id = v_uid AND nd.scope = 'admin' AND nd.item_id = al.id
      ))
      ORDER BY al.created_at DESC
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
    ) t;

  RETURN jsonb_build_object(
    'alerts', v_rows,
    'unread', (SELECT count(*) FROM saas_immobilier.admin_alerts WHERE is_read = false),
    'critical', (SELECT count(*) FROM saas_immobilier.admin_alerts WHERE is_read = false AND priority IN ('high', 'critical'))
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_alerts(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_mark_alert(p_id uuid, p_read boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  UPDATE saas_immobilier.admin_alerts
  SET is_read = COALESCE(p_read, true),
      read_at = CASE WHEN COALESCE(p_read, true) THEN now() ELSE NULL END
  WHERE id = p_id;
  RETURN true;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_mark_alert(uuid, boolean) TO authenticated, service_role;

-- État global du compte (utilisé par App.tsx)
CREATE OR REPLACE FUNCTION saas_immobilier.mon_etat_compte()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
    'is_admin', public.is_platform_admin(),
    'memberships', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'agency_id', am.agency_id,
            'agency_name', a.name,
            'agency_status', a.status,
            'role', am.role,
            'suspended_at', a.suspended_at,
            'suspended_reason', a.suspended_reason
          ) ORDER BY a.name
        )
        FROM saas_immobilier.agency_members am
        JOIN saas_immobilier.agencies a ON a.id = am.agency_id
        WHERE am.user_id = (SELECT auth.uid())
          AND am.status = 'active'
      ),
      '[]'::jsonb
    )
  );
$function$;

GRANT EXECUTE ON FUNCTION saas_immobilier.mon_etat_compte() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Catalogue public des offres & paramètres d'inscription
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.public_plans_catalog()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'display_name', COALESCE(p.display_name, p.name),
        'description', p.description,
        'price_monthly', p.price_monthly,
        'setup_fee', p.setup_fee,
        'currency', p.currency,
        'max_members', p.max_members,
        'max_properties', p.max_properties,
        'max_photos_per_property', p.max_photos_per_property,
        'max_whatsapp_connections', p.max_whatsapp_connections,
        'monthly_agent_messages', p.monthly_agent_messages,
        'monthly_follow_ups', p.monthly_follow_ups,
        'monthly_conversations', p.monthly_conversations,
        'modules', p.modules,
        'sort_order', p.sort_order
      ) ORDER BY p.sort_order ASC, p.price_monthly ASC
    ),
    '[]'::jsonb
  )
  FROM saas_immobilier.plans p
  WHERE p.name IN ('starter', 'pro', 'enterprise');
$function$;

GRANT EXECUTE ON FUNCTION public.public_plans_catalog() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_signup_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_signup jsonb;
BEGIN
  SELECT value INTO v_signup FROM saas_immobilier.platform_settings WHERE key = 'signup';
  RETURN jsonb_build_object(
    'require_admin_validation', true,
    'trial_days', COALESCE((v_signup->>'trial_days')::int, 14),
    'quota_source', 'plan'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.platform_signup_settings() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_set_signup_settings(
  p_require_validation boolean,
  p_trial_days integer DEFAULT 14
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_days integer := 14;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  -- La règle métier validée impose la validation admin après installation physique
  -- et 14 jours d'essai gratuit.
  INSERT INTO saas_immobilier.platform_settings (key, value, updated_by)
  VALUES ('signup', jsonb_build_object('require_admin_validation', true, 'trial_days', v_days), auth.uid())
  ON CONFLICT (key) DO UPDATE
    SET value = jsonb_build_object('require_admin_validation', true, 'trial_days', v_days),
        updated_by = auth.uid(),
        updated_at = now();
  RETURN public.platform_signup_settings();
END;
$function$;

-- -----------------------------------------------------------------------------
-- 8. Inscription d'une nouvelle agence : choix obligatoire de l'offre + `pending`
-- -----------------------------------------------------------------------------
-- Suppression de l'ancienne surcharge à 11 paramètres si elle existe pour éviter
-- toute ambiguïté PostgREST avec la version à 12 paramètres.
DROP FUNCTION IF EXISTS saas_immobilier.create_agency_for_self(
  text, text, text, text, text, text, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION saas_immobilier.create_agency_for_self(
  p_name text,
  p_legal_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_country text DEFAULT 'Mali',
  p_timezone text DEFAULT 'Africa/Bamako',
  p_currency text DEFAULT 'XOF',
  p_description text DEFAULT NULL,
  p_logo_url text DEFAULT NULL,
  p_plan_id uuid DEFAULT NULL
)
RETURNS saas_immobilier.agencies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_slug text;
  v_plan record;
  v_agency saas_immobilier.agencies;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sofia-onboarding:' || v_uid::text, 0));

  IF EXISTS (
    SELECT 1 FROM saas_immobilier.agency_members am
    WHERE am.user_id = v_uid AND am.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ce compte est deja rattache a une agence'
      USING ERRCODE = '22023', HINT = 'agency_already_exists';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'le nom de l''agence est obligatoire' USING ERRCODE = '22023';
  END IF;

  IF p_plan_id IS NULL THEN
    RAISE EXCEPTION 'le choix d''une offre (Essentiel, Pro ou Premium) est obligatoire'
      USING ERRCODE = '22023', HINT = 'plan_required';
  END IF;

  SELECT pl.id, pl.name, COALESCE(pl.display_name, pl.name) AS label, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = p_plan_id
    AND pl.name IN ('starter', 'pro', 'enterprise');

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre choisie invalide : veuillez selectionner Essentiel, Pro ou Premium'
      USING ERRCODE = '22023', HINT = 'invalid_plan';
  END IF;

  INSERT INTO saas_immobilier.user_profiles (id, email, role)
  SELECT v_uid, u.email, 'agency'
  FROM auth.users u
  WHERE u.id = v_uid
  ON CONFLICT (id) DO NOTHING;

  v_slug := lower(regexp_replace(btrim(p_name), '[^a-z0-9]+', '-', 'g'));
  v_slug := btrim(v_slug, '-');
  IF v_slug = '' THEN
    v_slug := 'agence';
  END IF;
  IF EXISTS (SELECT 1 FROM saas_immobilier.agencies a WHERE a.slug = v_slug) THEN
    v_slug := v_slug || '-' || left(replace(gen_random_uuid()::text, '-', ''), 8);
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  INSERT INTO saas_immobilier.agencies (
    name, slug, legal_name, phone, email, address, city, country, timezone, currency,
    status, description, logo_url,
    pending_plan_id, pending_updated_at,
    installation_fee_expected, installation_status
  ) VALUES (
    btrim(p_name),
    v_slug,
    NULLIF(btrim(COALESCE(p_legal_name, '')), ''),
    NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_email, '')), ''),
    NULLIF(btrim(COALESCE(p_address, '')), ''),
    NULLIF(btrim(COALESCE(p_city, '')), ''),
    COALESCE(NULLIF(btrim(COALESCE(p_country, '')), ''), 'Mali'),
    COALESCE(NULLIF(btrim(COALESCE(p_timezone, '')), ''), 'Africa/Bamako'),
    COALESCE(NULLIF(btrim(COALESCE(p_currency, '')), ''), 'XOF'),
    'pending',
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    NULLIF(btrim(COALESCE(p_logo_url, '')), ''),
    v_plan.id,
    now(),
    COALESCE(v_plan.setup_fee, 0),
    'pending'
  )
  RETURNING * INTO v_agency;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role, status)
  VALUES (v_agency.id, v_uid, 'owner', 'active');

  INSERT INTO saas_immobilier.agency_business_hours (agency_id, day_of_week, start_time, end_time, enabled)
  SELECT v_agency.id, d, '08:30'::time, '18:00'::time, true
  FROM generate_series(1, 6) AS d
  ON CONFLICT DO NOTHING;

  -- Notification dédupliquée côté agence
  PERFORM saas_immobilier.emit_agency_notification_once(
    v_agency.id,
    'agency_registered:' || v_agency.id::text,
    'Dossier enregistré — Installation en attente',
    'Votre agence « ' || v_agency.name || ' » est enregistrée avec l''offre ' || v_plan.label
      || ' (installation physique : ' || to_char(COALESCE(v_plan.setup_fee, 0), 'FM999G999G999') || ' FCFA). '
      || 'Notre équipe procède à l''installation et active vos 14 jours d''essai gratuit dès la mise en service.',
    jsonb_build_object(
      'onboarding', true,
      'pending_validation', true,
      'plan_id', v_plan.id,
      'plan_name', v_plan.label,
      'setup_fee', v_plan.setup_fee,
      'price_monthly', v_plan.price_monthly
    )
  );

  -- Alerte dédupliquée côté administrateur
  PERFORM saas_immobilier.emit_admin_alert_once(
    'agency_created_' || v_agency.id::text,
    'agency_created',
    'Nouvelle agence à installer : ' || v_agency.name,
    'Offre choisie : ' || v_plan.label || ' — Frais d''installation physique à encaisser : '
      || to_char(COALESCE(v_plan.setup_fee, 0), 'FM999G999G999') || ' FCFA ('
      || COALESCE(v_agency.city, v_agency.country) || ').',
    'high',
    v_agency.id,
    '/admin/validations',
    'Gérer l''installation',
    jsonb_build_object(
      'plan_id', v_plan.id,
      'plan_name', v_plan.label,
      'setup_fee', v_plan.setup_fee,
      'price_monthly', v_plan.price_monthly,
      'city', v_agency.city,
      'phone', v_agency.phone,
      'email', v_agency.email
    )
  );

  INSERT INTO saas_immobilier.usage_events (
    agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key
  ) VALUES (
    v_agency.id,
    v_uid,
    'agency_created',
    'agency',
    v_agency.id,
    jsonb_build_object(
      'name', v_agency.name,
      'city', v_agency.city,
      'status', 'pending',
      'plan_id', v_plan.id,
      'plan_name', v_plan.label,
      'setup_fee', v_plan.setup_fee
    ),
    'agency_created_' || v_agency.id::text
  )
  ON CONFLICT DO NOTHING;

  RETURN v_agency;
END;
$function$;

REVOKE ALL ON FUNCTION saas_immobilier.create_agency_for_self(
  text, text, text, text, text, text, text, text, text, text, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION saas_immobilier.create_agency_for_self(
  text, text, text, text, text, text, text, text, text, text, text, uuid
) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9. Neutralisation des anciens parcours contournant `pending`
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.onboard_agency(p_agency_name text, p_slug text)
RETURNS TABLE(agency_id uuid, owner_user_id uuid, subscription_id uuid, sofia_config_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'Parcours obsolete desactive : utilisez l''inscription standard avec choix d''offre et activation administrative.'
    USING ERRCODE = '42501', HINT = 'onboarding_requires_admin_activation';
END;
$function$;

REVOKE ALL ON FUNCTION public.onboard_agency(text, text) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'agency_create_with_trial'
  ) THEN
    EXECUTE $neutralize$
      CREATE OR REPLACE FUNCTION public.agency_create_with_trial(
        p_name text,
        p_plan_id uuid,
        p_legal_name text DEFAULT NULL,
        p_phone text DEFAULT NULL,
        p_email text DEFAULT NULL,
        p_address text DEFAULT NULL,
        p_city text DEFAULT NULL,
        p_country text DEFAULT 'ML',
        p_timezone text DEFAULT 'Africa/Bamako',
        p_currency text DEFAULT 'XOF',
        p_description text DEFAULT NULL
      )
      RETURNS saas_immobilier.agencies
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'public'
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'Demarrage automatique d''essai interdit : toute nouvelle agence doit passer par l''installation physique et l''activation administrative.'
          USING ERRCODE = '42501', HINT = 'admin_activation_required';
      END;
      $fn$;
      REVOKE ALL ON FUNCTION public.agency_create_with_trial(
        text, uuid, text, text, text, text, text, text, text, text, text
      ) FROM PUBLIC, anon, authenticated;
    $neutralize$;
  END IF;
END $$;

-- `agency_start_trial` ne peut plus démarrer un essai par l'agence elle-même :
-- seul l'administrateur démarre les 14 jours via `admin_activate_pending_agency`.
CREATE OR REPLACE FUNCTION public.agency_start_trial(p_agency_id uuid, p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
  v_plan record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.billing_has_access(p_agency_id) THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.status, a.pending_plan_id, a.installation_fee_expected
    INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'l''essai de 14 jours ne peut etre ouvert que lors de l''activation par l''administrateur'
      USING ERRCODE = '42501', HINT = 'admin_activation_required';
  END IF;

  SELECT pl.id, COALESCE(pl.display_name, pl.name) AS label, pl.setup_fee
    INTO v_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = COALESCE(p_plan_id, v_agency.pending_plan_id);

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_admin()
     AND v_agency.pending_plan_id IS NOT NULL
     AND v_plan.id IS DISTINCT FROM v_agency.pending_plan_id
     AND COALESCE(v_plan.setup_fee, 0) IS DISTINCT FROM COALESCE(v_agency.installation_fee_expected, 0) THEN
    RAISE EXCEPTION 'Seul l''administrateur peut modifier l''offre lorsque les frais d''installation changent.'
      USING ERRCODE = '42501', HINT = 'setup_fee_change_admin_only';
  END IF;

  RETURN jsonb_build_object(
    'mode', 'pending_validation',
    'agency_id', p_agency_id,
    'plan_id', v_agency.pending_plan_id,
    'plan_name', v_plan.label
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 10. Règle métier : modification d'offre pendant `pending` et les 14j d'essai
--     réservée à l'administrateur dès que les frais d'installation diffèrent
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_select_pending_plan(p_agency_id uuid, p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
  v_current_plan record;
  v_new_plan record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.billing_has_access(p_agency_id) THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.* INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id
  FOR UPDATE;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est plus en attente d''activation' USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.name, COALESCE(pl.display_name, pl.name) AS label, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_new_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = p_plan_id AND pl.name IN ('starter', 'pro', 'enterprise');

  IF v_new_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.pending_plan_id IS NOT NULL THEN
    SELECT pl.id, pl.setup_fee INTO v_current_plan
    FROM saas_immobilier.plans pl WHERE pl.id = v_agency.pending_plan_id;
  END IF;

  IF NOT public.is_platform_admin() THEN
    IF v_agency.installation_status <> 'pending' THEN
      RAISE EXCEPTION 'L''installation est deja enregistree : seul l''administrateur peut modifier l''offre.'
        USING ERRCODE = '42501', HINT = 'installation_already_recorded';
    END IF;
    IF v_current_plan.id IS NOT NULL
       AND COALESCE(v_new_plan.setup_fee, 0) IS DISTINCT FROM COALESCE(v_current_plan.setup_fee, 0) THEN
      RAISE EXCEPTION 'Pendant la mise en service, seul l''administrateur peut modifier l''offre lorsque les frais d''installation changent.'
        USING ERRCODE = '42501', HINT = 'setup_fee_change_admin_only';
    END IF;
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  UPDATE saas_immobilier.agencies a
  SET pending_plan_id = v_new_plan.id,
      installation_fee_expected = COALESCE(v_new_plan.setup_fee, 0),
      pending_note = NULL,
      pending_updated_at = now(),
      updated_at = now()
  WHERE a.id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'plan_id', v_new_plan.id,
    'plan_name', v_new_plan.label,
    'setup_fee', COALESCE(v_new_plan.setup_fee, 0),
    'price_monthly', COALESCE(v_new_plan.price_monthly, 0),
    'amount_due', COALESCE(v_new_plan.setup_fee, 0),
    'currency', COALESCE(v_new_plan.currency, 'XOF'),
    'status', 'pending'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.agency_change_plan_during_trial(p_agency_id uuid, p_plan_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_sub record;
  v_old_plan record;
  v_new_plan record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE = '42501';
  END IF;

  SELECT s.* INTO v_sub
  FROM saas_immobilier.agency_subscriptions s
  WHERE s.agency_id = p_agency_id
  ORDER BY (s.status = 'active') DESC, s.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'aucun abonnement' USING ERRCODE = 'P0002';
  END IF;
  IF NOT (v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now()) THEN
    RAISE EXCEPTION 'changement d offre pendant l essai uniquement'
      USING ERRCODE = '22023', HINT = 'trial_change_window_closed';
  END IF;

  SELECT pl.* INTO v_old_plan FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
  SELECT pl.* INTO v_new_plan FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id AND pl.name IN ('starter', 'pro', 'enterprise');

  IF v_new_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.is_platform_admin()
     AND COALESCE(v_new_plan.setup_fee, 0) IS DISTINCT FROM COALESCE(v_old_plan.setup_fee, 0) THEN
    RAISE EXCEPTION 'Pendant les 14 jours d''essai, seul l''administrateur peut modifier l''offre lorsque les frais d''installation changent.'
      USING ERRCODE = '42501', HINT = 'setup_fee_change_admin_only';
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  UPDATE saas_immobilier.agency_subscriptions
  SET plan_id = v_new_plan.id, updated_at = now()
  WHERE id = v_sub.id;

  UPDATE saas_immobilier.agencies
  SET pending_plan_id = v_new_plan.id,
      installation_fee_expected = COALESCE(v_new_plan.setup_fee, 0),
      updated_at = now()
  WHERE id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'plan_id', v_new_plan.id,
    'plan_name', COALESCE(v_new_plan.display_name, v_new_plan.name),
    'mode', 'trial_changed'
  );
END;
$function$;

-- Si la fonction Lab `agency_change_plan_automatic` existe, appliquer la même garde pendant l'essai.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'agency_change_plan_automatic'
  ) THEN
    EXECUTE $guard_auto$
      CREATE OR REPLACE FUNCTION public.agency_change_plan_automatic(p_agency_id uuid, p_plan_id uuid)
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path TO 'pg_catalog', 'public'
      AS $fn$
      DECLARE
        v_agency saas_immobilier.agencies%ROWTYPE;
        v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
        v_current saas_immobilier.plans%ROWTYPE;
        v_target saas_immobilier.plans%ROWTYPE;
      BEGIN
        IF auth.uid() IS NULL OR NOT public.billing_has_access(p_agency_id) THEN
          RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE = '42501';
        END IF;

        SELECT * INTO v_agency FROM saas_immobilier.agencies WHERE id = p_agency_id FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
        END IF;

        IF v_agency.status = 'pending' AND NOT public.is_platform_admin() THEN
          RETURN public.agency_select_pending_plan(p_agency_id, p_plan_id);
        END IF;

        SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions
        WHERE agency_id = p_agency_id
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 1 FOR UPDATE;

        SELECT * INTO v_target FROM saas_immobilier.plans WHERE id = p_plan_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
        END IF;

        IF v_sub.id IS NOT NULL THEN
          SELECT * INTO v_current FROM saas_immobilier.plans WHERE id = v_sub.plan_id;
        END IF;

        IF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now() THEN
          RETURN public.agency_change_plan_during_trial(p_agency_id, p_plan_id);
        END IF;

        RAISE EXCEPTION 'changement d''offre en cours d''abonnement gere via facturation SasPay'
          USING ERRCODE = '22023';
      END;
      $fn$;
    $guard_auto$;
  END IF;
END $$;

-- Modification administrative de l'offre d'une agence en attente
CREATE OR REPLACE FUNCTION public.admin_set_pending_agency_plan(
  p_agency_id uuid,
  p_plan_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
  v_old_plan record;
  v_new_plan record;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.* INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id
  FOR UPDATE;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est plus en statut pending (statut : %)', v_agency.status
      USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.name, COALESCE(pl.display_name, pl.name) AS label, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_new_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = p_plan_id AND pl.name IN ('starter', 'pro', 'enterprise');

  IF v_new_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.pending_plan_id IS NOT NULL THEN
    SELECT pl.id, COALESCE(pl.display_name, pl.name) AS label, pl.price_monthly, pl.setup_fee
      INTO v_old_plan
    FROM saas_immobilier.plans pl
    WHERE pl.id = v_agency.pending_plan_id;
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  UPDATE saas_immobilier.agencies a
  SET pending_plan_id = v_new_plan.id,
      installation_fee_expected = COALESCE(v_new_plan.setup_fee, 0),
      pending_updated_at = now(),
      updated_at = now()
  WHERE a.id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    mensualite_from, mensualite_to, mensualite_variation, reason, actor_id
  ) VALUES (
    p_agency_id,
    'plan_change',
    v_old_plan.id,
    v_new_plan.id,
    v_old_plan.label,
    v_new_plan.label,
    COALESCE(v_old_plan.price_monthly, 0),
    COALESCE(v_new_plan.price_monthly, 0),
    0,
    COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), 'Modification administrative de l''offre avant activation'),
    auth.uid()
  );

  PERFORM saas_immobilier.emit_agency_notification_once(
    p_agency_id,
    'pending_plan_admin_changed:' || p_agency_id::text || ':' || v_new_plan.id::text || ':' || extract(epoch from now())::bigint::text,
    'Offre mise à jour par l''administration',
    'Votre dossier est désormais configuré sur l''offre ' || v_new_plan.label
      || ' (installation physique : ' || to_char(COALESCE(v_new_plan.setup_fee, 0), 'FM999G999G999')
      || ' FCFA ; abonnement après 14j d''essai : ' || to_char(COALESCE(v_new_plan.price_monthly, 0), 'FM999G999G999') || ' FCFA/mois).',
    jsonb_build_object('plan_id', v_new_plan.id, 'plan_name', v_new_plan.label, 'setup_fee', v_new_plan.setup_fee)
  );

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'plan_id', v_new_plan.id,
    'plan_name', v_new_plan.label,
    'setup_fee', COALESCE(v_new_plan.setup_fee, 0),
    'price_monthly', COALESCE(v_new_plan.price_monthly, 0)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_set_pending_agency_plan(uuid, uuid, text) TO authenticated, service_role;

-- Adaptation sécurisée de `admin_change_agency_plan_journaled` :
--   • si l'agence est `pending` -> met à jour l'offre en attente sans activer sans installation ;
--   • si l'agence est en essai gratuit (`trial` actif) -> change l'offre en conservant l'essai
--     jusqu'à `trial_ends_at` (sans facturer de prorata d'abonnement pendant l'essai gratuit) ;
--   • si l'agence est en abonnement payant -> conserve intégralement la proratisation serveur existante.
CREATE OR REPLACE FUNCTION public.admin_change_agency_plan_journaled(
  p_agency_id uuid,
  p_plan_id uuid,
  p_effective_on date DEFAULT CURRENT_DATE,
  p_note text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency       record;
  v_sub          record;
  v_prev_plan_id uuid;
  v_prev_name    text := NULL;
  v_prev_price   numeric := 0;
  v_new          record;
  v_variation    numeric;
  v_prorata      jsonb;
  v_invoice      uuid;
  v_event        uuid;
  v_ref          text;
  v_amount       numeric;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.* INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id
  FOR UPDATE;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.status = 'pending' THEN
    RETURN public.admin_set_pending_agency_plan(p_agency_id, p_plan_id, COALESCE(p_note, p_reason))
           || jsonb_build_object('changed', true, 'mode', 'pending_plan_updated', 'invoice_amount', 0);
  END IF;

  SELECT s.* INTO v_sub
  FROM saas_immobilier.agency_subscriptions s
  WHERE s.agency_id = p_agency_id
  ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
           s.created_at DESC
  LIMIT 1
  FOR UPDATE;

  v_prev_plan_id := v_sub.plan_id;
  IF v_prev_plan_id IS NOT NULL THEN
    SELECT COALESCE(pl.display_name, pl.name), COALESCE(pl.price_monthly, 0)
      INTO v_prev_name, v_prev_price
    FROM saas_immobilier.plans pl WHERE pl.id = v_prev_plan_id;
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_new
  FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;

  IF v_new.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_prev_plan_id IS NOT DISTINCT FROM p_plan_id THEN
    RETURN jsonb_build_object('changed', false, 'reason', 'offre inchangee');
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  -- Cas essai gratuit en cours (J0..J14) : l'offre change immédiatement avec tous ses
  -- quotas, l'échéance d'essai `trial_ends_at` est préservée, aucune facture d'abonnement
  -- n'est générée pendant l'essai gratuit.
  IF v_sub.id IS NOT NULL AND v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now() THEN
    UPDATE saas_immobilier.agency_subscriptions
    SET plan_id = v_new.id, updated_at = now()
    WHERE id = v_sub.id;

    UPDATE saas_immobilier.agencies
    SET pending_plan_id = v_new.id,
        installation_fee_expected = COALESCE(v_new.setup_fee, 0),
        updated_at = now()
    WHERE id = p_agency_id;

    PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
      mensualite_from, mensualite_to, mensualite_variation, reason, actor_id
    ) VALUES (
      p_agency_id, 'plan_change', v_prev_plan_id, v_new.id,
      v_prev_name, COALESCE(v_new.display_name, v_new.name),
      v_prev_price, v_new.price_monthly, 0,
      COALESCE(p_reason, p_note, 'Changement d''offre par administrateur pendant l''essai de 14 jours'),
      auth.uid()
    ) RETURNING id INTO v_event;

    PERFORM saas_immobilier.emit_agency_notification_once(
      p_agency_id,
      'trial_plan_admin_changed:' || v_event::text,
      'Votre offre d''essai a été mise à jour',
      'Votre essai gratuit est désormais actif sur l''offre ' || COALESCE(v_new.display_name, v_new.name)
        || ' jusqu''au ' || to_char(v_sub.trial_ends_at, 'DD/MM/YYYY') || '.',
      jsonb_build_object('plan_id', v_new.id, 'plan_name', COALESCE(v_new.display_name, v_new.name), 'trial_ends_at', v_sub.trial_ends_at)
    );

    RETURN jsonb_build_object(
      'changed', true,
      'mode', 'trial_plan_updated',
      'plan_from', v_prev_name,
      'plan_to', COALESCE(v_new.display_name, v_new.name),
      'mensualite_from', v_prev_price,
      'mensualite_to', COALESCE(v_new.price_monthly, 0),
      'mensualite_variation', 0,
      'invoice_id', NULL,
      'invoice_amount', 0,
      'event_id', v_event
    );
  END IF;

  -- Cas abonnement payant : proratisation serveur conservée intégralement.
  IF v_sub.id IS NULL THEN
    INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at, ends_at)
    VALUES (p_agency_id, v_new.id, 'active', now(), now() + interval '1 month')
    RETURNING * INTO v_sub;
  ELSE
    UPDATE saas_immobilier.agency_subscriptions
    SET plan_id = v_new.id,
        status = 'active',
        ends_at = COALESCE(ends_at, now() + interval '1 month'),
        updated_at = now()
    WHERE id = v_sub.id;
  END IF;

  UPDATE saas_immobilier.agencies
  SET status = 'active',
      pending_plan_id = v_new.id,
      suspended_at = NULL,
      suspended_reason = NULL,
      updated_at = now()
  WHERE id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  v_variation := COALESCE(v_new.price_monthly, 0) - v_prev_price;

  IF v_variation > 0 THEN
    v_prorata := public.subscription_prorata(v_variation, COALESCE(p_effective_on, CURRENT_DATE));
    v_amount  := (v_prorata->>'prorata_amount')::numeric;
    v_ref     := 'ADMIN-' || upper(left(replace(p_agency_id::text, '-', ''), 6))
                 || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

    INSERT INTO saas_immobilier.subscription_invoices (
      agency_id, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
      amount, prorata_applied, prorata_days, prorata_days_in_month,
      period_start, period_end, status, reference, note, created_by
    ) VALUES (
      p_agency_id, v_prev_plan_id, v_new.id,
      v_prev_name, COALESCE(v_new.display_name, v_new.name),
      v_amount, true,
      (v_prorata->>'days_remaining')::integer, (v_prorata->>'days_in_month')::integer,
      (v_prorata->>'effective_on')::date, (v_prorata->>'month_end')::date,
      'pending', v_ref,
      COALESCE(p_note, 'Montee d offre facturee au prorata des jours restants'),
      auth.uid()
    ) RETURNING id INTO v_invoice;
  END IF;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    mensualite_from, mensualite_to, mensualite_variation,
    invoice_id, amount, reference, reason, actor_id
  ) VALUES (
    p_agency_id, 'plan_change', v_prev_plan_id, v_new.id,
    v_prev_name, COALESCE(v_new.display_name, v_new.name),
    v_prev_price, v_new.price_monthly, v_variation,
    v_invoice, CASE WHEN v_invoice IS NULL THEN NULL ELSE v_amount END, v_ref,
    COALESCE(p_reason, p_note,
             CASE WHEN v_variation > 0 THEN 'Montee d offre'
                  WHEN v_variation < 0 THEN 'Baisse d offre'
                  ELSE 'Changement d offre' END),
    auth.uid()
  ) RETURNING id INTO v_event;

  RETURN jsonb_build_object(
    'changed', true,
    'plan_from', v_prev_name,
    'plan_to', COALESCE(v_new.display_name, v_new.name),
    'mensualite_from', v_prev_price,
    'mensualite_to', COALESCE(v_new.price_monthly, 0),
    'mensualite_variation', v_variation,
    'invoice_id', v_invoice,
    'invoice_amount', CASE WHEN v_invoice IS NULL THEN 0 ELSE v_amount END,
    'prorata', v_prorata,
    'event_id', v_event
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  PERFORM public.admin_change_agency_plan_journaled(
    p_agency_id,
    p_plan_id,
    CURRENT_DATE,
    'Changement d''offre par administrateur',
    NULL
  );
  RETURN true;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 11. Lecture de l'espace d'attente (Agence) & file d'installation (Admin)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_pending_state(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
  v_plan   record;
  v_decl   record;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    IF NOT (public.is_agency_member_any_status(p_agency_id) OR public.is_platform_admin()) THEN
      RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT a.*
    INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id;

  IF v_agency.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT pl.*
    INTO v_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = v_agency.pending_plan_id;

  SELECT d.id, d.status, d.amount, d.method, d.transaction_reference, d.paid_on, d.review_note, d.created_at
    INTO v_decl
  FROM saas_immobilier.payment_declarations d
  WHERE d.agency_id = p_agency_id
  ORDER BY d.created_at DESC
  LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'agency_id', v_agency.id,
    'agency_name', v_agency.name,
    'legal_name', v_agency.legal_name,
    'phone', v_agency.phone,
    'email', v_agency.email,
    'address', v_agency.address,
    'city', v_agency.city,
    'country', v_agency.country,
    'agency_status', v_agency.status,
    'is_pending', v_agency.status = 'pending',
    'pending_since', v_agency.created_at,
    'pending_note', v_agency.pending_note,
    'pending_updated_at', v_agency.pending_updated_at,
    'trial_days', 14,
    'plan', CASE WHEN v_plan.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_plan.id,
      'name', v_plan.name,
      'display_name', COALESCE(v_plan.display_name, v_plan.name),
      'price_monthly', v_plan.price_monthly,
      'setup_fee', v_plan.setup_fee,
      'currency', v_plan.currency,
      'max_members', v_plan.max_members,
      'max_properties', v_plan.max_properties,
      'max_photos_per_property', v_plan.max_photos_per_property,
      'monthly_agent_messages', v_plan.monthly_agent_messages,
      'monthly_follow_ups', v_plan.monthly_follow_ups,
      'modules', v_plan.modules
    ) END,
    -- Les frais d'installation sont réglés physiquement (jamais additionnés à la mensualité).
    'setup_fee', COALESCE(v_plan.setup_fee, v_agency.installation_fee_expected, 0),
    'price_monthly_after_trial', COALESCE(v_plan.price_monthly, 0),
    'amount_due', COALESCE(v_plan.setup_fee, v_agency.installation_fee_expected, 0),
    'installation', jsonb_build_object(
      'status', v_agency.installation_status,
      'fee_expected', COALESCE(v_plan.setup_fee, v_agency.installation_fee_expected, 0),
      'amount_collected', v_agency.installation_amount_collected,
      'collected_at', v_agency.installation_collected_at,
      'completed_at', v_agency.installation_completed_at,
      'payment_method', v_agency.installation_payment_method,
      'receipt_reference', v_agency.installation_receipt_reference,
      'note', v_agency.installation_note
    ),
    'latest_declaration', CASE WHEN v_decl.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_decl.id,
      'status', v_decl.status,
      'amount', v_decl.amount,
      'method', v_decl.method,
      'transaction_reference', v_decl.transaction_reference,
      'paid_on', v_decl.paid_on,
      'review_note', v_decl.review_note,
      'created_at', v_decl.created_at
    ) END
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agency_pending_state(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pending_agencies()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_rows jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.created_at ASC), '[]'::jsonb)
    INTO v_rows
  FROM (
    SELECT
      a.id AS agency_id,
      a.name AS agency_name,
      a.legal_name,
      a.slug,
      a.phone AS agency_phone,
      a.email AS agency_email,
      a.address,
      a.city,
      a.country,
      a.created_at,
      a.pending_plan_id,
      a.pending_note,
      a.pending_updated_at,
      pl.name AS plan_name,
      COALESCE(pl.display_name, pl.name) AS plan_display_name,
      pl.price_monthly,
      COALESCE(pl.setup_fee, a.installation_fee_expected, 0) AS setup_fee,
      COALESCE(pl.currency, a.currency, 'XOF') AS currency,
      COALESCE(pl.setup_fee, a.installation_fee_expected, 0) AS amount_due,
      a.installation_status,
      a.installation_amount_collected,
      a.installation_collected_at,
      a.installation_completed_at,
      a.installation_payment_method,
      a.installation_receipt_reference,
      a.installation_note,
      (
        SELECT up.full_name
        FROM saas_immobilier.user_profiles up
        JOIN saas_immobilier.agency_members am ON am.user_id = up.id
        WHERE am.agency_id = a.id AND am.role = 'owner'
        ORDER BY am.created_at ASC LIMIT 1
      ) AS owner_name,
      (
        SELECT up.email
        FROM saas_immobilier.user_profiles up
        JOIN saas_immobilier.agency_members am ON am.user_id = up.id
        WHERE am.agency_id = a.id AND am.role = 'owner'
        ORDER BY am.created_at ASC LIMIT 1
      ) AS owner_email,
      (
        SELECT up.phone
        FROM saas_immobilier.user_profiles up
        JOIN saas_immobilier.agency_members am ON am.user_id = up.id
        WHERE am.agency_id = a.id AND am.role = 'owner'
        ORDER BY am.created_at ASC LIMIT 1
      ) AS owner_phone,
      (
        SELECT jsonb_build_object(
          'id', d.id,
          'status', d.status,
          'amount', d.amount,
          'method', d.method,
          'transaction_reference', d.transaction_reference,
          'paid_on', d.paid_on,
          'proof_path', d.proof_path,
          'created_at', d.created_at
        )
        FROM saas_immobilier.payment_declarations d
        WHERE d.agency_id = a.id
        ORDER BY d.created_at DESC
        LIMIT 1
      ) AS latest_declaration,
      (
        SELECT count(*)
        FROM saas_immobilier.payment_declarations d2
        WHERE d2.agency_id = a.id AND d2.status = 'pending'
      ) AS pending_declarations_count
    FROM saas_immobilier.agencies a
    LEFT JOIN saas_immobilier.plans pl ON pl.id = a.pending_plan_id
    WHERE a.status = 'pending'
  ) t;

  RETURN jsonb_build_object('agencies', v_rows, 'total', jsonb_array_length(v_rows));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.pending_agencies() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 12. Enregistrement de l'installation physique & Activation admin (Essai 14j)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_record_physical_installation(
  p_agency_id uuid,
  p_collected_amount numeric DEFAULT NULL,
  p_payment_method text DEFAULT 'cash',
  p_receipt_reference text DEFAULT NULL,
  p_installation_completed boolean DEFAULT true,
  p_collected_on date DEFAULT CURRENT_DATE,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency    record;
  v_plan      record;
  v_expected  numeric;
  v_collected numeric;
  v_method    text := COALESCE(NULLIF(btrim(COALESCE(p_payment_method, '')), ''), 'cash');
  v_status    text;
  v_ledger_id uuid;
  v_ref       text;
  v_now       timestamptz := now();
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  IF v_method NOT IN ('cash', 'orange_money_physical', 'wave_physical', 'bank_transfer', 'check', 'other') THEN
    RAISE EXCEPTION 'mode d''encaissement physique invalide : %', v_method USING ERRCODE = '22023';
  END IF;

  SELECT a.* INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id
  FOR UPDATE;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  SELECT pl.id, pl.name, COALESCE(pl.display_name, pl.name) AS label, pl.setup_fee, pl.price_monthly, pl.currency
    INTO v_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = v_agency.pending_plan_id;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'aucune offre associee a cette agence : selectionnez une offre avant d''enregistrer l''installation'
      USING ERRCODE = '22023';
  END IF;

  v_expected  := COALESCE(v_plan.setup_fee, v_agency.installation_fee_expected, 0);
  v_collected := COALESCE(p_collected_amount, v_expected);

  IF v_collected < 0 THEN
    RAISE EXCEPTION 'le montant encaisse ne peut pas etre negatif' USING ERRCODE = '22023';
  END IF;

  v_status := CASE WHEN COALESCE(p_installation_completed, true) THEN 'completed' ELSE 'paid_pending_setup' END;
  v_ref := COALESCE(
    NULLIF(btrim(COALESCE(p_receipt_reference, '')), ''),
    'INST-' || upper(left(replace(p_agency_id::text, '-', ''), 6)) || '-' || to_char(v_now, 'YYYYMMDD')
  );

  INSERT INTO saas_immobilier.physical_installation_payments (
    agency_id, plan_id, plan_name, install_stage,
    expected_amount, collected_amount, currency, payment_method,
    receipt_reference, installation_completed,
    installed_at, collected_on, recorded_by, note
  ) VALUES (
    p_agency_id, v_plan.id, v_plan.label, 'initial',
    v_expected, v_collected, COALESCE(v_plan.currency, 'XOF'), v_method,
    v_ref, COALESCE(p_installation_completed, true),
    CASE WHEN COALESCE(p_installation_completed, true) THEN v_now ELSE NULL END,
    COALESCE(p_collected_on, CURRENT_DATE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_note, '')), '')
  )
  ON CONFLICT (agency_id) WHERE install_stage = 'initial' DO UPDATE
    SET plan_id                = EXCLUDED.plan_id,
        plan_name              = EXCLUDED.plan_name,
        expected_amount        = EXCLUDED.expected_amount,
        collected_amount       = EXCLUDED.collected_amount,
        payment_method         = EXCLUDED.payment_method,
        receipt_reference      = EXCLUDED.receipt_reference,
        installation_completed = EXCLUDED.installation_completed,
        installed_at           = COALESCE(saas_immobilier.physical_installation_payments.installed_at, EXCLUDED.installed_at),
        collected_on           = EXCLUDED.collected_on,
        recorded_by            = EXCLUDED.recorded_by,
        note                   = COALESCE(EXCLUDED.note, saas_immobilier.physical_installation_payments.note),
        updated_at             = now()
  RETURNING id INTO v_ledger_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  UPDATE saas_immobilier.agencies a
  SET installation_fee_expected     = v_expected,
      installation_status           = v_status,
      installation_amount_collected = v_collected,
      installation_collected_at     = COALESCE(a.installation_collected_at, v_now),
      installation_collected_by     = COALESCE(a.installation_collected_by, auth.uid()),
      installation_completed_at     = CASE WHEN v_status = 'completed' THEN COALESCE(a.installation_completed_at, v_now) ELSE NULL END,
      installation_completed_by     = CASE WHEN v_status = 'completed' THEN COALESCE(a.installation_completed_by, auth.uid()) ELSE NULL END,
      installation_payment_method   = v_method,
      installation_receipt_reference = v_ref,
      installation_note             = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), a.installation_note),
      pending_updated_at            = v_now,
      updated_at                    = v_now
  WHERE a.id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  -- Journalisation dans `subscription_events` sans toucher à `subscription_payments`
  IF NOT EXISTS (
    SELECT 1 FROM saas_immobilier.subscription_events se
    WHERE se.agency_id = p_agency_id
      AND se.event_type = 'installation_completed'
      AND se.reference = v_ref
  ) THEN
    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_to_id, plan_to_name,
      mensualite_to, mensualite_variation, amount, reference, reason, actor_id
    ) VALUES (
      p_agency_id,
      'installation_completed',
      v_plan.id,
      v_plan.label,
      v_plan.price_monthly,
      0,
      v_collected,
      v_ref,
      CASE WHEN v_status = 'completed'
        THEN 'Installation physique realisee et frais d''installation encaisses hors SasPay'
        ELSE 'Frais d''installation physique encaisses (installation technique en cours)'
      END,
      auth.uid()
    );
  END IF;

  IF v_status = 'completed' THEN
    PERFORM saas_immobilier.emit_agency_notification_once(
      p_agency_id,
      'physical_installation_completed:' || p_agency_id::text,
      'Installation physique réalisée',
      'L''installation de votre agence « ' || v_agency.name || ' » (offre ' || v_plan.label
        || ', reçu ' || v_ref || ') est enregistrée. L''activation de vos 14 jours d''essai gratuit est imminente.',
      jsonb_build_object(
        'installation_payment_id', v_ledger_id,
        'collected_amount', v_collected,
        'receipt_reference', v_ref,
        'plan_name', v_plan.label
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'installation_payment_id', v_ledger_id,
    'installation_status', v_status,
    'expected_amount', v_expected,
    'collected_amount', v_collected,
    'payment_method', v_method,
    'receipt_reference', v_ref,
    'currency', COALESCE(v_plan.currency, 'XOF')
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_record_physical_installation(
  uuid, numeric, text, text, boolean, date, text
) TO authenticated, service_role;

-- Suppression de l'ancienne signature 1 paramètre si nécessaire avant création
-- avec `p_note DEFAULT NULL` (compatible avec les appels à 1 seul paramètre !).
DROP FUNCTION IF EXISTS public.admin_activate_pending_agency(uuid);

CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(
  p_agency_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency     record;
  v_plan       record;
  v_sub_id     uuid;
  v_now        timestamptz := now();
  v_trial_days integer := 14;
  v_trial_end  timestamptz;
  v_event_id   uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.* INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id
  FOR UPDATE;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est pas en attente d''activation (statut : %)', v_agency.status
      USING ERRCODE = '22023';
  END IF;

  IF v_agency.pending_plan_id IS NULL THEN
    RAISE EXCEPTION 'aucune offre choisie pour cette agence' USING ERRCODE = '22023';
  END IF;

  IF v_agency.installation_status <> 'completed' THEN
    RAISE EXCEPTION 'Veuillez d''abord enregistrer l''encaissement physique et la realisation de l''installation avant d''activer l''agence.'
      USING ERRCODE = '22023', HINT = 'installation_not_completed';
  END IF;

  SELECT pl.id, pl.name, COALESCE(pl.display_name, pl.name) AS label, pl.price_monthly, pl.setup_fee, pl.currency
    INTO v_plan
  FROM saas_immobilier.plans pl
  WHERE pl.id = v_agency.pending_plan_id;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM saas_immobilier.agency_subscriptions s
    WHERE s.agency_id = p_agency_id
  ) THEN
    RAISE EXCEPTION 'un abonnement existe deja pour cette agence' USING ERRCODE = '22023';
  END IF;

  v_trial_end := v_now + make_interval(days => v_trial_days);

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  INSERT INTO saas_immobilier.agency_subscriptions (
    agency_id, plan_id, status, starts_at, ends_at, trial_ends_at
  ) VALUES (
    p_agency_id, v_plan.id, 'trial', v_now, v_trial_end, v_trial_end
  )
  RETURNING id INTO v_sub_id;

  UPDATE saas_immobilier.agencies a
  SET status             = 'trial',
      pending_note       = NULL,
      pending_updated_at = v_now,
      activated_at       = v_now,
      activated_by       = auth.uid(),
      suspended_at       = NULL,
      suspended_reason   = NULL,
      updated_at         = v_now
  WHERE a.id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, plan_to_name,
    mensualite_to, mensualite_variation, reference, reason, actor_id
  ) VALUES (
    p_agency_id,
    'trial_started',
    v_plan.id,
    v_plan.label,
    v_plan.price_monthly,
    0,
    v_agency.installation_receipt_reference,
    COALESCE(
      NULLIF(btrim(COALESCE(p_note, '')), ''),
      'Activation administrative apres installation physique — essai gratuit de 14 jours demarre'
    ),
    auth.uid()
  )
  RETURNING id INTO v_event_id;

  INSERT INTO saas_immobilier.usage_events (
    agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key
  ) VALUES (
    p_agency_id,
    auth.uid(),
    'agency_activated_trial',
    'agency',
    p_agency_id,
    jsonb_build_object(
      'subscription_id', v_sub_id,
      'plan_id', v_plan.id,
      'plan_name', v_plan.label,
      'trial_days', v_trial_days,
      'trial_starts_at', v_now,
      'trial_ends_at', v_trial_end
    ),
    'agency_activated_trial_' || p_agency_id::text
  )
  ON CONFLICT DO NOTHING;

  -- Notifications dédupliquées :
  -- 1) Agence activée + Essai 14 jours démarré (côté agence)
  PERFORM saas_immobilier.emit_agency_notification_once(
    p_agency_id,
    'agency_activated_trial:' || p_agency_id::text,
    'Agence activée — Vos 14 jours d''essai gratuit ont commencé',
    'Bienvenue sur Sofia Immobilier ! Votre offre ' || v_plan.label
      || ' est activée avec accès complet à toutes ses fonctionnalités jusqu''au '
      || to_char(v_trial_end, 'DD/MM/YYYY')
      || '. À l''issue des 14 jours, votre abonnement mensuel ('
      || to_char(COALESCE(v_plan.price_monthly, 0), 'FM999G999G999')
      || ' FCFA/mois via SasPay) prendra automatiquement le relais sans coupure.',
    jsonb_build_object(
      'agency_activated', true,
      'trial_started', true,
      'subscription_id', v_sub_id,
      'plan_id', v_plan.id,
      'plan_name', v_plan.label,
      'trial_starts_at', v_now,
      'trial_ends_at', v_trial_end,
      'price_monthly', v_plan.price_monthly
    )
  );

  -- 2) Confirmation d'essai démarré (côté administrateur)
  PERFORM saas_immobilier.emit_admin_alert_once(
    'trial_started_' || v_sub_id::text,
    'trial_started',
    'Agence activée en essai (14j) : ' || v_agency.name,
    'Offre ' || v_plan.label || ' ouverte en essai gratuit du '
      || to_char(v_now, 'DD/MM/YYYY') || ' au ' || to_char(v_trial_end, 'DD/MM/YYYY') || '.',
    'normal',
    p_agency_id,
    '/admin/abonnements',
    'Suivre l''essai',
    jsonb_build_object(
      'subscription_id', v_sub_id,
      'plan_id', v_plan.id,
      'plan_name', v_plan.label,
      'trial_starts_at', v_now,
      'trial_ends_at', v_trial_end
    )
  );

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'subscription_id', v_sub_id,
    'status', 'trial',
    'subscription_status', 'trial',
    'plan_id', v_plan.id,
    'plan_name', v_plan.label,
    'trial_days', v_trial_days,
    'starts_at', v_now,
    'trial_ends_at', v_trial_end,
    'ends_at', v_trial_end,
    'price_monthly', v_plan.price_monthly,
    'setup_fee_collected', v_agency.installation_amount_collected,
    'event_id', v_event_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_activate_pending_agency(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_reject_pending_agency(p_agency_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_agency record;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'le motif est obligatoire' USING ERRCODE = '22023';
  END IF;

  SELECT a.id, a.name, a.status INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id
  FOR UPDATE;

  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est pas en attente (statut : %)', v_agency.status
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  UPDATE saas_immobilier.agencies a
  SET pending_note = btrim(p_reason),
      pending_updated_at = now(),
      updated_at = now()
  WHERE a.id = v_agency.id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  PERFORM saas_immobilier.emit_agency_notification_once(
    v_agency.id,
    'pending_note:' || v_agency.id::text || ':' || md5(btrim(p_reason)),
    'Information sur votre dossier d''installation',
    'Message de l''administration Sofia : ' || btrim(p_reason),
    jsonb_build_object('pending_rejected', true, 'reason', btrim(p_reason))
  );

  RETURN jsonb_build_object(
    'agency_id', v_agency.id,
    'status', 'pending',
    'reason', btrim(p_reason)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_reject_pending_agency(uuid, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 13. Accès complet aux modules et quotas de l'offre pendant les 14 jours d'essai
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_current_plan(p_agency_id uuid)
RETURNS saas_immobilier.plans
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT p.*
  FROM saas_immobilier.agency_subscriptions s
  JOIN saas_immobilier.plans p ON p.id = s.plan_id
  WHERE s.agency_id = p_agency_id
    AND s.status IN ('active', 'trial', 'past_due')
  ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 ELSE 2 END,
           s.created_at DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.agency_has_module(p_agency_id uuid, p_module text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.agencies a
    WHERE a.id = p_agency_id
      AND a.status IN ('active', 'trial')
  )
  AND COALESCE(
    (
      SELECT bool_or(pl.modules @> to_jsonb(p_module::text))
      FROM public.agency_current_plan(p_agency_id) pl
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.plan_limit_value(p_agency_id uuid, p_key text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT CASE p_key
           WHEN 'max_properties'          THEN pl.max_properties
           WHEN 'max_members'             THEN pl.max_members
           WHEN 'max_photos_per_property' THEN pl.max_photos_per_property
           WHEN 'monthly_agent_messages'  THEN pl.monthly_agent_messages
           WHEN 'monthly_follow_ups'      THEN pl.monthly_follow_ups
           WHEN 'monthly_conversations'   THEN pl.monthly_conversations
           ELSE NULL
         END
  FROM public.agency_current_plan(p_agency_id) pl
  WHERE EXISTS (
    SELECT 1 FROM saas_immobilier.agencies a
    WHERE a.id = p_agency_id AND a.status IN ('active', 'trial')
  );
$function$;

CREATE OR REPLACE FUNCTION public.agency_effective_quota(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_state jsonb;
  v_plan record;
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged_direct boolean;
BEGIN
  v_privileged_direct := session_user IN ('postgres', 'supabase_admin')
                         AND v_db_role IN ('none', 'postgres', 'supabase_admin');

  IF NOT COALESCE(
    (v_jwt_role = 'service_role' AND (v_db_role = 'service_role' OR v_privileged_direct))
    OR (v_jwt_role IS NULL AND v_privileged_direct)
    OR (
      v_jwt_role = 'authenticated'
      AND auth.uid() IS NOT NULL
      AND (public.is_agency_member_any_status(p_agency_id) OR public.billing_has_access(p_agency_id))
    ),
    false
  ) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;

  v_state := public.agency_plan_state(p_agency_id);
  SELECT * INTO v_plan FROM public.agency_current_plan(p_agency_id);

  -- Quotas 100 % complets de l'offre choisie pendant l'essai de 14 jours comme en abonnement actif.
  RETURN jsonb_build_object(
    'is_trial', v_state->>'state' = 'trial',
    'source', 'plan',
    'trial_ends_at', CASE WHEN v_state->>'state' = 'trial' THEN v_state->'trial_ends_at' ELSE NULL END,
    'agent_messages_limit', COALESCE(v_plan.monthly_agent_messages, 0),
    'max_members', COALESCE(v_plan.max_members, 0),
    'max_properties', COALESCE(v_plan.max_properties, 0),
    'max_photos_per_property', COALESCE(v_plan.max_photos_per_property, 0),
    'monthly_follow_ups', COALESCE(v_plan.monthly_follow_ups, 0),
    'monthly_conversations', COALESCE(v_plan.monthly_conversations, 0)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agency_effective_quota(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 14. Suivi financier administrateur : ligne distincte « Installations physiques »
--     strictement séparée des abonnements récurrents
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_revenue_report(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_months integer;
  v_from   date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  v_months := LEAST(GREATEST(COALESCE(p_months, 12), 1), 36);
  v_from   := (date_trunc('month', now()) - ((v_months - 1) || ' month')::interval)::date;

  RETURN jsonb_build_object(
    'months', (
      SELECT COALESCE(jsonb_agg(m ORDER BY m.month_start), '[]'::jsonb)
      FROM (
        SELECT
          g.month_start,
          CASE WHEN g.month_start = date_trunc('month', now())::date
               THEN (
                 SELECT COALESCE(SUM(pl.price_monthly), 0)
                 FROM saas_immobilier.agency_subscriptions s
                 JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                 WHERE s.status = 'active'
               )
               ELSE NULL
          END AS mensualite_total,
          CASE WHEN g.month_start = date_trunc('month', now())::date
               THEN (
                 SELECT COALESCE(jsonb_object_agg(t.code, t.total), '{}'::jsonb)
                 FROM (
                   SELECT pl.name AS code, SUM(pl.price_monthly) AS total
                   FROM saas_immobilier.agency_subscriptions s
                   JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                   WHERE s.status = 'active'
                   GROUP BY 1
                 ) t
               )
               ELSE '{}'::jsonb
          END AS mensualite_par_offre,
          COALESCE(enc.encaisse, 0) AS encaisse,
          COALESCE(enc.nb, 0) AS payments_count,
          COALESCE(inst.installations_total, 0) AS installations_physiques,
          COALESCE(inst.installations_nb, 0) AS installations_physiques_count
        FROM generate_series(v_from, date_trunc('month', now())::date, interval '1 month') AS g(month_start)
        LEFT JOIN LATERAL (
          SELECT
            SUM(CASE WHEN sp.entry_kind = 'reversal' THEN -sp.amount ELSE sp.amount END) AS encaisse,
            COUNT(*) FILTER (WHERE sp.entry_kind = 'payment') AS nb
          FROM saas_immobilier.subscription_payments sp
          WHERE date_trunc('month', sp.paid_at) = g.month_start
        ) enc ON true
        LEFT JOIN LATERAL (
          SELECT
            SUM(pip.collected_amount) AS installations_total,
            COUNT(*) AS installations_nb
          FROM saas_immobilier.physical_installation_payments pip
          WHERE date_trunc('month', pip.collected_on) = g.month_start
        ) inst ON true
      ) m
    ),
    'journal', (
      SELECT COALESCE(jsonb_agg(j ORDER BY j.occurred_at DESC), '[]'::jsonb)
      FROM (
        SELECT
          se.id,
          se.created_at AS occurred_at,
          se.event_type,
          a.name AS agency_name,
          se.agency_id,
          se.plan_from_name,
          se.plan_to_name,
          se.mensualite_from,
          se.mensualite_to,
          se.mensualite_variation,
          se.amount AS facture_amount,
          se.reference,
          se.reason,
          se.payment_id,
          inv.status AS invoice_status,
          inv.amount AS invoice_amount,
          inv.prorata_applied,
          COALESCE(up.full_name, up.email) AS actor_name
        FROM saas_immobilier.subscription_events se
        JOIN saas_immobilier.agencies a ON a.id = se.agency_id
        LEFT JOIN saas_immobilier.subscription_invoices inv ON inv.id = se.invoice_id
        LEFT JOIN saas_immobilier.user_profiles up ON up.id = se.actor_id
        WHERE se.created_at >= v_from
      ) j
    ),
    'totals', (
      SELECT jsonb_build_object(
        'mensualite_total', COALESCE((
          SELECT SUM(pl.price_monthly)
          FROM saas_immobilier.agency_subscriptions s
          JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
          WHERE s.status = 'active'
        ), 0),
        'mensualite_par_offre', COALESCE((
          SELECT jsonb_object_agg(t.code, t.total)
          FROM (
            SELECT pl.name AS code, SUM(pl.price_monthly) AS total
            FROM saas_immobilier.agency_subscriptions s
            JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
            WHERE s.status = 'active'
            GROUP BY 1
          ) t
        ), '{}'::jsonb),
        'encaisse', COALESCE((
          SELECT SUM(CASE WHEN sp.entry_kind = 'reversal' THEN -sp.amount ELSE sp.amount END)
          FROM saas_immobilier.subscription_payments sp
        ), 0),
        'encaisse_mois', COALESCE((
          SELECT SUM(CASE WHEN sp.entry_kind = 'reversal' THEN -sp.amount ELSE sp.amount END)
          FROM saas_immobilier.subscription_payments sp
          WHERE date_trunc('month', sp.paid_at) = date_trunc('month', now())
        ), 0),
        'encaisse_brut', COALESCE((
          SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp WHERE sp.entry_kind = 'payment'
        ), 0),
        'ecritures_contraires', COALESCE((
          SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp WHERE sp.entry_kind = 'reversal'
        ), 0),
        'paiements_valides', (
          SELECT count(*) FROM saas_immobilier.subscription_payments sp WHERE sp.entry_kind = 'payment'
        ),
        -- Ligne financière distincte « Installations physiques » (jamais confondue avec les abonnements)
        'installations_physiques_total', COALESCE((
          SELECT SUM(pip.collected_amount) FROM saas_immobilier.physical_installation_payments pip
        ), 0),
        'installations_physiques_mois', COALESCE((
          SELECT SUM(pip.collected_amount)
          FROM saas_immobilier.physical_installation_payments pip
          WHERE date_trunc('month', pip.collected_on) = date_trunc('month', now())
        ), 0),
        'installations_physiques_periode', COALESCE((
          SELECT SUM(pip.collected_amount)
          FROM saas_immobilier.physical_installation_payments pip
          WHERE pip.collected_on >= v_from
        ), 0),
        'installations_physiques_nombre', (
          SELECT count(*) FROM saas_immobilier.physical_installation_payments
        ),
        'factures_en_attente_montant', COALESCE((
          SELECT SUM(i.amount) FROM saas_immobilier.subscription_invoices i WHERE i.status = 'pending'
        ), 0),
        'factures_en_attente_nombre', (
          SELECT count(*) FROM saas_immobilier.subscription_invoices i WHERE i.status = 'pending'
        ),
        'factures_payees_nombre', (
          SELECT count(*) FROM saas_immobilier.subscription_invoices i WHERE i.status = 'paid'
        ),
        'agences_actives', (
          SELECT count(*) FROM saas_immobilier.agency_subscriptions WHERE status = 'active'
        ),
        'agences_essai', (
          SELECT count(*) FROM saas_immobilier.agency_subscriptions WHERE status = 'trial'
        ),
        'active_without_payment', (
          SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
          FROM (
            SELECT a.id, a.name, COALESCE(pl.display_name, pl.name) AS plan_name, pl.price_monthly
            FROM saas_immobilier.agency_subscriptions s
            JOIN saas_immobilier.agencies a ON a.id = s.agency_id
            JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
            WHERE s.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM saas_immobilier.subscription_payments sp
                WHERE sp.agency_id = s.agency_id AND sp.entry_kind = 'payment'
              )
          ) x
        )
      )
    ),
    'installations_physiques', (
      SELECT COALESCE(jsonb_agg(ip ORDER BY ip.collected_on DESC, ip.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT
          pip.id,
          pip.agency_id,
          a.name AS agency_name,
          pip.plan_id,
          COALESCE(pip.plan_name, pl.display_name, pl.name) AS plan_name,
          pip.install_stage,
          pip.expected_amount,
          pip.collected_amount,
          pip.currency,
          pip.payment_method,
          pip.receipt_reference,
          pip.installation_completed,
          pip.installed_at,
          pip.collected_on,
          pip.note,
          COALESCE(up.full_name, up.email) AS recorded_by_name,
          pip.created_at
        FROM saas_immobilier.physical_installation_payments pip
        JOIN saas_immobilier.agencies a ON a.id = pip.agency_id
        LEFT JOIN saas_immobilier.plans pl ON pl.id = pip.plan_id
        LEFT JOIN saas_immobilier.user_profiles up ON up.id = pip.recorded_by
        WHERE pip.collected_on >= v_from
      ) ip
    ),
    'factures', (
      SELECT COALESCE(jsonb_agg(f ORDER BY f.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT
          i.id, i.agency_id, a.name AS agency_name, i.plan_from_name, i.plan_to_name,
          i.amount, i.status, i.prorata_applied, i.prorata_days, i.prorata_days_in_month,
          i.reference, i.created_at, i.paid_at
        FROM saas_immobilier.subscription_invoices i
        JOIN saas_immobilier.agencies a ON a.id = i.agency_id
        WHERE i.status <> 'cancelled'
      ) f
    ),
    'by_plan', (
      SELECT COALESCE(jsonb_agg(z ORDER BY z.sort_order), '[]'::jsonb)
      FROM (
        SELECT
          p.id, p.name, p.display_name, p.price_monthly, p.setup_fee, p.currency, p.sort_order,
          (SELECT count(*) FROM saas_immobilier.agency_subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_agencies,
          (SELECT count(*) FROM saas_immobilier.agency_subscriptions s WHERE s.plan_id = p.id AND s.status = 'trial') AS trial_agencies
        FROM saas_immobilier.plans p
      ) z
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.platform_revenue_report(integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.platform_subscription_revenue(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_months integer := LEAST(GREATEST(COALESCE(p_months, 12), 1), 36);
  v_from   date    := (date_trunc('month', now()) - ((v_months - 1) || ' month')::interval)::date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'months', (
      SELECT COALESCE(jsonb_agg(row_to_json(m)::jsonb ORDER BY m.month_start), '[]'::jsonb)
      FROM (
        SELECT
          g.month_start::date AS month_start,
          COALESCE(agg.revenue, 0) AS revenue,
          COALESCE(agg.paying_agencies, 0) AS paying_agencies,
          COALESCE(agg.payments_count, 0) AS payments_count,
          COALESCE(inst.installations_revenue, 0) AS installations_physiques,
          COALESCE(inst.installations_count, 0) AS installations_physiques_count
        FROM generate_series(v_from, date_trunc('month', now())::date, interval '1 month') AS g(month_start)
        LEFT JOIN (
          SELECT
            date_trunc('month', sp.paid_at)::date AS month_start,
            SUM(sp.amount) AS revenue,
            COUNT(DISTINCT sp.agency_id) AS paying_agencies,
            COUNT(*) AS payments_count
          FROM saas_immobilier.subscription_payments sp
          WHERE sp.paid_at >= v_from
          GROUP BY 1
        ) agg ON agg.month_start = g.month_start::date
        LEFT JOIN (
          SELECT
            date_trunc('month', pip.collected_on)::date AS month_start,
            SUM(pip.collected_amount) AS installations_revenue,
            COUNT(*) AS installations_count
          FROM saas_immobilier.physical_installation_payments pip
          WHERE pip.collected_on >= v_from
          GROUP BY 1
        ) inst ON inst.month_start = g.month_start::date
      ) m
    ),
    'by_plan', (
      SELECT COALESCE(jsonb_agg(row_to_json(b)::jsonb ORDER BY b.sort_order), '[]'::jsonb)
      FROM (
        SELECT
          p.id, p.name, p.display_name, p.price_monthly, p.setup_fee, p.currency, p.sort_order,
          (SELECT count(*) FROM saas_immobilier.agency_subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_agencies,
          (SELECT count(*) FROM saas_immobilier.agency_subscriptions s WHERE s.plan_id = p.id AND s.status = 'trial') AS trial_agencies,
          (SELECT count(*) FROM saas_immobilier.agency_subscriptions s WHERE s.plan_id = p.id) AS total_agencies,
          (
            SELECT COALESCE(SUM(sp.amount), 0)
            FROM saas_immobilier.subscription_payments sp
            JOIN saas_immobilier.agency_subscriptions s2 ON s2.id = sp.subscription_id
            WHERE s2.plan_id = p.id
          ) AS revenue_total,
          (
            SELECT COALESCE(SUM(pip.collected_amount), 0)
            FROM saas_immobilier.physical_installation_payments pip
            WHERE pip.plan_id = p.id
          ) AS installations_physiques_total
        FROM saas_immobilier.plans p
      ) b
    ),
    'totals', (
      SELECT jsonb_build_object(
        'revenue_period', COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp WHERE sp.paid_at >= v_from), 0),
        'revenue_all', COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp), 0),
        'installations_physiques_period', COALESCE((SELECT SUM(pip.collected_amount) FROM saas_immobilier.physical_installation_payments pip WHERE pip.collected_on >= v_from), 0),
        'installations_physiques_all', COALESCE((SELECT SUM(pip.collected_amount) FROM saas_immobilier.physical_installation_payments pip), 0),
        'installations_physiques_count', (SELECT count(*) FROM saas_immobilier.physical_installation_payments),
        'payments_period', (SELECT count(*) FROM saas_immobilier.subscription_payments sp WHERE sp.paid_at >= v_from),
        'paying_agencies_period', (SELECT count(DISTINCT sp.agency_id) FROM saas_immobilier.subscription_payments sp WHERE sp.paid_at >= v_from),
        'paying_agencies_all', (SELECT count(DISTINCT sp.agency_id) FROM saas_immobilier.subscription_payments sp),
        'paying_agencies_active', (SELECT count(*) FROM saas_immobilier.agency_subscriptions WHERE status = 'active'),
        'trial_agencies', (SELECT count(*) FROM saas_immobilier.agency_subscriptions WHERE status = 'trial'),
        'suspended_agencies', (SELECT count(*) FROM saas_immobilier.agencies WHERE status = 'suspended'),
        'expiring_30d', (
          SELECT count(*) FROM saas_immobilier.agency_subscriptions
          WHERE ends_at IS NOT NULL AND ends_at >= now() AND ends_at < (now() + interval '30 day')
        ),
        'overdue', (
          SELECT count(*) FROM saas_immobilier.agency_subscriptions
          WHERE ends_at IS NOT NULL AND ends_at < now()
        ),
        'pending_declarations', (SELECT count(*) FROM saas_immobilier.payment_declarations WHERE status = 'pending'),
        'pending_plan_changes', (SELECT count(*) FROM saas_immobilier.plan_change_requests WHERE status = 'pending')
      )
    )
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.platform_subscription_revenue(integer) TO authenticated, service_role;

COMMIT;
