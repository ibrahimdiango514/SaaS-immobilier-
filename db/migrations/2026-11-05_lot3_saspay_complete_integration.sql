-- =============================================================================
-- LOT 3 — Intégration SasPay complète (4 motifs officiels, prorata serveur,
--         vérification serveur-à-serveur, webhooks HMAC, réconciliation et
--         réactivation automatique d'agence suspendue)
-- Date : 2026-11-05
-- Cible d'exécution autorisée : Sofia Immobilier Lab (yswsildmbeomjlyofnrk)
-- Production (xbuuhfwobrafcbgtdgjx) : AUCUNE EXÉCUTION SANS VALIDATION EXPLICITE
--
-- Motifs officiels SasPay pris en charge :
--   1. 'first_subscription' : 1re mensualité générée à J14 (hors installation)
--   2. 'renewal'            : renouvellement mensuel (échéance ouverte ou anticipé)
--   3. 'plan_change'        : montée d'offre en cours d'abonnement actif (prorata serveur)
--   4. 'reactivation'       : régularisation et réactivation immédiate d'une agence
--                             suspendue pour impayé
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Colonnes additives, table d'exceptions et contrainte des motifs SasPay
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.online_payments
  ADD COLUMN IF NOT EXISTS checkout_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_net_amount numeric,
  ADD COLUMN IF NOT EXISTS provider_charged_amount numeric,
  ADD COLUMN IF NOT EXISTS last_reconcile_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_checkout_attempt_at timestamptz;

ALTER TABLE saas_immobilier.online_payments
  DROP CONSTRAINT IF EXISTS online_payments_purpose_check;

ALTER TABLE saas_immobilier.online_payments
  ADD CONSTRAINT online_payments_purpose_check
  CHECK (purpose = ANY (ARRAY[
    'first_subscription'::text,
    'renewal'::text,
    'plan_change'::text,
    'reactivation'::text,
    'setup'::text,
    'invoice'::text
  ]));

CREATE INDEX IF NOT EXISTS online_payments_agency_status_created_idx
  ON saas_immobilier.online_payments (agency_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS online_payments_session_id_idx
  ON saas_immobilier.online_payments (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS saas_immobilier.billing_reconciliation_exceptions (
  payment_id uuid PRIMARY KEY REFERENCES saas_immobilier.online_payments(id) ON DELETE CASCADE,
  session_id uuid,
  transaction_id uuid,
  reason text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

ALTER TABLE saas_immobilier.billing_reconciliation_exceptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE saas_immobilier.saspay_webhook_events
  ADD COLUMN IF NOT EXISTS external_transaction_id uuid;

CREATE INDEX IF NOT EXISTS saspay_webhook_events_tx_idx
  ON saas_immobilier.saspay_webhook_events (external_transaction_id, event_type)
  WHERE external_transaction_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Calcul du prorata serveur pour la montée d'offre (Décision 2)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saspay_preview_plan_upgrade(
  p_agency_id uuid,
  p_target_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_cur saas_immobilier.plans%ROWTYPE;
  v_target saas_immobilier.plans%ROWTYPE;
  v_open_cycle_inv uuid;
  v_p_start date;
  v_p_end date;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_total_days integer;
  v_days_left integer;
  v_delta numeric;
  v_prorata numeric;
BEGIN
  IF NOT (public.is_agency_member_any_status(p_agency_id) OR public.billing_has_access(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès agence refusé.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = p_agency_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Agence introuvable.');
  END IF;

  IF v_ag.status = 'pending' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'En attente d''activation : seul l''administrateur peut modifier l''offre avant la fin de l''installation physique.'
    );
  END IF;

  IF v_ag.status = 'suspended' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Agence suspendue : régularisez d''abord votre abonnement avant de changer d''offre.'
    );
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
    AND status IN ('active', 'trial', 'past_due')
  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           created_at DESC
  LIMIT 1;

  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Aucun abonnement trouvé.');
  END IF;

  IF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now() THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Pendant les 14 jours d''essai gratuit, tout changement d''offre est effectué par l''administrateur (ajustement des frais d''installation).'
    );
  END IF;

  SELECT * INTO v_cur FROM saas_immobilier.plans WHERE id = v_sub.plan_id;
  SELECT * INTO v_target FROM saas_immobilier.plans WHERE id = p_target_plan_id;

  IF v_target.id IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Offre cible introuvable.');
  END IF;

  IF v_target.id = v_cur.id THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'Votre agence bénéficie déjà de cette offre.');
  END IF;

  IF COALESCE(v_target.price_monthly, 0) <= COALESCE(v_cur.price_monthly, 0) THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Le passage vers une offre inférieure est géré avec l''administrateur en fin de période.'
    );
  END IF;

  -- Vérifier qu'aucune facture mensuelle de base n'est encore impayée sur la période courante
  SELECT inv.id INTO v_open_cycle_inv
  FROM saas_immobilier.subscription_invoices inv
  WHERE inv.agency_id = p_agency_id
    AND inv.status = 'pending'
    AND (inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR inv.billing_kind = 'period')
  LIMIT 1;

  IF v_open_cycle_inv IS NOT NULL OR v_sub.status = 'past_due' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Réglez d''abord votre facture mensuelle en cours avant de passer à une offre supérieure au prorata.',
      'blocking_invoice_id', v_open_cycle_inv
    );
  END IF;

  v_p_start := COALESCE((v_sub.current_period_start AT TIME ZONE 'UTC')::date, (v_sub.starts_at AT TIME ZONE 'UTC')::date, v_today);
  v_p_end   := COALESCE((v_sub.current_period_end AT TIME ZONE 'UTC')::date, (v_sub.ends_at AT TIME ZONE 'UTC')::date, (v_today + 30));

  IF v_p_end <= v_today THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'reason', 'Votre période mensuelle arrive à échéance aujourd''hui : renouvelez d''abord votre mois.'
    );
  END IF;

  v_total_days := GREATEST(1, (v_p_end - v_p_start));
  v_days_left  := LEAST(v_total_days, GREATEST(1, (v_p_end - v_today)));
  v_delta      := v_target.price_monthly - v_cur.price_monthly;
  v_prorata    := GREATEST(100, round((v_delta * v_days_left::numeric) / v_total_days::numeric, 0));

  RETURN jsonb_build_object(
    'eligible', true,
    'agency_id', p_agency_id,
    'subscription_id', v_sub.id,
    'current_plan_id', v_cur.id,
    'current_plan_name', COALESCE(v_cur.display_name, v_cur.name),
    'current_price_monthly', v_cur.price_monthly,
    'target_plan_id', v_target.id,
    'target_plan_name', COALESCE(v_target.display_name, v_target.name),
    'target_price_monthly', v_target.price_monthly,
    'monthly_delta', v_delta,
    'days_remaining', v_days_left,
    'total_days', v_total_days,
    'prorata_amount', v_prorata,
    'currency', COALESCE(v_target.currency, 'XOF'),
    'period_start', v_p_start,
    'period_end', v_p_end
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.saspay_preview_plan_upgrade(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION saas_immobilier.prepare_plan_change_invoice(
  p_agency_id uuid,
  p_target_plan_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_preview jsonb;
  v_inv_id uuid;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_quote_due timestamptz;
  v_ref text;
BEGIN
  v_preview := public.saspay_preview_plan_upgrade(p_agency_id, p_target_plan_id);
  IF NOT COALESCE((v_preview->>'eligible')::boolean, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_preview->>'reason', 'Montée d''offre indisponible.') USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE id = (v_preview->>'subscription_id')::uuid
  FOR UPDATE;

  -- Réutiliser le devis du jour s'il existe déjà pour la même offre cible
  SELECT inv.id INTO v_inv_id
  FROM saas_immobilier.subscription_invoices inv
  WHERE inv.agency_id = p_agency_id
    AND inv.status = 'pending'
    AND inv.invoice_kind = 'plan_change'
    AND inv.plan_to_id = p_target_plan_id
    AND inv.period_start = v_today
    AND inv.amount = (v_preview->>'prorata_amount')::numeric
  ORDER BY inv.created_at DESC
  LIMIT 1;

  IF v_inv_id IS NOT NULL THEN
    RETURN v_inv_id;
  END IF;

  -- Annuler d'éventuels anciens devis de changement d'offre périmés
  UPDATE saas_immobilier.subscription_invoices
  SET status = 'cancelled',
      note = COALESCE(note, '') || ' [Devis prorata remplacé]'
  WHERE agency_id = p_agency_id
    AND status = 'pending'
    AND (invoice_kind = 'plan_change' OR billing_kind = 'plan_change');

  UPDATE saas_immobilier.online_payments
  SET status = 'cancelled',
      fail_reason = 'superseded_plan_quote',
      updated_at = now()
  WHERE agency_id = p_agency_id
    AND status = 'pending'
    AND purpose IN ('plan_change', 'invoice')
    AND checkout_session_id IS NULL;

  v_quote_due := LEAST(
    ((v_today + 1)::timestamp AT TIME ZONE 'UTC'),
    COALESCE(v_sub.current_period_end, v_sub.ends_at, now() + interval '24 hours')
  );
  v_ref := saas_immobilier.subscription_reference('UPG');

  INSERT INTO saas_immobilier.subscription_invoices (
    agency_id,
    plan_from_id,
    plan_to_id,
    plan_from_name,
    plan_to_name,
    amount,
    currency,
    prorata_applied,
    prorata_days,
    prorata_days_in_month,
    period_start,
    period_end,
    status,
    reference,
    note,
    created_by,
    invoice_kind,
    due_at,
    grace_ends_at,
    billing_kind,
    billing_subscription_id,
    billing_due_at
  ) VALUES (
    p_agency_id,
    (v_preview->>'current_plan_id')::uuid,
    (v_preview->>'target_plan_id')::uuid,
    v_preview->>'current_plan_name',
    v_preview->>'target_plan_name',
    (v_preview->>'prorata_amount')::numeric,
    COALESCE(v_preview->>'currency', 'XOF'),
    true,
    (v_preview->>'days_remaining')::int,
    (v_preview->>'total_days')::int,
    v_today,
    (v_preview->>'period_end')::date,
    'pending',
    v_ref,
    format(
      'Prorata montée d''offre %s → %s (%s/%s jours restants)',
      v_preview->>'current_plan_name',
      v_preview->>'target_plan_name',
      v_preview->>'days_remaining',
      v_preview->>'total_days'
    ),
    auth.uid(),
    'plan_change',
    v_quote_due,
    v_quote_due,
    'plan_change',
    v_sub.id,
    COALESCE(v_sub.current_period_end, v_sub.ends_at)
  )
  RETURNING id INTO v_inv_id;

  RETURN v_inv_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Création / réutilisation d'une intention de paiement SasPay (4 motifs)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saspay_create_checkout(
  p_agency_id uuid,
  p_purpose text,
  p_plan_id uuid DEFAULT NULL,
  p_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_plan saas_immobilier.plans%ROWTYPE;
  v_inv saas_immobilier.subscription_invoices%ROWTYPE;
  v_existing saas_immobilier.online_payments%ROWTYPE;
  v_purpose text := lower(btrim(COALESCE(p_purpose, '')));
  v_resolved_purpose text;
  v_inv_id uuid;
  v_payment_id uuid;
  v_amount numeric;
  v_currency text;
  v_customer_email text;
  v_customer_name text;
  v_quote_expiry timestamptz := NULL;
  v_description text;
BEGIN
  IF p_agency_id IS NULL THEN
    RAISE EXCEPTION 'Identifiant d''agence obligatoire.' USING ERRCODE = '22023';
  END IF;

  IF NOT public.billing_has_access(p_agency_id) THEN
    RAISE EXCEPTION 'Accès refusé : propriétaire ou administrateur de l''agence requis.' USING ERRCODE = '42501';
  END IF;

  IF v_purpose = 'setup' THEN
    RAISE EXCEPTION 'Les frais d''installation physique ne sont jamais encaissés en ligne via SasPay.' USING ERRCODE = '22023';
  END IF;

  IF v_purpose NOT IN ('first_subscription', 'renewal', 'plan_change', 'reactivation', 'invoice') THEN
    RAISE EXCEPTION 'Motif de paiement invalide (%). Motifs autorisés : first_subscription, renewal, plan_change, reactivation.', p_purpose USING ERRCODE = '22023';
  END IF;

  -- Synchroniser le cycle de l'agence (J14 -> 1er mois ou E1 -> grâce/suspension)
  PERFORM public.agency_sync_billing_lifecycle(p_agency_id);

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = p_agency_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF v_ag.status = 'pending' THEN
    RAISE EXCEPTION 'Paiement indisponible : votre agence est en attente d''installation physique et d''activation administrateur.' USING ERRCODE = '22023';
  END IF;

  IF v_ag.status = 'cancelled' THEN
    RAISE EXCEPTION 'Paiement indisponible : compte agence clôturé.' USING ERRCODE = '22023';
  END IF;

  IF v_ag.status = 'suspended' AND COALESCE(v_ag.suspended_reason, 'unpaid') <> 'unpaid' THEN
    RAISE EXCEPTION 'Suspension administrative (%) : contactez l''équipe Sofia Immobilier.', v_ag.suspended_reason USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RAISE EXCEPTION 'Aucun abonnement actif ou éligible trouvé pour cette agence.' USING ERRCODE = 'P0002';
  END IF;

  -- Résolution stricte du motif et du montant côté serveur uniquement
  IF v_purpose = 'plan_change' THEN
    IF p_plan_id IS NULL AND p_invoice_id IS NULL THEN
      RAISE EXCEPTION 'Offre cible obligatoire pour un changement d''offre.' USING ERRCODE = '22023';
    END IF;
    IF p_invoice_id IS NOT NULL THEN
      v_inv_id := p_invoice_id;
    ELSE
      v_inv_id := saas_immobilier.prepare_plan_change_invoice(p_agency_id, p_plan_id);
    END IF;
    SELECT * INTO v_inv FROM saas_immobilier.subscription_invoices WHERE id = v_inv_id FOR UPDATE;
    IF NOT FOUND OR v_inv.agency_id <> p_agency_id OR v_inv.status <> 'pending' THEN
      RAISE EXCEPTION 'Devis de changement d''offre introuvable ou expiré.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_inv.plan_to_id;
    v_resolved_purpose := 'plan_change';
    v_amount := v_inv.amount;
    v_currency := COALESCE(v_inv.currency, 'XOF');
    v_quote_expiry := COALESCE(v_inv.due_at, now() + interval '12 hours');
    v_description := format('Sofia Immobilier — Montée d''offre vers %s (%s)', COALESCE(v_plan.display_name, v_plan.name), COALESCE(v_inv.reference, 'prorata'));

  ELSIF v_purpose = 'invoice' AND p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_inv FROM saas_immobilier.subscription_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND OR v_inv.agency_id <> p_agency_id OR v_inv.status <> 'pending' THEN
      RAISE EXCEPTION 'Facture introuvable ou déjà réglée.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = COALESCE(v_inv.plan_to_id, v_sub.plan_id);
    v_inv_id := v_inv.id;
    v_resolved_purpose := CASE
      WHEN v_inv.invoice_kind = 'plan_change' OR v_inv.billing_kind = 'plan_change' THEN 'plan_change'
      WHEN v_ag.status = 'suspended' THEN 'reactivation'
      WHEN v_inv.invoice_kind = 'first_subscription' THEN 'first_subscription'
      ELSE 'renewal'
    END;
    v_amount := v_inv.amount;
    v_currency := COALESCE(v_inv.currency, 'XOF');
    IF v_resolved_purpose = 'plan_change' THEN
      v_quote_expiry := COALESCE(v_inv.due_at, now() + interval '12 hours');
    END IF;
    v_description := format('Sofia Immobilier — Facture %s (%s)', COALESCE(v_inv.reference, v_resolved_purpose), COALESCE(v_plan.display_name, v_plan.name));

  ELSIF v_purpose = 'reactivation' OR v_ag.status = 'suspended' THEN
    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_sub.plan_id;
    SELECT * INTO v_inv
    FROM saas_immobilier.subscription_invoices inv
    WHERE inv.agency_id = p_agency_id
      AND inv.status = 'pending'
      AND (inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR inv.billing_kind = 'period')
    ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
    LIMIT 1
    FOR UPDATE;

    IF v_inv.id IS NULL THEN
      v_inv_id := saas_immobilier.ensure_cycle_invoice(
        p_agency_id, v_sub.id, v_sub.plan_id, 'renewal', now(), now() + interval '1 month', 5, now()
      );
      SELECT * INTO v_inv FROM saas_immobilier.subscription_invoices WHERE id = v_inv_id;
    ELSE
      v_inv_id := v_inv.id;
    END IF;

    v_resolved_purpose := 'reactivation';
    v_amount := v_plan.price_monthly;
    v_currency := COALESCE(v_plan.currency, 'XOF');
    v_description := format('Sofia Immobilier — Régularisation et réactivation (%s)', COALESCE(v_plan.display_name, v_plan.name));

  ELSE
    -- 'first_subscription' ou 'renewal'
    IF v_sub.status = 'trial' AND v_sub.trial_ends_at IS NOT NULL AND v_sub.trial_ends_at > now() THEN
      RAISE EXCEPTION 'Votre essai gratuit de 14 jours est encore en cours jusqu''au %. Votre première facture mensuelle s''ouvrira automatiquement à la fin de l''essai.', to_char(v_sub.trial_ends_at AT TIME ZONE 'UTC', 'DD/MM/YYYY') USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_sub.plan_id;

    SELECT * INTO v_inv
    FROM saas_immobilier.subscription_invoices inv
    WHERE inv.agency_id = p_agency_id
      AND inv.status = 'pending'
      AND (inv.invoice_kind IN ('first_subscription', 'renewal') OR inv.billing_kind = 'period')
    ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
    LIMIT 1
    FOR UPDATE;

    IF v_inv.id IS NOT NULL THEN
      v_inv_id := v_inv.id;
      v_resolved_purpose := CASE WHEN v_inv.invoice_kind = 'first_subscription' THEN 'first_subscription' ELSE 'renewal' END;
      v_amount := v_inv.amount;
      v_currency := COALESCE(v_inv.currency, 'XOF');
      v_description := format(
        'Sofia Immobilier — %s (%s)',
        CASE WHEN v_resolved_purpose = 'first_subscription' THEN '1er mois d''abonnement' ELSE 'Renouvellement mensuel' END,
        COALESCE(v_plan.display_name, v_plan.name)
      );
    ELSE
      -- Renouvellement anticipé d'un mois supplémentaire (la période courante étant déjà payée)
      v_inv_id := NULL;
      v_resolved_purpose := 'renewal';
      v_amount := v_plan.price_monthly;
      v_currency := COALESCE(v_plan.currency, 'XOF');
      v_description := format('Sofia Immobilier — Renouvellement mensuel anticipé (%s)', COALESCE(v_plan.display_name, v_plan.name));
    END IF;
  END IF;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Montant calculé invalide (%).', v_amount USING ERRCODE = '22023';
  END IF;

  -- Réutilisation idempotente d'une session pending non expirée pour le même motif / facture / montant
  SELECT * INTO v_existing
  FROM saas_immobilier.online_payments op
  WHERE op.agency_id = p_agency_id
    AND op.status = 'pending'
    AND op.purpose = v_resolved_purpose
    AND op.amount = v_amount
    AND op.currency = v_currency
    AND (op.invoice_id IS NOT DISTINCT FROM v_inv_id)
    AND (op.expires_at IS NULL OR op.expires_at > now() + interval '2 minutes')
    AND NULLIF(op.metadata->>'checkout_quarantine_reason', '') IS NULL
  ORDER BY op.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'payment_id', v_existing.id,
      'purpose', v_existing.purpose,
      'amount', v_existing.amount,
      'currency', v_existing.currency,
      'plan_id', v_existing.plan_id,
      'invoice_id', v_existing.invoice_id,
      'checkout_session_id', v_existing.checkout_session_id,
      'checkout_url', v_existing.checkout_url,
      'expires_at', v_existing.expires_at,
      'reused', (v_existing.checkout_session_id IS NOT NULL AND v_existing.checkout_url IS NOT NULL)
    );
  END IF;

  -- Coordonnées client avec cascade de repli fiable
  SELECT up.email, up.full_name
  INTO v_customer_email, v_customer_name
  FROM saas_immobilier.agency_members m
  JOIN saas_immobilier.user_profiles up ON up.id = m.user_id
  WHERE m.agency_id = p_agency_id
    AND m.status = 'active'
    AND m.role IN ('owner', 'admin')
  ORDER BY (m.role = 'owner') DESC, m.created_at ASC
  LIMIT 1;

  IF NULLIF(btrim(COALESCE(v_customer_email, '')), '') IS NULL THEN
    v_customer_email := NULLIF(btrim(COALESCE(v_ag.email, '')), '');
  END IF;

  IF NULLIF(btrim(COALESCE(v_customer_email, '')), '') IS NULL AND auth.uid() IS NOT NULL THEN
    SELECT u.email INTO v_customer_email FROM auth.users u WHERE u.id = auth.uid();
  END IF;

  v_customer_email := COALESCE(NULLIF(btrim(v_customer_email), ''), 'facturation@sofia-immobilier.ml');
  v_customer_name  := COALESCE(NULLIF(btrim(v_customer_name), ''), v_ag.name, 'Agence Sofia Immobilier');

  v_payment_id := gen_random_uuid();

  INSERT INTO saas_immobilier.online_payments (
    id,
    agency_id,
    subscription_id,
    invoice_id,
    plan_id,
    purpose,
    amount,
    currency,
    status,
    provider,
    idempotency_key,
    created_by,
    metadata
  ) VALUES (
    v_payment_id,
    p_agency_id,
    v_sub.id,
    v_inv_id,
    v_plan.id,
    v_resolved_purpose,
    v_amount,
    v_currency,
    'pending',
    'saspay',
    'OP-' || replace(v_payment_id::text, '-', ''),
    auth.uid(),
    jsonb_build_object(
      'description', v_description,
      'country', CASE WHEN v_ag.country IN ('Mali', 'ML') OR v_ag.country IS NULL THEN 'ML' ELSE left(upper(v_ag.country), 2) END,
      'customer_email', v_customer_email,
      'customer_name', v_customer_name,
      'agency_name', v_ag.name,
      'purpose', v_resolved_purpose,
      'invoice_reference', v_inv.reference
    ) || CASE WHEN v_quote_expiry IS NOT NULL THEN jsonb_build_object('quote_expires_at', v_quote_expiry) ELSE '{}'::jsonb END
  );

  RETURN jsonb_build_object(
    'payment_id', v_payment_id,
    'purpose', v_resolved_purpose,
    'amount', v_amount,
    'currency', v_currency,
    'plan_id', v_plan.id,
    'invoice_id', v_inv_id,
    'checkout_session_id', NULL,
    'checkout_url', NULL,
    'reused', false
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.saspay_create_checkout(uuid, text, uuid, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Confirmation durcie d'un paiement SasPay (vérification serveur + idempotence)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.saspay_confirm_verified_payment(
  p_payment_id uuid,
  p_session_id uuid,
  p_transaction_id uuid,
  p_requested_amount numeric,
  p_currency text,
  p_transaction_reference text DEFAULT NULL,
  p_net_amount numeric DEFAULT NULL,
  p_charged_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_settle jsonb;
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_ref text;
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  IF p_payment_id IS NULL OR p_session_id IS NULL OR p_transaction_id IS NULL OR p_requested_amount IS NULL OR NULLIF(btrim(p_currency), '') IS NULL THEN
    RAISE EXCEPTION 'Vérification fournisseur incomplète.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
  FROM saas_immobilier.online_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND OR v_row.checkout_session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'Session de paiement incohérente.' USING ERRCODE = '22023';
  END IF;

  -- Protection anti-falsification stricte du montant et de la devise
  IF abs(COALESCE(p_requested_amount, 0) - v_row.amount) > 0.005
     OR upper(btrim(p_currency)) <> upper(btrim(v_row.currency)) THEN
    INSERT INTO saas_immobilier.billing_reconciliation_exceptions (
      payment_id, session_id, transaction_id, reason
    ) VALUES (
      v_row.id, p_session_id, p_transaction_id,
      format('amount_or_currency_mismatch: expected %s %s, got %s %s', v_row.amount, v_row.currency, p_requested_amount, p_currency)
    )
    ON CONFLICT (payment_id) DO UPDATE
    SET transaction_id = EXCLUDED.transaction_id,
        reason = EXCLUDED.reason,
        last_seen_at = now(),
        resolved_at = NULL;

    PERFORM saas_immobilier.billing_admin_alert_once(
      v_row.agency_id,
      'saspay-mismatch:' || v_row.id::text,
      'payment_amount_mismatch',
      'critical',
      'Divergence de montant SasPay bloquée',
      format('Attendu : %s %s — Reçu : %s %s (session %s). Aucun crédit appliqué.', v_row.amount, v_row.currency, p_requested_amount, p_currency, p_session_id),
      jsonb_build_object('payment_id', v_row.id, 'session_id', p_session_id, 'transaction_id', p_transaction_id)
    );

    RAISE EXCEPTION 'Montant ou devise fournisseur incohérent.' USING ERRCODE = '22023';
  END IF;

  IF v_row.transaction_id IS NOT NULL AND v_row.transaction_id <> p_transaction_id THEN
    RAISE EXCEPTION 'Transaction différente déjà rattachée à cette intention.' USING ERRCODE = '22023';
  END IF;

  -- Idempotence : déjà payé et réconcilié
  IF v_row.status = 'paid' AND v_row.reconciled_at IS NOT NULL THEN
    UPDATE saas_immobilier.billing_reconciliation_exceptions
    SET resolved_at = COALESCE(resolved_at, now())
    WHERE payment_id = v_row.id;

    RETURN jsonb_build_object(
      'status', 'paid',
      'payment_id', v_row.id,
      'agency_id', v_row.agency_id,
      'purpose', v_row.purpose,
      'already_processed', true,
      'reactivated', false
    );
  END IF;

  v_ref := 'SASPAY-' || upper(substr(replace(v_row.id::text, '-', ''), 1, 10));

  v_settle := saas_immobilier.apply_confirmed_subscription_payment(
    p_agency_id          => v_row.agency_id,
    p_purpose            => v_row.purpose,
    p_amount             => v_row.amount,
    p_currency           => v_row.currency,
    p_method             => 'saspay',
    p_invoice_id         => v_row.invoice_id,
    p_target_plan_id     => v_row.plan_id,
    p_reference          => v_ref,
    p_note               => format('Paiement en ligne vérifié auprès de SasPay (%s)', v_row.purpose),
    p_recorded_by        => v_row.created_by,
    p_provider           => 'saspay',
    p_provider_reference => COALESCE(NULLIF(btrim(p_transaction_reference), ''), p_transaction_id::text),
    p_provider_status    => 'SUCCESS',
    p_online_payment_id  => v_row.id,
    p_now                => now()
  );

  UPDATE saas_immobilier.online_payments
  SET
    status                  = 'paid',
    paid_at                 = COALESCE(paid_at, now()),
    reconciled_at           = now(),
    transaction_id          = p_transaction_id,
    transaction_reference   = COALESCE(NULLIF(btrim(p_transaction_reference), ''), p_transaction_id::text),
    paid_amount             = p_requested_amount,
    provider_net_amount     = p_net_amount,
    provider_charged_amount = p_charged_amount,
    subscription_id         = COALESCE(NULLIF(v_settle->>'subscription_id', '')::uuid, subscription_id),
    fail_reason             = NULL,
    updated_at              = now()
  WHERE id = v_row.id;

  UPDATE saas_immobilier.billing_reconciliation_exceptions
  SET resolved_at = now()
  WHERE payment_id = v_row.id
    AND resolved_at IS NULL;

  RETURN jsonb_build_object(
    'status', 'paid',
    'payment_id', v_row.id,
    'agency_id', v_row.agency_id,
    'purpose', v_row.purpose,
    'subscription_payment_id', v_settle->>'payment_id',
    'already_processed', COALESCE((v_settle->>'already_processed')::boolean, false),
    'reactivated', COALESCE((v_settle->>'reactivated')::boolean, false),
    'plan_changed', COALESCE((v_settle->>'plan_changed')::boolean, false),
    'ends_at', v_settle->'ends_at',
    'paid_through_at', v_settle->'paid_through_at'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.saspay_confirm_guarded_payment(
  p_payment_id uuid,
  p_session_id uuid,
  p_transaction_id uuid,
  p_requested_amount numeric,
  p_currency text,
  p_transaction_reference text DEFAULT NULL,
  p_net_amount numeric DEFAULT NULL,
  p_charged_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR v_row.checkout_session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'Session de paiement incohérente.' USING ERRCODE = '22023';
  END IF;

  IF v_row.checkout_url IS NULL OR NULLIF(v_row.metadata->>'checkout_quarantine_reason', '') IS NOT NULL THEN
    RAISE EXCEPTION 'Session en quarantaine : rapprochement exceptionnel nécessaire.' USING ERRCODE = '22023';
  END IF;

  RETURN public.saspay_confirm_verified_payment(
    p_payment_id,
    p_session_id,
    p_transaction_id,
    p_requested_amount,
    p_currency,
    p_transaction_reference,
    p_net_amount,
    p_charged_amount
  );
END;
$$;

-- S'assurer que les utilitaires de claim / attach / fail / reconcile sont présents et portables
CREATE OR REPLACE FUNCTION public.saspay_claim_checkout(p_payment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'Intention de paiement introuvable ou fermée.' USING ERRCODE = '22023';
  END IF;

  IF v_row.checkout_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'attached', true);
  END IF;

  -- Si un claim précédent date de plus de 60 secondes sans session attachée, autoriser la reprise
  IF v_row.checkout_claimed_at IS NOT NULL AND v_row.checkout_claimed_at > now() - interval '60 seconds' THEN
    RETURN jsonb_build_object('claimed', false, 'attached', false);
  END IF;

  UPDATE saas_immobilier.online_payments
  SET checkout_claimed_at = now(), updated_at = now()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('claimed', true, 'attached', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.saspay_attach_checkout_checked(
  p_payment_id uuid,
  p_session_id uuid,
  p_checkout_url text,
  p_expires_at timestamptz DEFAULT NULL,
  p_quarantine_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_quarantine_reason, '')), '');
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intention introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF v_row.checkout_session_id IS NOT NULL THEN
    IF v_row.checkout_session_id IS DISTINCT FROM p_session_id THEN
      RAISE EXCEPTION 'Une session différente est déjà associée.' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object(
      'payment_id', v_row.id,
      'checkout_session_id', v_row.checkout_session_id,
      'checkout_url', v_row.checkout_url,
      'already_attached', true,
      'quarantined', (v_row.checkout_url IS NULL),
      'quarantine_reason', v_row.metadata->>'checkout_quarantine_reason'
    );
  END IF;

  IF p_checkout_url IS NULL OR p_checkout_url !~ '^https://[^/[:space:]]+' THEN
    v_reason := COALESCE(v_reason, 'session_url_invalid');
  END IF;

  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    v_reason := COALESCE(v_reason, 'session_expired_before_attach');
  END IF;

  UPDATE saas_immobilier.online_payments
  SET
    checkout_session_id = p_session_id,
    checkout_url        = CASE WHEN v_reason IS NULL THEN p_checkout_url ELSE NULL END,
    expires_at          = p_expires_at,
    metadata            = (COALESCE(metadata, '{}'::jsonb) - 'checkout_quarantine_reason')
                          || CASE WHEN v_reason IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('checkout_quarantine_reason', v_reason) END,
    updated_at          = now()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'payment_id', p_payment_id,
    'checkout_session_id', p_session_id,
    'checkout_url', CASE WHEN v_reason IS NULL THEN p_checkout_url ELSE NULL END,
    'already_attached', false,
    'quarantined', (v_reason IS NOT NULL),
    'quarantine_reason', v_reason
  );
END;
$$;

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
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
  v_next_status text;
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
      WHEN p_reason LIKE '%expired%' THEN 'expired'
      WHEN p_reason LIKE '%cancelled%' THEN 'cancelled'
      ELSE 'failed'
    END;

    UPDATE saas_immobilier.online_payments
    SET status = v_next_status,
        fail_reason = p_reason,
        updated_at = now()
    WHERE id = p_payment_id;
  ELSE
    UPDATE saas_immobilier.online_payments
    SET fail_reason = p_reason,
        updated_at = now()
    WHERE id = p_payment_id;
  END IF;

  PERFORM saas_immobilier.billing_notify(
    v_row.agency_id,
    'payment-failed:' || v_row.id::text || ':' || COALESCE(p_reason, 'failed'),
    'Paiement non abouti',
    'La tentative de paiement SasPay n''a pas abouti. Vous pouvez relancer le règlement à tout moment depuis votre espace.',
    jsonb_build_object('payment_id', v_row.id, 'reason', p_reason)
  );
END;
$$;

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
END;
$$;

DROP FUNCTION IF EXISTS public.saspay_reconciliation_batch(uuid, integer);

CREATE OR REPLACE FUNCTION public.saspay_reconciliation_batch(
  p_after uuid DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_force boolean DEFAULT false
)
RETURNS TABLE(payment_id uuid, checkout_session_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT op.id, op.checkout_session_id
  FROM saas_immobilier.online_payments op
  WHERE op.checkout_session_id IS NOT NULL
    AND (op.status = 'pending' OR (op.status = 'paid' AND op.reconciled_at IS NULL))
    AND (
      p_force
      OR op.last_reconcile_attempt_at IS NULL
      OR op.last_reconcile_attempt_at < now() - interval '2 minutes'
    )
    AND (p_after IS NULL OR op.id > p_after)
  ORDER BY op.last_reconcile_attempt_at ASC NULLS FIRST, op.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$$;

CREATE OR REPLACE FUNCTION public.saspay_mark_reconcile_attempt(p_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_jwt_role text := auth.role();
  v_db_role text := COALESCE(NULLIF(current_setting('role', true), ''), 'none');
  v_privileged boolean := session_user IN ('postgres', 'supabase_admin') AND v_db_role IN ('none', 'postgres', 'supabase_admin');
BEGIN
  IF NOT (v_jwt_role = 'service_role' OR v_privileged) THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;
  UPDATE saas_immobilier.online_payments SET last_reconcile_attempt_at = now() WHERE id = p_payment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.billing_log_reconciliation_run(
  p_checked integer,
  p_opened integer DEFAULT 0,
  p_errors integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO saas_immobilier.billing_automation_runs (kind, result)
  VALUES (
    'reconciliation',
    jsonb_build_object('checked', p_checked, 'opened', p_opened, 'errors', p_errors, 'run_at', now())
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Lectures Agence & Admin pour le suivi SasPay, retour paiement & suspension
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.saspay_payment_for_caller(uuid);

CREATE OR REPLACE FUNCTION public.saspay_payment_for_caller(
  p_payment_id uuid DEFAULT NULL,
  p_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row saas_immobilier.online_payments%ROWTYPE;
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_plan saas_immobilier.plans%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
BEGIN
  IF p_payment_id IS NULL AND p_session_id IS NULL THEN
    RAISE EXCEPTION 'Identifiant de paiement ou de session requis.' USING ERRCODE = '22023';
  END IF;

  IF p_payment_id IS NOT NULL THEN
    SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE id = p_payment_id;
  ELSE
    SELECT * INTO v_row FROM saas_immobilier.online_payments WHERE checkout_session_id = p_session_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Paiement introuvable.' USING ERRCODE = 'P0002';
  END IF;

  IF NOT (public.billing_has_access(v_row.agency_id) OR public.is_agency_member_any_status(v_row.agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé à ce paiement.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = v_row.agency_id;
  SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_row.plan_id;
  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = v_row.agency_id
  ORDER BY updated_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'payment_id', v_row.id,
    'agency_id', v_row.agency_id,
    'agency_name', v_ag.name,
    'agency_status', v_ag.status,
    'purpose', v_row.purpose,
    'plan_id', v_row.plan_id,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name),
    'invoice_id', v_row.invoice_id,
    'amount', v_row.amount,
    'currency', v_row.currency,
    'status', v_row.status,
    'checkout_session_id', v_row.checkout_session_id,
    'transaction_reference', v_row.transaction_reference,
    'fail_reason', v_row.fail_reason,
    'paid_at', v_row.paid_at,
    'expires_at', v_row.expires_at,
    'reconciled_at', v_row.reconciled_at,
    'subscription_ends_at', v_sub.ends_at,
    'paid_through_at', v_sub.paid_through_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.saspay_payment_for_caller(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.saspay_payment_state(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN public.saspay_payment_for_caller(NULL, p_session_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.saspay_payment_state(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.agency_online_payments(p_agency_id uuid)
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

  IF NOT (public.billing_has_access(p_agency_id) OR public.is_agency_member_any_status(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé.' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(x)), '[]'::jsonb)
    FROM (
      SELECT
        op.id,
        op.agency_id,
        op.invoice_id,
        op.plan_id,
        COALESCE(pl.display_name, pl.name) AS plan_name,
        op.purpose,
        op.amount,
        op.currency,
        op.status,
        op.provider,
        op.checkout_session_id,
        op.transaction_reference,
        op.fail_reason,
        op.paid_at,
        op.reconciled_at,
        op.expires_at,
        op.created_at
      FROM saas_immobilier.online_payments op
      LEFT JOIN saas_immobilier.plans pl ON pl.id = op.plan_id
      WHERE op.agency_id = p_agency_id
      ORDER BY op.created_at DESC
      LIMIT 30
    ) x
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.agency_online_payments(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.saspay_regularisation_state(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ag saas_immobilier.agencies%ROWTYPE;
  v_sub saas_immobilier.agency_subscriptions%ROWTYPE;
  v_plan saas_immobilier.plans%ROWTYPE;
  v_inv saas_immobilier.subscription_invoices%ROWTYPE;
  v_can_manage boolean := public.billing_has_access(p_agency_id);
  v_can_pay boolean := false;
BEGIN
  IF NOT (v_can_manage OR public.is_agency_member_any_status(p_agency_id)) THEN
    RAISE EXCEPTION 'Accès refusé.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ag FROM saas_immobilier.agencies WHERE id = p_agency_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agence introuvable.' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_sub
  FROM saas_immobilier.agency_subscriptions
  WHERE agency_id = p_agency_id
  ORDER BY CASE status WHEN 'past_due' THEN 0 WHEN 'active' THEN 1 WHEN 'trial' THEN 2 ELSE 3 END,
           created_at DESC
  LIMIT 1;

  IF v_sub.plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_sub.plan_id;
  ELSIF v_ag.pending_plan_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM saas_immobilier.plans WHERE id = v_ag.pending_plan_id;
  END IF;

  SELECT * INTO v_inv
  FROM saas_immobilier.subscription_invoices inv
  WHERE inv.agency_id = p_agency_id
    AND inv.status = 'pending'
    AND (inv.invoice_kind IN ('first_subscription', 'renewal', 'reactivation') OR inv.billing_kind = 'period')
  ORDER BY COALESCE(inv.due_at, inv.billing_due_at, inv.created_at) ASC
  LIMIT 1;

  v_can_pay := (
    v_can_manage
    AND v_ag.status = 'suspended'
    AND COALESCE(v_ag.suspended_reason, 'unpaid') = 'unpaid'
    AND v_plan.id IS NOT NULL
  );

  RETURN jsonb_build_object(
    'agency_id', v_ag.id,
    'agency_name', v_ag.name,
    'agency_status', v_ag.status,
    'suspended_at', v_ag.suspended_at,
    'suspended_reason', v_ag.suspended_reason,
    'can_manage', v_can_manage,
    'can_pay', v_can_pay,
    'plan_id', v_plan.id,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name),
    'price_monthly', v_plan.price_monthly,
    'due_at', COALESCE(v_inv.due_at, v_inv.billing_due_at, v_sub.current_period_end, v_sub.ends_at),
    'grace_ends_at', COALESCE(v_inv.grace_ends_at, v_sub.grace_ends_at),
    'invoice_id', v_inv.id,
    'invoice_reference', v_inv.reference,
    'amount', COALESCE(v_inv.amount, v_plan.price_monthly),
    'currency', COALESCE(v_inv.currency, v_plan.currency, 'XOF')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.saspay_regularisation_state(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_saspay_overview(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_kpis jsonb;
  v_payments jsonb;
  v_exceptions jsonb;
  v_webhooks jsonb;
  v_runs jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Administrateur plateforme requis.' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'paid_count', COUNT(*) FILTER (WHERE status = 'paid'),
    'paid_volume_xof', COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0),
    'pending_count', COUNT(*) FILTER (WHERE status = 'pending'),
    'failed_count', COUNT(*) FILTER (WHERE status IN ('failed', 'expired', 'cancelled')),
    'exceptions_count', (SELECT COUNT(*) FROM saas_immobilier.billing_reconciliation_exceptions WHERE resolved_at IS NULL),
    'webhooks_24h', (SELECT COUNT(*) FROM saas_immobilier.saspay_webhook_events WHERE created_at > now() - interval '24 hours')
  )
  INTO v_kpis
  FROM saas_immobilier.online_payments;

  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb)
  INTO v_payments
  FROM (
    SELECT
      op.id,
      op.agency_id,
      a.name AS agency_name,
      op.purpose,
      COALESCE(pl.display_name, pl.name) AS plan_name,
      op.amount,
      op.currency,
      op.status,
      op.checkout_session_id,
      op.transaction_reference,
      op.provider_net_amount,
      op.provider_charged_amount,
      op.fail_reason,
      op.paid_at,
      op.reconciled_at,
      op.expires_at,
      op.created_at
    FROM saas_immobilier.online_payments op
    LEFT JOIN saas_immobilier.agencies a ON a.id = op.agency_id
    LEFT JOIN saas_immobilier.plans pl ON pl.id = op.plan_id
    ORDER BY op.created_at DESC
    LIMIT v_lim
  ) p;

  SELECT COALESCE(jsonb_agg(row_to_json(e)), '[]'::jsonb)
  INTO v_exceptions
  FROM (
    SELECT
      bre.payment_id,
      op.agency_id,
      a.name AS agency_name,
      bre.session_id,
      bre.transaction_id,
      bre.reason,
      bre.first_seen_at,
      bre.last_seen_at
    FROM saas_immobilier.billing_reconciliation_exceptions bre
    LEFT JOIN saas_immobilier.online_payments op ON op.id = bre.payment_id
    LEFT JOIN saas_immobilier.agencies a ON a.id = op.agency_id
    WHERE bre.resolved_at IS NULL
    ORDER BY bre.last_seen_at DESC
    LIMIT 25
  ) e;

  SELECT COALESCE(jsonb_agg(row_to_json(w)), '[]'::jsonb)
  INTO v_webhooks
  FROM (
    SELECT
      id,
      event_type,
      processing_result,
      processed_at,
      created_at,
      payload
    FROM saas_immobilier.saspay_webhook_events
    ORDER BY created_at DESC
    LIMIT 25
  ) w;

  SELECT COALESCE(jsonb_agg(row_to_json(ar)), '[]'::jsonb)
  INTO v_runs
  FROM (
    SELECT id, kind, result, created_at
    FROM saas_immobilier.billing_automation_runs
    ORDER BY created_at DESC
    LIMIT 15
  ) ar;

  RETURN jsonb_build_object(
    'kpis', v_kpis,
    'payments', v_payments,
    'exceptions', v_exceptions,
    'webhooks', v_webhooks,
    'automation_runs', v_runs
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_saspay_overview(integer) TO authenticated, service_role;

COMMIT;
