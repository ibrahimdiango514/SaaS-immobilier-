-- =============================================================================
-- LOT 5 — Suspension, grâce de 5 jours, réactivation automatique, cas limites,
--         zéro perte de jours payés et planification Cron horaire
-- Date : 2026-11-05
-- Cible autorisée : Sofia Immobilier Lab (yswsildmbeomjlyofnrk)
-- Production (xbuuhfwobrafcbgtdgjx) : AUCUNE EXÉCUTION SANS VALIDATION EXPLICITE
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Protection exceptionnelle anti-suspension (cas litige / accord écrit Admin)
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN IF NOT EXISTS auto_suspend_disabled_until timestamptz;

COMMENT ON COLUMN saas_immobilier.agencies.auto_suspend_disabled_until IS
  'LOT 5 : Date limite temporaire avant laquelle la suspension automatique pour impayé est différée (cas litige / délai exceptionnel accordé par l''administrateur plateforme).';

-- -----------------------------------------------------------------------------
-- 1. Garantie de présence de `ensure_cycle_invoice` (8 paramètres LOT 2/3)
-- -----------------------------------------------------------------------------
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
    agency_id, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    amount, currency, prorata_applied, period_start, period_end,
    status, reference, note, created_at, invoice_kind, due_at,
    grace_ends_at, billing_kind, billing_subscription_id, billing_due_at, billing_period_key
  ) VALUES (
    p_agency_id, v_plan.id, v_plan.id,
    COALESCE(v_plan.display_name, v_plan.name), COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly, COALESCE(v_plan.currency, 'XOF'), false,
    (p_period_start AT TIME ZONE 'UTC')::date, (p_period_end AT TIME ZONE 'UTC')::date,
    'pending', v_ref, v_note, COALESCE(p_now, now()), v_kind, v_due,
    v_grace_end, 'period', p_sub_id, v_due, v_period_key
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
    ORDER BY inv.created_at DESC LIMIT 1;
    RETURN v_inv_id;
  END IF;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, plan_to_name, mensualite_to,
    invoice_id, amount, reference, reason, created_at
  ) VALUES (
    p_agency_id, 'invoice_generated', v_plan.id, COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly, v_inv_id, v_plan.price_monthly, v_ref, v_note, COALESCE(p_now, now())
  );

  RETURN v_inv_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Moteur `apply_confirmed_subscription_payment` (signature 15 paramètres LOT 2/3)
--    ZÉRO perte de jours payés + auto-résolution des alertes de suspension/grâce
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
  v_was_past_due boolean := false;
  v_plan_changed boolean := false;
  v_next_invoice_id uuid := NULL;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Montant de paiement invalide (%).', p_amount USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
  FROM saas_immobilier.platform_settings WHERE key = 'billing';
  v_grace := COALESCE(v_grace, 5);

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

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = p_agency_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002'; END IF;

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

  v_was_past_due := (v_sub.status = 'past_due');

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM saas_immobilier.subscription_invoices WHERE id = p_invoice_id FOR UPDATE;
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
  IF v_plan.id IS NULL THEN RAISE EXCEPTION 'Offre cible introuvable.' USING ERRCODE = 'P0002'; END IF;

  IF v_inv.id IS NOT NULL AND ROUND(p_amount) <> ROUND(v_inv.amount) THEN
    RAISE EXCEPTION 'Montant incohérent avec la facture attendue (% FCFA reçu contre % FCFA facturé).', p_amount, v_inv.amount USING ERRCODE = '22023';
  END IF;

  -- Cas A : Montée d'offre en cours d'abonnement payant (prorata serveur)
  IF v_purpose = 'plan_change' THEN
    IF v_ag.status <> 'active' THEN
      RAISE EXCEPTION 'Le changement d''offre payant requiert un abonnement actif.' USING ERRCODE = '22023';
    END IF;

    v_pay_start := COALESCE(v_inv.period_start::timestamptz, v_now);
    v_pay_end   := COALESCE(v_sub.current_period_end, v_sub.ends_at, v_now + interval '1 month');
    v_plan_changed := (v_sub.plan_id IS DISTINCT FROM v_plan.id);

    UPDATE saas_immobilier.agency_subscriptions
    SET plan_id = v_plan.id, updated_at = v_now
    WHERE id = v_sub.id;

    PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
    UPDATE saas_immobilier.agencies SET pending_plan_id = v_plan.id, updated_at = v_now WHERE id = p_agency_id;
    PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  -- Cas B : Réactivation d'une agence suspendue pour impayé -> 1 mois PLEIN à partir de `v_now` (ZÉRO perte de jours payés !)
  ELSIF v_purpose = 'reactivation' OR v_ag.status = 'suspended' THEN
    IF v_ag.status = 'suspended'
       AND v_ag.suspended_reason IS NOT NULL
       AND v_ag.suspended_reason <> 'unpaid'
       AND NOT public.is_platform_admin() THEN
      RAISE EXCEPTION 'Suspension administrative (%) : réactivation automatique non autorisée sans validation administrateur.', v_ag.suspended_reason USING ERRCODE = '42501';
    END IF;

    v_reactivated := (v_ag.status = 'suspended' OR v_sub.status = 'suspended');
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
      grace_ends_at        = NULL,
      updated_at           = v_now
    WHERE id = v_sub.id;

    PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
    UPDATE saas_immobilier.agencies
    SET status = 'active', pending_plan_id = v_plan.id, suspended_at = NULL, suspended_reason = NULL, updated_at = v_now
    WHERE id = p_agency_id;
    PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  -- Cas C : 1re mensualité ('first_subscription'), renouvellement ('renewal') ou prépaiement pendant l'essai
  ELSE
    IF v_sub.status = 'trial' THEN
      v_pay_start := GREATEST(COALESCE(v_sub.trial_ends_at, v_now), COALESCE(v_sub.paid_through_at, COALESCE(v_sub.trial_ends_at, v_now)));
      v_pay_end   := v_pay_start + interval '1 month';

      IF v_now >= COALESCE(v_sub.trial_ends_at, v_now) THEN
        UPDATE saas_immobilier.agency_subscriptions
        SET plan_id = v_plan.id, status = 'active', current_period_start = v_pay_start,
            current_period_end = v_pay_end, ends_at = v_pay_end, paid_through_at = v_pay_end,
            grace_ends_at = NULL, updated_at = v_now
        WHERE id = v_sub.id;

        PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
        UPDATE saas_immobilier.agencies SET status = 'active', pending_plan_id = v_plan.id, updated_at = v_now
        WHERE id = p_agency_id AND status IN ('trial', 'active');
        PERFORM set_config('sofia.internal_agency_mutation', 'off', true);
      ELSE
        -- Toujours dans les 14j gratuits : l'essai reste intact et le mois payé court de J14 à E1 !
        UPDATE saas_immobilier.agency_subscriptions
        SET plan_id = v_plan.id, paid_through_at = v_pay_end, updated_at = v_now
        WHERE id = v_sub.id;
      END IF;

    ELSIF v_inv.id IS NOT NULL THEN
      v_pay_start := COALESCE(v_inv.period_start::timestamptz, v_sub.current_period_start, v_sub.starts_at, v_now);
      v_pay_end   := COALESCE(v_inv.due_at, v_inv.billing_due_at, v_sub.current_period_end, v_sub.ends_at, v_pay_start + interval '1 month');

      IF v_now >= v_pay_end THEN
        v_next_start := v_pay_end;
        v_next_end   := v_pay_end + interval '1 month';

        UPDATE saas_immobilier.agency_subscriptions
        SET plan_id = v_plan.id, status = 'active', current_period_start = v_next_start,
            current_period_end = v_next_end, ends_at = v_next_end,
            paid_through_at = GREATEST(COALESCE(v_sub.paid_through_at, v_pay_end), v_pay_end),
            grace_ends_at = NULL, updated_at = v_now
        WHERE id = v_sub.id;
      ELSE
        UPDATE saas_immobilier.agency_subscriptions
        SET plan_id = v_plan.id, status = 'active',
            current_period_start = COALESCE(v_sub.current_period_start, v_pay_start),
            current_period_end = v_pay_end, ends_at = v_pay_end,
            paid_through_at = GREATEST(COALESCE(v_sub.paid_through_at, v_pay_end), v_pay_end),
            grace_ends_at = NULL, updated_at = v_now
        WHERE id = v_sub.id;
      END IF;

      PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
      UPDATE saas_immobilier.agencies
      SET status = 'active', pending_plan_id = v_plan.id, suspended_at = NULL, suspended_reason = NULL, updated_at = v_now
      WHERE id = p_agency_id AND status IN ('active', 'trial', 'suspended');
      PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

    ELSE
      v_pay_start := GREATEST(COALESCE(v_sub.paid_through_at, v_sub.current_period_end, v_sub.ends_at, v_now), v_now);
      v_pay_end   := v_pay_start + interval '1 month';

      UPDATE saas_immobilier.agency_subscriptions
      SET plan_id = v_plan.id, status = 'active',
          current_period_start = COALESCE(v_sub.current_period_start, v_now),
          current_period_end = v_pay_end, ends_at = v_pay_end, paid_through_at = v_pay_end,
          grace_ends_at = NULL, updated_at = v_now
      WHERE id = v_sub.id;
    END IF;
  END IF;

  v_ref := COALESCE(NULLIF(btrim(p_reference), ''), saas_immobilier.subscription_reference('PAY'));

  INSERT INTO saas_immobilier.subscription_payments (
    agency_id, subscription_id, plan_id, amount, currency, paid_at,
    period_start, period_end, method, recorded_by, note, reference,
    entry_kind, invoice_id, provider, provider_reference, provider_status,
    online_payment_id, created_at
  ) VALUES (
    p_agency_id, v_sub.id, v_plan.id, p_amount,
    COALESCE(NULLIF(btrim(p_currency), ''), v_plan.currency, 'XOF'),
    (v_now AT TIME ZONE 'UTC')::date,
    (v_pay_start AT TIME ZONE 'UTC')::date,
    ((v_pay_end AT TIME ZONE 'UTC')::date - 1),
    COALESCE(NULLIF(btrim(p_method), ''), 'saspay'),
    p_recorded_by,
    COALESCE(NULLIF(btrim(p_note), ''), format('Paiement confirmé (%s)', v_purpose)),
    v_ref, 'payment', v_inv.id, p_provider, p_provider_reference, p_provider_status,
    p_online_payment_id, v_now
  )
  RETURNING id INTO v_payment_id;

  IF v_inv.id IS NOT NULL THEN
    UPDATE saas_immobilier.subscription_invoices
    SET status = 'paid', paid_at = v_now, paid_payment_id = v_payment_id
    WHERE id = v_inv.id;
  END IF;

  IF v_purpose = 'reactivation' OR v_reactivated THEN
    UPDATE saas_immobilier.subscription_invoices
    SET status = 'cancelled',
        note = COALESCE(note, '') || format(' [Soldée par réactivation %s]', v_ref)
    WHERE agency_id = p_agency_id
      AND status = 'pending'
      AND (v_inv.id IS NULL OR id <> v_inv.id)
      AND (invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR billing_kind = 'period');
  END IF;

  -- Clôturer automatiquement les alertes admin de grâce / suspension obsolètes
  IF v_reactivated OR v_was_past_due THEN
    UPDATE saas_immobilier.admin_alerts
    SET is_read = true, read_at = COALESCE(read_at, v_now)
    WHERE agency_id = p_agency_id
      AND is_read = false
      AND kind IN ('agency_suspended', 'agency_entered_grace');
  END IF;

  IF v_next_start IS NOT NULL AND v_next_end IS NOT NULL THEN
    v_next_invoice_id := saas_immobilier.ensure_cycle_invoice(
      p_agency_id, v_sub.id, v_plan.id, 'renewal', v_next_start, v_next_end, v_grace, v_now
    );
  END IF;

  -- Les triggers LOT 4 sur `subscription_events` émettent automatiquement et idempotemment :
  -- `payment-confirmed:`, `reactivated:`, `plan-upgraded:` + leurs alertes Admin !
  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    mensualite_from, mensualite_to, mensualite_variation, payment_id, invoice_id,
    amount, reference, actor_id, reason, created_at
  ) VALUES (
    p_agency_id, 'payment_validated', v_old_plan.id, v_plan.id,
    COALESCE(v_old_plan.display_name, v_old_plan.name), COALESCE(v_plan.display_name, v_plan.name),
    v_old_plan.price_monthly, v_plan.price_monthly,
    COALESCE(v_plan.price_monthly, 0) - COALESCE(v_old_plan.price_monthly, 0),
    v_payment_id, v_inv.id, p_amount, v_ref, p_recorded_by,
    format('Paiement confirmé (%s)', v_purpose), v_now
  );

  IF v_reactivated THEN
    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_to_id, plan_to_name, mensualite_to,
      payment_id, invoice_id, amount, reference, actor_id, reason, created_at
    ) VALUES (
      p_agency_id, 'reactivation', v_plan.id, COALESCE(v_plan.display_name, v_plan.name),
      v_plan.price_monthly, v_payment_id, v_inv.id, p_amount, v_ref, p_recorded_by,
      format('Réactivation automatique immédiate après paiement %s (aucun jour payé perdu)', v_ref), v_now
    );

    INSERT INTO saas_immobilier.activity_log (
      agency_id, user_id, action, entity_type, entity_id, summary, metadata
    ) VALUES (
      p_agency_id, p_recorded_by, 'agency_auto_reactivated', 'agency', p_agency_id,
      format('Agence réactivée automatiquement suite au paiement %s', v_ref),
      jsonb_build_object('payment_id', v_payment_id, 'ends_at', v_pay_end, 'purpose', v_purpose)
    );
  END IF;

  IF v_plan_changed THEN
    UPDATE saas_immobilier.plan_change_requests
    SET status = 'approved', handled_by = COALESCE(p_recorded_by, handled_by),
        handled_at = v_now, handle_note = format('Changement d''offre activé après paiement %s', v_ref),
        updated_at = v_now
    WHERE agency_id = p_agency_id
      AND requested_plan_id = v_plan.id
      AND status IN ('pending', 'payment_required');

    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
      mensualite_from, mensualite_to, mensualite_variation, invoice_id, payment_id,
      amount, reference, actor_id, reason, created_at
    ) VALUES (
      p_agency_id, 'plan_change', v_old_plan.id, v_plan.id,
      COALESCE(v_old_plan.display_name, v_old_plan.name), COALESCE(v_plan.display_name, v_plan.name),
      v_old_plan.price_monthly, v_plan.price_monthly,
      COALESCE(v_plan.price_monthly, 0) - COALESCE(v_old_plan.price_monthly, 0),
      v_inv.id, v_payment_id, p_amount, v_ref, p_recorded_by,
      'Montée d''offre activée après règlement du prorata', v_now
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
    'agency_status', (SELECT status FROM saas_immobilier.agencies WHERE id = p_agency_id),
    'current_period_start', v_sub.current_period_start,
    'current_period_end', v_sub.current_period_end,
    'ends_at', v_sub.ends_at,
    'paid_through_at', v_sub.paid_through_at,
    'grace_ends_at', v_sub.grace_ends_at,
    'reactivated', v_reactivated,
    'plan_changed', v_plan_changed
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Automate complet `process_subscription_lifecycle` (LOT 4 + LOT 5)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_subscription_lifecycle(
  p_agency_id uuid DEFAULT NULL,
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
  v_grace_days constant integer := 5;
  r record;
  v_expired_op record;
  v_p_start timestamptz;
  v_p_end timestamptz;
  v_grace_end timestamptz;
  v_inv_id uuid;
  v_has_open_inv boolean;
  v_cycle_paid boolean;
  v_trials_converted int := 0;
  v_invoices_created int := 0;
  v_renewals_rolled int := 0;
  v_entered_grace int := 0;
  v_suspended int := 0;
  v_shielded int := 0;
  v_reminders_sent int := 0;
  v_sessions_expired int := 0;
  v_processed int := 0;
  v_summary jsonb;
BEGIN
  IF NOT (
    v_jwt_role = 'service_role'
    OR v_privileged
    OR (v_jwt_role = 'authenticated' AND (
      public.is_platform_admin()
      OR (p_agency_id IS NOT NULL AND public.is_agency_member_any_status(p_agency_id))
    ))
  ) THEN
    RAISE EXCEPTION 'Accès refusé pour exécuter l''automate d''abonnement.' USING ERRCODE = '42501';
  END IF;

  -- A) Expiration automatique des sessions SasPay `pending` dont `expires_at < v_now`
  FOR v_expired_op IN
    SELECT id, checkout_session_id, agency_id
    FROM saas_immobilier.online_payments
    WHERE status = 'pending'
      AND (p_agency_id IS NULL OR agency_id = p_agency_id)
      AND expires_at IS NOT NULL
      AND expires_at < v_now
    FOR UPDATE SKIP LOCKED
  LOOP
    IF v_expired_op.checkout_session_id IS NOT NULL THEN
      PERFORM public.saspay_record_failed(
        v_expired_op.id, v_expired_op.checkout_session_id, 'saspay_session_expired', true
      );
    ELSE
      UPDATE saas_immobilier.online_payments
      SET status = 'expired', fail_reason = 'intent_expired', updated_at = v_now
      WHERE id = v_expired_op.id;
    END IF;
    v_sessions_expired := v_sessions_expired + 1;
  END LOOP;

  -- B) Traitement du cycle de chaque agence éligible (`trial` ou `active`)
  FOR r IN
    SELECT
      a.id AS agency_id, a.name AS agency_name, a.status AS agency_status, a.auto_suspend_disabled_until,
      s.id AS sub_id, s.plan_id, s.status AS sub_status, s.starts_at, s.trial_ends_at, s.ends_at,
      s.current_period_start, s.current_period_end, s.grace_ends_at, s.paid_through_at,
      COALESCE(p.display_name, p.name) AS plan_label, p.price_monthly
    FROM saas_immobilier.agencies a
    JOIN LATERAL (
      SELECT * FROM saas_immobilier.agency_subscriptions s0
      WHERE s0.agency_id = a.id ORDER BY s0.created_at DESC LIMIT 1
    ) s ON true
    JOIN saas_immobilier.plans p ON p.id = s.plan_id
    WHERE (p_agency_id IS NULL OR a.id = p_agency_id)
      AND a.status IN ('trial', 'active')
      AND s.status IN ('trial', 'active', 'past_due')
    FOR UPDATE OF a, s SKIP LOCKED
  LOOP
    v_processed := v_processed + 1;

    -- CAS 1 : Essai gratuit 14 jours
    IF r.sub_status = 'trial' AND r.trial_ends_at IS NOT NULL THEN
      IF v_now < r.trial_ends_at THEN
        IF v_now >= (r.trial_ends_at - interval '5 days') AND v_now < (r.trial_ends_at - interval '2 days') THEN
          IF saas_immobilier.billing_notify_once(
            r.agency_id, 'trial-5d:' || r.sub_id::text, 'trial',
            'Votre essai gratuit se termine dans 5 jours',
            format('Votre essai gratuit de l''offre %s prendra fin le %s. À cette date, votre 1er mois d''abonnement (%s FCFA) débutera automatiquement sans coupure d''accès.', r.plan_label, to_char(r.trial_ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY'), to_char(r.price_monthly, 'FM999G999G990')),
            '/mon-offre', 'Consulter mon offre', 'normal',
            jsonb_build_object('event_kind', 'trial_ending_5d', 'trial_ends_at', r.trial_ends_at)
          ) IS NOT NULL THEN v_reminders_sent := v_reminders_sent + 1; END IF;
        ELSIF v_now >= (r.trial_ends_at - interval '2 days') THEN
          IF saas_immobilier.billing_notify_once(
            r.agency_id, 'trial-2d:' || r.sub_id::text, 'trial',
            'Plus que 48h d''essai gratuit',
            format('Votre essai gratuit s''achève le %s. Votre 1re facture mensuelle (%s FCFA, sans frais d''installation) sera générée automatiquement à l''ouverture de votre 1er mois.', to_char(r.trial_ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY'), to_char(r.price_monthly, 'FM999G999G990')),
            '/mon-offre', 'Préparer mon abonnement', 'normal',
            jsonb_build_object('event_kind', 'trial_ending_2d', 'trial_ends_at', r.trial_ends_at)
          ) IS NOT NULL THEN v_reminders_sent := v_reminders_sent + 1; END IF;

          PERFORM saas_immobilier.admin_alert_once(
            r.agency_id, 'trial-ending-2d:' || r.sub_id::text, 'trial_ending_soon', 'low',
            format('Essai gratuit bientôt terminé (%s)', r.agency_name),
            format('Fin de l''essai 14j prévue le %s sur l''offre %s (%s FCFA/mois).', to_char(r.trial_ends_at AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY'), r.plan_label, to_char(r.price_monthly, 'FM999G999G990')),
            '/admin/abonnements', 'Voir l''abonnement',
            jsonb_build_object('category', 'trial', 'trial_ends_at', r.trial_ends_at)
          );
        END IF;
      ELSE
        v_p_start := r.trial_ends_at;
        v_p_end := GREATEST(r.trial_ends_at + interval '1 month', COALESCE(r.paid_through_at, r.trial_ends_at + interval '1 month'));

        UPDATE saas_immobilier.agency_subscriptions
        SET status = 'active', current_period_start = v_p_start, current_period_end = v_p_end,
            ends_at = v_p_end, grace_ends_at = NULL, updated_at = v_now
        WHERE id = r.sub_id;

        PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
        UPDATE saas_immobilier.agencies SET status = 'active', updated_at = v_now
        WHERE id = r.agency_id AND status = 'trial';
        PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

        IF r.paid_through_at IS NULL OR r.paid_through_at < v_p_end THEN
          v_inv_id := saas_immobilier.ensure_cycle_invoice(
            r.agency_id, r.sub_id, r.plan_id, 'first_subscription', v_p_start, v_p_end, v_grace_days, v_now
          );
          v_invoices_created := v_invoices_created + 1;
        ELSE
          v_inv_id := NULL;
        END IF;

        INSERT INTO saas_immobilier.subscription_events (
          agency_id, event_type, plan_to_id, plan_to_name, mensualite_to, invoice_id, amount, reason, created_at
        ) VALUES (
          r.agency_id, 'trial_ended', r.plan_id, r.plan_label, r.price_monthly, v_inv_id, r.price_monthly,
          format('Fin des 14 jours d''essai — ouverture du 1er mois (%s → %s)', to_char(v_p_start AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY'), to_char(v_p_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY')),
          v_now
        );

        PERFORM saas_immobilier.billing_notify_once(
          r.agency_id, 'trial-ended:' || r.sub_id::text, 'trial',
          'Fin de l''essai gratuit — Début de votre 1er mois d''abonnement',
          format('Votre essai gratuit de 14 jours est terminé. Votre 1er mois d''abonnement %s (%s FCFA) est ouvert jusqu''au %s avec accès complet conservé.', r.plan_label, to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY')),
          '/mon-offre', 'Voir mon abonnement', 'normal',
          jsonb_build_object('event_kind', 'trial_ended_first_month_started', 'invoice_id', v_inv_id, 'period_end', v_p_end)
        );

        PERFORM saas_immobilier.admin_alert_once(
          r.agency_id, 'trial-ended:' || r.sub_id::text, 'trial_ended', 'normal',
          format('Fin d''essai 14j — 1er mois ouvert (%s)', r.agency_name),
          format('Passage automatique en 1er mois %s (%s FCFA) avec échéance au %s.', r.plan_label, to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY')),
          '/admin/abonnements', 'Suivre le 1er mois',
          jsonb_build_object('category', 'trial', 'invoice_id', v_inv_id, 'due_at', v_p_end)
        );

        v_trials_converted := v_trials_converted + 1;

        SELECT s.status, s.current_period_start, s.current_period_end, s.ends_at, s.grace_ends_at, s.paid_through_at
        INTO r.sub_status, r.current_period_start, r.current_period_end, r.ends_at, r.grace_ends_at, r.paid_through_at
        FROM saas_immobilier.agency_subscriptions s WHERE s.id = r.sub_id;
      END IF;
    END IF;

    -- CAS 2 : Abonnement mensuel actif ou en grâce
    IF r.sub_status IN ('active', 'past_due') THEN
      v_p_start := COALESCE(r.current_period_start, r.starts_at, v_now);
      v_p_end := COALESCE(r.current_period_end, r.ends_at);

      IF v_p_end IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM saas_immobilier.subscription_invoices inv
          WHERE inv.agency_id = r.agency_id AND inv.status = 'pending'
            AND (inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR inv.billing_kind = 'period')
        ) INTO v_has_open_inv;

        v_cycle_paid := (r.paid_through_at IS NOT NULL AND r.paid_through_at >= (v_p_end - interval '1 minute'))
                        OR (NOT v_has_open_inv AND NOT EXISTS (
                          SELECT 1 FROM saas_immobilier.subscription_invoices inv0 WHERE inv0.agency_id = r.agency_id
                        ));

        IF v_now < v_p_end AND v_has_open_inv THEN
          IF v_now >= (v_p_end - interval '5 days') AND v_now < (v_p_end - interval '2 days') THEN
            IF saas_immobilier.billing_notify_once(
              r.agency_id, 'due-5d:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'), 'billing',
              'Échéance mensuelle dans 5 jours',
              format('Votre échéance %s (%s FCFA) arrive le %s. Réglez-la en 1 clic via SasPay pour conserver un cycle continu.', r.plan_label, to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY')),
              '/mon-offre', 'Payer via SasPay', 'normal',
              jsonb_build_object('event_kind', 'due_reminder_5d', 'due_at', v_p_end)
            ) IS NOT NULL THEN v_reminders_sent := v_reminders_sent + 1; END IF;
          ELSIF v_now >= (v_p_end - interval '2 days') THEN
            IF saas_immobilier.billing_notify_once(
              r.agency_id, 'due-2d:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'), 'billing',
              'Échéance mensuelle dans 48 heures',
              format('Votre facture mensuelle de %s FCFA arrive à échéance le %s. Réglez-la dès maintenant depuis Mon offre.', to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY')),
              '/mon-offre', 'Régler maintenant', 'high',
              jsonb_build_object('event_kind', 'due_reminder_2d', 'due_at', v_p_end)
            ) IS NOT NULL THEN v_reminders_sent := v_reminders_sent + 1; END IF;
          END IF;

        ELSIF v_now >= v_p_end THEN
          IF v_cycle_paid AND NOT v_has_open_inv THEN
            WHILE v_p_end <= v_now AND v_p_end + interval '1 month' <= v_now + interval '2 months' LOOP
              v_p_start := v_p_end;
              v_p_end := v_p_end + interval '1 month';
              EXIT WHEN v_p_end > v_now;
            END LOOP;

            UPDATE saas_immobilier.agency_subscriptions
            SET status = 'active', current_period_start = v_p_start, current_period_end = v_p_end,
                ends_at = v_p_end, grace_ends_at = NULL, updated_at = v_now
            WHERE id = r.sub_id;

            IF r.paid_through_at IS NULL OR r.paid_through_at < v_p_end THEN
              v_inv_id := saas_immobilier.ensure_cycle_invoice(
                r.agency_id, r.sub_id, r.plan_id, 'renewal', v_p_start, v_p_end, v_grace_days, v_now
              );
              v_invoices_created := v_invoices_created + 1;
            END IF;

            v_renewals_rolled := v_renewals_rolled + 1;

          ELSE
            IF NOT v_has_open_inv THEN
              v_inv_id := saas_immobilier.ensure_cycle_invoice(
                r.agency_id, r.sub_id, r.plan_id, 'renewal', v_p_start, v_p_end, v_grace_days, v_now
              );
              v_invoices_created := v_invoices_created + 1;
            END IF;

            v_grace_end := COALESCE(r.grace_ends_at, v_p_end + make_interval(days => v_grace_days));

            IF v_now <= v_grace_end THEN
              IF r.sub_status <> 'past_due' OR r.grace_ends_at IS NULL THEN
                UPDATE saas_immobilier.agency_subscriptions
                SET status = 'past_due', grace_ends_at = v_grace_end, updated_at = v_now
                WHERE id = r.sub_id;
                v_entered_grace := v_entered_grace + 1;
              END IF;

              PERFORM saas_immobilier.billing_notify_once(
                r.agency_id, 'due-reached:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'), 'billing',
                'Échéance mensuelle atteinte',
                format('Votre facture d''abonnement %s de %s FCFA est arrivée à échéance le %s.', r.plan_label, to_char(r.price_monthly, 'FM999G999G990'), to_char(v_p_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY')),
                '/mon-offre', 'Payer ma facture', 'high',
                jsonb_build_object('event_kind', 'due_date_reached', 'due_at', v_p_end, 'amount', r.price_monthly)
              );

              PERFORM saas_immobilier.billing_notify_once(
                r.agency_id, 'grace-start:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'), 'suspension',
                'Début de votre période de grâce de 5 jours',
                format('Vous conservez 100 %% d''accès à vos outils jusqu''au %s à %s (heure de Bamako). Régularisez votre mensualité de %s FCFA avant cette date pour éviter la suspension automatique.', to_char(v_grace_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY'), to_char(v_grace_end AT TIME ZONE 'Africa/Bamako', 'HH24:MI'), to_char(r.price_monthly, 'FM999G999G990')),
                '/mon-offre', 'Régulariser via SasPay', 'high',
                jsonb_build_object('event_kind', 'grace_period_started', 'grace_ends_at', v_grace_end)
              );

              PERFORM saas_immobilier.admin_alert_once(
                r.agency_id, 'grace:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'),
                'agency_entered_grace', 'high',
                format('Agence en grâce de 5 jours (%s)', r.agency_name),
                format('Échéance %s FCFA dépassée — suspension automatique prévue le %s si impayée.', to_char(r.price_monthly, 'FM999G999G990'), to_char(v_grace_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI')),
                '/admin/abonnements', 'Suivre l''échéance',
                jsonb_build_object('category', 'suspension', 'grace_ends_at', v_grace_end, 'amount', r.price_monthly)
              );

              IF v_now >= (v_grace_end - interval '3 days') AND v_now < (v_grace_end - interval '1 day') THEN
                IF saas_immobilier.billing_notify_once(
                  r.agency_id, 'grace-mid:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'), 'suspension',
                  'Rappel période de grâce : 3 jours restants',
                  format('Il vous reste 3 jours de grâce avant suspension automatique (limite : %s). Réglez votre facture de %s FCFA en ligne via SasPay.', to_char(v_grace_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI'), to_char(r.price_monthly, 'FM999G999G990')),
                  '/mon-offre', 'Régulariser maintenant', 'high',
                  jsonb_build_object('event_kind', 'grace_reminder_mid', 'grace_ends_at', v_grace_end)
                ) IS NOT NULL THEN v_reminders_sent := v_reminders_sent + 1; END IF;
              ELSIF v_now >= (v_grace_end - interval '1 day') THEN
                IF saas_immobilier.billing_notify_once(
                  r.agency_id, 'grace-last:' || r.sub_id::text || ':' || to_char(v_p_end AT TIME ZONE 'UTC', 'YYYYMMDD'), 'suspension',
                  'Dernier jour de grâce avant suspension',
                  format('Attention : votre période de grâce expire le %s (moins de 24h). Réglez %s FCFA via SasPay pour maintenir l''accès continu de votre équipe.', to_char(v_grace_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI'), to_char(r.price_monthly, 'FM999G999G990')),
                  '/mon-offre', 'Éviter la suspension', 'critical',
                  jsonb_build_object('event_kind', 'grace_reminder_last_day', 'grace_ends_at', v_grace_end)
                ) IS NOT NULL THEN v_reminders_sent := v_reminders_sent + 1; END IF;
              END IF;

            ELSE
              IF (r.auto_suspend_disabled_until IS NOT NULL AND r.auto_suspend_disabled_until > v_now)
                 OR EXISTS (
                   SELECT 1 FROM saas_immobilier.agency_members m
                   JOIN saas_immobilier.platform_admins pa ON pa.user_id = m.user_id
                   WHERE m.agency_id = r.agency_id AND m.status = 'active' AND pa.status = 'active'
                 ) THEN
                v_shielded := v_shielded + 1;
              ELSE
                UPDATE saas_immobilier.agency_subscriptions
                SET status = 'suspended', grace_ends_at = v_grace_end, updated_at = v_now
                WHERE id = r.sub_id;

                PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
                UPDATE saas_immobilier.agencies
                SET status = 'suspended', suspended_at = v_now, suspended_reason = 'unpaid', updated_at = v_now
                WHERE id = r.agency_id;
                PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

                INSERT INTO saas_immobilier.subscription_events (
                  agency_id, event_type, plan_to_id, plan_to_name, mensualite_to, reason, created_at
                ) VALUES (
                  r.agency_id, 'suspension', r.plan_id, r.plan_label, r.price_monthly,
                  format('Suspension automatique après 5 jours de grâce sans paiement (fin de grâce : %s)', to_char(v_grace_end AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI')),
                  v_now
                );

                INSERT INTO saas_immobilier.activity_log (
                  agency_id, action, entity_type, entity_id, summary, metadata
                ) VALUES (
                  r.agency_id, 'agency_auto_suspended_unpaid', 'agency', r.agency_id,
                  format('Suspension automatique pour impayé après 5 jours de grâce (%s)', r.agency_name),
                  jsonb_build_object('subscription_id', r.sub_id, 'grace_ends_at', v_grace_end)
                );

                v_suspended := v_suspended + 1;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;
    END IF;
  END LOOP;

  v_summary := jsonb_build_object(
    'processed', v_processed,
    'trials_converted', v_trials_converted,
    'invoices_created', v_invoices_created,
    'renewals_rolled', v_renewals_rolled,
    'entered_grace', v_entered_grace,
    'suspended', v_suspended,
    'shielded', v_shielded,
    'reminders_sent', v_reminders_sent,
    'sessions_expired', v_sessions_expired,
    'reference_now', v_now
  );

  IF p_agency_id IS NULL THEN
    INSERT INTO saas_immobilier.billing_automation_runs (kind, result)
    VALUES ('cycle', v_summary);
  END IF;

  RETURN v_summary;
END;
$$;

DROP FUNCTION IF EXISTS public.process_subscription_lifecycle(timestamptz);

GRANT EXECUTE ON FUNCTION public.process_subscription_lifecycle(uuid, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.billing_run_cycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public.process_subscription_lifecycle(NULL, now());
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
  v_res := public.process_subscription_lifecycle(NULL, now());
  RETURN jsonb_build_object(
    'reminders_sent', COALESCE((v_res->>'reminders_sent')::int, 0),
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
  v_res := public.process_subscription_lifecycle(NULL, now());
  RETURN COALESCE((v_res->>'suspended')::int, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_suspension_shield(
  p_agency_id uuid,
  p_days integer DEFAULT 3,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_anchor timestamptz;
  v_until timestamptz;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  IF p_days IS NULL OR p_days <= 0 THEN
    v_until := NULL;
  ELSE
    SELECT GREATEST(now(), COALESCE(s.grace_ends_at, s.current_period_end, s.ends_at, now()))
    INTO v_anchor
    FROM saas_immobilier.agency_subscriptions s
    WHERE s.agency_id = p_agency_id
    ORDER BY s.created_at DESC LIMIT 1;

    v_until := COALESCE(v_anchor, now()) + make_interval(days => LEAST(p_days, 30));
  END IF;

  PERFORM set_config('sofia.internal_agency_mutation', 'on', true);
  UPDATE saas_immobilier.agencies SET auto_suspend_disabled_until = v_until, updated_at = now() WHERE id = p_agency_id;
  PERFORM set_config('sofia.internal_agency_mutation', 'off', true);

  INSERT INTO saas_immobilier.activity_log (
    agency_id, user_id, action, entity_type, entity_id, summary, metadata
  ) VALUES (
    p_agency_id, v_admin_id, 'admin_suspension_shield_updated', 'agency', p_agency_id,
    CASE WHEN v_until IS NULL THEN 'Protection temporaire contre la suspension retirée'
         ELSE format('Protection contre la suspension activée jusqu''au %s', to_char(v_until AT TIME ZONE 'Africa/Bamako', 'DD/MM/YYYY HH24:MI'))
    END,
    jsonb_build_object('until', v_until, 'note', p_note)
  );

  RETURN jsonb_build_object('agency_id', p_agency_id, 'auto_suspend_disabled_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_suspension_shield(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_suspension_shield(uuid, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.billing_automation_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_has_cron boolean := EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron');
  v_cron_jobs jsonb := '[]'::jsonb;
  v_last_cycle jsonb;
  v_last_reconcile jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  IF v_has_cron THEN
    EXECUTE $q$
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'jobid', jobid, 'jobname', jobname, 'schedule', schedule, 'active', active
      )), '[]'::jsonb)
      FROM cron.job WHERE jobname LIKE 'sofia-%'
    $q$ INTO v_cron_jobs;
  END IF;

  SELECT row_to_json(r)::jsonb INTO v_last_cycle
  FROM (SELECT id, kind, created_at, result FROM saas_immobilier.billing_automation_runs WHERE kind = 'cycle' ORDER BY created_at DESC LIMIT 1) r;

  SELECT row_to_json(r)::jsonb INTO v_last_reconcile
  FROM (SELECT id, kind, created_at, result FROM saas_immobilier.billing_automation_runs WHERE kind = 'reconciliation' ORDER BY created_at DESC LIMIT 1) r;

  RETURN jsonb_build_object(
    'pg_cron_active', v_has_cron,
    'cron_jobs', v_cron_jobs,
    'last_cycle_run', v_last_cycle,
    'last_reconciliation_run', v_last_reconcile,
    'checked_at', now(),
    'timezone', 'Africa/Bamako'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_automation_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.billing_automation_health() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Planification automatique horaire via `pg_cron` (si extension disponible)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron non activable automatiquement : %', SQLERRM;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname IN ('sofia-subscription-lifecycle-hourly', 'sofia_subscription_lifecycle_15m');

    PERFORM cron.schedule(
      'sofia-subscription-lifecycle-hourly',
      '*/15 * * * *',
      $cron$SELECT public.process_subscription_lifecycle(NULL, now()); SELECT public.admin_scan_alerts();$cron$
    );
  END IF;
END;
$$;

COMMIT;
