-- =============================================================================
-- SASPAY — PAIEMENTS EN LIGNE (Phase 1)
-- Projet : xbuuhfwobrafcbgtdgjx   schema saas_immobilier, RPC dans public
-- Date   : 2026-11-03
-- Staging : applique d'abord sur l'environnement isole (db/staging/), jamais
--           en production sans accord explicite.
-- Retour : db/rollback/2026-11-03_saspay_paiements_en_ligne_rollback.sql
--
-- PRINCIPES
-- * STRICTEMENT ADDITIF : 2 nouvelles tables, 1 colonne sur
--   subscription_payments, 7 nouvelles fonctions. Aucune fonction existante
--   n'est modifiee, aucune regle metier existante n'est changee.
-- * Le paiement manuel Orange Money / Wave (submit_payment_declaration /
--   review_payment_declaration) est conserve intact : c'est un 2e chemin.
-- * Le montant est TOUJOURS calcule cote base. Le navigateur n'envoie jamais
--   de montant payable.
-- * Essai unique 14 jours et delai de grace 5 jours : NON TOUCHES.
--   `saspay_create_checkout` refuse meme un renouvellement pendant un essai
--   valide (la conversion se fait via les fonctions d'essai existantes).
-- * Protection doubles paiements (5 barrieres) :
--     1. index uniques partiels : UN SEUL checkout ouvert par portee ;
--     2. checkout_session_id UNIQUE sur online_payments ;
--     3. subscription_payments.online_payment_id UNIQUE : au plus une ecriture
--        d'encaisse par paiement en ligne ;
--     4. saspay_confirm_payment verrouille la ligne (FOR UPDATE) et refuse
--        tout retraitement d'un paiement deja paye (idempotence webhook) ;
--     5. le montant confirme par SasPay doit etre egal au montant attendu
--        (sinon ecart comptable signale, aucun credit).
--
-- SASPAY (docs.saspay.me) — routes utilisees :
--   POST https://api.saspay.me/api/v1/checkout-sessions/
--   GET  https://api.saspay.me/api/v1/checkout-sessions/{id}/status/
--   GET  https://api.saspay.me/api/v1/payments/{id}/verify/
--   Webhook : HMAC-SHA256 sur `${timestamp}.${corps_brut}`,
--             headers X-Webhook-Signature / X-Webhook-Timestamp / X-Webhook-Event,
--             tolerance 300 s. Le webhook NE CONTIENT PAS l'id du checkout :
--             le rapprochement passe par GET status sur les sessions ouvertes
--             (cf. Edge Function saspay-webhook).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. online_payments — intentions de paiement en ligne
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.online_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  subscription_id       uuid REFERENCES saas_immobilier.agency_subscriptions(id) ON DELETE SET NULL,
  invoice_id            uuid REFERENCES saas_immobilier.subscription_invoices(id) ON DELETE SET NULL,
  plan_id               uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  purpose               text NOT NULL CHECK (purpose IN ('setup', 'renewal', 'invoice')),
  amount                numeric(14,2) NOT NULL CHECK (amount > 0),
  currency              text NOT NULL DEFAULT 'XOF',
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'cancelled')),
  provider              text NOT NULL DEFAULT 'saspay',
  idempotency_key       text NOT NULL UNIQUE,
  checkout_session_id   uuid UNIQUE,
  checkout_url          text,
  transaction_id        uuid,
  transaction_reference text,
  paid_amount           numeric(14,2),
  fail_reason           text,
  reconciled_at         timestamptz,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,
  paid_at               timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE saas_immobilier.online_payments IS
  'Intentions de paiement en ligne SasPay (setup / renouvellement / facture). Montant calcule cote base.';

CREATE INDEX IF NOT EXISTS online_payments_agency_idx
  ON saas_immobilier.online_payments (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS online_payments_status_idx
  ON saas_immobilier.online_payments (status, updated_at DESC);

-- Barriere 1 : au plus UN checkout ouvert par portee. Une fois paye (ou
-- expire), la portee se libere pour le mois suivant.
CREATE UNIQUE INDEX IF NOT EXISTS online_payments_open_setup_uniq
  ON saas_immobilier.online_payments (agency_id)
  WHERE purpose = 'setup' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS online_payments_open_renewal_uniq
  ON saas_immobilier.online_payments (agency_id)
  WHERE purpose = 'renewal' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS online_payments_open_invoice_uniq
  ON saas_immobilier.online_payments (agency_id, invoice_id)
  WHERE purpose = 'invoice' AND status = 'pending' AND invoice_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. saspay_webhook_events — boite de reception durable des webhooks
--    (audit + protection contre les livraisons repetees)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.saspay_webhook_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        text,
  signature         text,
  signature_ts      bigint,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  processing_result text,
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saspay_webhook_events_created_idx
  ON saas_immobilier.saspay_webhook_events (created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. subscription_payments.online_payment_id — barriere 3
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS online_payment_id uuid
  CONSTRAINT subscription_payments_online_payment_key
  UNIQUE REFERENCES saas_immobilier.online_payments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS subscription_payments_online_payment_idx
  ON saas_immobilier.subscription_payments (online_payment_id)
  WHERE online_payment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. RLS — lecture membres/admin, ecriture uniquement service_role ou
--    fonctions SECURITY DEFINER (aucune politique INSERT/UPDATE pour
--    authenticated : le navigateur ne peut pas falsifier un paiement).
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.online_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.saspay_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE saas_immobilier.online_payments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE saas_immobilier.saspay_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE saas_immobilier.online_payments TO authenticated, service_role;
GRANT SELECT ON TABLE saas_immobilier.saspay_webhook_events TO authenticated, service_role;
GRANT ALL ON TABLE saas_immobilier.online_payments TO service_role;
GRANT ALL ON TABLE saas_immobilier.saspay_webhook_events TO service_role;

DROP POLICY IF EXISTS online_payments_member_select ON saas_immobilier.online_payments;
CREATE POLICY online_payments_member_select ON saas_immobilier.online_payments
  FOR SELECT TO authenticated USING (public.is_agency_member(agency_id));

DROP POLICY IF EXISTS online_payments_platform_admin_select ON saas_immobilier.online_payments;
CREATE POLICY online_payments_platform_admin_select ON saas_immobilier.online_payments
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS saspay_webhook_events_admin_select ON saas_immobilier.saspay_webhook_events;
CREATE POLICY saspay_webhook_events_admin_select ON saas_immobilier.saspay_webhook_events
  FOR SELECT TO authenticated USING (public.is_platform_admin());

-- =============================================================================
-- 5. saspay_create_checkout — cote AGENCE (JWT utilisateur)
--    Cree (ou reutilise) l'intention de paiement. Le montant est calcule ici,
--    jamais recu du navigateur.
--    p_purpose : 'setup'    = frais d'installation + premier mois (agence pending)
--                'renewal'  = mensualite de l'offre en cours
--                'invoice'  = facture en attente (prorata de changement d'offre)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.saspay_create_checkout(
  p_agency_id uuid,
  p_purpose   text,
  p_plan_id   uuid DEFAULT NULL,
  p_invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_purpose   text := COALESCE(NULLIF(btrim(p_purpose), ''), '');
  v_agency    record;
  v_plan      record;
  v_sub       record;
  v_invoice   record;
  v_amount    numeric;
  v_currency  text;
  v_target    uuid;
  v_existing  record;
  v_id        uuid;
  v_key       text;
  v_desc      text;
  v_profile   record;
  v_role      text;
  -- Scalaires : un record jamais assigne leve 55000 des qu'on en lit un
  -- champ (meme dans un CASE). On ne lit que des variables initialisees.
  v_plan_id   uuid := NULL;
  v_sub_id    uuid := NULL;
  v_inv_plan  uuid := NULL;
BEGIN
  IF v_purpose NOT IN ('setup', 'renewal', 'invoice') THEN
    RAISE EXCEPTION 'objectif de paiement invalide (setup, renewal, invoice)' USING ERRCODE = '22023';
  END IF;

  -- Meme garde que le formulaire de declaration manuelle : proprietaire ou
  -- administrateur de l'agence. Un agent ne paie pas, un inconnu non plus.
  v_role := auth.role();
  IF v_role IS NULL OR v_role = 'anon' THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'proprietaire ou administrateur de l agence requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.name, a.status, a.country, a.currency, a.pending_plan_id
    INTO v_agency
    FROM saas_immobilier.agencies a
   WHERE a.id = p_agency_id
   FOR UPDATE;
  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_agency.status = 'suspended' THEN
    RAISE EXCEPTION 'agence suspendue : paiement en ligne indisponible' USING ERRCODE = '22023';
  END IF;

  -- Libere les intentions expirees avant de chercher un doublon ouvert.
  UPDATE saas_immobilier.online_payments
     SET status = 'expired', updated_at = now()
   WHERE agency_id = p_agency_id
     AND status = 'pending'
     AND expires_at IS NOT NULL
     AND expires_at < now();

  -- ------------------------------------------------------------------ setup
  IF v_purpose = 'setup' THEN
    IF v_agency.status <> 'pending' THEN
      RAISE EXCEPTION 'les frais d installation ne concernent que une agence en attente (statut : %)', v_agency.status
        USING ERRCODE = '22023';
    END IF;
    IF v_agency.pending_plan_id IS NULL THEN
      RAISE EXCEPTION 'choisissez d abord une offre' USING ERRCODE = '22023';
    END IF;
    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency
      INTO v_plan
      FROM saas_immobilier.plans pl
     WHERE pl.id = v_agency.pending_plan_id;
    IF v_plan.id IS NULL THEN
      RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
    END IF;
    v_amount   := COALESCE(v_plan.setup_fee, 0) + COALESCE(v_plan.price_monthly, 0);
    v_currency := COALESCE(v_plan.currency, 'XOF');
    v_target   := NULL;
    v_plan_id  := v_plan.id;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'montant nul : configurateur d offre incomplet' USING ERRCODE = '22023';
    END IF;
    v_desc := 'Sofia Immobilier - Frais d''installation + premier mois - '
              || COALESCE(v_plan.display_name, v_plan.name);

  -- --------------------------------------------------------------- renewal
  ELSIF v_purpose = 'renewal' THEN
    IF v_agency.status NOT IN ('active', 'trial', 'pending') THEN
      RAISE EXCEPTION 'renouvellement indisponible pour ce statut d agence (statut : %)', v_agency.status
        USING ERRCODE = '22023';
    END IF;
    SELECT s.id, s.plan_id, s.status, s.ends_at, s.trial_ends_at
      INTO v_sub
      FROM saas_immobilier.agency_subscriptions s
     WHERE s.agency_id = p_agency_id
       AND s.status IN ('active', 'trial', 'past_due')
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 ELSE 2 END,
              s.created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF v_sub.id IS NULL THEN
      RAISE EXCEPTION 'aucun abonnement actif : utilisez le paiement d installation'
        USING ERRCODE = '22023';
    END IF;
    -- Essai 14 jours : on ne facture pas pendant un essai valide. La
    -- conversion se fait via admin_end_trial / fin d essai, regles existantes.
    IF COALESCE(v_sub.trial_ends_at > now(), false) THEN
      RAISE EXCEPTION 'essai gratuit en cours : paiement disponible apres l essai'
        USING ERRCODE = '22023';
    END IF;
    SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.currency
      INTO v_plan
      FROM saas_immobilier.plans pl
     WHERE pl.id = v_sub.plan_id;
    IF v_plan.id IS NULL THEN
      RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
    END IF;
    v_amount   := COALESCE(v_plan.price_monthly, 0);
    v_currency := COALESCE(v_plan.currency, 'XOF');
    v_target   := NULL;
    v_plan_id  := v_plan.id;
    v_sub_id   := v_sub.id;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'montant nul : configurateur d offre incomplet' USING ERRCODE = '22023';
    END IF;
    v_desc := 'Sofia Immobilier - Abonnement mensuel - ' || COALESCE(v_plan.display_name, v_plan.name);

  -- --------------------------------------------------------------- invoice
  ELSIF v_purpose = 'invoice' THEN
    IF p_invoice_id IS NULL THEN
      RAISE EXCEPTION 'facture obligatoire pour cet objectif' USING ERRCODE = '22023';
    END IF;
    SELECT i.id, i.agency_id, i.amount, i.currency, i.status, i.reference,
           i.plan_to_id, i.plan_from_name, i.plan_to_name
      INTO v_invoice
      FROM saas_immobilier.subscription_invoices i
     WHERE i.id = p_invoice_id
     FOR UPDATE;
    IF v_invoice.id IS NULL THEN
      RAISE EXCEPTION 'facture introuvable' USING ERRCODE = 'P0002';
    END IF;
    IF v_invoice.agency_id <> p_agency_id THEN
      RAISE EXCEPTION 'facture d une autre agence' USING ERRCODE = '42501';
    END IF;
    IF v_invoice.status <> 'pending' THEN
      RAISE EXCEPTION 'facture deja traitee (statut : %)', v_invoice.status USING ERRCODE = '22023';
    END IF;
    v_amount   := v_invoice.amount;
    v_currency := COALESCE(v_invoice.currency, 'XOF');
    v_target   := v_invoice.id;
    v_inv_plan := v_invoice.plan_to_id;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'montant nul' USING ERRCODE = '22023';
    END IF;
    v_desc := 'Sofia Immobilier - Facture '
              || COALESCE(v_invoice.reference, v_invoice.id::text)
              || ' - ' || COALESCE(v_invoice.plan_to_name, 'changement d offre');
  END IF;

  -- ------------------------------------------- un seul checkout ouvert par
  -- portee (index unique partiel) : reutilise plutot que de creer un doublon
  SELECT op.id, op.checkout_url, op.checkout_session_id, op.amount, op.currency,
         op.idempotency_key, op.expires_at
    INTO v_existing
    FROM saas_immobilier.online_payments op
   WHERE op.agency_id = p_agency_id
     AND op.purpose = v_purpose
     AND op.status = 'pending'
     AND (v_purpose <> 'invoice' OR op.invoice_id = v_target)
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'payment_id',        v_existing.id,
      'idempotency_key',   v_existing.idempotency_key,
      'amount',            v_existing.amount,
      'currency',          v_existing.currency,
      'checkout_url',      v_existing.checkout_url,
      'checkout_session_id', v_existing.checkout_session_id,
      'reused',            true
    );
  END IF;

  -- Intention neuve. La cle d'idempotence est locale (SasPay peut ignorer son
  -- header sur le checkout hébergé : notre index unique partiel fait foi).
  v_id  := gen_random_uuid();
  v_key := 'OP-' || replace(v_id::text, '-', '');

  SELECT up.full_name, up.email
    INTO v_profile
    FROM saas_immobilier.user_profiles up
   WHERE up.id = auth.uid();

  INSERT INTO saas_immobilier.online_payments (
    id, agency_id, subscription_id, invoice_id, plan_id, purpose, amount, currency,
    idempotency_key, created_by, expires_at, metadata
  ) VALUES (
    v_id, p_agency_id,
    v_sub_id,
    v_target, COALESCE(v_plan_id, v_inv_plan), v_purpose, v_amount, v_currency,
    v_key, auth.uid(), now() + interval '45 minutes',
    jsonb_build_object(
      'description', v_desc,
      'country', COALESCE(v_agency.country, 'ML'),
      'customer_email', v_profile.email,
      'customer_name', COALESCE(v_profile.full_name, v_profile.email),
      'agency_name', v_agency.name
    )
  );

  RETURN jsonb_build_object(
    'payment_id',      v_id,
    'idempotency_key', v_key,
    'amount',          v_amount,
    'currency',        v_currency,
    'description',     v_desc,
    'country',         COALESCE(v_agency.country, 'ML'),
    'customer_email',  v_profile.email,
    'customer_name',   COALESCE(v_profile.full_name, v_profile.email),
    'reused',          false
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.saspay_create_checkout(uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.saspay_create_checkout(uuid, text, uuid, uuid)
  TO authenticated, service_role;


-- =============================================================================
-- 6. saspay_attach_checkout — cote SERVEUR (service_role uniquement)
--    Ecrit l'identifiant de session SasPay retourne par l'API. Idempotent :
--    si la session est deja attachee, on la renvoie telle quelle.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.saspay_attach_checkout(
  p_payment_id    uuid,
  p_session_id    uuid,
  p_checkout_url  text,
  p_expires_at    timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_row record;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;
  IF p_payment_id IS NULL OR p_session_id IS NULL OR p_checkout_url IS NULL THEN
    RAISE EXCEPTION 'parametres obligatoires' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM saas_immobilier.online_payments
   WHERE id = p_payment_id
   FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'intention de paiement introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Deja attachee : on ne ecrase jamais une session (protection doublon).
  IF v_row.checkout_session_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'payment_id', v_row.id,
      'checkout_session_id', v_row.checkout_session_id,
      'checkout_url', v_row.checkout_url,
      'already_attached', true
    );
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'intention plus ouverte (statut : %)', v_row.status USING ERRCODE = '22023';
  END IF;

  UPDATE saas_immobilier.online_payments
     SET checkout_session_id = p_session_id,
         checkout_url        = p_checkout_url,
         expires_at          = COALESCE(p_expires_at, now() + interval '45 minutes'),
         updated_at          = now()
   WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'payment_id', v_row.id,
    'checkout_session_id', p_session_id,
    'checkout_url', p_checkout_url,
    'already_attached', false
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.saspay_attach_checkout(uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.saspay_attach_checkout(uuid, uuid, text, timestamptz)
  TO service_role;


-- =============================================================================
-- 7. saspay_confirm_payment — cote SERVEUR (service_role uniquement)
--    Appelee par le webhook et par le fichier de retour. Idempotent : un
--    paiement deja paye n'est jamais retraite (barriere 4), le montant confirme
--    doit correspondre (barriere 5).
--
--    Effets par objectif :
--      setup    -> aucun encaissement immediat : l'activation reste une
--                  validation administrateur (admin_activate_pending_agency_paid).
--      renewal  -> ecriture encaisse + prolongation de l'echeance + journal.
--      invoice  -> ecriture encaisse rattachee a la facture + facture payee
--                  + journal. Le changement d'offre lui-meme a deja ete applique
--                  par admin_change_agency_plan_journaled.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.saspay_confirm_payment(
  p_payment_id           uuid DEFAULT NULL,
  p_session_id           uuid DEFAULT NULL,
  p_outcome              text DEFAULT 'paid',
  p_transaction_id       uuid DEFAULT NULL,
  p_transaction_reference text DEFAULT NULL,
  p_requested_amount     numeric DEFAULT NULL,
  p_fail_reason          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
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
    -- une validation administrateur — regle metier existante conservee.
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
    -- est recu mais la facture est deja soldée. A rapprocher / rembourser.
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
$fn$;

REVOKE ALL ON FUNCTION public.saspay_confirm_payment(uuid, uuid, text, uuid, text, numeric, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.saspay_confirm_payment(uuid, uuid, text, uuid, text, numeric, text)
  TO service_role;


-- =============================================================================
-- 8. saspay_payment_state — cote AGENCE (JWT) : relit UNE intention qui appartient
--    a une agence dont l'appelant est membre. Sert au fichier de retour.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.saspay_payment_state(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_row record;
  v_role text;
BEGIN
  v_role := auth.role();
  IF v_role IS NULL OR v_role = 'anon' THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session obligatoire' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
    FROM saas_immobilier.online_payments
   WHERE checkout_session_id = p_session_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  IF NOT (public.is_agency_member(v_row.agency_id) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'acces refuse' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'payment_id', v_row.id,
    'agency_id', v_row.agency_id,
    'purpose', v_row.purpose,
    'amount', v_row.amount,
    'currency', v_row.currency,
    'status', v_row.status,
    'checkout_session_id', v_row.checkout_session_id,
    'transaction_reference', v_row.transaction_reference,
    'fail_reason', v_row.fail_reason,
    'paid_at', v_row.paid_at,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.saspay_payment_state(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.saspay_payment_state(uuid)
  TO authenticated, service_role;


-- =============================================================================
-- 9. saspay_recent_pending_sessions — cote SERVEUR : liste bornee des
--    intentions ouvertes munies d'une session, pour le rapprochement webhook
--    (le webhook SasPay ne contient pas l'id du checkout).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.saspay_recent_pending_sessions(p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role requis' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
      FROM (
        SELECT op.id AS payment_id,
               op.checkout_session_id,
               op.amount,
               op.currency,
               op.purpose,
               op.status,
               op.agency_id
          FROM saas_immobilier.online_payments op
         WHERE op.status = 'pending'
           AND op.checkout_session_id IS NOT NULL
           AND op.updated_at > now() - interval '48 hours'
         ORDER BY op.updated_at DESC
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 25)
      ) x
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.saspay_recent_pending_sessions(integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.saspay_recent_pending_sessions(integer)
  TO service_role;


-- =============================================================================
-- 10. admin_activate_pending_agency_paid — cote ADMIN : validation d'un dossier
--     dont le paiement d'installation a ete confirme EN LIGNE.
--     Active l'agence (fonction existante inchangee) ET encaisse le paiement
--     rattache a l'intention SasPay. Barriere : au plus un encaissement par
--     intention (unique online_payment_id) + reconciled_at.
--     Le chemin manuel (admin_activate_pending_agency) reste en place.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency_paid(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_status   text;
  v_online   record;
  v_activation jsonb;
  v_sub_id    uuid;
  v_payment   uuid;
  v_ref       text;
  v_plan      record;
  v_event     uuid;
  v_owner     uuid;
  v_ends      date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.status INTO v_status FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'cette agence n''est plus en attente (statut : %)', v_status USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_online
    FROM saas_immobilier.online_payments op
   WHERE op.agency_id = p_agency_id
     AND op.purpose = 'setup'
     AND op.status = 'paid'
   ORDER BY op.paid_at DESC NULLS LAST, op.created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF v_online.id IS NULL THEN
    RAISE EXCEPTION 'aucun paiement en ligne confirme pour cette agence'
      USING ERRCODE = '22023';
  END IF;
  IF v_online.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'paiement deja rattache a un encaissement' USING ERRCODE = '22023';
  END IF;

  -- Activation : fonction existante, inchangee (cree l'abonnement, notifie,
  -- journalise l'evenement d'activation).
  v_activation := public.admin_activate_pending_agency(p_agency_id);

  SELECT s.id INTO v_sub_id
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY (s.status = 'active') DESC, s.created_at DESC
   LIMIT 1;
  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'abonnement introuvable apres activation' USING ERRCODE = 'P0002';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.currency INTO v_plan
    FROM saas_immobilier.plans pl
   WHERE pl.id = COALESCE(v_online.plan_id,
             (SELECT s.plan_id FROM saas_immobilier.agency_subscriptions s WHERE s.id = v_sub_id));

  v_ref := 'SASPAY-' || left(replace(v_online.id::text, '-', ''), 12)
           || '-' || to_char(now(), 'YYYYMMDDHH24MISS');

  INSERT INTO saas_immobilier.subscription_payments (
    agency_id, subscription_id, plan_id, amount, currency, paid_at,
    period_start, period_end, method, recorded_by, note, reference,
    entry_kind, provider, provider_reference, provider_status, online_payment_id
  ) VALUES (
    p_agency_id, v_sub_id, COALESCE(v_online.plan_id,
      (SELECT s.plan_id FROM saas_immobilier.agency_subscriptions s WHERE s.id = v_sub_id)),
    v_online.amount, COALESCE(v_online.currency, 'XOF'), CURRENT_DATE,
    CURRENT_DATE,
    (SELECT s.ends_at FROM saas_immobilier.agency_subscriptions s WHERE s.id = v_sub_id),
    'saspay', NULL,
    'Frais d installation + premier mois payes en ligne (SasPay)', v_ref,
    'payment', 'saspay',
    COALESCE(v_online.transaction_reference, v_online.transaction_id::text),
    'SUCCESS', v_online.id
  ) RETURNING id INTO v_payment;

  UPDATE saas_immobilier.online_payments
     SET reconciled_at = now(), updated_at = now()
   WHERE id = v_online.id;

  SELECT am.user_id INTO v_owner
    FROM saas_immobilier.agency_members am
   WHERE am.agency_id = p_agency_id AND am.role = 'owner' AND am.status = 'active'
   ORDER BY am.created_at ASC LIMIT 1;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_to_id, plan_to_name, mensualite_variation,
    payment_id, amount, reference, reason, actor_id
  ) VALUES (
    p_agency_id, 'payment_validated',
    COALESCE(v_online.plan_id,
      (SELECT s.plan_id FROM saas_immobilier.agency_subscriptions s WHERE s.id = v_sub_id)),
    COALESCE(v_plan.display_name, v_plan.name), 0,
    v_payment, v_online.amount, v_ref,
    'Installation reglee en ligne (SasPay) - validation administrative', auth.uid()
  ) RETURNING id INTO v_event;

  v_ends := (v_activation->>'ends_at')::date;

  RETURN v_activation || jsonb_build_object(
    'online_payment_id', v_online.id,
    'payment_id', v_payment,
    'encaisse', v_online.amount,
    'event_id', v_event
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_activate_pending_agency_paid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_activate_pending_agency_paid(uuid)
  TO authenticated, service_role;


-- =============================================================================
-- 11. agency_invoices — cote AGENCE : ses propres factures (la RLS de la table
--     est admin-only ; les membres ont besoin de ce lecteur pour payer un
--     prorata de changement d'offre en ligne).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.agency_invoices(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT i.id, i.agency_id, i.amount, i.currency, i.status, i.reference,
               i.plan_from_name, i.plan_to_name, i.prorata_applied,
               i.prorata_days, i.prorata_days_in_month, i.note,
               i.created_at, i.paid_at,
               EXISTS (SELECT 1 FROM saas_immobilier.online_payments op
                        WHERE op.invoice_id = i.id AND op.status = 'paid') AS has_online_payment
          FROM saas_immobilier.subscription_invoices i
         WHERE i.agency_id = p_agency_id
      ) x
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.agency_invoices(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_invoices(uuid)
  TO authenticated, service_role;


-- =============================================================================
-- 12. CORRECTIF DU CHEMIN MANUEL (Orange Money / Wave) — sans changement de
--     regle. Constat le 2026-11-03 : la version de production de
--     `submit_payment_declaration` n'enregistre JAMAIS `plan_id` sur la
--     declaration, alors que `admin_review_payment` (le coeur de
--     `review_payment_declaration`) leve « offre introuvable pour cette
--     demande » des que `plan_id` est nul. Toute validation manuelle
--     echouait donc. Le corps est identique a production auquel on ajoute
--     le figeage de l'offre courante (ou de l'offre en attente) au moment de
--     la declaration. Aucun montant, aucune garde, aucun droit modifie.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.submit_payment_declaration(
  p_agency_id uuid,
  p_amount numeric,
  p_method text,
  p_transaction_reference text,
  p_paid_on date,
  p_proof_path text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
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
    (agency_id, amount, method, transaction_reference, paid_on, proof_path,
     declared_by, plan_id)
  VALUES (p_agency_id, p_amount, p_method, btrim(p_transaction_reference),
          COALESCE(p_paid_on, CURRENT_DATE), NULLIF(btrim(COALESCE(p_proof_path,'')),''),
          auth.uid(),
          -- CORRECTIF : offre courante (ou en attente) figee sur la declaration
          -- pour que la validation admin ne echoue pas sur « offre introuvable ».
          COALESCE(
            (SELECT s.plan_id FROM saas_immobilier.agency_subscriptions s
              WHERE s.agency_id = p_agency_id
              ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                                     WHEN 'past_due' THEN 2 ELSE 3 END,
                       s.created_at DESC
              LIMIT 1),
            (SELECT a.pending_plan_id FROM saas_immobilier.agencies a
              WHERE a.id = p_agency_id)))
  RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.submit_payment_declaration(uuid, numeric, text, text, date, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_payment_declaration(uuid, numeric, text, text, date, text)
  TO authenticated, service_role;


-- =============================================================================
-- 13. CORRECTIFS DE ROBUSTESSE — records plpgsql non initialises (meme famille
--     de bug que le correctif session5b). Constatés en staging le 2026-11-03 :
--
--   a) admin_activate_agency_journaled : `v_prev` (record) n'est assigne que
--      SI une abonnement precedent existe. Pour une PREMIERE activation (agence
--      pending sans abonnement — le parcours normal d'une nouvelle agence !),
--      `COALESCE(v_prev.price_monthly, 0)` leve 55000 « record not assigned »
--      : la validation admin plantait. Corrige avec des scalaires initialises.
--      AUCUN changement de regle : mêmes écritures, mêmes journaux.
--
--   b) admin_change_agency_plan_journaled : meme defaut sur `v_prev` quand
--      l'agence n'a aucun abonnement precedent (lecture de
--      `v_prev.display_name` dans l'INSERT du journal).
--
-- Le comportement, les montants, les journaux et les droits sont identiques ;
-- seuls les lectures de records non assignes sont remplacees par des
-- variables scalaires initialisees a NULL/0.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_activate_agency_journaled(
  p_agency_id uuid,
  p_plan_id   uuid DEFAULT NULL,
  p_note      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
  v_prev_plan_id uuid;
  v_prev_name    text := NULL;
  v_prev_price   numeric := 0;
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
    SELECT COALESCE(pl.display_name, pl.name), COALESCE(pl.price_monthly, 0)
      INTO v_prev_name, v_prev_price
      FROM saas_immobilier.plans pl WHERE pl.id = v_prev_plan_id;
  END IF;

  -- Primitive interne, non redirigee.
  v_activation := public.admin_activate_agency(p_agency_id, p_plan_id);

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly
    INTO v_plan FROM saas_immobilier.plans pl
   WHERE pl.id = (v_activation->>'plan_id')::uuid;

  v_variation := COALESCE(v_plan.price_monthly, 0) - v_prev_price;
  v_type := CASE WHEN v_prev_plan_id IS NULL THEN 'activation' ELSE 'reactivation' END;

  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    mensualite_from, mensualite_to, mensualite_variation, reason, actor_id
  ) VALUES (
    p_agency_id, v_type, v_prev_plan_id, v_plan.id,
    v_prev_name, COALESCE(v_plan.display_name, v_plan.name),
    v_prev_price, v_plan.price_monthly, v_variation,
    COALESCE(p_note, 'activation administrateur'), auth.uid()
  ) RETURNING id INTO v_event;

  RETURN v_activation || jsonb_build_object('event_id', v_event,
                                            'event_type', v_type,
                                            'mensualite_variation', v_variation);
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_activate_agency_journaled(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_activate_agency_journaled(uuid, uuid, text)
  TO authenticated, service_role;


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
SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE
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

  SELECT s.plan_id INTO v_prev_plan_id
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_prev_plan_id IS NOT NULL THEN
    SELECT COALESCE(pl.display_name, pl.name), COALESCE(pl.price_monthly, 0)
      INTO v_prev_name, v_prev_price
      FROM saas_immobilier.plans pl WHERE pl.id = v_prev_plan_id;
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.currency
    INTO v_new FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;

  IF v_new.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_prev_plan_id IS NOT DISTINCT FROM p_plan_id THEN
    RETURN jsonb_build_object('changed', false, 'reason', 'offre inchangee');
  END IF;

  PERFORM public.admin_assign_plan(p_agency_id, p_plan_id, 'active',
                                   COALESCE(p_note, 'changement direct par administrateur'));

  v_variation := COALESCE(v_new.price_monthly, 0) - v_prev_price;

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
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_change_agency_plan_journaled(uuid, uuid, date, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_change_agency_plan_journaled(uuid, uuid, date, text, text)
  TO authenticated, service_role;

COMMIT;
