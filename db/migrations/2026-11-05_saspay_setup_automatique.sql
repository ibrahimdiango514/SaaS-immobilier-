-- =============================================================================
-- SASPAY — PHASE 2 : LE PAIEMENT DE CREATION (« setup ») NE PLUS ATTENDRE
--                    DE VALIDATION ADMINISTRATEUR
-- Projet : xbuuhfwobrafcbgtdgjx    schema saas_immobilier, RPC dans public
-- Date   : 2026-11-05
-- Retour : db/rollback/2026-11-05_saspay_setup_automatique_rollback.sql
-- =============================================================================
-- REGLE SUPPRIMEE
--   Avant : un paiement `setup` (frais d'installation + premier mois) etait
--   marque « paye », puis laisse en attente : la fonction renvoyait
--   requires_admin_validation = true, ne creait aucun abonnement et n'ecrivait
--   aucun encaissement. Un administrateur devait activer l'agence a la main.
--   Apres : des que SasPay confirme le paiement, l'agence est activee et son
--   abonnement est cree (ou bascule en actif) dans la meme transaction.
--   Aucune intervention humaine.
--
-- POURQUOI NE PAS APPELER admin_assign_plan
--   Elle exige is_platform_admin(), qui lit auth.uid(). Cote webhook,
--   auth.role() vaut 'service_role' et auth.uid() est NULL : la garde
--   refuserait. L'activation est donc ecrite ici, en autonome, avec exactement
--   les memes effets que la branche `renewal` (deja automatique).
--
-- EFFETS D'UN PAIEMENT setup CONFIRME
--   1. agence `pending` -> `active` (et `suspended` pour impaye -> `active`) ;
--   2. abonnement cree s'il manque, sinon bascule sur l'offre payee en `active` ;
--   3. echeance = la plus lointaine entre (fin d'essai, echeance en cours,
--      aujourd'hui) + 1 mois — jamais de raccourcissement, et un essai en cours
--      n'est pas ampute du mois paye ;
--   4. encaissement ecrit dans subscription_payments (method 'saspay') ;
--   5. evenement journalise dans subscription_events ('activation') ;
--   6. notification au proprietaire de l'agence.
--
-- MONTANT
--   Jamais recalcule ici : il a ete fixe cote base par saspay_create_checkout
--   (frais d'installation + premier mois) et verifie par la barriere d'ecart
--   en entree de fonction.
--
-- IDEMPOTENCE INCHANGEE
--   Un paiement deja `paid` n'est jamais retraite (controle en entree de
--   fonction). Une seule session ouverte par portee empeche les doublons.
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
  v_plan_id   uuid;
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
  -- Activation AUTOMATIQUE de l'agence des le paiement confirme.
  -- Ancienne regle (validation administrateur) : SUPPRIMEE le 2026-11-05.
  IF v_row.purpose = 'setup' THEN
    SELECT a.id, a.name, a.status, a.pending_plan_id, a.suspended_reason
      INTO v_agency
      FROM saas_immobilier.agencies a WHERE a.id = v_row.agency_id FOR UPDATE;

    IF v_agency.id IS NULL THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'agence_introuvable_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    -- Offre a activer : celle du paiement, sinon celle demandee a l'inscription,
    -- sinon l'offre la moins chere du catalogue.
    v_plan_id := v_row.plan_id;
    IF v_plan_id IS NULL THEN v_plan_id := v_agency.pending_plan_id; END IF;
    IF v_plan_id IS NULL THEN
      SELECT pl.id INTO v_plan_id FROM saas_immobilier.plans pl ORDER BY pl.price_monthly ASC LIMIT 1;
    END IF;

    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
      INTO v_plan
      FROM saas_immobilier.plans pl WHERE pl.id = v_plan_id;

    IF v_plan.id IS NULL THEN
      UPDATE saas_immobilier.online_payments
         SET status = 'paid', paid_at = now(), reconciled_at = now(),
             paid_amount = v_amount,
             transaction_id = COALESCE(p_transaction_id, transaction_id),
             transaction_reference = COALESCE(p_transaction_reference, transaction_reference),
             fail_reason = 'offre_introuvable_a_revoir',
             updated_at = now()
       WHERE id = v_row.id;
      RETURN jsonb_build_object('found', true, 'payment_id', v_row.id, 'status', 'paid',
                                'needs_attention', true, 'effects_applied', false);
    END IF;

    -- Abonnement existant ou a creer.
    SELECT s.id, s.plan_id, s.status, s.ends_at, s.trial_ends_at
      INTO v_sub
      FROM saas_immobilier.agency_subscriptions s
     WHERE s.agency_id = v_row.agency_id
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                            WHEN 'past_due' THEN 2 WHEN 'expired' THEN 3 ELSE 4 END,
              s.created_at DESC
     LIMIT 1
     FOR UPDATE;

    -- Echeance : la plus lointaine entre la fin d'essai, l'echeance en cours et
    -- aujourd'hui, + 1 mois. Meme regle que le renouvellement : on n'ampute
    -- jamais une periode deja payee, et les jours d'essai ne sont pas perdus.
    v_end := (GREATEST(
                COALESCE(v_sub.ends_at::date, CURRENT_DATE),
                COALESCE(v_sub.trial_ends_at::date, CURRENT_DATE),
                CURRENT_DATE
              ) + interval '1 month')::date;

    IF v_sub.id IS NULL THEN
      INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at, ends_at, trial_ends_at)
      VALUES (v_row.agency_id, v_plan.id, 'active', now(), v_end, NULL)
      RETURNING id INTO v_sub.id;
    ELSE
      UPDATE saas_immobilier.agency_subscriptions
         SET plan_id = v_plan.id, status = 'active', ends_at = v_end,
             trial_ends_at = NULL, updated_at = now()
       WHERE id = v_sub.id;
    END IF;

    -- Activation de l'agence. Une suspension pour impaye est levee ; une
    -- suspension decidee par un administrateur (autre motif) ne l'est pas.
    IF v_agency.status = 'pending' THEN
      UPDATE saas_immobilier.agencies
         SET status = 'active', pending_note = NULL, pending_updated_at = now(),
             suspended_at = NULL, suspended_reason = NULL, updated_at = now()
       WHERE id = v_row.agency_id;
    ELSIF v_agency.status = 'suspended' AND COALESCE(v_agency.suspended_reason, 'unpaid') = 'unpaid' THEN
      UPDATE saas_immobilier.agencies
         SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
       WHERE id = v_row.agency_id;
    END IF;

    v_ref := 'SASPAY-' || left(replace(v_row.id::text, '-', ''), 12)
             || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

    INSERT INTO saas_immobilier.subscription_payments (
      agency_id, subscription_id, plan_id, amount, currency, paid_at,
      period_start, period_end, method, recorded_by, note, reference,
      entry_kind, provider, provider_reference, provider_status, online_payment_id
    ) VALUES (
      v_row.agency_id, v_sub.id, v_plan.id, v_amount,
      COALESCE(v_row.currency, 'XOF'), CURRENT_DATE,
      CURRENT_DATE, v_end - 1, 'saspay', NULL,
      'Installation et premier mois payes en ligne (SasPay)', v_ref,
      'payment', 'saspay', COALESCE(p_transaction_reference, p_transaction_id::text),
      'SUCCESS', v_row.id
    ) RETURNING id INTO v_payment;

    INSERT INTO saas_immobilier.subscription_events (
      agency_id, event_type, plan_to_id, plan_to_name, mensualite_to,
      payment_id, amount, reference, reason, actor_id
    ) VALUES (
      v_row.agency_id, 'activation', v_plan.id,
      COALESCE(v_plan.display_name, v_plan.name), COALESCE(v_plan.price_monthly, 0),
      v_payment, v_amount, v_ref,
      'Activation automatique apres paiement en ligne (SasPay)', NULL
    ) RETURNING id INTO v_event;

    SELECT am.user_id INTO v_owner
      FROM saas_immobilier.agency_members am
     WHERE am.agency_id = v_row.agency_id AND am.role = 'owner' AND am.status = 'active'
     ORDER BY am.created_at ASC LIMIT 1;
    IF v_owner IS NOT NULL THEN
      INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
      VALUES (v_row.agency_id, v_owner, 'system',
              'Agence activee',
              'Votre paiement a ete recu. Votre agence est active jusqu''au '
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
      'status', 'paid', 'purpose', 'setup',
      'payment_row_id', v_payment, 'subscription_id', v_sub.id,
      'ends_at', v_end, 'event_id', v_event,
      'agency_activated', true, 'requires_admin_validation', false,
      'effects_applied', true, 'needs_attention', false
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
