-- =============================================================================
-- CORRECTIF - public.admin_validate_payment
-- Projet : xbuuhfwobrafcbgtdgjx
-- Date   : 2026-10-26
--
-- BUG : « valider une facture en attente » echouait avec
--       ERROR 55000: record "v_plan" is not assigned yet
--
-- CAUSE : la fonction declaraient des variables de type `record` (v_plan,
-- v_invoice). Quand le front validait une facture, il n'envoyait pas
-- p_plan_id : v_plan n'etait donc jamais affectee. La moindre lecture d'un
-- champ (v_plan.name pour construire la reference) levait 55000. Le meme
-- defaut menacait v_invoice quand aucun p_invoice_id n'etait fourni.
--
-- CORRECTIF : plus aucune variable `record` non initialisee. Les champs utiles
-- sont lus dans des variables scalaires initialisees a NULL, et l'offre est
-- resolue explicitement : p_plan_id, sinon l'offre visee par la facture.
--
-- Comportement inchange par ailleurs : la fonction reste la seule voie
-- d'augmentation de l'encaisse, elle enregistre auteur et date d'office, et
-- elle fait passer la facture a « payee » quand p_invoice_id est fourni.
-- Aucune autre fonction, aucune RLS n'est touchee.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_validate_payment(
  p_agency_id  uuid,
  p_plan_id    uuid DEFAULT NULL,
  p_amount     numeric DEFAULT NULL,
  p_paid_on    date DEFAULT CURRENT_DATE,
  p_reference  text DEFAULT NULL,
  p_note       text DEFAULT NULL,
  p_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_plan_id        uuid;
  v_plan_name      text;
  v_plan_display   text;
  v_currency       text := 'XOF';
  v_sub_id         uuid;
  v_amount         numeric;
  v_payment        uuid;
  v_ref            text;
  v_invoice_status text;
  v_invoice_amount numeric;
  v_invoice_plan   uuid;
  v_event          uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT i.status, i.amount, i.plan_to_id
      INTO v_invoice_status, v_invoice_amount, v_invoice_plan
      FROM saas_immobilier.subscription_invoices i
     WHERE i.id = p_invoice_id
       FOR UPDATE;

    IF v_invoice_status IS NULL THEN
      RAISE EXCEPTION 'facture introuvable' USING ERRCODE = 'P0002';
    END IF;
    IF v_invoice_status <> 'pending' THEN
      RAISE EXCEPTION 'facture deja traitee (statut : %)', v_invoice_status USING ERRCODE = '22023';
    END IF;
    v_amount := COALESCE(p_amount, v_invoice_amount);
  ELSE
    v_amount := p_amount;
  END IF;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;

  -- Offre : celle demandee, sinon celle visee par la facture.
  v_plan_id := COALESCE(p_plan_id, v_invoice_plan);
  IF v_plan_id IS NOT NULL THEN
    SELECT pl.name, pl.display_name, pl.currency
      INTO v_plan_name, v_plan_display, v_currency
      FROM saas_immobilier.plans pl
     WHERE pl.id = v_plan_id;
  END IF;

  SELECT s.id INTO v_sub_id
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1;

  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = 'P0002';
  END IF;

  v_ref := COALESCE(NULLIF(btrim(p_reference), ''),
                    public.subscription_reference(p_agency_id,
                                                  COALESCE(v_plan_name, 'PAIEMENT'),
                                                  'ADMIN'));

  INSERT INTO saas_immobilier.subscription_payments (
    agency_id, subscription_id, plan_id, amount, currency, paid_at,
    period_start, period_end, method, recorded_by, note, reference,
    entry_kind, invoice_id
  ) VALUES (
    p_agency_id, v_sub_id, v_plan_id, v_amount, COALESCE(v_currency, 'XOF'),
    COALESCE(p_paid_on, CURRENT_DATE),
    COALESCE(p_paid_on, CURRENT_DATE),
    (COALESCE(p_paid_on, CURRENT_DATE) + interval '1 month' - interval '1 day')::date,
    'admin_validation', auth.uid(),
    COALESCE(p_note, 'Paiement valide par administrateur'), v_ref,
    'payment', p_invoice_id
  ) RETURNING id INTO v_payment;

  IF p_invoice_id IS NOT NULL THEN
    UPDATE saas_immobilier.subscription_invoices
       SET status = 'paid', paid_at = now(), paid_payment_id = v_payment
     WHERE id = p_invoice_id;
  END IF;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, plan_to_name, mensualite_variation,
    invoice_id, payment_id, amount, reference, reason, actor_id
  ) VALUES (
    p_agency_id, 'payment_validated', v_plan_id,
    COALESCE(v_plan_display, v_plan_name),
    0, p_invoice_id, v_payment, v_amount, v_ref,
    COALESCE(p_note, 'Paiement valide par administrateur'), auth.uid()
  ) RETURNING id INTO v_event;

  RETURN jsonb_build_object(
    'payment_id', v_payment,
    'amount', v_amount,
    'reference', v_ref,
    'invoice_id', p_invoice_id,
    'plan_id', v_plan_id,
    'event_id', v_event
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_validate_payment(uuid, uuid, numeric, date, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_validate_payment(uuid, uuid, numeric, date, text, text, uuid)
  TO authenticated, service_role;

COMMIT;
