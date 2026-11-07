-- =============================================================================
-- LOT 2 — Cycle d'abonnement, facturation mensuelle, grâce de 5 jours,
--         suspension automatique et réactivation sur paiement confirmé
-- Date : 2026-11-05
-- Cible d'exécution autorisée : Sofia Immobilier Lab (yswsildmbeomjlyofnrk)
-- Production (xbuuhfwobrafcbgtdgjx) : AUCUNE EXÉCUTION SANS VALIDATION EXPLICITE
--
-- Chronologie métier officielle garantie :
--   1. J0 → J14 : Essai gratuit de 14 jours après activation admin (accès 100 %
--      complet au dashboard, modules et quotas de l'offre choisie).
--   2. J14 : Démarrage automatique du 1er mois payant [J14 → E1] (E1 = J14 + 1 mois)
--      et génération automatique idempotente de la 1re facture mensuelle
--      (invoice_kind = 'first_subscription', amount = price_monthly, ZÉRO frais
--      d'installation physique ajoutés, due_at = E1, grace_ends_at = E1 + 5 jours).
--   3. J14 → E1 : Accès complet au dashboard, modules et quotas même si la
--      facture mensuelle est encore en statut 'pending'.
--   4. E1 → E1 + 5 jours : Si la facture n'est pas réglée à E1, entrée en
--      période de grâce de 5 jours (sub.status = 'past_due', agencies.status = 'active')
--      avec maintien de 100 % des accès et quotas. Si déjà payée (paid_through_at >= E1),
--      ouverture transparente du mois suivant [E1 → E2] et facture 'renewal'.
--   5. Après E1 + 5 jours : Suspension automatique (agencies.status = 'suspended',
--      suspended_reason = 'unpaid') UNIQUEMENT après expiration des 5 jours de grâce.
--   6. Confirmation d'un paiement : Règlement idempotent de la facture, mise à jour
--      des périodes / paid_through_at et réactivation automatique immédiate si suspendue.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Colonnes additives non-destructives (compatibles Lab & Production)
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN IF NOT EXISTS auto_suspend_disabled_until timestamptz;

ALTER TABLE saas_immobilier.agency_subscriptions
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_through_at timestamptz;

ALTER TABLE saas_immobilier.subscription_invoices
  ADD COLUMN IF NOT EXISTS invoice_kind text NOT NULL DEFAULT 'plan_change',
  ADD COLUMN IF NOT EXISTS due_at timestamptz,
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_kind text,
  ADD COLUMN IF NOT EXISTS billing_subscription_id uuid REFERENCES saas_immobilier.agency_subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS billing_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_period_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'saas_immobilier'
      AND c.conname = 'subscription_invoices_invoice_kind_check'
  ) THEN
    ALTER TABLE saas_immobilier.subscription_invoices
      ADD CONSTRAINT subscription_invoices_invoice_kind_check
      CHECK (invoice_kind IN ('first_subscription', 'renewal', 'plan_change', 'reactivation'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_invoices_billing_period_key_uniq
  ON saas_immobilier.subscription_invoices (billing_period_key)
  WHERE billing_period_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_invoices_cycle_period_uniq
  ON saas_immobilier.subscription_invoices (agency_id, period_start)
  WHERE invoice_kind IN ('first_subscription', 'renewal') AND status <> 'cancelled';

CREATE INDEX IF NOT EXISTS subscription_invoices_agency_status_due_idx
  ON saas_immobilier.subscription_invoices (agency_id, status, due_at DESC);

ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS online_payment_id uuid;

CREATE TABLE IF NOT EXISTS saas_immobilier.billing_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('cycle', 'reconciliation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE saas_immobilier.billing_automation_runs ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Rattrapage non-destructif des abonnements existants (ex. SBC AI Agency Demo)
-- -----------------------------------------------------------------------------
-- Les abonnements déjà 'active' sans facture de période impayée ouverte
-- (comme SBC AI Agency Demo avec ends_at = 2026-12-27) ont leur période en cours
-- déjà réglée jusqu'à ends_at -> paid_through_at = ends_at.
UPDATE saas_immobilier.agency_subscriptions s
SET
  current_period_start = COALESCE(s.current_period_start, CASE WHEN s.ends_at IS NOT NULL THEN s.ends_at - interval '1 month' ELSE s.starts_at END),
  current_period_end   = COALESCE(s.current_period_end, s.ends_at),
  grace_ends_at        = COALESCE(s.grace_ends_at, CASE WHEN s.ends_at IS NOT NULL THEN s.ends_at + interval '5 days' ELSE NULL END),
  paid_through_at      = COALESCE(
    s.paid_through_at,
    CASE
      WHEN s.status = 'active'
           AND s.ends_at IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM saas_immobilier.subscription_invoices inv
             WHERE inv.agency_id = s.agency_id
               AND inv.status = 'pending'
               AND COALESCE(inv.billing_kind, '') = 'period'
           )
      THEN s.ends_at
      ELSE NULL
    END
  )
WHERE s.status = 'active'
  AND (s.current_period_start IS NULL OR s.current_period_end IS NULL OR s.grace_ends_at IS NULL OR s.paid_through_at IS NULL);

UPDATE saas_immobilier.agency_subscriptions s
SET
  current_period_start = COALESCE(s.current_period_start, s.starts_at),
  current_period_end   = COALESCE(s.current_period_end, s.trial_ends_at, s.ends_at)
WHERE s.status = 'trial'
  AND (s.current_period_start IS NULL OR s.current_period_end IS NULL);

UPDATE saas_immobilier.subscription_invoices inv
SET
  due_at        = COALESCE(inv.due_at, inv.billing_due_at, inv.created_at),
  grace_ends_at = COALESCE(inv.grace_ends_at, CASE WHEN inv.billing_due_at IS NOT NULL THEN inv.billing_due_at + interval '5 days' ELSE inv.created_at + interval '5 days' END),
  billing_kind  = COALESCE(inv.billing_kind, CASE WHEN inv.prorata_applied THEN 'plan_change' ELSE 'period' END)
WHERE inv.due_at IS NULL OR inv.grace_ends_at IS NULL OR inv.billing_kind IS NULL;

-- Aligner les paramètres plateforme sur 14 jours d'essai et 5 jours de grâce
INSERT INTO saas_immobilier.platform_settings (key, value)
VALUES ('billing', jsonb_build_object('grace_days', 5, 'trial_days', 14, 'reminder_days', jsonb_build_array(5, 2, 0)))
ON CONFLICT (key) DO UPDATE
SET value = COALESCE(saas_immobilier.platform_settings.value, '{}'::jsonb)
          || jsonb_build_object(
               'grace_days', COALESCE((saas_immobilier.platform_settings.value->>'grace_days')::int, 5),
               'trial_days', 14
             ),
    updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. Fonctions utilitaires internes de facturation et d'alertes dédupliquées
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.subscription_reference(p_prefix text DEFAULT 'SIA')
RETURNS text
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(NULLIF(btrim(p_prefix), ''), 'SIA')
         || '-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD')
         || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
$$;

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
  v_inserted text;
BEGIN
  INSERT INTO saas_immobilier.billing_notification_keys (event_key, agency_id)
  VALUES ('admin:' || p_event_key, p_agency_id)
  ON CONFLICT (event_key) DO NOTHING
  RETURNING event_key INTO v_inserted;

  IF v_inserted IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO saas_immobilier.admin_alerts (
    agency_id, alert_key, kind, title, reason, priority, action_href, action_label, metadata
  ) VALUES (
    p_agency_id,
    'admin:' || p_event_key,
    p_type,
    p_title,
    p_message,
    CASE WHEN p_priority IN ('low', 'normal', 'high', 'critical') THEN p_priority ELSE 'normal' END,
    '/admin/abonnements',
    'Voir l''abonnement',
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('dedup_key', 'admin:' || p_event_key)
  )
  ON CONFLICT (alert_key) DO NOTHING;

  RETURN true;
END;
$$;

-- Génération strictement idempotente d'une facture mensuelle de cycle
-- IMPORTANT : n'inclut JAMAIS les frais d'installation physique (setup_fee).
CREATE OR REPLACE FUNCTION saas_immobilier.ensure_cycle_invoice(
  p_agency_id uuid,
  p_sub_id uuid,
  p_plan_id uuid,
  p_invoice_kind text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_grace_days integer DEFAULT 5,
  p_now timestamptz DEFAULT now()
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_plan saas_immobilier.plans%ROWTYPE;
  v_inv_id uuid;
  v_kind text := CASE WHEN p_invoice_kind = 'first_subscription' THEN 'first_subscription' ELSE 'renewal' END;
  v_grace int := GREATEST(COALESCE(p_grace_days, 5), 0);
  v_due timestamptz := p_period_end;
  v_grace_end timestamptz := p_period_end + make_interval(days => v_grace);
  v_period_key text;
  v_ref text;
  v_note text;
BEGIN
  SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = p_plan_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offre introuvable (%).', p_plan_id USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_plan.price_monthly, 0) <= 0 THEN
    RAISE EXCEPTION 'Mensualité invalide pour l''offre %.', v_plan.name USING ERRCODE = '22023';
  END IF;

  v_period_key := p_sub_id::text || ':' || to_char(p_period_start AT TIME ZONE 'UTC', 'YYYYMMDD');

  SELECT inv.id INTO v_inv_id
  FROM saas_immobilier.subscription_invoices inv
  WHERE (
      inv.billing_period_key = v_period_key
      OR (
        inv.agency_id = p_agency_id
        AND inv.period_start = (p_period_start AT TIME ZONE 'UTC')::date
        AND inv.invoice_kind IN ('first_subscription', 'renewal')
        AND inv.status <> 'cancelled'
      )
    )
  ORDER BY inv.created_at DESC
  LIMIT 1;

  IF v_inv_id IS NOT NULL THEN
    RETURN v_inv_id;
  END IF;

  v_ref := saas_immobilier.subscription_reference(CASE WHEN v_kind = 'first_subscription' THEN 'SUB1' ELSE 'REN' END);
  v_note := CASE
    WHEN v_kind = 'first_subscription' THEN
      format('Première mensualité après 14 jours d''essai gratuit — offre %s (hors frais d''installation physique)', COALESCE(v_plan.display_name, v_plan.name))
    ELSE
      format('Échéance mensuelle d''abonnement — offre %s', COALESCE(v_plan.display_name, v_plan.name))
  END;

  INSERT INTO saas_immobilier.subscription_invoices (
    agency_id,
    plan_from_id,
    plan_to_id,
    plan_from_name,
    plan_to_name,
    amount,
    currency,
    prorata_applied,
    period_start,
    period_end,
    status,
    reference,
    note,
    created_at,
    invoice_kind,
    due_at,
    grace_ends_at,
    billing_kind,
    billing_subscription_id,
    billing_due_at,
    billing_period_key
  ) VALUES (
    p_agency_id,
    v_plan.id,
    v_plan.id,
    COALESCE(v_plan.display_name, v_plan.name),
    COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly,
    COALESCE(v_plan.currency, 'XOF'),
    false,
    (p_period_start AT TIME ZONE 'UTC')::date,
    (p_period_end AT TIME ZONE 'UTC')::date,
    'pending',
    v_ref,
    v_note,
    COALESCE(p_now, now()),
    v_kind,
    v_due,
    v_grace_end,
    'period',
    p_sub_id,
    v_due,
    v_period_key
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inv_id;

  IF v_inv_id IS NULL THEN
    SELECT inv.id INTO v_inv_id
    FROM saas_immobilier.subscription_invoices inv
    WHERE inv.billing_period_key = v_period_key
       OR (
         inv.agency_id = p_agency_id
         AND inv.period_start = (p_period_start AT TIME ZONE 'UTC')::date
         AND inv.invoice_kind IN ('first_subscription', 'renewal')
         AND inv.status <> 'cancelled'
       )
    ORDER BY inv.created_at DESC
    LIMIT 1;
    RETURN v_inv_id;
  END IF;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id,
    event_type,
    plan_to_id,
    plan_to_name,
    mensualite_to,
    invoice_id,
    amount,
    reference,
    reason,
    created_at
  ) VALUES (
    p_agency_id,
    'invoice_generated',
    v_plan.id,
    COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly,
    v_inv_id,
    v_plan.price_monthly,
    v_ref,
    v_note,
    COALESCE(p_now, now())
  );

  RETURN v_inv_id;
END;
$$;

-- Remplacement sécurisé de saas_immobilier.billing_ensure_period_invoice
-- afin qu'aucun appel existant n'ajoute jamais setup_fee sur une facture mensuelle.
CREATE OR REPLACE FUNCTION saas_immobilier.billing_ensure_period_invoice(p_agency_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_open_inv uuid;
  v_grace int := 5;
  v_p_start timestamptz;
  v_p_end timestamptz;
  v_has_prior_cycle boolean;
BEGIN
  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
    AND status IN ('active', 'trial', 'past_due', 'expired', 'suspended')
  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Abonnement introuvable pour cette agence.' USING ERRCODE = 'P0002';
  END IF;

  IF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now() THEN
    RAISE EXCEPTION 'Essai gratuit de 14 jours encore en cours : aucune facture mensuelle exigible avant la fin de l''essai.' USING ERRCODE = '22023';
  END IF;

  SELECT inv.id INTO v_open_inv
  FROM saas_immobilier.subscription_invoices inv
  WHERE inv.agency_id = p_agency_id
    AND inv.status = 'pending'
    AND (inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR inv.billing_kind = 'period')
  ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
  LIMIT 1;

  IF v_open_inv IS NOT NULL THEN
    RETURN v_open_inv;
  END IF;

  v_has_prior_cycle := EXISTS (
    SELECT 1
    FROM saas_immobilier.subscription_invoices inv
    WHERE inv.agency_id = p_agency_id
      AND inv.invoice_kind IN ('first_subscription', 'renewal')
      AND inv.status <> 'cancelled'
  ) OR EXISTS (
    SELECT 1
    FROM saas_immobilier.subscription_payments sp
    WHERE sp.agency_id = p_agency_id
      AND sp.entry_kind = 'payment'
  );

  IF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at <= now() THEN
    v_p_start := v_sub.trial_ends_at;
    v_p_end   := v_sub.trial_ends_at + interval '1 month';
  ELSIF v_sub.paid_through_at IS NOT NULL AND v_sub.current_period_end IS NOT NULL AND v_sub.paid_through_at >= v_sub.current_period_end THEN
    v_p_start := v_sub.current_period_end;
    v_p_end   := v_sub.current_period_end + interval '1 month';
  ELSE
    v_p_start := COALESCE(v_sub.current_period_start, v_sub.starts_at, now());
    v_p_end   := COALESCE(v_sub.current_period_end, v_sub.ends_at, v_p_start + interval '1 month');
  END IF;

  RETURN saas_immobilier.ensure_cycle_invoice(
    p_agency_id,
    v_sub.id,
    v_sub.plan_id,
    CASE WHEN v_has_prior_cycle THEN 'renewal' ELSE 'first_subscription' END,
    v_p_start,
    v_p_end,
    v_grace,
    now()
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Mise à jour de admin_activate_pending_agency (LOT 1 -> LOT 2)
--    Initialise current_period_start = J0 et current_period_end = J14
-- -----------------------------------------------------------------------------
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

  SELECT * INTO v_agency
  FROM saas_immobilier.agencies
  WHERE id = p_agency_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.status <> 'pending' THEN
    RAISE EXCEPTION 'Cette agence n''est plus en attente d''activation (statut actuel : %).', v_agency.status USING ERRCODE = '22023';
  END IF;

  IF v_agency.pending_plan_id IS NULL THEN
    RAISE EXCEPTION 'Aucune offre choisie pour cette agence. Sélectionnez une offre avant l''activation.' USING ERRCODE = '22023';
  END IF;

  IF v_agency.installation_status <> 'completed' THEN
    RAISE EXCEPTION 'Activation refusée : l''installation physique sur site et l''encaissement des frais d''installation doivent être marqués comme réalisés avant l''activation.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_plan
  FROM saas_immobilier.plans
  WHERE id = v_agency.pending_plan_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offre sélectionnée introuvable.' USING ERRCODE = 'P0002';
  END IF;

  v_trial_ends_at := v_now + make_interval(days => v_trial_days);

  SELECT id INTO v_existing_sub_id
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_existing_sub_id IS NOT NULL THEN
    UPDATE saas_immobilier.agency_subscriptions
    SET
      plan_id              = v_plan.id,
      status               = 'trial',
      starts_at            = v_now,
      trial_ends_at        = v_trial_ends_at,
      ends_at              = v_trial_ends_at,
      current_period_start = v_now,
      current_period_end   = v_trial_ends_at,
      grace_ends_at        = NULL,
      paid_through_at      = NULL,
      updated_at           = v_now
    WHERE id = v_existing_sub_id
    RETURNING id INTO v_sub_id;
  ELSE
    INSERT INTO saas_immobilier.agency_subscriptions (
      agency_id,
      plan_id,
      status,
      starts_at,
      trial_ends_at,
      ends_at,
      current_period_start,
      current_period_end
    ) VALUES (
      p_agency_id,
      v_plan.id,
      'trial',
      v_now,
      v_trial_ends_at,
      v_trial_ends_at,
      v_now,
      v_trial_ends_at
    )
    RETURNING id INTO v_sub_id;
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);

  UPDATE saas_immobilier.agencies
  SET
    status           = 'trial',
    activated_at     = v_now,
    activated_by     = v_admin_id,
    suspended_at     = NULL,
    suspended_reason = NULL,
    pending_note     = COALESCE(NULLIF(btrim(p_note), ''), pending_note),
    updated_at       = v_now
  WHERE id = p_agency_id;

  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  INSERT INTO saas_immobilier.subscription_events (
    agency_id,
    event_type,
    plan_to_id,
    plan_to_name,
    mensualite_to,
    actor_id,
    reason
  ) VALUES (
    p_agency_id,
    'trial_started',
    v_plan.id,
    COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly,
    v_admin_id,
    COALESCE(
      NULLIF(btrim(p_note), ''),
      format('Activation admin après installation physique — essai gratuit %s jours avec quotas complets (%s)', v_trial_days, COALESCE(v_plan.display_name, v_plan.name))
    )
  );

  INSERT INTO saas_immobilier.activity_log (
    agency_id,
    user_id,
    action,
    entity_type,
    entity_id,
    summary,
    metadata
  ) VALUES (
    p_agency_id,
    v_admin_id,
    'agency_activated_trial_started',
    'agency',
    p_agency_id,
    format('Agence activée — essai gratuit de %s jours démarré sur l''offre %s', v_trial_days, COALESCE(v_plan.display_name, v_plan.name)),
    jsonb_build_object(
      'subscription_id', v_sub_id,
      'plan_id', v_plan.id,
      'plan_name', COALESCE(v_plan.display_name, v_plan.name),
      'trial_days', v_trial_days,
      'trial_ends_at', v_trial_ends_at
    )
  );

  PERFORM saas_immobilier.billing_notify(
    p_agency_id,
    'trial-started:' || v_sub_id::text || ':' || to_char(v_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI'),
    'Votre agence est activée !',
    format(
      'Bienvenue sur Sofia Immobilier. Votre essai gratuit de %s jours sur l''offre %s est actif jusqu''au %s avec 100 %% des quotas et modules.',
      v_trial_days,
      COALESCE(v_plan.display_name, v_plan.name),
      to_char(v_trial_ends_at AT TIME ZONE 'UTC', 'DD/MM/YYYY')
    ),
    jsonb_build_object(
      'subscription_id', v_sub_id,
      'plan_id', v_plan.id,
      'trial_ends_at', v_trial_ends_at
    )
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
-- 5. Moteur central d'imputation d'un paiement d'abonnement confirmé
--    Utilisé par admin_validate_payment, review_payment_declaration ET SasPay (LOT 3)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.apply_confirmed_subscription_payment(
  p_agency_id uuid,
  p_purpose text,
  p_amount numeric,
  p_currency text DEFAULT 'XOF',
  p_method text DEFAULT 'saspay',
  p_invoice_id uuid DEFAULT NULL,
  p_target_plan_id uuid DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_recorded_by uuid DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_provider_reference text DEFAULT NULL,
  p_provider_status text DEFAULT NULL,
  p_online_payment_id uuid DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_inv saas_immobilier.subscription_invoices%ROWTYPE;
  v_plan saas_immobilier.plans%ROWTYPE;
  v_old_plan saas_immobilier.plans%ROWTYPE;
  v_payment_id uuid;
  v_grace int := 5;
  v_now timestamptz := COALESCE(p_now, now());
  v_purpose text := COALESCE(NULLIF(btrim(p_purpose), ''), 'renewal');
  v_ref text;
  v_pay_start timestamptz;
  v_pay_end timestamptz;
  v_next_start timestamptz;
  v_next_end timestamptz;
  v_reactivated boolean := false;
  v_plan_changed boolean := false;
  v_next_invoice_id uuid := NULL;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant de paiement invalide (%).', p_amount USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

  -- Idempotence sur online_payment_id s'il a déjà été enregistré
  IF p_online_payment_id IS NOT NULL THEN
    SELECT sp.id INTO v_payment_id
    FROM saas_immobilier.subscription_payments sp
    WHERE sp.online_payment_id = p_online_payment_id
      AND sp.entry_kind = 'payment'
    LIMIT 1;

    IF v_payment_id IS NOT NULL THEN
      SELECT * INTO v_sub
      FROM saas_immobilier.agency_subscriptions
      WHERE agency_id = p_agency_id
      ORDER BY updated_at DESC LIMIT 1;

      RETURN jsonb_build_object(
        'already_processed', true,
        'payment_id', v_payment_id,
        'agency_id', p_agency_id,
        'subscription_id', v_sub.id,
        'ends_at', v_sub.ends_at,
        'paid_through_at', v_sub.paid_through_at,
        'reactivated', false
      );
    END IF;
  END IF;

  SELECT * INTO v_ag
  FROM saas_immobilier.agencies
  WHERE id = p_agency_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF v_ag.status = 'pending' THEN
    RAISE EXCEPTION 'Paiement d''abonnement refusé : l''agence est encore en attente d''installation physique et d''activation administrateur.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'Aucun abonnement trouvé pour cette agence.' USING ERRCODE = 'P0002';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv
    FROM saas_immobilier.subscription_invoices
    WHERE id = p_invoice_id
    FOR UPDATE;

    IF NOT FOUND OR v_inv.agency_id <> p_agency_id THEN
      RAISE EXCEPTION 'Facture introuvable ou rattachée à une autre agence.' USING ERRCODE = '22023';
    END IF;

    IF v_inv.status = 'paid' THEN
      RETURN jsonb_build_object(
        'already_processed', true,
        'payment_id', v_inv.paid_payment_id,
        'agency_id', p_agency_id,
        'subscription_id', v_sub.id,
        'ends_at', v_sub.ends_at,
        'paid_through_at', v_sub.paid_through_at,
        'reactivated', false
      );
    END IF;

    IF v_inv.status <> 'pending' THEN
      RAISE EXCEPTION 'Facture annulée ou non payable.' USING ERRCODE = '22023';
    END IF;
  ELSE
    -- Recherche automatique d'une facture de cycle ouverte si non fournie
    IF v_purpose IN ('first_subscription', 'renewal', 'reactivation') THEN
      SELECT * INTO v_inv
      FROM saas_immobilier.subscription_invoices inv
      WHERE inv.agency_id = p_agency_id
        AND inv.status = 'pending'
        AND (inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR inv.billing_kind = 'period')
      ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
      LIMIT 1
      FOR UPDATE;
    END IF;
  END IF;

  -- Normalisation du motif selon la facture le cas échéant
  IF v_inv.id IS NOT NULL AND v_purpose = 'invoice' THEN
    IF v_inv.invoice_kind = 'plan_change' OR v_inv.billing_kind = 'plan_change' THEN
      v_purpose := 'plan_change';
    ELSIF v_ag.status = 'suspended' THEN
      v_purpose := 'reactivation';
    ELSIF v_inv.invoice_kind = 'first_subscription' THEN
      v_purpose := 'first_subscription';
    ELSE
      v_purpose := 'renewal';
    END IF;
  ELSIF v_ag.status = 'suspended' AND v_purpose IN ('renewal', 'first_subscription') THEN
    v_purpose := 'reactivation';
  END IF;

  SELECT * INTO v_old_plan FROM saas_immobilier.plans WHERE id = v_sub.plan_id;
  SELECT * INTO v_plan FROM saas_immobilier.plans
  WHERE id = COALESCE(p_target_plan_id, v_inv.plan_to_id, v_sub.plan_id);

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'Offre cible introuvable.' USING ERRCODE = 'P0002';
  END IF;

  -- ---------------------------------------------------------------------------
  -- Cas A : Montée d'offre en cours d'abonnement payant (prorata serveur)
  -- ---------------------------------------------------------------------------
  IF v_purpose = 'plan_change' THEN
    IF v_ag.status <> 'active' THEN
      RAISE EXCEPTION 'Le changement d''offre payant requiert un abonnement actif.' USING ERRCODE = '22023';
    END IF;

    v_pay_start := COALESCE(v_inv.period_start::timestamptz, v_now);
    v_pay_end   := COALESCE(v_sub.current_period_end, v_sub.ends_at, v_now + interval '1 month');
    v_plan_changed := (v_sub.plan_id IS DISTINCT FROM v_plan.id);

    UPDATE saas_immobilier.agency_subscriptions
    SET
      plan_id    = v_plan.id,
      updated_at = v_now
    WHERE id = v_sub.id;

    PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
    UPDATE saas_immobilier.agencies
    SET
      pending_plan_id = v_plan.id,
      updated_at      = v_now
    WHERE id = p_agency_id;
    PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  -- ---------------------------------------------------------------------------
  -- Cas B : Réactivation d'une agence suspendue pour impayé (purpose = 'reactivation')
  -- ---------------------------------------------------------------------------
  ELSIF v_purpose = 'reactivation' OR v_ag.status = 'suspended' THEN
    IF v_ag.status = 'suspended'
       AND v_ag.suspended_reason IS NOT NULL
       AND v_ag.suspended_reason <> 'unpaid'
       AND NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'Suspension administrative (%) : réactivation automatique non autorisée sans validation administrateur.', v_ag.suspended_reason USING ERRCODE = '42501';
    END IF;

    v_reactivated := (v_ag.status = 'suspended');
    v_pay_start   := v_now;
    v_pay_end     := v_now + interval '1 month';

    UPDATE saas_immobilier.agency_subscriptions
    SET
      plan_id              = v_plan.id,
      status               = 'active',
      current_period_start = v_pay_start,
      current_period_end   = v_pay_end,
      ends_at              = v_pay_end,
      paid_through_at      = v_pay_end,
      grace_ends_at        = v_pay_end + make_interval(days => v_grace),
      updated_at           = v_now
    WHERE id = v_sub.id;

    PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
    UPDATE saas_immobilier.agencies
    SET
      status           = 'active',
      pending_plan_id  = v_plan.id,
      suspended_at     = NULL,
      suspended_reason = NULL,
      updated_at       = v_now
    WHERE id = p_agency_id;
    PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  -- ---------------------------------------------------------------------------
  -- Cas C : Paiement de la 1re mensualité ('first_subscription') ou d'un
  --         renouvellement ('renewal') pendant le mois actif ou la grâce de 5j
  -- ---------------------------------------------------------------------------
  ELSE
    IF v_sub.status = 'trial' THEN
      -- Si l'agence règle par anticipation pendant ou juste à la fin de l'essai :
      -- son 1er mois payé court de trial_ends_at (ou now) à +1 mois.
      v_pay_start := COALESCE(v_sub.trial_ends_at, v_now);
      v_pay_end   := v_pay_start + interval '1 month';

      IF v_now >= v_pay_start THEN
        UPDATE saas_immobilier.agency_subscriptions
        SET
          plan_id              = v_plan.id,
          status               = 'active',
          current_period_start = v_pay_start,
          current_period_end   = v_pay_end,
          ends_at              = v_pay_end,
          paid_through_at      = v_pay_end,
          grace_ends_at        = v_pay_end + make_interval(days => v_grace),
          updated_at           = v_now
        WHERE id = v_sub.id;

        PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
        UPDATE saas_immobilier.agencies
        SET status = 'active', pending_plan_id = v_plan.id, updated_at = v_now
        WHERE id = p_agency_id AND status IN ('trial', 'active');
        PERFORM set_config('sofia.internal_agency_mutation', 'off', true);
      ELSE
        -- Toujours dans les 14 jours d'essai : on crédite paid_through_at = E1
        UPDATE saas_immobilier.agency_subscriptions
        SET
          plan_id         = v_plan.id,
          paid_through_at = v_pay_end,
          updated_at      = v_now
        WHERE id = v_sub.id;
      END IF;

    ELSIF v_inv.id IS NOT NULL THEN
      -- Règlement de la facture ouverte de la période [period_start, due_at]
      v_pay_start := COALESCE(v_inv.period_start::timestamptz, v_sub.current_period_start, v_sub.starts_at, v_now);
      v_pay_end   := COALESCE(v_inv.due_at, v_inv.billing_due_at, v_sub.current_period_end, v_sub.ends_at, v_pay_start + interval '1 month');

      IF v_now >= v_pay_end THEN
        -- L'agence réglait pendant la période de grâce [E1, E1 + 5j] :
        -- la période [J14, E1] est soldée ET la période suivante [E1, E2] s'ouvre immédiatement !
        v_next_start := v_pay_end;
        v_next_end   := v_pay_end + interval '1 month';

        UPDATE saas_immobilier.agency_subscriptions
        SET
          plan_id              = v_plan.id,
          status               = 'active',
          current_period_start = v_next_start,
          current_period_end   = v_next_end,
          ends_at              = v_next_end,
          paid_through_at      = GREATEST(COALESCE(v_sub.paid_through_at, v_pay_end), v_pay_end),
          grace_ends_at        = v_next_end + make_interval(days => v_grace),
          updated_at           = v_now
        WHERE id = v_sub.id;
      ELSE
        -- L'agence règle sa facture courante avant l'échéance E1 (entre J14 et E1) :
        -- la période [J14, E1] est désormais intégralement payée (paid_through_at = E1).
        UPDATE saas_immobilier.agency_subscriptions
        SET
          plan_id              = v_plan.id,
          status               = 'active',
          current_period_start = COALESCE(v_sub.current_period_start, v_pay_start),
          current_period_end   = v_pay_end,
          ends_at              = v_pay_end,
          paid_through_at      = GREATEST(COALESCE(v_sub.paid_through_at, v_pay_end), v_pay_end),
          grace_ends_at        = v_pay_end + make_interval(days => v_grace),
          updated_at           = v_now
        WHERE id = v_sub.id;
      END IF;

      PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
      UPDATE saas_immobilier.agencies
      SET
        status           = 'active',
        pending_plan_id  = v_plan.id,
        suspended_at     = NULL,
        suspended_reason = NULL,
        updated_at       = v_now
      WHERE id = p_agency_id AND status IN ('active', 'trial', 'suspended');
      PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

    ELSE
      -- Renouvellement anticipé alors qu'aucune facture impayée n'est ouverte :
      -- prolonge d'un mois supplémentaire sans perdre un seul jour déjà payé !
      v_pay_start := GREATEST(COALESCE(v_sub.paid_through_at, v_sub.current_period_end, v_sub.ends_at, v_now), v_now);
      v_pay_end   := v_pay_start + interval '1 month';

      UPDATE saas_immobilier.agency_subscriptions
      SET
        plan_id              = v_plan.id,
        status               = 'active',
        current_period_start = COALESCE(v_sub.current_period_start, v_now),
        current_period_end   = v_pay_end,
        ends_at              = v_pay_end,
        paid_through_at      = v_pay_end,
        grace_ends_at        = v_pay_end + make_interval(days => v_grace),
        updated_at           = v_now
      WHERE id = v_sub.id;
    END IF;
  END IF;

  v_ref := COALESCE(NULLIF(btrim(p_reference), ''), saas_immobilier.subscription_reference('PAY'));

  INSERT INTO saas_immobilier.subscription_payments (
    agency_id,
    subscription_id,
    plan_id,
    amount,
    currency,
    paid_at,
    period_start,
    period_end,
    method,
    recorded_by,
    note,
    reference,
    entry_kind,
    invoice_id,
    provider,
    provider_reference,
    provider_status,
    online_payment_id,
    created_at
  ) VALUES (
    p_agency_id,
    v_sub.id,
    v_plan.id,
    p_amount,
    COALESCE(NULLIF(btrim(p_currency), ''), v_plan.currency, 'XOF'),
    (v_now AT TIME ZONE 'UTC')::date,
    (v_pay_start AT TIME ZONE 'UTC')::date,
    ((v_pay_end AT TIME ZONE 'UTC')::date - 1),
    COALESCE(NULLIF(btrim(p_method), ''), 'saspay'),
    p_recorded_by,
    COALESCE(NULLIF(btrim(p_note), ''), format('Paiement confirmé (%s)', v_purpose)),
    v_ref,
    'payment',
    v_inv.id,
    p_provider,
    p_provider_reference,
    p_provider_status,
    p_online_payment_id,
    v_now
  )
  RETURNING id INTO v_payment_id;

  IF v_inv.id IS NOT NULL THEN
    UPDATE saas_immobilier.subscription_invoices
    SET
      status          = 'paid',
      paid_at         = v_now,
      paid_payment_id = v_payment_id
    WHERE id = v_inv.id;
  END IF;

  -- Lors d'une réactivation, annuler proprement d'éventuelles factures de cycle
  -- résiduelles plus anciennes afin que l'agence reparte avec 0 dette ouverte.
  IF v_purpose = 'reactivation' THEN
    UPDATE saas_immobilier.subscription_invoices
    SET
      status = 'cancelled',
      note   = COALESCE(note, '') || format(' [Soldée par réactivation %s]', v_ref)
    WHERE agency_id = p_agency_id
      AND status = 'pending'
      AND (v_inv.id IS NULL OR id <> v_inv.id)
      AND (invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR billing_kind = 'period');
  END IF;

  -- Si le paiement réglait une facture en retard pendant la grâce (v_next_start IS NOT NULL),
  -- générer la facture 'renewal' de la nouvelle période active [E1, E2].
  IF v_next_start IS NOT NULL AND v_next_end IS NOT NULL THEN
    v_next_invoice_id := saas_immobilier.ensure_cycle_invoice(
      p_agency_id,
      v_sub.id,
      v_plan.id,
      'renewal',
      v_next_start,
      v_next_end,
      v_grace,
      v_now
    );
  END IF;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id,
    event_type,
    plan_from_id,
    plan_to_id,
    plan_from_name,
    plan_to_name,
    mensualite_from,
    mensualite_to,
    mensualite_variation,
    payment_id,
    invoice_id,
    amount,
    reference,
    actor_id,
    reason,
    created_at
  ) VALUES (
    p_agency_id,
    'payment_validated',
    v_old_plan.id,
    v_plan.id,
    COALESCE(v_old_plan.display_name, v_old_plan.name),
    COALESCE(v_plan.display_name, v_plan.name),
    v_old_plan.price_monthly,
    v_plan.price_monthly,
    COALESCE(v_plan.price_monthly, 0) - COALESCE(v_old_plan.price_monthly, 0),
    v_payment_id,
    v_inv.id,
    p_amount,
    v_ref,
    p_recorded_by,
    format('Paiement confirmé (%s)', v_purpose),
    v_now
  );

  IF v_reactivated THEN
    INSERT INTO saas_immobilier.subscription_events (
      agency_id,
      event_type,
      plan_to_id,
      plan_to_name,
      mensualite_to,
      payment_id,
      invoice_id,
      amount,
      reference,
      actor_id,
      reason,
      created_at
    ) VALUES (
      p_agency_id,
      'reactivation',
      v_plan.id,
      COALESCE(v_plan.display_name, v_plan.name),
      v_plan.price_monthly,
      v_payment_id,
      v_inv.id,
      p_amount,
      v_ref,
      p_recorded_by,
      'Réactivation automatique immédiate après confirmation du paiement',
      v_now
    );

    INSERT INTO saas_immobilier.activity_log (
      agency_id, user_id, action, entity_type, entity_id, summary, metadata
    ) VALUES (
      p_agency_id,
      p_recorded_by,
      'agency_auto_reactivated',
      'agency',
      p_agency_id,
      format('Agence réactivée automatiquement suite au paiement %s', v_ref),
      jsonb_build_object('payment_id', v_payment_id, 'ends_at', v_pay_end, 'purpose', v_purpose)
    );

    PERFORM saas_immobilier.billing_notify(
      p_agency_id,
      'reactivated:' || v_payment_id::text,
      'Votre agence est réactivée !',
      format(
        'Votre paiement de %s %s a été confirmé. L''accès complet à votre espace Sofia Immobilier est rétabli jusqu''au %s.',
        to_char(p_amount, 'FM999G999G990'),
        COALESCE(v_plan.currency, 'FCFA'),
        to_char(v_pay_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')
      ),
      jsonb_build_object('payment_id', v_payment_id, 'ends_at', v_pay_end)
    );
  ELSE
    PERFORM saas_immobilier.billing_notify(
      p_agency_id,
      'payment-confirmed:' || v_payment_id::text,
      'Paiement d''abonnement confirmé',
      format(
        'Votre paiement de %s %s (%s) a bien été enregistré.',
        to_char(p_amount, 'FM999G999G990'),
        COALESCE(v_plan.currency, 'FCFA'),
        COALESCE(v_plan.display_name, v_plan.name)
      ),
      jsonb_build_object('payment_id', v_payment_id, 'invoice_id', v_inv.id, 'purpose', v_purpose)
    );
  END IF;

  IF v_plan_changed THEN
    UPDATE saas_immobilier.plan_change_requests
    SET
      status      = 'approved',
      handled_by  = COALESCE(p_recorded_by, handled_by),
      handled_at  = v_now,
      handle_note = format('Changement d''offre activé après paiement %s', v_ref),
      updated_at  = v_now
    WHERE agency_id = p_agency_id
      AND requested_plan_id = v_plan.id
      AND status IN ('pending', 'payment_required');

    INSERT INTO saas_immobilier.subscription_events (
      agency_id,
      event_type,
      plan_from_id,
      plan_to_id,
      plan_from_name,
      plan_to_name,
      mensualite_from,
      mensualite_to,
      mensualite_variation,
      invoice_id,
      payment_id,
      amount,
      reference,
      actor_id,
      reason,
      created_at
    ) VALUES (
      p_agency_id,
      'plan_change',
      v_old_plan.id,
      v_plan.id,
      COALESCE(v_old_plan.display_name, v_old_plan.name),
      COALESCE(v_plan.display_name, v_plan.name),
      v_old_plan.price_monthly,
      v_plan.price_monthly,
      COALESCE(v_plan.price_monthly, 0) - COALESCE(v_old_plan.price_monthly, 0),
      v_inv.id,
      v_payment_id,
      p_amount,
      v_ref,
      p_recorded_by,
      'Montée d''offre activée après règlement du prorata',
      v_now
    );

    PERFORM saas_immobilier.billing_notify(
      p_agency_id,
      'plan-upgraded:' || v_payment_id::text,
      'Nouvelle offre activée !',
      format('Votre agence bénéficie immédiatement des quotas et modules de l''offre %s.', COALESCE(v_plan.display_name, v_plan.name)),
      jsonb_build_object('plan_id', v_plan.id, 'payment_id', v_payment_id)
    );
  END IF;

  SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions WHERE id = v_sub.id;

  RETURN jsonb_build_object(
    'already_processed', false,
    'payment_id', v_payment_id,
    'agency_id', p_agency_id,
    'subscription_id', v_sub.id,
    'invoice_id', v_inv.id,
    'next_invoice_id', v_next_invoice_id,
    'purpose', v_purpose,
    'plan_id', v_sub.plan_id,
    'status', v_sub.status,
    'agency_status', 'active',
    'current_period_start', v_sub.current_period_start,
    'current_period_end', v_sub.current_period_end,
    'ends_at', v_sub.ends_at,
    'paid_through_at', v_sub.paid_through_at,
    'grace_ends_at', v_sub.grace_ends_at,
    'reactivated', v_reactivated,
    'plan_changed', v_plan_changed,
    'reference', v_ref
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Moteur automatisé idempotent du cycle de vie (LOT 2)
--    process_subscription_lifecycle(p_now timestamptz DEFAULT now())
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_subscription_lifecycle(
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamptz := COALESCE(p_now, now());
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_grace int := 5;
  r record;
  v_inv_id uuid;
  v_p_start timestamptz;
  v_p_end timestamptz;
  v_grace_end timestamptz;
  v_days_left int;
  v_grace_days_left int;
  v_is_demo_protected boolean;
  v_trials_converted int := 0;
  v_renewals_opened int := 0;
  v_entered_grace int := 0;
  v_suspended int := 0;
  v_notifications int := 0;
  v_alerts int := 0;
  v_errors int := 0;
  v_notified boolean;
  v_alerted boolean;
  v_result jsonb;
BEGIN
  IF NOT (
    v_jwt_role = 'service_role'
    OR v_privileged
    OR (v_jwt_role = 'authenticated' AND public.is_platform_admin())
  ) THEN
    RAISE EXCEPTION 'Accès refusé : exécution réservée au système ou à un administrateur plateforme.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

  FOR r IN
    SELECT
      a.id AS agency_id,
      a.name AS agency_name,
      a.status AS agency_status,
      a.auto_suspend_disabled_until,
      s.id AS subscription_id,
      s.plan_id,
      s.status AS sub_status,
      s.starts_at,
      s.trial_ends_at,
      s.ends_at,
      s.current_period_start,
      s.current_period_end,
      s.grace_ends_at,
      s.paid_through_at,
      COALESCE(pl.display_name, pl.name) AS plan_label,
      pl.price_monthly,
      COALESCE(pl.currency, 'XOF') AS currency
    FROM saas_immobilier.agencies a
    JOIN LATERAL (
      SELECT s0.*
      FROM saas_immobilier.agency_subscriptions s0
      WHERE s0.agency_id = a.id
        AND s0.status IN ('trial', 'active', 'past_due')
      ORDER BY CASE s0.status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
               s0.created_at DESC
      LIMIT 1
    ) s ON true
    JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
    WHERE a.status IN ('trial', 'active')
    FOR UPDATE OF a SKIP LOCKED
  LOOP
    BEGIN
      v_is_demo_protected := EXISTS (
        SELECT 1
        FROM saas_immobilier.agency_members m
        JOIN saas_immobilier.platform_admins pa ON pa.user_id = m.user_id
        WHERE m.agency_id = r.agency_id
          AND m.status = 'active'
          AND pa.status = 'active'
      ) OR (r.auto_suspend_disabled_until IS NOT NULL AND r.auto_suspend_disabled_until > v_now);

      -- =======================================================================
      -- PHASE 1 & 2 : Agence en essai gratuit de 14 jours (J0 -> J14)
      -- =======================================================================
      IF r.sub_status = 'trial' AND r.trial_ends_at IS NOT NULL THEN
        IF v_now < r.trial_ends_at THEN
          -- Rappels préventifs pendant l'essai : J9 (J-5) et J12 (J-2)
          v_days_left := ceil(extract(epoch FROM (r.trial_ends_at - v_now)) / 86400.0)::int;

          IF v_days_left <= 5 AND v_days_left > 2 THEN
            v_notified := saas_immobilier.billing_notify(
              r.agency_id,
              'trial-jminus5:' || r.subscription_id::text || ':' || to_char(r.trial_ends_at AT TIME ZONE 'UTC', 'YYYYMMDD'),
              'Votre essai gratuit se termine dans ' || v_days_left || ' jours',
              format(
                'Vous profitez actuellement de l''offre %s gratuitement jusqu''au %s. À cette date, votre premier mois d''abonnement (%s FCFA) démarrera automatiquement.',
                r.plan_label,
                to_char(r.trial_ends_at AT TIME ZONE 'UTC', 'DD/MM/YYYY'),
                to_char(r.price_monthly, 'FM999G999G990')
              ),
              jsonb_build_object('kind', 'trial_reminder_5d', 'trial_ends_at', r.trial_ends_at, 'days_left', v_days_left)
            );
            IF v_notified THEN v_notifications := v_notifications + 1; END IF;

          ELSIF v_days_left <= 2 AND v_days_left >= 1 THEN
            v_notified := saas_immobilier.billing_notify(
              r.agency_id,
              'trial-jminus2:' || r.subscription_id::text || ':' || to_char(r.trial_ends_at AT TIME ZONE 'UTC', 'YYYYMMDD'),
              'Fin de votre essai gratuit dans ' || v_days_left || ' jour(s)',
              format(
                'Votre essai gratuit sur l''offre %s prend fin le %s. Votre premier mois d''abonnement (%s FCFA) s''ouvrira sans interruption de vos accès.',
                r.plan_label,
                to_char(r.trial_ends_at AT TIME ZONE 'UTC', 'DD/MM/YYYY'),
                to_char(r.price_monthly, 'FM999G999G990')
              ),
              jsonb_build_object('kind', 'trial_reminder_2d', 'trial_ends_at', r.trial_ends_at, 'days_left', v_days_left)
            );
            IF v_notified THEN v_notifications := v_notifications + 1; END IF;
          END IF;

        ELSE
          -- ===================================================================
          -- J14 ATTEINT : Fin de l'essai -> Démarrage automatique du 1er mois
          --               payant [J14 -> E1] + génération de la 1re facture
          --               mensuelle (SANS frais d'installation !)
          -- ===================================================================
          v_p_start   := r.trial_ends_at;
          v_p_end     := r.trial_ends_at + interval '1 month';
          v_grace_end := v_p_end + make_interval(days => v_grace);

          IF r.paid_through_at IS NULL OR r.paid_through_at < v_p_end THEN
            v_inv_id := saas_immobilier.ensure_cycle_invoice(
              r.agency_id,
              r.subscription_id,
              r.plan_id,
              'first_subscription',
              v_p_start,
              v_p_end,
              v_grace,
              v_now
            );
          ELSE
            v_inv_id := NULL;
          END IF;

          UPDATE saas_immobilier.agency_subscriptions
          SET
            status               = 'active',
            current_period_start = v_p_start,
            current_period_end   = v_p_end,
            ends_at              = v_p_end,
            grace_ends_at        = v_grace_end,
            updated_at           = v_now
          WHERE id = r.subscription_id;

          PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
          UPDATE saas_immobilier.agencies
          SET
            status     = 'active',
            updated_at = v_now
          WHERE id = r.agency_id AND status = 'trial';
          PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

          INSERT INTO saas_immobilier.subscription_events (
            agency_id,
            event_type,
            plan_to_id,
            plan_to_name,
            mensualite_to,
            invoice_id,
            amount,
            reason,
            created_at
          ) VALUES (
            r.agency_id,
            'trial_ended',
            r.plan_id,
            r.plan_label,
            r.price_monthly,
            v_inv_id,
            r.price_monthly,
            format('Fin des 14 jours d''essai — ouverture du 1er mois payant jusqu''au %s', to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')),
            v_now
          );

          v_notified := saas_immobilier.billing_notify(
            r.agency_id,
            'trial-ended-m1:' || r.subscription_id::text || ':' || to_char(v_p_start AT TIME ZONE 'UTC', 'YYYYMMDD'),
            'Début de votre 1er mois d''abonnement',
            format(
              'Votre essai gratuit de 14 jours est terminé. Votre 1er mois sur l''offre %s est actif jusqu''au %s et votre facture mensuelle de %s FCFA est disponible dans Mon offre.',
              r.plan_label,
              to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY'),
              to_char(r.price_monthly, 'FM999G999G990')
            ),
            jsonb_build_object(
              'kind', 'first_month_started',
              'invoice_id', v_inv_id,
              'period_start', v_p_start,
              'period_end', v_p_end,
              'due_at', v_p_end
            )
          );
          IF v_notified THEN v_notifications := v_notifications + 1; END IF;

          v_alerted := saas_immobilier.billing_admin_alert_once(
            r.agency_id,
            'trial-ended-m1:' || r.subscription_id::text || ':' || to_char(v_p_start AT TIME ZONE 'UTC', 'YYYYMMDD'),
            'trial_converted',
            'normal',
            format('Fin d''essai 14j — 1re facture émise (%s)', r.agency_name),
            format('L''agence %s est passée en 1er mois d''abonnement (%s — %s FCFA, échéance le %s).', r.agency_name, r.plan_label, to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')),
            jsonb_build_object('invoice_id', v_inv_id, 'due_at', v_p_end)
          );
          IF v_alerted THEN v_alerts := v_alerts + 1; END IF;

          v_trials_converted := v_trials_converted + 1;

          -- Recharger les dates mises à jour si p_now a déjà dépassé E1 (ex: rattrapage ou simulation temporelle)
          r.sub_status           := 'active';
          r.current_period_start := v_p_start;
          r.current_period_end   := v_p_end;
          r.ends_at              := v_p_end;
          r.grace_ends_at        := v_grace_end;
        END IF;
      END IF;

      -- =======================================================================
      -- PHASE 3, 4 & 5 : Abonnement mensuel en cours, échéance E1/En, grâce 5j,
      --                  et suspension automatique après E1 + 5 jours
      -- =======================================================================
      IF r.sub_status IN ('active', 'past_due') THEN
        v_p_start   := COALESCE(r.current_period_start, r.starts_at);
        v_p_end     := COALESCE(r.current_period_end, r.ends_at);
        v_grace_end := COALESCE(r.grace_ends_at, CASE WHEN v_p_end IS NOT NULL THEN v_p_end + make_interval(days => v_grace) ELSE NULL END);

        IF v_p_end IS NOT NULL THEN
          -- Rechercher une facture de cycle ouverte pour cette agence
          SELECT inv.id INTO v_inv_id
          FROM saas_immobilier.subscription_invoices inv
          WHERE inv.agency_id = r.agency_id
            AND inv.status = 'pending'
            AND (inv.invoice_kind IN ('first_subscription', 'renewal') OR inv.billing_kind = 'period')
          ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
          LIMIT 1;

          -- -------------------------------------------------------------------
          -- Sous-cas 3 : Période mensuelle en cours (now < E1) -> Accès 100 % complet
          -- -------------------------------------------------------------------
          IF v_now < v_p_end THEN
            IF v_inv_id IS NOT NULL THEN
              v_days_left := ceil(extract(epoch FROM (v_p_end - v_now)) / 86400.0)::int;
              IF v_days_left <= 5 AND v_days_left > 2 THEN
                v_notified := saas_immobilier.billing_notify(
                  r.agency_id,
                  'due-jminus5:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                  'Échéance mensuelle dans ' || v_days_left || ' jours',
                  format(
                    'Votre facture mensuelle %s (%s FCFA) arrive à échéance le %s. Réglez-la en ligne via SasPay depuis Mon offre.',
                    r.plan_label,
                    to_char(r.price_monthly, 'FM999G999G990'),
                    to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')
                  ),
                  jsonb_build_object('kind', 'due_reminder_5d', 'invoice_id', v_inv_id, 'due_at', v_p_end)
                );
                IF v_notified THEN v_notifications := v_notifications + 1; END IF;
              ELSIF v_days_left <= 2 AND v_days_left >= 0 THEN
                v_notified := saas_immobilier.billing_notify(
                  r.agency_id,
                  'due-jminus2:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                  'Échéance mensuelle dans ' || GREATEST(v_days_left, 1) || ' jour(s)',
                  format(
                    'Votre échéance mensuelle de %s FCFA (%s) est attendue pour le %s.',
                    to_char(r.price_monthly, 'FM999G999G990'),
                    r.plan_label,
                    to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')
                  ),
                  jsonb_build_object('kind', 'due_reminder_2d', 'invoice_id', v_inv_id, 'due_at', v_p_end)
                );
                IF v_notified THEN v_notifications := v_notifications + 1; END IF;
              END IF;
            END IF;

          -- -------------------------------------------------------------------
          -- Sous-cas 4A : Échéance atteinte (now >= E1) ET période déjà payée
          --               -> Ouverture transparente de la période [E1, E2] !
          -- -------------------------------------------------------------------
          ELSIF v_inv_id IS NULL AND r.paid_through_at IS NOT NULL AND r.paid_through_at >= v_p_end THEN
            v_p_start   := v_p_end;
            v_p_end     := v_p_start + interval '1 month';
            v_grace_end := v_p_end + make_interval(days => v_grace);

            IF r.paid_through_at < v_p_end THEN
              v_inv_id := saas_immobilier.ensure_cycle_invoice(
                r.agency_id,
                r.subscription_id,
                r.plan_id,
                'renewal',
                v_p_start,
                v_p_end,
                v_grace,
                v_now
              );
            END IF;

            UPDATE saas_immobilier.agency_subscriptions
            SET
              status               = 'active',
              current_period_start = v_p_start,
              current_period_end   = v_p_end,
              ends_at              = v_p_end,
              grace_ends_at        = v_grace_end,
              updated_at           = v_now
            WHERE id = r.subscription_id;

            v_notified := saas_immobilier.billing_notify(
              r.agency_id,
              'renewal-opened:' || r.subscription_id::text || ':' || to_char(v_p_start AT TIME ZONE 'UTC', 'YYYYMMDD'),
              'Nouvelle période mensuelle ouverte',
              format(
                'Votre nouvelle période mensuelle (%s) est ouverte jusqu''au %s. Votre facture de renouvellement de %s FCFA est disponible dans Mon offre.',
                r.plan_label,
                to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY'),
                to_char(r.price_monthly, 'FM999G999G990')
              ),
              jsonb_build_object('kind', 'renewal_opened', 'invoice_id', v_inv_id, 'period_start', v_p_start, 'due_at', v_p_end)
            );
            IF v_notified THEN v_notifications := v_notifications + 1; END IF;

            v_renewals_opened := v_renewals_opened + 1;

          -- -------------------------------------------------------------------
          -- Sous-cas 4B & 5 : Échéance dépassée (now >= E1) SANS paiement confirmé
          -- -------------------------------------------------------------------
          ELSE
            IF v_inv_id IS NULL THEN
              v_inv_id := saas_immobilier.ensure_cycle_invoice(
                r.agency_id,
                r.subscription_id,
                r.plan_id,
                'renewal',
                COALESCE(v_p_start, v_p_end - interval '1 month'),
                v_p_end,
                v_grace,
                v_now
              );
            END IF;

            IF v_now <= v_grace_end THEN
              -- ===============================================================
              -- PHASE 4B : Période de grâce de 5 jours [E1 -> E1 + 5j]
              -- Accès 100 % complet maintenu (agencies.status reste 'active') !
              -- ===============================================================
              IF r.sub_status <> 'past_due' OR r.grace_ends_at IS DISTINCT FROM v_grace_end THEN
                UPDATE saas_immobilier.agency_subscriptions
                SET
                  status        = 'past_due',
                  grace_ends_at = v_grace_end,
                  updated_at    = v_now
                WHERE id = r.subscription_id;

                v_entered_grace := v_entered_grace + 1;
              END IF;

              v_grace_days_left := GREATEST(1, ceil(extract(epoch FROM (v_grace_end - v_now)) / 86400.0)::int);

              v_notified := saas_immobilier.billing_notify(
                r.agency_id,
                'grace-entered:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                'Échéance dépassée — Période de grâce de 5 jours',
                format(
                  'Votre facture mensuelle de %s FCFA (%s) est arrivée à échéance le %s. Vos accès complets sont maintenus jusqu''au %s : régularisez via SasPay pour éviter toute suspension.',
                  to_char(r.price_monthly, 'FM999G999G990'),
                  r.plan_label,
                  to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY'),
                  to_char(v_grace_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')
                ),
                jsonb_build_object('kind', 'grace_started', 'invoice_id', v_inv_id, 'due_at', v_p_end, 'grace_ends_at', v_grace_end)
              );
              IF v_notified THEN v_notifications := v_notifications + 1; END IF;

              v_alerted := saas_immobilier.billing_admin_alert_once(
                r.agency_id,
                'grace-entered:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                'payment_overdue_grace',
                'high',
                format('Agence en période de grâce 5j (%s)', r.agency_name),
                format('Échéance du %s impayée (%s FCFA). Fin de la grâce de 5 jours le %s.', to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY'), to_char(r.price_monthly, 'FM999G999G990'), to_char(v_grace_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')),
                jsonb_build_object('invoice_id', v_inv_id, 'due_at', v_p_end, 'grace_ends_at', v_grace_end)
              );
              IF v_alerted THEN v_alerts := v_alerts + 1; END IF;

              -- Alerte urgente à E1 + 3j (<= 2 jours avant suspension)
              IF v_grace_days_left <= 2 THEN
                v_notified := saas_immobilier.billing_notify(
                  r.agency_id,
                  'grace-urgent:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                  'Suspension automatique dans ' || v_grace_days_left || ' jour(s)',
                  format(
                    'Dernier rappel : votre période de grâce expire le %s. Réglez %s FCFA via SasPay pour conserver l''accès à votre agence.',
                    to_char(v_grace_end AT TIME ZONE 'UTC', 'DD/MM/YYYY'),
                    to_char(r.price_monthly, 'FM999G999G990')
                  ),
                  jsonb_build_object('kind', 'grace_urgent', 'invoice_id', v_inv_id, 'grace_ends_at', v_grace_end, 'grace_days_left', v_grace_days_left)
                );
                IF v_notified THEN v_notifications := v_notifications + 1; END IF;
              END IF;

            ELSIF NOT v_is_demo_protected THEN
              -- ===============================================================
              -- PHASE 5 : Après E1 + 5 jours sans paiement -> SUSPENSION AUTO
              -- ===============================================================
              UPDATE saas_immobilier.agency_subscriptions
              SET
                status        = 'past_due',
                grace_ends_at = v_grace_end,
                updated_at    = v_now
              WHERE id = r.subscription_id;

              PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
              UPDATE saas_immobilier.agencies
              SET
                status           = 'suspended',
                suspended_at     = v_now,
                suspended_reason = 'unpaid',
                updated_at       = v_now
              WHERE id = r.agency_id
                AND status IN ('active', 'trial');
              PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

              IF FOUND THEN
                INSERT INTO saas_immobilier.subscription_events (
                  agency_id,
                  event_type,
                  plan_to_id,
                  plan_to_name,
                  mensualite_to,
                  invoice_id,
                  amount,
                  reason,
                  created_at
                ) VALUES (
                  r.agency_id,
                  'suspension',
                  r.plan_id,
                  r.plan_label,
                  r.price_monthly,
                  v_inv_id,
                  r.price_monthly,
                  format('Suspension automatique après expiration des %s jours de grâce (échéance du %s)', v_grace, to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')),
                  v_now
                );

                INSERT INTO saas_immobilier.activity_log (
                  agency_id, action, entity_type, entity_id, summary, metadata
                ) VALUES (
                  r.agency_id,
                  'agency_auto_suspended',
                  'agency',
                  r.agency_id,
                  format('Suspension automatique pour facture impayée après %s jours de grâce', v_grace),
                  jsonb_build_object('reason', 'unpaid', 'invoice_id', v_inv_id, 'due_at', v_p_end, 'grace_ends_at', v_grace_end)
                );

                v_notified := saas_immobilier.billing_notify(
                  r.agency_id,
                  'auto-suspended:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                  'Agence suspendue pour échéance impayée',
                  format(
                    'La période de grâce de %s jours ayant expiré, l''accès à votre agence est temporairement suspendu. Réglez %s FCFA via SasPay pour réactiver immédiatement votre espace.',
                    v_grace,
                    to_char(r.price_monthly, 'FM999G999G990')
                  ),
                  jsonb_build_object('kind', 'agency_suspended_unpaid', 'invoice_id', v_inv_id, 'amount', r.price_monthly)
                );
                IF v_notified THEN v_notifications := v_notifications + 1; END IF;

                v_alerted := saas_immobilier.billing_admin_alert_once(
                  r.agency_id,
                  'auto-suspended:' || r.subscription_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                  'agency_auto_suspended',
                  'critical',
                  format('Agence suspendue automatiquement (%s)', r.agency_name),
                  format('Suspension automatique après expiration des %s jours de grâce (facture %s FCFA échue le %s).', v_grace, to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'UTC', 'DD/MM/YYYY')),
                  jsonb_build_object('invoice_id', v_inv_id, 'due_at', v_p_end, 'grace_ends_at', v_grace_end)
                );
                IF v_alerted THEN v_alerts := v_alerts + 1; END IF;

                v_suspended := v_suspended + 1;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE WARNING 'process_subscription_lifecycle error on agency %: %', r.agency_id, SQLERRM;
    END;
  END LOOP;

  v_result := jsonb_build_object(
    'evaluated_at', v_now,
    'trials_converted', v_trials_converted,
    'renewals_opened', v_renewals_opened,
    'entered_grace', v_entered_grace,
    'suspended', v_suspended,
    'notifications_sent', v_notifications,
    'alerts_created', v_alerts,
    'errors', v_errors
  );

  INSERT INTO saas_immobilier.billing_automation_runs (kind, result)
  VALUES ('cycle', v_result);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_subscription_lifecycle(timestamptz) TO authenticated, service_role;

-- Délégation propre des anciennes fonctions d'automatisation vers le moteur LOT 2
CREATE OR REPLACE FUNCTION public.billing_run_cycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public.process_subscription_lifecycle(now());
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_run_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.process_subscription_lifecycle(now());
  RETURN jsonb_build_object(
    'reminders_sent', COALESCE((v_res->>'notifications_sent')::int, 0),
    'lifecycle', v_res,
    'run_at', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.suspend_overdue_agencies()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.process_subscription_lifecycle(now());
  RETURN COALESCE((v_res->>'suspended')::int, 0);
END;
$$;

-- Synchronisation temps-réel d'une agence à l'ouverture de son espace (sans attendre pg_cron)
CREATE OR REPLACE FUNCTION public.agency_sync_billing_lifecycle(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_grace int := 5;
  v_p_start timestamptz;
  v_p_end timestamptz;
  v_grace_end timestamptz;
  v_inv_id uuid;
  v_is_demo_protected boolean;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Authentification requise.' USING ERRCODE = '42501';
  END IF;

  IF auth.role() <> 'service_role'
     AND NOT (public.is_agency_member_any_status(p_agency_id) OR public.billing_has_access(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès agence refusé.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = p_agency_id FOR UPDATE;
  IF NOT FOUND OR v_ag.status NOT IN ('trial', 'active') THEN
    RETURN public.agency_plan_state(p_agency_id);
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
    AND status IN ('trial', 'active', 'past_due')
  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RETURN public.agency_plan_state(p_agency_id);
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

  -- Matérialiser J14 -> 1er mois payant si l'essai vient de se terminer
  IF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND now() >= v_sub.trial_ends_at THEN
    v_p_start   := v_sub.trial_ends_at;
    v_p_end     := v_sub.trial_ends_at + interval '1 month';
    v_grace_end := v_p_end + make_interval(days => v_grace);

    IF v_sub.paid_through_at IS NULL OR v_sub.paid_through_at < v_p_end THEN
      v_inv_id := saas_immobilier.ensure_cycle_invoice(
        p_agency_id, v_sub.id, v_sub.plan_id, 'first_subscription', v_p_start, v_p_end, v_grace, now()
      );
    END IF;

    UPDATE saas_immobilier.agency_subscriptions
    SET status = 'active', current_period_start = v_p_start, current_period_end = v_p_end,
        ends_at = v_p_end, grace_ends_at = v_grace_end, updated_at = now()
    WHERE id = v_sub.id;

    PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
    UPDATE saas_immobilier.agencies SET status = 'active', updated_at = now() WHERE id = p_agency_id AND status = 'trial';
    PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

    SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions WHERE id = v_sub.id;
  END IF;

  -- Matérialiser E1 -> Grâce ou Renouvellement ou Suspension si l'échéance est atteinte
  v_p_end := COALESCE(v_sub.current_period_end, v_sub.ends_at);
  IF v_sub.status IN ('active', 'past_due') AND v_p_end IS NOT NULL AND now() >= v_p_end THEN
    SELECT inv.id INTO v_inv_id
    FROM saas_immobilier.subscription_invoices inv
    WHERE inv.agency_id = p_agency_id
      AND inv.status = 'pending'
      AND (inv.invoice_kind IN ('first_subscription', 'renewal') OR inv.billing_kind = 'period')
    ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
    LIMIT 1;

    IF v_inv_id IS NULL AND v_sub.paid_through_at IS NOT NULL AND v_sub.paid_through_at >= v_p_end THEN
      v_p_start   := v_p_end;
      v_p_end     := v_p_start + interval '1 month';
      v_grace_end := v_p_end + make_interval(days => v_grace);
      IF v_sub.paid_through_at < v_p_end THEN
        PERFORM saas_immobilier.ensure_cycle_invoice(
          p_agency_id, v_sub.id, v_sub.plan_id, 'renewal', v_p_start, v_p_end, v_grace, now()
        );
      END IF;
      UPDATE saas_immobilier.agency_subscriptions
      SET status = 'active', current_period_start = v_p_start, current_period_end = v_p_end,
          ends_at = v_p_end, grace_ends_at = v_grace_end, updated_at = now()
      WHERE id = v_sub.id;
    ELSE
      v_grace_end := COALESCE(v_sub.grace_ends_at, v_p_end + make_interval(days => v_grace));
      IF v_inv_id IS NULL THEN
        PERFORM saas_immobilier.ensure_cycle_invoice(
          p_agency_id, v_sub.id, v_sub.plan_id, 'renewal',
          COALESCE(v_sub.current_period_start, v_p_end - interval '1 month'), v_p_end, v_grace, now()
        );
      END IF;
      IF now() <= v_grace_end THEN
        UPDATE saas_immobilier.agency_subscriptions
        SET status = 'past_due', grace_ends_at = v_grace_end, updated_at = now()
        WHERE id = v_sub.id AND status <> 'past_due';
      ELSE
        v_is_demo_protected := EXISTS (
          SELECT 1 FROM saas_immobilier.agency_members m
          JOIN saas_immobilier.platform_admins pa ON pa.user_id = m.user_id
          WHERE m.agency_id = p_agency_id AND m.status = 'active' AND pa.status = 'active'
        ) OR (v_ag.auto_suspend_disabled_until IS NOT NULL AND v_ag.auto_suspend_disabled_until > now());

        IF NOT v_is_demo_protected THEN
          UPDATE saas_immobilier.agency_subscriptions SET status = 'past_due', grace_ends_at = v_grace_end, updated_at = now() WHERE id = v_sub.id;
          PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
          UPDATE saas_immobilier.agencies SET status = 'suspended', suspended_at = now(), suspended_reason = 'unpaid', updated_at = now()
          WHERE id = p_agency_id AND status IN ('active', 'trial');
          PERFORM set_config('sofia.internal_agency_mutation', 'off', true);
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN public.agency_plan_state(p_agency_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_sync_billing_lifecycle(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Lecture enrichie de l'état d'offre, des factures et du compte utilisateur
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_plan_state(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_agency record;
  v_sub record;
  v_plan record;
  v_open_inv record;
  v_grace integer := 5;
  v_state text;
  v_billing_phase text;
  v_p_start timestamptz;
  v_p_end timestamptz;
  v_grace_end timestamptz;
  v_is_period_paid boolean := false;
BEGIN
  SELECT a.id, a.status, a.suspended_at, a.suspended_reason, a.pending_plan_id, a.installation_status
  INTO v_agency
  FROM saas_immobilier.agencies a
  WHERE a.id = p_agency_id;

  IF v_agency.id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'state', 'missing', 'has_plan', false);
  END IF;

  SELECT s.* INTO v_sub
  FROM saas_immobilier.agency_subscriptions s
  WHERE s.agency_id = p_agency_id
  ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           s.created_at DESC
  LIMIT 1;

  IF v_sub.id IS NOT NULL THEN
    SELECT pl.* INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
  ELSIF v_agency.pending_plan_id IS NOT NULL THEN
    SELECT pl.* INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_agency.pending_plan_id;
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

  SELECT
    inv.id,
    inv.invoice_kind,
    inv.amount,
    inv.currency,
    COALESCE(inv.due_at, inv.billing_due_at) AS due_at,
    inv.grace_ends_at,
    inv.reference,
    inv.period_start,
    inv.period_end
  INTO v_open_inv
  FROM saas_immobilier.subscription_invoices inv
  WHERE inv.agency_id = p_agency_id
    AND inv.status = 'pending'
  ORDER BY CASE WHEN inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') THEN 0 ELSE 1 END,
           COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
  LIMIT 1;

  v_p_start   := COALESCE(v_sub.current_period_start, v_sub.starts_at);
  v_p_end     := COALESCE(v_sub.current_period_end, v_sub.ends_at);
  v_grace_end := COALESCE(
    v_sub.grace_ends_at,
    v_open_inv.grace_ends_at,
    CASE WHEN v_p_end IS NOT NULL THEN v_p_end + make_interval(days => v_grace) ELSE NULL END
  );

  v_is_period_paid := (
    v_sub.paid_through_at IS NOT NULL
    AND v_p_end IS NOT NULL
    AND v_sub.paid_through_at >= v_p_end
    AND (v_open_inv.id IS NULL OR v_open_inv.invoice_kind = 'plan_change')
  );

  IF v_agency.status = 'pending' THEN
    v_state := 'pending';
    v_billing_phase := 'pending';
  ELSIF v_agency.status = 'suspended' THEN
    v_state := 'suspended';
    v_billing_phase := CASE WHEN COALESCE(v_agency.suspended_reason, 'unpaid') = 'unpaid' THEN 'suspended_unpaid' ELSE 'suspended_admin' END;
  ELSIF v_sub.id IS NULL OR v_plan.id IS NULL THEN
    v_state := 'no_plan';
    v_billing_phase := 'no_plan';
  ELSIF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now() THEN
    v_state := 'trial';
    v_billing_phase := 'trial';
  ELSIF v_sub.status IN ('cancelled', 'expired') THEN
    v_state := 'cancelled';
    v_billing_phase := 'cancelled';
  ELSIF v_p_end IS NOT NULL AND now() >= v_p_end AND NOT v_is_period_paid THEN
    IF v_grace_end IS NOT NULL AND now() > v_grace_end THEN
      v_state := 'suspended_overdue';
      v_billing_phase := 'suspended_unpaid';
    ELSE
      v_state := 'overdue';
      v_billing_phase := 'grace_period';
    END IF;
  ELSE
    v_state := 'active';
    v_billing_phase := CASE WHEN v_open_inv.id IS NOT NULL AND v_open_inv.invoice_kind IN ('first_subscription', 'renewal') THEN 'active_unpaid_open' ELSE 'active_paid' END;
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'agency_id', v_agency.id,
    'agency_status', v_agency.status,
    'suspended_at', v_agency.suspended_at,
    'suspended_reason', v_agency.suspended_reason,
    'installation_status', v_agency.installation_status,
    'state', v_state,
    'billing_phase', v_billing_phase,
    'has_plan', (v_sub.id IS NOT NULL AND v_plan.id IS NOT NULL),
    'subscription_id', v_sub.id,
    'subscription_status', v_sub.status,
    'plan_id', v_plan.id,
    'plan_code', v_plan.name,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name),
    'plan_price_monthly', v_plan.price_monthly,
    'plan_setup_fee', v_plan.setup_fee,
    'currency', COALESCE(v_plan.currency, 'XOF'),
    'trial_ends_at', v_sub.trial_ends_at,
    'trial_days_left', CASE
      WHEN v_sub.trial_ends_at IS NULL THEN NULL
      ELSE GREATEST(0, ceil(extract(epoch FROM (v_sub.trial_ends_at - now())) / 86400.0)::int)
    END,
    'starts_at', v_sub.starts_at,
    'ends_at', v_p_end,
    'current_period_start', v_p_start,
    'current_period_end', v_p_end,
    'paid_through_at', v_sub.paid_through_at,
    'is_current_period_paid', v_is_period_paid,
    'days_to_due', CASE
      WHEN v_p_end IS NULL THEN NULL
      ELSE ceil(extract(epoch FROM (v_p_end - now())) / 86400.0)::int
    END,
    'grace_days', v_grace,
    'grace_ends_at', v_grace_end,
    'grace_days_left', CASE
      WHEN v_billing_phase = 'grace_period' AND v_grace_end IS NOT NULL THEN
        GREATEST(0, ceil(extract(epoch FROM (v_grace_end - now())) / 86400.0)::int)
      ELSE NULL
    END,
    'grace_hours_left', CASE
      WHEN v_billing_phase = 'grace_period' AND v_grace_end IS NOT NULL THEN
        GREATEST(0, ceil(extract(epoch FROM (v_grace_end - now())) / 3600.0)::int)
      ELSE NULL
    END,
    'open_invoice_id', v_open_inv.id,
    'open_invoice_kind', v_open_inv.invoice_kind,
    'open_invoice_amount', v_open_inv.amount,
    'open_invoice_due_at', v_open_inv.due_at,
    'open_invoice_reference', v_open_inv.reference,
    'is_locked', v_state IN ('pending', 'suspended', 'suspended_overdue'),
    'requires_action', v_state IN ('no_plan', 'overdue', 'pending', 'suspended', 'suspended_overdue')
                       OR (v_open_inv.id IS NOT NULL)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_plan_state(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agency_invoices(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_agency_id IS NULL THEN
    RAISE EXCEPTION 'Agence obligatoire.' USING ERRCODE = '22023';
  END IF;

  IF NOT (
    public.is_agency_member(p_agency_id)
    OR public.is_agency_member_any_status(p_agency_id)
    OR public.billing_has_access(p_agency_id)
  ) THEN
    RAISE EXCEPTION 'Accès refusé.' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
    FROM (
      SELECT
        inv.id,
        inv.agency_id,
        inv.invoice_kind,
        inv.billing_kind,
        inv.plan_from_id,
        inv.plan_to_id,
        inv.plan_from_name,
        inv.plan_to_name,
        inv.amount,
        inv.currency,
        inv.prorata_applied,
        inv.prorata_days,
        inv.prorata_days_in_month,
        inv.period_start,
        inv.period_end,
        COALESCE(inv.due_at, inv.billing_due_at) AS due_at,
        inv.grace_ends_at,
        inv.status,
        inv.reference,
        inv.note,
        inv.created_at,
        inv.paid_at,
        inv.paid_payment_id
      FROM saas_immobilier.subscription_invoices inv
      WHERE inv.agency_id = p_agency_id
      ORDER BY inv.created_at DESC
    ) x
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_invoices(uuid) TO authenticated, service_role;

-- État du compte authentifié (permet de distinguer suspension impayée vs désactivation admin)
CREATE OR REPLACE FUNCTION public.mon_etat_compte()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean := public.is_platform_admin();
  v_memberships jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('is_admin', false, 'memberships', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'agency_id', a.id,
    'agency_name', a.name,
    'role', m.role,
    'status', m.status,
    'agency_status', a.status,
    'suspended_reason', a.suspended_reason
  ) ORDER BY m.created_at ASC), '[]'::jsonb)
  INTO v_memberships
  FROM saas_immobilier.agency_members m
  JOIN saas_immobilier.agencies a ON a.id = m.agency_id
  WHERE m.user_id = v_uid
    AND m.status = 'active';

  RETURN jsonb_build_object(
    'is_admin', v_is_admin,
    'memberships', v_memberships
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.mon_etat_compte() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION saas_immobilier.mon_etat_compte()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.mon_etat_compte();
$$;

GRANT EXECUTE ON FUNCTION saas_immobilier.mon_etat_compte() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8. Alignement des actions administrateur (fin/prolongation d'essai, paiements
--    manuels de secours et revue de déclarations) avec le cycle LOT 2
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_end_trial(
  p_agency_id uuid,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_now timestamptz := now();
  v_p_end timestamptz := v_now + interval '1 month';
  v_grace int := 5;
  v_inv_id uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
  ORDER BY (status = 'trial') DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'Aucun abonnement trouvé.' USING ERRCODE = 'P0002';
  END IF;

  IF v_sub.status <> 'trial' THEN
    RAISE EXCEPTION 'Cet abonnement n''est pas en essai gratuit.' USING ERRCODE = '22023';
  END IF;

  v_inv_id := saas_immobilier.ensure_cycle_invoice(
    p_agency_id,
    v_sub.id,
    v_sub.plan_id,
    'first_subscription',
    v_now,
    v_p_end,
    v_grace,
    v_now
  );

  UPDATE saas_immobilier.agency_subscriptions
  SET
    status               = 'active',
    trial_ends_at        = v_now,
    current_period_start = v_now,
    current_period_end   = v_p_end,
    ends_at              = v_p_end,
    grace_ends_at        = v_p_end + make_interval(days => v_grace),
    updated_at           = v_now
  WHERE id = v_sub.id;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
  UPDATE saas_immobilier.agencies
  SET status = 'active', updated_at = v_now
  WHERE id = p_agency_id AND status IN ('trial', 'pending');
  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, invoice_id, actor_id, reason
  ) VALUES (
    p_agency_id, 'trial_ended', v_sub.plan_id, v_inv_id, auth.uid(),
    COALESCE(NULLIF(btrim(p_note), ''), 'Clôture anticipée de l''essai par l''administrateur — ouverture du 1er mois')
  );

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'status', 'active',
    'ends_at', v_p_end,
    'invoice_id', v_inv_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_extend_trial(
  p_agency_id uuid,
  p_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_days int := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
  v_new timestamptz;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
  ORDER BY (status = 'trial') DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'Aucun abonnement trouvé.' USING ERRCODE = 'P0002';
  END IF;

  IF v_sub.status <> 'trial' THEN
    RAISE EXCEPTION 'Cet abonnement n''est pas en essai gratuit.' USING ERRCODE = '22023';
  END IF;

  v_new := GREATEST(COALESCE(v_sub.trial_ends_at, now()), now()) + make_interval(days => v_days);

  UPDATE saas_immobilier.agency_subscriptions
  SET
    trial_ends_at      = v_new,
    current_period_end = v_new,
    ends_at            = v_new,
    updated_at         = now()
  WHERE id = v_sub.id;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
  UPDATE saas_immobilier.agencies
  SET status = 'trial', updated_at = now()
  WHERE id = p_agency_id AND status <> 'suspended';
  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'trial_ends_at', v_new,
    'days_added', v_days
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_validate_payment(
  p_agency_id uuid,
  p_plan_id uuid DEFAULT NULL,
  p_amount numeric DEFAULT NULL,
  p_paid_on date DEFAULT CURRENT_DATE,
  p_reference text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_inv saas_immobilier.subscription_invoices%ROWTYPE;
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_plan saas_immobilier.plans%ROWTYPE;
  v_amount numeric;
  v_purpose text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = p_agency_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM saas_immobilier.subscription_invoices WHERE id = p_invoice_id;
    IF NOT FOUND OR v_inv.agency_id <> p_agency_id THEN
      RAISE EXCEPTION 'Facture introuvable pour cette agence.' USING ERRCODE = 'P0002';
    END IF;
    v_amount := COALESCE(p_amount, v_inv.amount);
    v_purpose := CASE
      WHEN v_inv.invoice_kind = 'plan_change' OR v_inv.billing_kind = 'plan_change' THEN 'plan_change'
      WHEN v_ag.status = 'suspended' THEN 'reactivation'
      WHEN v_inv.invoice_kind = 'first_subscription' THEN 'first_subscription'
      ELSE 'renewal'
    END;
  ELSE
    SELECT * INTO v_sub
    FROM saas_immobilier.agency_subscriptions
    WHERE agency_id = p_agency_id
    ORDER BY created_at DESC LIMIT 1;
    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = COALESCE(p_plan_id, v_sub.plan_id);
    v_amount := COALESCE(p_amount, v_plan.price_monthly);
    v_purpose := CASE WHEN v_ag.status = 'suspended' THEN 'reactivation' ELSE 'renewal' END;
  END IF;

  RETURN saas_immobilier.apply_confirmed_subscription_payment(
    p_agency_id          => p_agency_id,
    p_purpose            => v_purpose,
    p_amount             => v_amount,
    p_currency           => COALESCE(v_inv.currency, 'XOF'),
    p_method             => 'bank_transfer',
    p_invoice_id         => p_invoice_id,
    p_target_plan_id     => COALESCE(p_plan_id, v_inv.plan_to_id),
    p_reference          => p_reference,
    p_note               => COALESCE(NULLIF(btrim(p_note), ''), 'Validation manuelle administrateur'),
    p_recorded_by        => auth.uid(),
    p_provider           => 'manual_admin',
    p_provider_reference => p_reference,
    p_provider_status    => 'VALIDATED',
    p_online_payment_id  => NULL,
    p_now                => COALESCE(p_paid_on::timestamptz, now())
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_payment(
  p_request_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_decl saas_immobilier.payment_declarations%ROWTYPE;
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_settle jsonb;
  v_payment_id uuid;
  v_clean_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  IF p_decision NOT IN ('approved', 'rejected', 'correction_requested') THEN
    RAISE EXCEPTION 'Décision invalide (approved, rejected ou correction_requested attendu).' USING ERRCODE = '22023';
  END IF;

  IF p_decision IN ('rejected', 'correction_requested') AND v_clean_note IS NULL THEN
    RAISE EXCEPTION 'Un motif est obligatoire pour refuser ou demander une correction.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_decl
  FROM saas_immobilier.payment_declarations
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Déclaration introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF v_decl.status NOT IN ('pending', 'submitted') THEN
    RAISE EXCEPTION 'Cette déclaration a déjà été traitée (%).', v_decl.status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = v_decl.agency_id;

  IF p_decision = 'approved' THEN
    v_settle := saas_immobilier.apply_confirmed_subscription_payment(
      p_agency_id          => v_decl.agency_id,
      p_purpose            => CASE WHEN v_ag.status = 'suspended' THEN 'reactivation' ELSE 'renewal' END,
      p_amount             => v_decl.amount,
      p_currency           => v_decl.currency,
      p_method             => COALESCE(v_decl.method, 'manual'),
      p_invoice_id         => NULL,
      p_target_plan_id     => v_decl.plan_id,
      p_reference          => COALESCE(v_decl.transaction_reference, v_decl.reference),
      p_note               => COALESCE(v_clean_note, v_decl.note, 'Déclaration de paiement approuvée'),
      p_recorded_by        => auth.uid(),
      p_provider           => 'manual_declaration',
      p_provider_reference => COALESCE(v_decl.transaction_reference, v_decl.reference),
      p_provider_status    => 'APPROVED',
      p_online_payment_id  => NULL,
      p_now                => now()
    );
    v_payment_id := NULLIF(v_settle->>'payment_id', '')::uuid;
  END IF;

  UPDATE saas_immobilier.payment_declarations
  SET
    status      = p_decision,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    review_note = v_clean_note,
    payment_id  = COALESCE(v_payment_id, payment_id),
    updated_at  = now()
  WHERE id = p_request_id;

  INSERT INTO saas_immobilier.payment_decision_log (
    declaration_id, agency_id, action, from_status, to_status, actor_id, actor_kind, amount, note
  ) VALUES (
    v_decl.id, v_decl.agency_id, p_decision, v_decl.status, p_decision, auth.uid(), 'platform_admin', v_decl.amount, v_clean_note
  );

  RETURN jsonb_build_object(
    'decision', p_decision,
    'id', v_decl.id,
    'declaration_id', v_decl.id,
    'reference', v_decl.reference,
    'status', p_decision,
    'payment_id', v_payment_id,
    'settlement', v_settle
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.review_payment_declaration(
  p_declaration_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.admin_review_payment(p_declaration_id, p_decision, p_note);
  RETURN NULLIF(v_res->>'payment_id', '')::uuid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_end_trial(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_extend_trial(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_validate_payment(uuid, uuid, numeric, date, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_review_payment(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_payment_declaration(uuid, text, text) TO authenticated, service_role;

-- Programmation automatique pg_cron (toutes les 15 minutes) si l'extension est installée
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'sofia_subscription_lifecycle_15m',
      '*/15 * * * *',
      $cron$SELECT public.process_subscription_lifecycle(now());$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron non programmé dans cet environnement : %', SQLERRM;
END
$$;

COMMIT;
