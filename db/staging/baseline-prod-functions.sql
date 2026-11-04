-- =============================================================================
-- STAGING — definitions de production extraites en LECTURE SEULE (2026-11-03)
-- Fonctions du chemin de paiement manuel + helpers appeles par elles.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.platform_signup_settings()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_signup jsonb; v_trial jsonb;
BEGIN
  SELECT value INTO v_signup FROM saas_immobilier.platform_settings WHERE key='signup';
  SELECT value INTO v_trial  FROM saas_immobilier.platform_settings WHERE key='trial';
  RETURN jsonb_build_object(
    'require_admin_validation', COALESCE((v_signup->>'require_admin_validation')::boolean, false),
    'trial_days',               COALESCE((v_signup->>'trial_days')::int, 14),
    'trial_agent_messages',     COALESCE((v_trial->>'agent_messages')::int, 200)
  );
END
$function$;

CREATE OR REPLACE FUNCTION saas_immobilier.notify_agency(
  p_agency_id uuid, p_type text, p_title text, p_message text,
  p_data jsonb DEFAULT '{}'::jsonb, p_dedup_key text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF p_agency_id IS NULL THEN RETURN NULL; END IF;

  IF p_dedup_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM saas_immobilier.notifications n
     WHERE n.agency_id = p_agency_id
       AND n.type = p_type
       AND n.data->>'dedup_key' = p_dedup_key
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
  VALUES (
    p_agency_id, NULL, p_type, p_title, p_message,
    COALESCE(p_data, '{}'::jsonb)
      || CASE WHEN p_dedup_key IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('dedup_key', p_dedup_key) END
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$function$;

-- Version de production (sans le figeage de plan_id : la migration SasPay
-- apporte ce correctif, testé plus loin).
CREATE OR REPLACE FUNCTION public.submit_payment_declaration(
  p_agency_id uuid, p_amount numeric, p_method text,
  p_transaction_reference text, p_paid_on date, p_proof_path text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;
  IF p_method NOT IN ('orange_money','wave') THEN
    RAISE EXCEPTION 'moyen de paiement invalide' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_transaction_reference,'')) = '' THEN
    RAISE EXCEPTION 'reference de transaction obligatoire' USING ERRCODE = '22023';
  END IF;

  INSERT INTO saas_immobilier.payment_declarations
    (agency_id, amount, method, transaction_reference, paid_on, proof_path, declared_by)
  VALUES (p_agency_id, p_amount, p_method, btrim(p_transaction_reference),
          COALESCE(p_paid_on, CURRENT_DATE), NULLIF(btrim(COALESCE(p_proof_path,'')),''), auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.review_payment_declaration(
  p_declaration_id uuid, p_decision text, p_note text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_review_payment(p_declaration_id, p_decision, p_note);
  RETURN NULLIF(v_res->>'payment_id', '')::uuid;
END
$function$;

CREATE OR REPLACE FUNCTION public.admin_review_payment(
  p_request_id uuid, p_decision text, p_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_dec      record;
  v_sub      record;
  v_plan     record;
  v_note     text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_amount   numeric;
  v_months   integer;
  v_start    timestamptz;
  v_end      timestamptz;
  v_payment  uuid;
  v_new_sub_id uuid;
  v_prev_end timestamptz;
  v_plan_from uuid;
  v_plan_from_name text;
  v_admin_label text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected', 'correction_requested') THEN
    RAISE EXCEPTION 'decision invalide' USING ERRCODE = '22023';
  END IF;
  IF p_decision IN ('rejected', 'correction_requested') AND v_note IS NULL THEN
    RAISE EXCEPTION 'un motif est obligatoire pour refuser ou demander une correction'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_dec
    FROM saas_immobilier.payment_declarations d
   WHERE d.id = p_request_id
     FOR UPDATE;

  IF v_dec.id IS NULL THEN
    RAISE EXCEPTION 'demande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_dec.status <> 'pending' THEN
    RAISE EXCEPTION 'cette demande a deja ete traitee (statut : %)', v_dec.status
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(up.full_name, ''), u.email, 'Administrateur')
    INTO v_admin_label
    FROM auth.users u
    LEFT JOIN saas_immobilier.user_profiles up ON up.id = u.id
   WHERE u.id = auth.uid();

  IF p_decision = 'rejected' THEN
    UPDATE saas_immobilier.payment_declarations d
       SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
           review_note = v_note
     WHERE d.id = v_dec.id;

    INSERT INTO saas_immobilier.payment_decision_log
      (declaration_id, agency_id, action, from_status, to_status, actor_id,
       actor_kind, actor_label, amount, note)
    VALUES (v_dec.id, v_dec.agency_id, 'rejected', 'pending', 'rejected', auth.uid(),
            'platform_admin', v_admin_label, v_dec.amount, v_note);

    PERFORM saas_immobilier.notify_agency(
      v_dec.agency_id, 'billing',
      'Paiement refuse',
      'Votre demande ' || COALESCE(v_dec.reference, '') || ' a ete refusee. Motif : ' || v_note,
      jsonb_build_object('declaration_id', v_dec.id, 'reference', v_dec.reference,
                         'status', 'rejected', 'kind', 'payment_rejected', 'reason', v_note),
      'rejected_' || v_dec.id::text
    );

    RETURN jsonb_build_object(
      'decision', 'rejected', 'id', v_dec.id, 'reference', v_dec.reference,
      'status', 'rejected', 'note', v_note, 'subscription_changed', false);
  END IF;

  IF p_decision = 'correction_requested' THEN
    UPDATE saas_immobilier.payment_declarations d
       SET status = 'correction_requested', reviewed_by = auth.uid(), reviewed_at = now(),
           review_note = v_note
     WHERE d.id = v_dec.id;

    INSERT INTO saas_immobilier.payment_decision_log
      (declaration_id, agency_id, action, from_status, to_status, actor_id,
       actor_kind, actor_label, amount, note)
    VALUES (v_dec.id, v_dec.agency_id, 'correction_requested', 'pending',
            'correction_requested', auth.uid(), 'platform_admin', v_admin_label,
            v_dec.amount, v_note);

    PERFORM saas_immobilier.notify_agency(
      v_dec.agency_id, 'billing',
      'Correction demandee sur votre paiement',
      'L administrateur demande une correction sur la demande ' ||
        COALESCE(v_dec.reference, '') || ' : ' || v_note,
      jsonb_build_object('declaration_id', v_dec.id, 'reference', v_dec.reference,
                         'status', 'correction_requested', 'kind', 'payment_correction',
                         'reason', v_note),
      'correction_' || v_dec.id::text
    );

    RETURN jsonb_build_object(
      'decision', 'correction_requested', 'id', v_dec.id, 'reference', v_dec.reference,
      'status', 'correction_requested', 'note', v_note, 'subscription_changed', false);
  END IF;

  v_amount := v_dec.amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'montant declare invalide' USING ERRCODE = '22023';
  END IF;
  IF v_dec.expected_amount IS NOT NULL AND v_amount <> v_dec.expected_amount THEN
    RAISE EXCEPTION 'montant declare (%) different du montant attendu (%)',
      v_amount, v_dec.expected_amount USING ERRCODE = '22023';
  END IF;

  IF v_dec.transaction_reference_norm IS NOT NULL
     AND v_dec.transaction_reference_norm <> '' THEN
    IF EXISTS (
      SELECT 1 FROM saas_immobilier.payment_declarations d
       WHERE d.transaction_reference_norm = v_dec.transaction_reference_norm
         AND d.status = 'approved'
         AND d.id <> v_dec.id
    ) THEN
      RAISE EXCEPTION 'cette reference de transaction a deja valide un autre paiement'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  SELECT p.* INTO v_plan FROM saas_immobilier.plans p WHERE p.id = v_dec.plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable pour cette demande' USING ERRCODE = 'P0002';
  END IF;
  v_months := GREATEST(COALESCE(v_dec.duration_months, 1), 1);

  SELECT s.* INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = v_dec.agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END, s.created_at DESC
   LIMIT 1
     FOR UPDATE;

  v_prev_end  := v_sub.ends_at;
  v_plan_from := v_sub.plan_id;

  IF v_sub.id IS NULL THEN
    v_start := CURRENT_DATE::timestamptz;
    v_end   := (CURRENT_DATE + (v_months || ' month')::interval)::timestamptz;
    INSERT INTO saas_immobilier.agency_subscriptions
      (agency_id, plan_id, status, starts_at, ends_at)
    VALUES (v_dec.agency_id, v_plan.id, 'active', v_start, v_end)
    RETURNING id INTO v_new_sub_id;
    SELECT s.* INTO v_sub FROM saas_immobilier.agency_subscriptions s WHERE s.id = v_new_sub_id;
  ELSE
    IF v_sub.ends_at IS NOT NULL AND v_sub.ends_at > now() THEN
      v_start := v_sub.ends_at;
    ELSE
      v_start := now();
    END IF;
    v_end := v_start + (v_months || ' month')::interval;

    UPDATE saas_immobilier.agency_subscriptions s
       SET plan_id       = v_plan.id,
           status        = 'active',
           ends_at       = v_end,
           trial_ends_at = NULL,
           updated_at    = now()
     WHERE s.id = v_sub.id;
  END IF;

  INSERT INTO saas_immobilier.subscription_payments (
    agency_id, subscription_id, plan_id, amount, currency, paid_at,
    period_start, period_end, method, recorded_by, note, reference,
    declaration_id, entry_kind
  ) VALUES (
    v_dec.agency_id, v_sub.id, v_plan.id, v_amount,
    COALESCE(v_dec.currency, v_plan.currency, 'XOF'),
    COALESCE(v_dec.paid_on, CURRENT_DATE),
    v_start::date, v_end::date,
    COALESCE(v_dec.method, 'manual'), auth.uid(),
    COALESCE(v_note, 'Paiement valide par administrateur'),
    v_dec.transaction_reference, v_dec.id, 'payment'
  ) RETURNING id INTO v_payment;

  UPDATE saas_immobilier.payment_declarations d
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         review_note = v_note, payment_id = v_payment,
         expected_amount = COALESCE(d.expected_amount, v_amount)
   WHERE d.id = v_dec.id;

  UPDATE saas_immobilier.agencies a
     SET status = 'active'
   WHERE a.id = v_dec.agency_id AND a.status = 'pending';

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    payment_id, amount, reference, reason, actor_id
  ) VALUES (
    v_dec.agency_id, 'payment_validated', v_plan_from, v_plan.id, v_plan_from_name,
    COALESCE(v_plan.display_name, v_plan.name), v_payment, v_amount,
    v_dec.transaction_reference,
    'Paiement manuel valide - demande ' || COALESCE(v_dec.reference, ''), auth.uid()
  );

  INSERT INTO saas_immobilier.activity_log
    (agency_id, user_id, action, entity_type, entity_id, summary)
  VALUES (
    v_dec.agency_id, auth.uid(), 'payment_approved', 'payment_declarations', v_dec.id,
    'Paiement valide : ' || v_amount || ' ' || COALESCE(v_dec.currency, 'XOF') ||
    ' (' || COALESCE(v_dec.reference, '') || ') - abonnement ' ||
    COALESCE(v_plan.display_name, v_plan.name) || ' jusqu au ' ||
    to_char(v_end, 'DD/MM/YYYY')
  );

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id,
     actor_kind, actor_label, amount, note)
  VALUES (v_dec.id, v_dec.agency_id, 'approved', 'pending', 'approved', auth.uid(),
          'platform_admin', v_admin_label, v_amount, v_note);

  PERFORM saas_immobilier.notify_agency(
    v_dec.agency_id, 'billing',
    'Paiement valide - abonnement active',
    'Votre paiement de ' || v_amount || ' ' || COALESCE(v_dec.currency, 'XOF') ||
      ' a ete verifie. L offre ' || COALESCE(v_plan.display_name, v_plan.name) ||
      ' est active jusqu au ' || to_char(v_end, 'DD/MM/YYYY') || '.',
    jsonb_build_object('declaration_id', v_dec.id, 'reference', v_dec.reference,
                       'status', 'approved', 'kind', 'payment_approved',
                       'ends_at', v_end),
    'approved_' || v_dec.id::text
  );

  RETURN jsonb_build_object(
    'decision', 'approved',
    'id', v_dec.id,
    'reference', v_dec.reference,
    'status', 'approved',
    'payment_id', v_payment,
    'subscription_id', v_sub.id,
    'plan_id', v_plan.id,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name),
    'amount', v_amount,
    'currency', COALESCE(v_dec.currency, v_plan.currency, 'XOF'),
    'previous_ends_at', v_prev_end,
    'starts_at', v_start,
    'ends_at', v_end,
    'duration_months', v_months,
    'subscription_changed', true
  );
END
$function$;
