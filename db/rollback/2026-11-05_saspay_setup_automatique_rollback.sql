-- =============================================================================
-- RETOUR ARRIERE — remet la validation administrateur sur le paiement `setup`
-- =============================================================================
-- Annule db/migrations/2026-11-05_saspay_setup_automatique.sql :
-- un paiement `setup` confirme repasse en attente de validation administrateur
-- (requires_admin_validation = true) et n'active plus l'agence.
-- A n'utiliser que si l'activation automatique doit etre annulee.
-- Les agences deja activees par la nouvelle regle restent activees : ce script
-- ne modifie aucune donnee, seulement le comportement de la fonction.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.saspay_confirm_payment(p_payment_id uuid DEFAULT NULL::uuid, p_session_id uuid DEFAULT NULL::uuid, p_outcome text DEFAULT 'paid'::text, p_transaction_id uuid DEFAULT NULL::uuid, p_transaction_reference text DEFAULT NULL::text, p_requested_amount numeric DEFAULT NULL::numeric, p_fail_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_row       record;
  v_outcome   text := CASE WHEN p_outcome = 'paid' THEN 'paid' ELSE 'failed' END;
  v_reason    text := NULLIF(btrim(COALESCE(p_fail_reason, '')), '');
  v_sub       record;
  v_plan      record;
  v_agency    record;
  v_invoice   record;
  v_payment   uuid;
  v_ref       text;
  v_end       date;
  v_event     uuid;
  v_owner     uuid;
  v_amount    numeric;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;
  IF p_payment_id IS NULL AND p_session_id IS NULL THEN
    RAISE EXCEPTION 'payment_id ou session_id obligatoire' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM saas_immobilier.online_payments
   WHERE (p_payment_id IS NOT NULL AND id = p_payment_id)
      OR (p_payment_id IS NULL AND checkout_session_id = p_session_id)
   FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  -- Idempotence : deja paye = rien a faire, jamais de retraitement.
  IF v_row.status = 'paid' THEN
    RETURN jsonb_build_object(
      'found', true, 'already_processed', true, 'payment_id', v_row.id,
      'status', 'paid', 'amount', v_row.amount, 'effects_applied', false
    );
  END IF;

  -- Barriere 5 : le montant annonce par SasPay doit correspondre au montant
  -- attendu. Un ecart signale un ecarter de comptabilite : aucun credit.
  IF v_outcome = 'paid'
     AND p_requested_amount IS NOT NULL
     AND abs(p_requested_amount - v_row.amount) > 0.005 THEN
    v_outcome := 'failed';
    v_reason  := 'amount_mismatch_expected_' || v_row.amount::text
                 || '_got_' || p_requested_amount::text;
  END IF;

  IF v_outcome = 'failed' THEN
    UPDATE saas_immobilier.online_payments
       SET status = 'failed',
           fail_reason = COALESCE(v_reason, 'echec signale par SasPay'),
           transaction_id = COALESCE(p_transaction_id, transaction_id),
           transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
           updated_at = now()
     WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'found', true, 'already_processed', false, 'payment_id', v_row.id,
      'status', 'failed', 'fail_reason', COALESCE(v_reason, 'echec signale par SasPay'),
      'effects_applied', false
    );
  END IF;

  -- ------------------------------------------------------------------ PAID
  v_amount := v_row.amount;

  -- --------------------------------------------------------------- setup
  IF v_row.purpose = 'setup' THEN
    SELECT a.id, a.name, a.status INTO v_agency
      FROM saas_immobilier.agencies a WHERE a.id = v_row.agency_id FOR UPDATE;

    IF v_agency.id IS NULL THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'agence_introuvable_admin_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    -- Aucun encaissement ici : l'activation (et l'ecriture d'encaisse) reste
    -- une validation administrateur - regle metier existante conservee.
    UPDATE saas_immobilier.online_payments
       SET status = 'paid', paid_at = now(), reconciled_at = CASE
             WHEN v_agency.status = 'pending' THEN NULL ELSE now() END,
           paid_amount = v_amount,
           transaction_id = COALESCE(p_transaction_id, transaction_id),
           transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
           fail_reason = CASE WHEN v_agency.status = 'pending' THEN fail_reason
                              ELSE 'agence_deja_activee_admin_a_revoir' END,
           updated_at = now()
     WHERE id = v_row.id;

    RETURN jsonb_build_object(
      'found', true, 'already_processed', false, 'payment_id', v_row.id,
      'status', 'paid', 'purpose', 'setup',
      'requires_admin_validation', v_agency.status = 'pending',
      'needs_attention', v_agency.status <> 'pending',
      'effects_applied', false
    );
  END IF;

  -- ------------------------------------------------------------ renewal
  IF v_row.purpose = 'renewal' THEN
    SELECT s.id, s.plan_id, s.status, s.ends_at, s.trial_ends_at
      INTO v_sub
      FROM saas_immobilier.agency_subscriptions s
     WHERE s.agency_id = v_row.agency_id
       AND s.status IN ('active', 'trial', 'past_due', 'expired', 'cancelled')
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                            WHEN 'past_due' THEN 2 WHEN 'expired' THEN 3 ELSE 4 END,
              s.created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF v_sub.id IS NULL THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'aucun_abonnement_admin_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    -- Abonnement annule par un administrateur : l'argent est recu mais on ne
    -- relance pas un abonnement que l'on a voulu arreter. A revoir en main.
    IF v_sub.status = 'cancelled' THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'abonnement_annule_admin_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.currency
      INTO v_plan
      FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;

    -- Meme regle que review_payment_declaration : on part de l'echeance la
    -- plus lointaine (aujourd'hui ou l'echeance existante) + 1 mois. Jamais de
    -- raccourcissement, jamais de mois gagne deux fois.
    v_end := (GREATEST(COALESCE(v_sub.ends_at::date, CURRENT_DATE), CURRENT_DATE)
              + interval '1 month')::date;

    v_ref := 'SASPAY-' || left(replace(v_row.id::text, '-', ''), 12)
             || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

    INSERT INTO saas_immobilier.subscription_payments (
      agency_id, subscription_id, plan_id, amount, currency, paid_at,
      period_start, period_end, method, recorded_by, note, reference,
      entry_kind, provider, provider_reference, provider_status, online_payment_id
    ) VALUES (
      v_row.agency_id, v_sub.id, v_sub.plan_id, v_amount,
      COALESCE(v_row.currency, 'XOF'), CURRENT_DATE,
      CURRENT_DATE, v_end - 1, 'saspay', NULL,
      'Abonnement mensuel paye en ligne (SasPay)', v_ref,
      'payment', 'saspay', COALESCE(p_transaction_reference, p_transaction_id::text),
      'SUCCESS', v_row.id
    ) RETURNING id INTO v_payment;

    UPDATE saas_immobilier.agency_subscriptions
       SET ends_at = v_end,
           status = CASE
             WHEN status IN ('past_due', 'expired') THEN 'active'
             WHEN status = 'trial' AND NOT COALESCE(trial_ends_at > now(), false) THEN 'active'
             ELSE status
           END,
           trial_ends_at = CASE WHEN status = 'trial'
                                 AND NOT COALESCE(trial_ends_at > now(), false)
                                THEN NULL ELSE trial_ends_at END,
           updated_at = now()
     WHERE id = v_sub.id;

    -- Suspension pour impaye : un paiement confirme reactive, comme le fait
    -- deja review_payment_declaration pour le paiement manuel.
    SELECT a.id, a.name, a.status, a.suspended_reason INTO v_agency
      FROM saas_immobilier.agencies a WHERE a.id = v_row.agency_id FOR UPDATE;
    IF v_agency.status = 'suspended' AND COALESCE(v_agency.suspended_reason, 'unpaid') = 'unpaid' THEN
      UPDATE saas_immobilier.agencies
         SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
       WHERE id = v_row.agency_id;
    END IF;

    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_to_id, plan_to_name, mensualite_variation,
      payment_id, amount, reference, reason, actor_id
    ) VALUES (
      v_row.agency_id, 'payment_validated', v_sub.plan_id,
      COALESCE(v_plan.display_name, v_plan.name), 0,
      v_payment, v_amount, v_ref,
      'Renouvellement paye en ligne (SasPay)', NULL
    ) RETURNING id INTO v_event;

    SELECT am.user_id INTO v_owner
      FROM saas_immobilier.agency_members am
     WHERE am.agency_id = v_row.agency_id AND am.role = 'owner' AND am.status = 'active'
     ORDER BY am.created_at ASC LIMIT 1;
    IF v_owner IS NOT NULL THEN
      INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
      VALUES (v_row.agency_id, v_owner, 'system',
              'Paiement recu',
              'Abonnement paye en ligne. Votre offre est active jusqu''au '
                || to_char(v_end, 'DD/MM/YYYY') || '.',
              jsonb_build_object('online_payment_id', v_row.id, 'ends_at', v_end));
    END IF;

    UPDATE saas_immobilier.online_payments
       SET status = 'paid', paid_at = now(), reconciled_at = now(),
           paid_amount = v_amount, subscription_id = v_sub.id,
           transaction_id = COALESCE(p_transaction_id, transaction_id),
           transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
           updated_at = now()
     WHERE id = v_row.id;

    RETURN jsonb_build_object(
      'found', true, 'already_processed', false, 'payment_id', v_row.id,
      'status', 'paid', 'purpose', 'renewal',
      'payment_row_id', v_payment, 'ends_at', v_end,
      'event_id', v_event, 'effects_applied', true, 'needs_attention', false
    );
  END IF;

  -- ------------------------------------------------------------- invoice
  IF v_row.purpose = 'invoice' THEN
    SELECT * INTO v_invoice
      FROM saas_immobilier.subscription_invoices i
     WHERE i.id = v_row.invoice_id
     FOR UPDATE;
    IF v_invoice.id IS NULL THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'facture_introuvable_admin_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    -- Facture deja payee entre temps (validation admin parallele) : l'argent
    -- est recu mais la facture est deja soldee. A rapprocher / rembourser.
    IF v_invoice.status <> 'pending' THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'facture_deja_' || v_invoice.status || '_admin_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    v_ref := 'SASPAY-' || left(replace(v_row.id::text, '-', ''), 12)
             || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

    SELECT s.id INTO v_sub
      FROM saas_immobilier.agency_subscriptions s
     WHERE s.agency_id = v_row.agency_id
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                            WHEN 'past_due' THEN 2 ELSE 3 END,
              s.created_at DESC
     LIMIT 1
     FOR UPDATE;

    INSERT INTO saas_immobilier.subscription_payments (
      agency_id, subscription_id, plan_id, amount, currency, paid_at,
      period_start, period_end, method, recorded_by, note, reference,
      entry_kind, invoice_id, provider, provider_reference, provider_status,
      online_payment_id
    ) VALUES (
      v_row.agency_id, v_sub.id, v_invoice.plan_to_id, v_amount,
      COALESCE(v_invoice.currency, 'XOF'), CURRENT_DATE,
      CURRENT_DATE, NULL, 'saspay', NULL,
      'Facture reglee en ligne (SasPay)', v_ref,
      'payment', v_invoice.id, 'saspay',
      COALESCE(p_transaction_reference, p_transaction_id::text), 'SUCCESS', v_row.id
    ) RETURNING id INTO v_payment;

    UPDATE saas_immobilier.subscription_invoices
       SET status = 'paid', paid_at = now(), paid_payment_id = v_payment
     WHERE id = v_invoice.id;

    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_to_id, plan_to_name, mensualite_variation,
      invoice_id, payment_id, amount, reference, reason, actor_id
    ) VALUES (
      v_row.agency_id, 'payment_validated', v_invoice.plan_to_id, v_invoice.plan_to_name,
      0, v_invoice.id, v_payment, v_amount, v_ref,
      'Facture reglee en ligne (SasPay)', NULL
    ) RETURNING id INTO v_event;

    UPDATE saas_immobilier.online_payments
       SET status = 'paid', paid_at = now(), reconciled_at = now(),
           paid_amount = v_amount, subscription_id = v_sub.id,
           transaction_id = COALESCE(p_transaction_id, transaction_id),
           transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
           updated_at = now()
     WHERE id = v_row.id;

    RETURN jsonb_build_object(
      'found', true, 'already_processed', false, 'payment_id', v_row.id,
      'status', 'paid', 'purpose', 'invoice',
      'payment_row_id', v_payment, 'invoice_id', v_invoice.id,
      'event_id', v_event, 'effects_applied', true, 'needs_attention', false
    );
  END IF;

  RAISE EXCEPTION 'objectif inconnu : %', v_row.purpose USING ERRCODE = '22023';
END
$function$;
