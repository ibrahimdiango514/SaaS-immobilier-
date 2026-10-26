-- =============================================================================
-- SESSION 5 - FACTURATION, JOURNAL ET MENSUALITE (appliquee en une transaction)
-- Projet : xbuuhfwobrafcbgtdgjx  schema saas_immobilier, RPC dans public
-- Date   : 2026-10-26
--
-- PRINCIPES
-- * Mensualite = somme des prix des offres actives. Mesure instantanee.
-- * Encaisse   = paiements valides par un administrateur, NET des ecritures
--                contraires. La preuve n'est pas obligatoire.
-- * Facture en attente = montant du sur changement d'offre. Hors encaisse.
-- * Aucune ligne supprimee, aucune fonction existante supprimee.
-- * admin_assign_plan et review_payment_declaration ne sont PAS modifiees.
-- * admin_activate_agency n'est PAS redirigee : c'est la primitive interne.
--
-- NOTE TECHNIQUE - ECRITURE COMPENSATOIRE
-- subscription_payments porte CHECK (amount >= 0). Une ligne negative est donc
-- impossible, et retirer cette contrainte fragiliserait une table financiere.
-- On ajoute donc entry_kind ('payment' | 'reversal') : une ecriture contraire
-- porte un montant POSITIF et se SOUSTRAIT dans les sommes. L'original reste
-- visible, la contrainte reste en place, rien n'est supprime.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. subscription_invoices - factures en attente
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.subscription_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  plan_from_id          uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_to_id            uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_from_name        text,
  plan_to_name          text,
  amount                numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency              text NOT NULL DEFAULT 'XOF',
  prorata_applied       boolean NOT NULL DEFAULT false,
  prorata_days          integer,
  prorata_days_in_month integer,
  period_start          date,
  period_end            date,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'cancelled')),
  reference             text UNIQUE,
  note                  text,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  paid_payment_id       uuid REFERENCES saas_immobilier.subscription_payments(id) ON DELETE SET NULL,
  source_payment_id     uuid REFERENCES saas_immobilier.subscription_payments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS subscription_invoices_agency_idx
  ON saas_immobilier.subscription_invoices (agency_id);
CREATE INDEX IF NOT EXISTS subscription_invoices_status_idx
  ON saas_immobilier.subscription_invoices (status);

-- -----------------------------------------------------------------------------
-- 2. subscription_events - journal dedie
-- -----------------------------------------------------------------------------
-- plan_from / plan_to sont enregistres EXPLICITEMENT a chaque evenement.
-- Aucune deduction par lag(). Pour l'historique anterieur au journal, l'offre
-- de depart vaut NULL et la variation aussi : on ne l'invente pas.
CREATE TABLE IF NOT EXISTS saas_immobilier.subscription_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id            uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  event_type           text NOT NULL CHECK (event_type IN (
                         'activation', 'plan_change', 'suspension',
                         'reactivation', 'payment_validated', 'payment_reclassified')),
  plan_from_id         uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_to_id           uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_from_name       text,
  plan_to_name         text,
  mensualite_from      numeric,
  mensualite_to        numeric,
  mensualite_variation numeric,
  invoice_id           uuid REFERENCES saas_immobilier.subscription_invoices(id) ON DELETE SET NULL,
  payment_id           uuid REFERENCES saas_immobilier.subscription_payments(id) ON DELETE SET NULL,
  amount               numeric,
  reference            text,
  reason               text,
  actor_id             uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_events_agency_idx
  ON saas_immobilier.subscription_events (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_events_created_idx
  ON saas_immobilier.subscription_events (created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. subscription_payments - ecritures contraires et lien facture
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS entry_kind text NOT NULL DEFAULT 'payment';
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS reversal_of uuid REFERENCES saas_immobilier.subscription_payments(id) ON DELETE RESTRICT;
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES saas_immobilier.subscription_invoices(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'subscription_payments_entry_kind_check'
       AND conrelid = 'saas_immobilier.subscription_payments'::regclass
  ) THEN
    ALTER TABLE saas_immobilier.subscription_payments
      ADD CONSTRAINT subscription_payments_entry_kind_check
      CHECK (entry_kind IN ('payment', 'reversal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS subscription_payments_entry_kind_idx
  ON saas_immobilier.subscription_payments (entry_kind);

-- -----------------------------------------------------------------------------
-- 4. Prorata - calcule en SQL, jamais dans le front
-- -----------------------------------------------------------------------------
-- Retourne la fraction du mois restant a partir de p_effective_on, incluse.
-- Exemple : changement le 26 octobre (31 jours) -> 6 jours restants, 6/31.
CREATE OR REPLACE FUNCTION public.subscription_prorata(
  p_amount       numeric,
  p_effective_on date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_day     date := COALESCE(p_effective_on, CURRENT_DATE);
  v_start   date := date_trunc('month', COALESCE(p_effective_on, CURRENT_DATE))::date;
  v_next    date := (date_trunc('month', COALESCE(p_effective_on, CURRENT_DATE)) + interval '1 month')::date;
  v_days    integer := ((date_trunc('month', COALESCE(p_effective_on, CURRENT_DATE)) + interval '1 month')::date
                        - date_trunc('month', COALESCE(p_effective_on, CURRENT_DATE))::date);
  v_left    integer := ((date_trunc('month', COALESCE(p_effective_on, CURRENT_DATE)) + interval '1 month')::date - v_day);
  v_ratio   numeric;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;
  IF v_days <= 0 THEN
    RAISE EXCEPTION 'mois invalide' USING ERRCODE = '22023';
  END IF;
  IF v_left < 0 THEN v_left := 0; END IF;
  IF v_left > v_days THEN v_left := v_days; END IF;

  v_ratio := v_left::numeric / v_days::numeric;

  RETURN jsonb_build_object(
    'base_amount',     p_amount,
    'prorata_amount',  round(p_amount * v_ratio, 2),
    'days_remaining',  v_left,
    'days_in_month',   v_days,
    'ratio',           round(v_ratio, 6),
    'effective_on',    v_day,
    'month_start',     v_start,
    'month_end',       (v_next - 1)
  );
END
$fn$;

-- -----------------------------------------------------------------------------
-- 5. Reference horodatee - corrige la collision
-- -----------------------------------------------------------------------------
-- L'ancienne forme ADMIN-<AAAAMMJJ>-<agence>-<OFFRE> entrait en collision des
-- qu'une meme agence vivait deux operations le meme jour : l'idempotence
-- avalait la seconde. On ajoute l'heure, la minute et la seconde.
CREATE OR REPLACE FUNCTION public.subscription_reference(
  p_agency_id uuid,
  p_plan_name text,
  p_prefix    text DEFAULT 'ADMIN'
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $fn$
  SELECT upper(COALESCE(p_prefix, 'ADMIN'))
         || '-' || to_char(now(), 'YYYYMMDDHH24MISS')
         || '-' || left(replace(p_agency_id::text, '-', ''), 8)
         || '-' || upper(COALESCE(NULLIF(btrim(p_plan_name), ''), 'OFFRE'));
$fn$;

-- -----------------------------------------------------------------------------
-- 6. Activation journalisee (aucun encaissement cree)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_activate_agency_journaled(
  p_agency_id uuid,
  p_plan_id   uuid DEFAULT NULL,
  p_note      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_prev_plan_id uuid;
  v_prev         record;
  v_activation   jsonb;
  v_plan         record;
  v_variation    numeric;
  v_event        uuid;
  v_type         text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT s.plan_id INTO v_prev_plan_id
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1;

  IF v_prev_plan_id IS NOT NULL THEN
    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
      INTO v_prev FROM saas_immobilier.plans pl WHERE pl.id = v_prev_plan_id;
  END IF;

  -- Primitive interne, non redirigee.
  v_activation := public.admin_activate_agency(p_agency_id, p_plan_id);

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
    INTO v_plan FROM saas_immobilier.plans pl
   WHERE pl.id = (v_activation->>'plan_id')::uuid;

  v_variation := COALESCE(v_plan.price_monthly, 0) - COALESCE(v_prev.price_monthly, 0);
  v_type := CASE WHEN v_prev_plan_id IS NULL THEN 'activation' ELSE 'reactivation' END;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    mensualite_from, mensualite_to, mensualite_variation, reason, actor_id
  ) VALUES (
    p_agency_id, v_type, v_prev_plan_id, v_plan.id,
    COALESCE(v_prev.display_name, v_prev.name), COALESCE(v_plan.display_name, v_plan.name),
    v_prev.price_monthly, v_plan.price_monthly, v_variation,
    COALESCE(p_note, 'activation administrateur'), auth.uid()
  ) RETURNING id INTO v_event;

  RETURN v_activation || jsonb_build_object('event_id', v_event,
                                            'event_type', v_type,
                                            'mensualite_variation', v_variation);
END
$fn$;

-- -----------------------------------------------------------------------------
-- 7. Changement d'offre journalise + facture en attente
-- -----------------------------------------------------------------------------
-- Aucun encaissement. Une montee cree une facture au prorata, une baisse n'en
-- cree aucune. admin_assign_plan reste la primitive, inchangee.
CREATE OR REPLACE FUNCTION public.admin_change_agency_plan_journaled(
  p_agency_id    uuid,
  p_plan_id      uuid,
  p_effective_on date DEFAULT CURRENT_DATE,
  p_note         text DEFAULT NULL,
  p_reason       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_prev_plan_id uuid;
  v_prev         record;
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

  SELECT s.plan_id INTO v_prev_plan_id
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_prev_plan_id IS NOT NULL THEN
    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
      INTO v_prev FROM saas_immobilier.plans pl WHERE pl.id = v_prev_plan_id;
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
    INTO v_new FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;

  IF v_new.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_prev_plan_id IS NOT DISTINCT FROM p_plan_id THEN
    RETURN jsonb_build_object('changed', false, 'reason', 'offre inchangee');
  END IF;

  PERFORM public.admin_assign_plan(p_agency_id, p_plan_id, 'active',
                                   COALESCE(p_note, 'changement direct par administrateur'));

  v_variation := COALESCE(v_new.price_monthly, 0) - COALESCE(v_prev.price_monthly, 0);

  IF v_variation > 0 THEN
    v_prorata := public.subscription_prorata(v_variation, p_effective_on);
    v_amount  := (v_prorata->>'prorata_amount')::numeric;
    v_ref     := public.subscription_reference(p_agency_id, v_new.name, 'ADMIN');

    INSERT INTO saas_immobilier.subscription_invoices (
      agency_id, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
      amount, prorata_applied, prorata_days, prorata_days_in_month,
      period_start, period_end, status, reference, note, created_by
    ) VALUES (
      p_agency_id, v_prev_plan_id, v_new.id,
      COALESCE(v_prev.display_name, v_prev.name), COALESCE(v_new.display_name, v_new.name),
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
    COALESCE(v_prev.display_name, v_prev.name), COALESCE(v_new.display_name, v_new.name),
    v_prev.price_monthly, v_new.price_monthly, v_variation,
    v_invoice, CASE WHEN v_invoice IS NULL THEN NULL ELSE v_amount END, v_ref,
    COALESCE(p_reason, p_note,
             CASE WHEN v_variation > 0 THEN 'Montee d offre'
                  WHEN v_variation < 0 THEN 'Baisse d offre'
                  ELSE 'Changement d offre' END),
    auth.uid()
  ) RETURNING id INTO v_event;

  RETURN jsonb_build_object(
    'changed', true,
    'plan_from', COALESCE(v_prev.display_name, v_prev.name),
    'plan_to', COALESCE(v_new.display_name, v_new.name),
    'mensualite_from', COALESCE(v_prev.price_monthly, 0),
    'mensualite_to', COALESCE(v_new.price_monthly, 0),
    'mensualite_variation', v_variation,
    'invoice_id', v_invoice,
    'invoice_amount', CASE WHEN v_invoice IS NULL THEN 0 ELSE v_amount END,
    'prorata', v_prorata,
    'event_id', v_event
  );
END
$fn$;

-- -----------------------------------------------------------------------------
-- 8. Validation d'un paiement par l'admin - seule voie d'augmentation
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_validate_payment(
  p_agency_id uuid,
  p_plan_id   uuid DEFAULT NULL,
  p_amount    numeric DEFAULT NULL,
  p_paid_on   date DEFAULT CURRENT_DATE,
  p_reference text DEFAULT NULL,
  p_note      text DEFAULT NULL,
  p_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_plan      record;
  v_sub_id    uuid;
  v_amount    numeric;
  v_payment   uuid;
  v_ref       text;
  v_invoice   record;
  v_event     uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT * INTO v_invoice FROM saas_immobilier.subscription_invoices
     WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'facture introuvable' USING ERRCODE = 'P0002';
    END IF;
    IF v_invoice.status <> 'pending' THEN
      RAISE EXCEPTION 'facture deja traitee (statut : %)', v_invoice.status USING ERRCODE = '22023';
    END IF;
    v_amount := COALESCE(p_amount, v_invoice.amount);
  ELSE
    v_amount := p_amount;
  END IF;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;

  SELECT s.id INTO v_sub_id FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1;

  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = 'P0002';
  END IF;

  IF p_plan_id IS NOT NULL THEN
    SELECT pl.id, pl.name, pl.display_name, pl.currency
      INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  END IF;

  v_ref := COALESCE(NULLIF(btrim(p_reference), ''),
                    public.subscription_reference(p_agency_id,
                      COALESCE(v_plan.name, 'PAIEMENT'), 'ADMIN'));

  INSERT INTO saas_immobilier.subscription_payments (
    agency_id, subscription_id, plan_id, amount, currency, paid_at,
    period_start, period_end, method, recorded_by, note, reference,
    entry_kind, invoice_id
  ) VALUES (
    p_agency_id, v_sub_id, COALESCE(p_plan_id, v_invoice.plan_to_id), v_amount,
    COALESCE(v_plan.currency, 'XOF'), COALESCE(p_paid_on, CURRENT_DATE),
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
    p_agency_id, 'payment_validated', COALESCE(p_plan_id, v_invoice.plan_to_id),
    COALESCE(v_plan.display_name, v_plan.name),
    0, p_invoice_id, v_payment, v_amount, v_ref,
    COALESCE(p_note, 'Paiement valide par administrateur'), auth.uid()
  ) RETURNING id INTO v_event;

  RETURN jsonb_build_object(
    'payment_id', v_payment,
    'amount', v_amount,
    'reference', v_ref,
    'invoice_id', p_invoice_id,
    'event_id', v_event
  );
END
$fn$;

-- -----------------------------------------------------------------------------
-- 9. Suspension et reactivation journalisees
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_suspend_agency(
  p_agency_id uuid,
  p_reason    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub   record;
  v_plan  record;
  v_event uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 ELSE 1 END, s.created_at DESC
   LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = 'P0002';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;

  UPDATE saas_immobilier.agency_subscriptions
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_sub.id;

  UPDATE saas_immobilier.agencies
     SET status = 'suspended', suspended_at = now(),
         suspended_reason = COALESCE(p_reason, 'suspension administrateur'),
         updated_at = now()
   WHERE id = p_agency_id;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_from_name,
    mensualite_from, mensualite_to, mensualite_variation, reason, actor_id
  ) VALUES (
    p_agency_id, 'suspension', v_sub.plan_id, COALESCE(v_plan.display_name, v_plan.name),
    v_plan.price_monthly, 0, -COALESCE(v_plan.price_monthly, 0),
    COALESCE(p_reason, 'suspension administrateur'), auth.uid()
  ) RETURNING id INTO v_event;

  RETURN jsonb_build_object('suspended', true, 'event_id', v_event,
                            'mensualite_variation', -COALESCE(v_plan.price_monthly, 0));
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_reactivate_agency(
  p_agency_id uuid,
  p_reason    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub   record;
  v_plan  record;
  v_event uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sub FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence' USING ERRCODE = 'P0002';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;

  UPDATE saas_immobilier.agency_subscriptions
     SET status = 'active',
         ends_at = GREATEST(COALESCE(ends_at, CURRENT_DATE), CURRENT_DATE + interval '1 month')::date,
         trial_ends_at = NULL, updated_at = now()
   WHERE id = v_sub.id;

  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
   WHERE id = p_agency_id;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, plan_to_name,
    mensualite_from, mensualite_to, mensualite_variation, reason, actor_id
  ) VALUES (
    p_agency_id, 'reactivation', v_sub.plan_id, COALESCE(v_plan.display_name, v_plan.name),
    0, v_plan.price_monthly, COALESCE(v_plan.price_monthly, 0),
    COALESCE(p_reason, 'reactivation administrateur'), auth.uid()
  ) RETURNING id INTO v_event;

  RETURN jsonb_build_object('reactivated', true, 'event_id', v_event,
                            'mensualite_variation', COALESCE(v_plan.price_monthly, 0));
END
$fn$;

-- -----------------------------------------------------------------------------
-- 10. Redirections - admin_activate_agency N'EST PAS redirigee
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_status text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  SELECT a.status INTO v_status FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est pas en attente de validation (statut : %)', v_status
      USING ERRCODE = '22023';
  END IF;
  RETURN public.admin_activate_agency_journaled(p_agency_id, NULL,
                                                 'validation administrateur');
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
BEGIN
  PERFORM public.admin_change_agency_plan_journaled(
            p_agency_id, p_plan_id, CURRENT_DATE,
            'Demonstration : changement d offre par administrateur', NULL);
  RETURN true;
END
$fn$;

-- -----------------------------------------------------------------------------
-- 11. platform_revenue_report - mensualite, encaisse, factures, journal
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_revenue_report(p_months integer DEFAULT 12)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
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
    -- ------------------------------------------------------------------
    -- Serie mensuelle. La mensualite n'est connue que pour le mois en
    -- cours : c'est une mesure instantanee, et l'historique des offres
    -- n'a pas ete conserve. Les mois passes renvoient NULL, jamais un
    -- chiffre reconstitue. L'encaisse, lui, est reel sur chaque mois.
    -- ------------------------------------------------------------------
    'months', (
      SELECT COALESCE(jsonb_agg(m ORDER BY m.month_start), '[]'::jsonb)
      FROM (
        SELECT g.month_start,
               CASE WHEN g.month_start = date_trunc('month', now())::date
                    THEN (SELECT COALESCE(SUM(pl.price_monthly), 0)
                            FROM saas_immobilier.agency_subscriptions s
                            JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                           WHERE s.status = 'active')
                    ELSE NULL END AS mensualite_total,
               CASE WHEN g.month_start = date_trunc('month', now())::date
                    THEN (SELECT COALESCE(jsonb_object_agg(t.code, t.total), '{}'::jsonb)
                            FROM (SELECT pl.name AS code, SUM(pl.price_monthly) AS total
                                    FROM saas_immobilier.agency_subscriptions s
                                    JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                                   WHERE s.status = 'active'
                                   GROUP BY 1) t)
                    ELSE '{}'::jsonb END AS mensualite_par_offre,
               COALESCE(enc.encaisse, 0) AS encaisse,
               COALESCE(enc.nb, 0)       AS payments_count
          FROM generate_series(v_from, date_trunc('month', now())::date, interval '1 month') AS g(month_start)
          LEFT JOIN LATERAL (
                SELECT SUM(CASE WHEN sp.entry_kind = 'reversal' THEN -sp.amount ELSE sp.amount END) AS encaisse,
                       COUNT(*) FILTER (WHERE sp.entry_kind = 'payment') AS nb
                  FROM saas_immobilier.subscription_payments sp
                 WHERE date_trunc('month', sp.paid_at) = g.month_start
               ) enc ON true
      ) m
    ),

    -- ------------------------------------------------------------------
    -- Journal des operations, avec offre de depart et d'arrivee
    -- enregistrees explicitement a chaque evenement.
    -- ------------------------------------------------------------------
    'journal', (
      SELECT COALESCE(jsonb_agg(j ORDER BY j.occurred_at DESC), '[]'::jsonb)
      FROM (
        SELECT se.id,
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
        'mensualite_total', COALESCE((SELECT SUM(pl.price_monthly)
                                        FROM saas_immobilier.agency_subscriptions s
                                        JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                                       WHERE s.status = 'active'), 0),
        'mensualite_par_offre', COALESCE((SELECT jsonb_object_agg(t.code, t.total)
                                            FROM (SELECT pl.name AS code, SUM(pl.price_monthly) AS total
                                                    FROM saas_immobilier.agency_subscriptions s
                                                    JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                                                   WHERE s.status = 'active'
                                                   GROUP BY 1) t), '{}'::jsonb),
        'encaisse', COALESCE((SELECT SUM(CASE WHEN sp.entry_kind = 'reversal'
                                              THEN -sp.amount ELSE sp.amount END)
                                FROM saas_immobilier.subscription_payments sp), 0),
        'encaisse_mois', COALESCE((SELECT SUM(CASE WHEN sp.entry_kind = 'reversal'
                                                    THEN -sp.amount ELSE sp.amount END)
                                     FROM saas_immobilier.subscription_payments sp
                                    WHERE date_trunc('month', sp.paid_at) = date_trunc('month', now())), 0),
        'encaisse_brut', COALESCE((SELECT SUM(sp.amount)
                                     FROM saas_immobilier.subscription_payments sp
                                    WHERE sp.entry_kind = 'payment'), 0),
        'ecritures_contraires', COALESCE((SELECT SUM(sp.amount)
                                           FROM saas_immobilier.subscription_payments sp
                                          WHERE sp.entry_kind = 'reversal'), 0),
        'paiements_valides', (SELECT count(*)
                                FROM saas_immobilier.subscription_payments sp
                               WHERE sp.entry_kind = 'payment'),
        'factures_en_attente_montant', COALESCE((SELECT SUM(i.amount)
                                                   FROM saas_immobilier.subscription_invoices i
                                                  WHERE i.status = 'pending'), 0),
        'factures_en_attente_nombre', (SELECT count(*)
                                         FROM saas_immobilier.subscription_invoices i
                                        WHERE i.status = 'pending'),
        'factures_payees_nombre', (SELECT count(*)
                                     FROM saas_immobilier.subscription_invoices i
                                    WHERE i.status = 'paid'),
        'agences_actives', (SELECT count(*)
                              FROM saas_immobilier.agency_subscriptions
                             WHERE status = 'active'),
        'active_without_payment', (
          SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
            FROM (SELECT a.id, a.name,
                         COALESCE(pl.display_name, pl.name) AS plan_name,
                         pl.price_monthly
                    FROM saas_immobilier.agency_subscriptions s
                    JOIN saas_immobilier.agencies a ON a.id = s.agency_id
                    JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                   WHERE s.status = 'active'
                     AND NOT EXISTS (SELECT 1 FROM saas_immobilier.subscription_payments sp
                                      WHERE sp.agency_id = s.agency_id
                                        AND sp.entry_kind = 'payment')) x
        )
      )
    ),

    'factures', (
      SELECT COALESCE(jsonb_agg(f ORDER BY f.created_at DESC), '[]'::jsonb)
        FROM (SELECT i.id, i.agency_id, a.name AS agency_name,
                     i.plan_from_name, i.plan_to_name, i.amount, i.status,
                     i.prorata_applied, i.prorata_days, i.prorata_days_in_month,
                     i.reference, i.created_at, i.paid_at
                FROM saas_immobilier.subscription_invoices i
                JOIN saas_immobilier.agencies a ON a.id = i.agency_id
               WHERE i.status <> 'cancelled') f
    ),

    'by_plan', (
      SELECT COALESCE(jsonb_agg(z ORDER BY z.sort_order), '[]'::jsonb)
        FROM (SELECT p.id, p.name, p.display_name, p.price_monthly, p.currency, p.sort_order,
                     (SELECT count(*) FROM saas_immobilier.agency_subscriptions s
                       WHERE s.plan_id = p.id AND s.status = 'active') AS active_agencies
                FROM saas_immobilier.plans p) z
    )
  );
END
$fn$;

-- -----------------------------------------------------------------------------
-- 12. Droits - anon retire partout, regrant explicite
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.subscription_prorata(numeric, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.subscription_reference(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_activate_agency_journaled(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_change_agency_plan_journaled(uuid, uuid, date, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_validate_payment(uuid, uuid, numeric, date, text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_suspend_agency(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_reactivate_agency(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_revenue_report(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.subscription_prorata(numeric, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.subscription_reference(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_activate_agency_journaled(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_change_agency_plan_journaled(uuid, uuid, date, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_validate_payment(uuid, uuid, numeric, date, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_suspend_agency(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_agency(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_revenue_report(integer) TO authenticated, service_role;

-- Tables : RLS activee, lecture reservee aux administrateurs plateforme.
-- Le front passe par les RPC SECURITY DEFINER, jamais en lecture directe.
ALTER TABLE saas_immobilier.subscription_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.subscription_events   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE saas_immobilier.subscription_invoices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE saas_immobilier.subscription_events   FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE saas_immobilier.subscription_invoices TO authenticated, service_role;
GRANT SELECT ON TABLE saas_immobilier.subscription_events   TO authenticated, service_role;
GRANT ALL ON TABLE saas_immobilier.subscription_invoices TO service_role;
GRANT ALL ON TABLE saas_immobilier.subscription_events   TO service_role;

DROP POLICY IF EXISTS subscription_invoices_admin_read ON saas_immobilier.subscription_invoices;
CREATE POLICY subscription_invoices_admin_read ON saas_immobilier.subscription_invoices
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS subscription_events_admin_read ON saas_immobilier.subscription_events;
CREATE POLICY subscription_events_admin_read ON saas_immobilier.subscription_events
  FOR SELECT TO authenticated USING (public.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 13. Reprise de l'historique dans le journal dedie
-- -----------------------------------------------------------------------------
-- Les changements d'offre anterieurs viennent de usage_events. Leur offre de
-- depart n'a jamais ete enregistree : elle reste NULL, et la variation aussi.
-- On ne la deduit pas.
INSERT INTO saas_immobilier.subscription_events (
  agency_id, event_type, plan_to_id, plan_to_name, mensualite_to,
  mensualite_variation, reason, created_at
)
SELECT ue.agency_id,
       'plan_change',
       (ue.metadata->>'plan_id')::uuid,
       COALESCE(pl.display_name, pl.name),
       pl.price_monthly,
       NULL,
       'Historique repris de usage_events : offre de depart non enregistree a l epoque',
       ue.created_at
  FROM saas_immobilier.usage_events ue
  LEFT JOIN saas_immobilier.plans pl ON pl.id = (ue.metadata->>'plan_id')::uuid
 WHERE ue.event_type = 'admin_plan_assigned'
   AND NOT EXISTS (
     SELECT 1 FROM saas_immobilier.subscription_events se
      WHERE se.agency_id = ue.agency_id
        AND abs(extract(epoch FROM (se.created_at - ue.created_at))) < 1
   );

INSERT INTO saas_immobilier.subscription_events (
  agency_id, event_type, plan_to_id, plan_to_name,
  payment_id, amount, reference, reason, actor_id, created_at
)
SELECT sp.agency_id, 'payment_validated',
       COALESCE(sp.plan_id, s.plan_id),
       COALESCE(pl.display_name, pl.name),
       sp.id, sp.amount, sp.reference,
       COALESCE(sp.note, 'Paiement enregistre'), sp.recorded_by, sp.created_at
  FROM saas_immobilier.subscription_payments sp
  LEFT JOIN saas_immobilier.agency_subscriptions s ON s.id = sp.subscription_id
  LEFT JOIN saas_immobilier.plans pl ON pl.id = COALESCE(sp.plan_id, s.plan_id)
 WHERE NOT EXISTS (
   SELECT 1 FROM saas_immobilier.subscription_events se WHERE se.payment_id = sp.id
 );

COMMIT;
