-- =============================================================================
-- PAIEMENT MANUEL DE BOUT EN BOUT — 2026-10-28
-- Projet Supabase : xbuuhfwobrafcbgtdgjx   ·   schéma métier : saas_immobilier
-- Retour arrière : db/rollback/2026-10-28_paiement_manuel_bout_en_bout_rollback.sql
-- Complément INDISSOCIABLE : db/migrations/2026-10-28_paiement_manuel_durcissement_admin.sql
--   (is_platform_admin() ne lit plus user_profiles.role ; garde anti-élévation)
-- =============================================================================
-- CE QUE FAIT CE FICHIER
--
-- 1. `saas_immobilier.payment_declarations` devient la DEMANDE DE PAIEMENT
--    complète : une ligne est créée au moment où l'agence choisit son offre
--    (statut `awaiting_payment`, référence générée par le serveur), puis
--    complétée avec la preuve (statut `pending`). Aucune table redondante.
--
-- 2. Statuts : awaiting_payment | pending | correction_requested | approved |
--    rejected | cancelled | expired.
--
-- 3. Garde-fous en base (pas seulement dans l'interface) :
--      - référence de transaction UNIQUE parmi les demandes pending/approved
--        → une même référence ne peut jamais valider deux paiements ;
--      - une seule demande `pending` par agence (pas de double soumission) ;
--      - un paiement d'abonnement ne peut être rattaché qu'à une seule
--        déclaration (index unique sur subscription_payments.declaration_id) ;
--      - champs de preuve obligatoires dès que la demande est soumise.
--
-- 4. Sept fonctions RPC `SECURITY DEFINER` : toutes les écritures critiques
--    (création, soumission, annulation, décision admin, réglages) passent par
--    elles. Le navigateur n'écrit plus jamais directement ces colonnes.
--
-- 5. Journal des décisions : `saas_immobilier.payment_decision_log`
--    (append-only, lisible par l'agence concernée et les admins).
--
-- 6. RLS durcie : une agence ne peut plus modifier son abonnement ni insérer /
--    modifier une déclaration à la main (deux politiques sont retirées).
--
-- 7. Notifications in-app réelles (table `notifications` déjà utilisée par la
--    cloche) + rappels d'échéance planifiés par pg_cron.
--
-- STRICTEMENT ADDITIF sur les données : aucune ligne supprimée, aucune colonne
-- supprimée, aucun tarif inventé (les prix viennent de `saas_immobilier.plans`).
-- =============================================================================

BEGIN;

-- #############################################################################
-- §1  payment_declarations — de la déclaration à la demande de paiement
-- #############################################################################

ALTER TABLE saas_immobilier.payment_declarations
  ADD COLUMN IF NOT EXISTS reference               text,
  ADD COLUMN IF NOT EXISTS plan_id                 uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS plan_name_snapshot      text,
  ADD COLUMN IF NOT EXISTS expected_amount         numeric(14,2),
  ADD COLUMN IF NOT EXISTS duration_months         integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS payer_name              text,
  ADD COLUMN IF NOT EXISTS proof_mime              text,
  ADD COLUMN IF NOT EXISTS proof_size              bigint,
  ADD COLUMN IF NOT EXISTS proof_uploaded_at       timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at            timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at              timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at            timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason           text;

-- Les champs de preuve n'existent pas encore au moment où l'agence choisit son
-- offre : on lève leur NOT NULL et on le remplace par une contrainte
-- conditionnelle, plus stricte (elle s'applique à toutes les demandes soumises).
ALTER TABLE saas_immobilier.payment_declarations
  ALTER COLUMN method                DROP NOT NULL,
  ALTER COLUMN transaction_reference DROP NOT NULL,
  ALTER COLUMN paid_on               DROP NOT NULL;

-- Référence normalisée (majuscules, sans espaces) : c'est elle qui porte
-- l'unicité. Colonne générée = impossible à fausser depuis le client.
ALTER TABLE saas_immobilier.payment_declarations
  ADD COLUMN IF NOT EXISTS transaction_reference_norm text
    GENERATED ALWAYS AS (
      upper(regexp_replace(btrim(coalesce(transaction_reference, '')), '\s+', '', 'g'))
    ) STORED;

ALTER TABLE saas_immobilier.payment_declarations
  DROP CONSTRAINT IF EXISTS payment_declarations_status_check;
ALTER TABLE saas_immobilier.payment_declarations
  ADD CONSTRAINT payment_declarations_status_check
  CHECK (status IN ('awaiting_payment', 'pending', 'correction_requested',
                    'approved', 'rejected', 'cancelled', 'expired'));

ALTER TABLE saas_immobilier.payment_declarations
  DROP CONSTRAINT IF EXISTS payment_declarations_submitted_fields_check;
ALTER TABLE saas_immobilier.payment_declarations
  ADD CONSTRAINT payment_declarations_submitted_fields_check
  CHECK (
    status IN ('awaiting_payment', 'cancelled', 'expired')
    OR (method IS NOT NULL
        AND transaction_reference IS NOT NULL
        AND btrim(transaction_reference) <> ''
        AND paid_on IS NOT NULL)
  );

ALTER TABLE saas_immobilier.payment_declarations
  DROP CONSTRAINT IF EXISTS payment_declarations_amount_check;
ALTER TABLE saas_immobilier.payment_declarations
  ADD CONSTRAINT payment_declarations_amount_check
  CHECK (amount IS NULL OR amount >= 0);

-- --- Index d'unicité : le cœur des garanties métier -------------------------
CREATE UNIQUE INDEX IF NOT EXISTS payment_declarations_reference_uniq
  ON saas_immobilier.payment_declarations (reference)
  WHERE reference IS NOT NULL;

-- Une même référence Mobile Money ne peut servir qu'à UNE demande en cours ou
-- validée, toutes agences confondues.
CREATE UNIQUE INDEX IF NOT EXISTS payment_declarations_txn_ref_uniq
  ON saas_immobilier.payment_declarations (transaction_reference_norm)
  WHERE status IN ('pending', 'approved') AND transaction_reference_norm <> '';

-- Une seule demande en attente de vérification par agence : deux clics
-- simultanés sur « Envoyer » ne peuvent pas créer deux lignes.
CREATE UNIQUE INDEX IF NOT EXISTS payment_declarations_one_pending_per_agency
  ON saas_immobilier.payment_declarations (agency_id)
  WHERE status = 'pending';

-- Un encaissement ne peut être rattaché qu'à une seule déclaration : une
-- approbation rejouée ne peut pas écrire un second paiement.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_payments_declaration_uniq
  ON saas_immobilier.subscription_payments (declaration_id)
  WHERE declaration_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_declarations_agency_status_idx
  ON saas_immobilier.payment_declarations (agency_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_declarations_status_created_idx
  ON saas_immobilier.payment_declarations (status, created_at DESC);

COMMENT ON COLUMN saas_immobilier.payment_declarations.reference IS
  'Référence de la demande de paiement générée par le serveur (SI-AAAAMMJJ-XXXXXX).';
COMMENT ON COLUMN saas_immobilier.payment_declarations.transaction_reference_norm IS
  'Référence Mobile Money normalisée (majuscules, sans espaces) : support de l''unicité.';

-- #############################################################################
-- §2  Journal des décisions (append-only)
-- #############################################################################

CREATE TABLE IF NOT EXISTS saas_immobilier.payment_decision_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id uuid NOT NULL REFERENCES saas_immobilier.payment_declarations(id) ON DELETE CASCADE,
  agency_id      uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  action         text NOT NULL CHECK (action IN (
                   'created', 'submitted', 'approved', 'rejected',
                   'correction_requested', 'cancelled', 'expired')),
  from_status    text,
  to_status      text,
  actor_id       uuid,
  actor_kind     text CHECK (actor_kind IN ('agency', 'platform_admin', 'system')),
  actor_label    text,
  amount         numeric(14,2),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_decision_log_declaration_idx
  ON saas_immobilier.payment_decision_log (declaration_id, created_at);
CREATE INDEX IF NOT EXISTS payment_decision_log_agency_idx
  ON saas_immobilier.payment_decision_log (agency_id, created_at DESC);

ALTER TABLE saas_immobilier.payment_decision_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_decision_log_select_member ON saas_immobilier.payment_decision_log;
DROP POLICY IF EXISTS payment_decision_log_select_admin  ON saas_immobilier.payment_decision_log;

-- Lecture : les membres de l'agence concernée, et les administrateurs.
-- Aucune politique INSERT/UPDATE/DELETE : la table n'est écrite que par les
-- fonctions SECURITY DEFINER. Le client ne peut donc pas fabriquer d'historique.
CREATE POLICY payment_decision_log_select_member
  ON saas_immobilier.payment_decision_log
  FOR SELECT TO authenticated
  USING (public.is_agency_member(agency_id));

CREATE POLICY payment_decision_log_select_admin
  ON saas_immobilier.payment_decision_log
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

-- #############################################################################
-- §3  Cycle de vie de l'abonnement — statuts autorisés
-- #############################################################################

ALTER TABLE saas_immobilier.agency_subscriptions
  DROP CONSTRAINT IF EXISTS agency_subscriptions_status_check;
ALTER TABLE saas_immobilier.agency_subscriptions
  ADD CONSTRAINT agency_subscriptions_status_check
  CHECK (status IN ('pending', 'trial', 'active', 'past_due', 'expired',
                    'suspended', 'cancelled'));

COMMENT ON CONSTRAINT agency_subscriptions_status_check
  ON saas_immobilier.agency_subscriptions IS
  'Cycle de vie : pending → trial → active → past_due → expired | suspended | cancelled.';

-- #############################################################################
-- §4  Configuration des moyens de paiement (lue par l'agence, écrite admin)
-- #############################################################################

-- Forme canonique stockée dans platform_settings.payment_instructions :
-- {
--   "methods": {
--     "orange_money": {"label","beneficiary","number","instructions",
--                      "enabled","reference_required","proof_required"},
--     "moov_money":   {...},
--     "wave":         {...}
--   },
--   "proof_required": bool,
--   "note": text
-- }
-- La fonction accepte AUSSI l'ancienne forme
-- {"orange_money":{"name","number"},"wave":{...},"beneficiary","note"} :
-- rien n'est perdu, aucune migration de données nécessaire.
CREATE OR REPLACE FUNCTION saas_immobilier.normalize_payment_config(p_raw jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_raw     jsonb := COALESCE(p_raw, '{}'::jsonb);
  v_methods jsonb := COALESCE(v_raw->'methods', '{}'::jsonb);
  v_out     jsonb := '{}'::jsonb;
  v_code    text;
  v_block   jsonb;
  v_number  text;
  v_enabled boolean;
  v_labels  jsonb := jsonb_build_object(
                'orange_money', 'Orange Money',
                'moov_money',   'Moov Money',
                'wave',         'Wave');
BEGIN
  FOREACH v_code IN ARRAY ARRAY['orange_money', 'moov_money', 'wave'] LOOP
    IF v_methods ? v_code THEN
      v_block := COALESCE(v_methods->v_code, '{}'::jsonb);
    ELSIF v_raw ? v_code THEN
      v_block := COALESCE(v_raw->v_code, '{}'::jsonb);       -- ancienne forme
    ELSE
      v_block := '{}'::jsonb;
    END IF;
    IF jsonb_typeof(v_block) <> 'object' THEN
      v_block := '{}'::jsonb;
    END IF;

    v_number := btrim(COALESCE(v_block->>'number', ''));

    IF jsonb_typeof(v_block->'enabled') = 'boolean' THEN
      v_enabled := (v_block->>'enabled')::boolean;
    ELSIF jsonb_typeof(v_block->'enabled') = 'string'
          AND lower(v_block->>'enabled') IN ('true', '1', 'yes', 'oui') THEN
      v_enabled := true;
    ELSE
      -- Ancienne forme : un numéro renseigné valait activation.
      v_enabled := (v_number <> '');
    END IF;

    v_out := jsonb_set(v_out, ARRAY[v_code], jsonb_build_object(
      'code',      v_code,
      'label',     COALESCE(NULLIF(btrim(v_block->>'label'), ''),
                            NULLIF(btrim(v_block->>'name'), ''),
                            v_labels->>v_code),
      'beneficiary', COALESCE(NULLIF(btrim(v_block->>'beneficiary'), ''),
                              NULLIF(btrim(v_block->>'name'), ''),
                              NULLIF(btrim(v_raw->>'beneficiary'), ''),
                              ''),
      'number',    v_number,
      'instructions', COALESCE(NULLIF(btrim(v_block->>'instructions'), ''), ''),
      'enabled',   v_enabled,
      -- « configuré » = activé ET numéro réellement renseigné. C'est cette
      -- valeur, et elle seule, qui autorise l'agence à soumettre une preuve.
      'configured', (v_enabled AND v_number <> ''),
      'reference_required',
        CASE WHEN jsonb_typeof(v_block->'reference_required') = 'boolean'
             THEN (v_block->>'reference_required')::boolean ELSE true END,
      'proof_required',
        CASE WHEN jsonb_typeof(v_block->'proof_required') = 'boolean'
             THEN (v_block->>'proof_required')::boolean ELSE false END
    ), true);
  END LOOP;

  RETURN jsonb_build_object(
    'methods', v_out,
    'method_order', jsonb_build_array('orange_money', 'moov_money', 'wave'),
    'proof_required',
      CASE WHEN jsonb_typeof(v_raw->'proof_required') = 'boolean'
           THEN (v_raw->>'proof_required')::boolean ELSE false END,
    'note', COALESCE(btrim(v_raw->>'note'), '')
  );
END
$fn$;

CREATE OR REPLACE FUNCTION saas_immobilier.payment_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_raw  jsonb;
  v_norm jsonb;
  v_code text;
  v_conf integer := 0;
BEGIN
  SELECT COALESCE(value, '{}'::jsonb) INTO v_raw
    FROM saas_immobilier.platform_settings WHERE key = 'payment_instructions';

  v_norm := saas_immobilier.normalize_payment_config(v_raw);

  FOREACH v_code IN ARRAY ARRAY['orange_money', 'moov_money', 'wave'] LOOP
    IF COALESCE((v_norm->'methods'->v_code->>'configured')::boolean, false) THEN
      v_conf := v_conf + 1;
    END IF;
  END LOOP;

  RETURN v_norm || jsonb_build_object(
    'configured_count', v_conf,
    'any_configured',   (v_conf > 0)
  );
END
$fn$;

REVOKE ALL ON FUNCTION saas_immobilier.normalize_payment_config(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION saas_immobilier.payment_config() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION saas_immobilier.payment_config() TO authenticated, service_role;

-- #############################################################################
-- §5  Notifications in-app (table `notifications` déjà utilisée par la cloche)
-- #############################################################################

CREATE OR REPLACE FUNCTION saas_immobilier.notify_agency(
  p_agency_id uuid,
  p_type      text,
  p_title     text,
  p_message   text,
  p_data      jsonb DEFAULT '{}'::jsonb,
  p_dedup_key text  DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_id uuid;
BEGIN
  IF p_agency_id IS NULL THEN RETURN NULL; END IF;

  IF p_dedup_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM saas_immobilier.notifications n
     WHERE n.agency_id = p_agency_id
       AND n.type = p_type
       AND n.data->>'dedup_key' = p_dedup_key
  ) THEN
    RETURN NULL;   -- déjà notifié : idempotent
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
$fn$;

REVOKE ALL ON FUNCTION saas_immobilier.notify_agency(uuid, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- #############################################################################
-- §6  RLS durcie — l'agence ne peut plus écrire son abonnement ni ses preuves
-- #############################################################################
-- Avant : `agency_subscriptions_update_admin` + `agency_subscriptions_insert_admin`
-- laissaient un propriétaire d'agence repousser lui-même sa date d'expiration
-- depuis le navigateur. Toutes les écritures passent désormais par des
-- fonctions SECURITY DEFINER gardées.
DROP POLICY IF EXISTS agency_subscriptions_update_admin  ON saas_immobilier.agency_subscriptions;
DROP POLICY IF EXISTS agency_subscriptions_insert_admin  ON saas_immobilier.agency_subscriptions;

-- Avant : `payment_declarations_insert_member` laissait un membre insérer une
-- déclaration avec le montant et le statut de son choix. Retirée : la création
-- passe par les RPC, qui imposent le montant attendu et le statut initial.
DROP POLICY IF EXISTS payment_declarations_insert_member ON saas_immobilier.payment_declarations;

-- Les politiques de LECTURE existantes (membre / administrateur) restent en
-- place : `payment_declarations_select_member`, `payment_declarations_admin_all`,
-- `payment_declarations_select_platform_admin`, `agency_subscriptions_select_member`,
-- `agency_subscriptions_select_platform_admin`.
--
-- Aucune politique UPDATE/DELETE n'existe sur payment_declarations : une agence
-- ne peut donc ni changer le statut, ni le montant attendu, ni la référence.

-- #############################################################################
-- §7  RPC — côté agence
-- #############################################################################

-- -----------------------------------------------------------------------------
-- 7.1 Vue complète de facturation (un seul aller-retour réseau)
-- -----------------------------------------------------------------------------
-- Remplace/étend public.agency_payment_access(uuid) : MÊME SIGNATURE, sortie
-- sur-ensemble (instructions, expected_amount, declarations, can_manage sont
-- conservés à l'identique pour le code existant).
CREATE OR REPLACE FUNCTION public.agency_payment_access(p_agency_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub    record;
  v_plan   record;
  v_pay    jsonb;
  v_bill   jsonb;
  v_grace  integer;
  v_cfg    jsonb;
  v_is_mgr boolean;
  v_plans  jsonb;
  v_reqs   jsonb;
  v_dur    jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;

  v_is_mgr := public.has_agency_role(p_agency_id, 'admin');

  SELECT COALESCE((value->>'grace_days')::int, 5) INTO v_grace
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_grace IS NULL THEN v_grace := 5; END IF;

  SELECT COALESCE(value, '{}'::jsonb) INTO v_pay
    FROM saas_immobilier.platform_settings WHERE key = 'payment_instructions';
  IF v_pay IS NULL THEN v_pay := '{}'::jsonb; END IF;

  SELECT COALESCE(value->'durations', '[1,3,6,12]'::jsonb) INTO v_dur
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_dur IS NULL OR jsonb_typeof(v_dur) <> 'array' THEN
    v_dur := '[1,3,6,12]'::jsonb;
  END IF;

  v_cfg := saas_immobilier.payment_config();

  SELECT s.id, s.status, s.starts_at, s.ends_at, s.trial_ends_at, s.plan_id
    INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY (s.status = 'active') DESC, s.created_at DESC
   LIMIT 1;

  IF v_sub.id IS NOT NULL THEN
    SELECT p.id, p.name, p.display_name, p.price_monthly, p.setup_fee, p.currency, p.modules
      INTO v_plan
      FROM saas_immobilier.plans p WHERE p.id = v_sub.plan_id;
  END IF;

  v_bill := public.agency_billing_state(p_agency_id);

  SELECT COALESCE(jsonb_agg(row_to_json(pl)::jsonb ORDER BY pl.sort_order, pl.price_monthly), '[]'::jsonb)
    INTO v_plans
    FROM (
      SELECT p.id, p.name, p.display_name, p.description,
             p.price_monthly, p.currency, p.setup_fee,
             p.max_members, p.max_properties, p.max_photos_per_property,
             p.monthly_agent_messages, p.modules, p.features, p.sort_order,
             (p.id = v_sub.plan_id) AS is_current
        FROM saas_immobilier.plans p
    ) pl;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',                    d.id,
           'reference',             d.reference,
           'plan_id',               d.plan_id,
           'plan_name',             COALESCE(d.plan_name_snapshot, dpl.display_name, dpl.name),
           'expected_amount',       d.expected_amount,
           'amount',                d.amount,
           'currency',              d.currency,
           'duration_months',       d.duration_months,
           'method',                d.method,
           'transaction_reference', d.transaction_reference,
           'paid_on',               d.paid_on,
           'payer_name',            d.payer_name,
           'status',                d.status,
           'note',                  d.note,
           'review_note',           d.review_note,
           'reviewed_at',           d.reviewed_at,
           'created_at',            d.created_at,
           'submitted_at',          d.submitted_at,
           'expires_at',            d.expires_at,
           'cancelled_at',          d.cancelled_at,
           'cancel_reason',         d.cancel_reason,
           'payment_id',            d.payment_id,
           'has_proof',             (d.proof_path IS NOT NULL),
           'proof_path',            d.proof_path
         ) ORDER BY d.created_at DESC), '[]'::jsonb)
    INTO v_reqs
    FROM saas_immobilier.payment_declarations d
    LEFT JOIN saas_immobilier.plans dpl ON dpl.id = d.plan_id
   WHERE d.agency_id = p_agency_id;

  RETURN jsonb_build_object(
    'agency_id',      p_agency_id,
    'can_manage',     v_is_mgr,
    'is_owner',       public.has_agency_role(p_agency_id, 'owner'),
    'instructions',   v_pay,                 -- forme brute (compatibilité)
    'payment_config', v_cfg,                 -- forme normalisée utilisée par l'UI
    'grace_days',     v_grace,
    'durations',      v_dur,
    'billing',        v_bill,
    'plans',          v_plans,
    'subscription',   CASE WHEN v_sub.id IS NULL THEN NULL ELSE jsonb_build_object(
                        'id', v_sub.id, 'status', v_sub.status,
                        'starts_at', v_sub.starts_at, 'ends_at', v_sub.ends_at,
                        'trial_ends_at', v_sub.trial_ends_at) END,
    'plan',           CASE WHEN v_plan.id IS NULL THEN NULL ELSE jsonb_build_object(
                        'id', v_plan.id, 'name', v_plan.name,
                        'display_name', v_plan.display_name,
                        'price_monthly', v_plan.price_monthly,
                        'setup_fee', v_plan.setup_fee,
                        'currency', v_plan.currency) END,
    'expected_amount', COALESCE(v_plan.price_monthly, 0),
    'requests',       v_reqs,
    'declarations',   v_reqs              -- clé historique conservée
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.agency_payment_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_payment_access(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7.2 Créer une demande de paiement (référence générée côté serveur)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_create_payment_request(
  p_agency_id       uuid,
  p_plan_id         uuid,
  p_duration_months integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_plan     record;
  v_exist    record;
  v_id       uuid;
  v_ref      text;
  v_expected numeric(14,2);
  v_months   integer;
  v_ttl      integer := 7;
  v_i        integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'seul le proprietaire ou un administrateur de l''agence peut payer' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_plan FROM saas_immobilier.plans p WHERE p.id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.price_monthly IS NULL OR v_plan.price_monthly <= 0 THEN
    RAISE EXCEPTION 'cette offre n''a pas de tarif mensuel : paiement impossible' USING ERRCODE = '22023';
  END IF;

  v_months := LEAST(GREATEST(COALESCE(p_duration_months, 1), 1), 12);
  -- Aucune remise inventée : le montant est exactement prix × durée.
  v_expected := round(v_plan.price_monthly * v_months, 2);

  SELECT COALESCE((value->>'request_ttl_days')::int, 7) INTO v_ttl
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_ttl IS NULL OR v_ttl < 1 THEN v_ttl := 7; END IF;

  -- Anti-double-clic : une demande identique encore valable est renvoyée
  -- telle quelle au lieu d'en créer une seconde.
  SELECT * INTO v_exist
    FROM saas_immobilier.payment_declarations d
   WHERE d.agency_id = p_agency_id
     AND d.status = 'awaiting_payment'
     AND d.plan_id = p_plan_id
     AND d.expected_amount = v_expected
     AND d.expires_at > now()
   ORDER BY d.created_at DESC
   LIMIT 1;

  IF v_exist.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'id', v_exist.id, 'reference', v_exist.reference,
      'expected_amount', v_exist.expected_amount, 'currency', v_exist.currency,
      'duration_months', v_exist.duration_months,
      'expires_at', v_exist.expires_at, 'status', v_exist.status,
      'reused', true);
  END IF;

  FOR v_i IN 1..8 LOOP
    v_ref := 'SI-' || to_char(now(), 'YYYYMMDD') || '-' ||
             upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM saas_immobilier.payment_declarations d WHERE d.reference = v_ref);
  END LOOP;

  INSERT INTO saas_immobilier.payment_declarations (
    agency_id, amount, currency, method, transaction_reference, paid_on,
    declared_by, status, plan_id, plan_name_snapshot, expected_amount,
    duration_months, reference, expires_at
  ) VALUES (
    p_agency_id, v_expected, COALESCE(v_plan.currency, 'XOF'), NULL, NULL, NULL,
    auth.uid(), 'awaiting_payment', p_plan_id,
    COALESCE(v_plan.display_name, v_plan.name), v_expected,
    v_months, v_ref, now() + (v_ttl || ' day')::interval
  ) RETURNING id INTO v_id;

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id, actor_kind, amount)
  VALUES (v_id, p_agency_id, 'created', NULL, 'awaiting_payment', auth.uid(), 'agency', v_expected);

  RETURN jsonb_build_object(
    'id', v_id, 'reference', v_ref, 'expected_amount', v_expected,
    'currency', COALESCE(v_plan.currency, 'XOF'), 'duration_months', v_months,
    'expires_at', now() + (v_ttl || ' day')::interval,
    'status', 'awaiting_payment', 'reused', false);
END
$fn$;

REVOKE ALL ON FUNCTION public.agency_create_payment_request(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_create_payment_request(uuid, uuid, integer) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7.3 Soumettre la preuve de paiement
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_submit_payment_proof(
  p_request_id           uuid,
  p_method               text,
  p_amount               numeric,
  p_transaction_reference text,
  p_paid_on              date,
  p_payer_name           text    DEFAULT NULL,
  p_proof_path           text    DEFAULT NULL,
  p_proof_mime           text    DEFAULT NULL,
  p_proof_size           bigint  DEFAULT NULL,
  p_confirmed            boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_dec      record;
  v_plan     record;
  v_cfg      jsonb;
  v_mcfg     jsonb;
  v_ref      text;
  v_norm     text;
  v_path     text;
  v_mime     text;
  v_ext      text;
  v_dupe     record;
  v_pending  record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dec
    FROM saas_immobilier.payment_declarations d
   WHERE d.id = p_request_id
     FOR UPDATE;
  IF v_dec.id IS NULL THEN
    RAISE EXCEPTION 'demande de paiement introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_agency_member(v_dec.agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(v_dec.agency_id, 'admin') THEN
    RAISE EXCEPTION 'seul le proprietaire ou un administrateur de l''agence peut payer' USING ERRCODE = '42501';
  END IF;
  IF v_dec.status NOT IN ('awaiting_payment', 'correction_requested') THEN
    RAISE EXCEPTION 'cette demande n''accepte plus de preuve (statut : %)', v_dec.status
      USING ERRCODE = '22023';
  END IF;
  IF v_dec.expires_at IS NOT NULL AND v_dec.expires_at < now() THEN
    RAISE EXCEPTION 'cette demande a expire : creez-en une nouvelle' USING ERRCODE = '22023';
  END IF;
  IF p_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'vous devez confirmer l''exactitude des informations' USING ERRCODE = '22023';
  END IF;

  -- --- Moyen de paiement réellement configuré -------------------------------
  v_cfg := saas_immobilier.payment_config();
  IF COALESCE((v_cfg->>'any_configured')::boolean, false) = false THEN
    RAISE EXCEPTION 'moyen de paiement en cours de configuration' USING ERRCODE = '22023';
  END IF;
  v_mcfg := v_cfg->'methods'->COALESCE(p_method, '');
  IF v_mcfg IS NULL OR COALESCE((v_mcfg->>'configured')::boolean, false) = false THEN
    RAISE EXCEPTION 'moyen de paiement en cours de configuration' USING ERRCODE = '22023';
  END IF;

  -- --- Montant : doit correspondre exactement au montant attendu ------------
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;
  IF v_dec.expected_amount IS NOT NULL AND p_amount <> v_dec.expected_amount THEN
    RAISE EXCEPTION 'le montant declare (%) ne correspond pas au montant attendu (%)',
      p_amount, v_dec.expected_amount USING ERRCODE = '22023';
  END IF;

  -- --- Date de paiement -----------------------------------------------------
  IF p_paid_on IS NULL THEN
    RAISE EXCEPTION 'date de paiement obligatoire' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on > CURRENT_DATE THEN
    RAISE EXCEPTION 'la date de paiement ne peut pas etre dans le futur' USING ERRCODE = '22023';
  END IF;
  IF p_paid_on < CURRENT_DATE - 90 THEN
    RAISE EXCEPTION 'la date de paiement est trop ancienne (90 jours maximum)' USING ERRCODE = '22023';
  END IF;

  -- --- Référence de transaction --------------------------------------------
  v_ref := btrim(COALESCE(p_transaction_reference, ''));
  IF v_ref = '' THEN
    RAISE EXCEPTION 'reference de transaction obligatoire' USING ERRCODE = '22023';
  END IF;
  IF length(v_ref) < 4 OR length(v_ref) > 80 THEN
    RAISE EXCEPTION 'la reference doit contenir entre 4 et 80 caracteres' USING ERRCODE = '22023';
  END IF;
  IF v_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._/#-]*$' THEN
    RAISE EXCEPTION 'la reference contient des caracteres non autorises' USING ERRCODE = '22023';
  END IF;
  v_norm := upper(regexp_replace(v_ref, '\s+', '', 'g'));

  SELECT d.id, d.agency_id, d.reference AS demand_ref, a.name AS agency_name
    INTO v_dupe
    FROM saas_immobilier.payment_declarations d
    JOIN saas_immobilier.agencies a ON a.id = d.agency_id
   WHERE d.transaction_reference_norm = v_norm
     AND d.status IN ('pending', 'approved')
     AND d.id <> v_dec.id
   LIMIT 1;
  IF v_dupe.id IS NOT NULL THEN
    RAISE EXCEPTION 'cette reference de transaction est deja utilisee (demande %)', v_dupe.demand_ref
      USING ERRCODE = '23505';
  END IF;

  -- --- Une seule demande en vérification par agence -------------------------
  SELECT d.id, d.reference INTO v_pending
    FROM saas_immobilier.payment_declarations d
   WHERE d.agency_id = v_dec.agency_id AND d.status = 'pending' AND d.id <> v_dec.id
   LIMIT 1;
  IF v_pending.id IS NOT NULL THEN
    RAISE EXCEPTION 'une autre demande est deja en attente de verification (%)', v_pending.reference
      USING ERRCODE = '23505';
  END IF;

  -- --- Justificatif ---------------------------------------------------------
  v_path := NULLIF(btrim(COALESCE(p_proof_path, '')), '');
  IF v_path IS NOT NULL THEN
    IF v_path NOT LIKE v_dec.agency_id::text || '/%' THEN
      RAISE EXCEPTION 'chemin de justificatif invalide' USING ERRCODE = '22023';
    END IF;
    IF v_path ~ '\.\.' OR v_path ~* '\.(exe|bat|cmd|com|sh|js|jsx|ts|html|php|py|msi|scr|ps1|jar|svg)$' THEN
      RAISE EXCEPTION 'type de fichier refuse' USING ERRCODE = '22023';
    END IF;
    v_mime := lower(btrim(COALESCE(p_proof_mime, '')));
    IF v_mime NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
      RAISE EXCEPTION 'format de justificatif refuse (JPG, PNG, WebP ou PDF)' USING ERRCODE = '22023';
    END IF;
    IF p_proof_size IS NULL OR p_proof_size <= 0 OR p_proof_size > 5242880 THEN
      RAISE EXCEPTION 'justificatif trop lourd (5 Mo maximum)' USING ERRCODE = '22023';
    END IF;
    v_ext := lower(substring(v_path from '\.([A-Za-z0-9]+)$'));
    IF v_ext IS NULL OR v_ext NOT IN ('jpg', 'jpeg', 'png', 'webp', 'pdf') THEN
      RAISE EXCEPTION 'extension de justificatif refusee' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_mime := NULL;
    IF COALESCE((v_cfg->>'proof_required')::boolean, false)
       OR COALESCE((v_mcfg->>'proof_required')::boolean, false) THEN
      RAISE EXCEPTION 'une capture ou un recu est obligatoire pour ce moyen de paiement'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT p.id, p.currency, p.display_name, p.name INTO v_plan
    FROM saas_immobilier.plans p WHERE p.id = v_dec.plan_id;

  UPDATE saas_immobilier.payment_declarations d
     SET method                 = p_method,
         amount                 = p_amount,
         currency               = COALESCE(v_plan.currency, d.currency, 'XOF'),
         transaction_reference  = v_ref,
         paid_on                = p_paid_on,
         payer_name             = NULLIF(btrim(COALESCE(p_payer_name, '')), ''),
         proof_path             = v_path,
         proof_mime             = v_mime,
         proof_size             = p_proof_size,
         proof_uploaded_at      = CASE WHEN v_path IS NULL THEN NULL ELSE now() END,
         status                 = 'pending',
         submitted_at           = now(),
         reviewed_by            = NULL,
         reviewed_at            = NULL,
         review_note            = NULL
   WHERE d.id = v_dec.id;

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id, actor_kind, amount, note)
  VALUES (v_dec.id, v_dec.agency_id, 'submitted', v_dec.status, 'pending',
          auth.uid(), 'agency', p_amount,
          'Preuve transmise par ' || p_method || ', reference ' || v_ref);

  -- Notification in-app pour l'agence (confirmation lisible dans la cloche).
  PERFORM saas_immobilier.notify_agency(
    v_dec.agency_id, 'billing',
    'Preuve de paiement transmise',
    'Votre paiement de ' || to_char(p_amount, 'FM999G999G999G990D00') || ' ' ||
      COALESCE(v_plan.currency, 'XOF') || ' (demande ' || v_dec.reference ||
      ') est en attente de verification par l''administrateur.',
    jsonb_build_object('declaration_id', v_dec.id, 'reference', v_dec.reference,
                       'status', 'pending', 'kind', 'payment_submitted'),
    'submitted_' || v_dec.id::text
  );

  -- Alerte dans la console d'administration (le trigger ne couvre que l'INSERT).
  PERFORM saas_immobilier.raise_admin_alert(
    'payment_submitted_' || v_dec.id::text,
    'payment_declared',
    'Paiement a verifier',
    'Demande ' || v_dec.reference || ' — ' || p_amount || ' ' || COALESCE(v_plan.currency, 'XOF') ||
      ' par ' || p_method || ', reference ' || v_ref || '.',
    'high', v_dec.agency_id, '/admin/paiements', 'Verifier le paiement',
    jsonb_build_object('declaration_id', v_dec.id, 'amount', p_amount, 'method', p_method)
  );

  RETURN jsonb_build_object(
    'id', v_dec.id, 'reference', v_dec.reference, 'status', 'pending',
    'amount', p_amount, 'currency', COALESCE(v_plan.currency, 'XOF'),
    'submitted_at', now(), 'has_proof', (v_path IS NOT NULL));
END
$fn$;

REVOKE ALL ON FUNCTION public.agency_submit_payment_proof(uuid, text, numeric, text, date, text, text, text, bigint, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_submit_payment_proof(uuid, text, numeric, text, date, text, text, text, bigint, boolean)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7.4 Annuler sa propre demande
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_cancel_payment_request(
  p_request_id uuid,
  p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_dec record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_dec FROM saas_immobilier.payment_declarations d
   WHERE d.id = p_request_id FOR UPDATE;
  IF v_dec.id IS NULL THEN
    RAISE EXCEPTION 'demande introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_agency_member(v_dec.agency_id) THEN
    RAISE EXCEPTION 'acces agence refuse' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(v_dec.agency_id, 'admin') THEN
    RAISE EXCEPTION 'seul un administrateur de l''agence peut annuler' USING ERRCODE = '42501';
  END IF;
  IF v_dec.status NOT IN ('awaiting_payment', 'correction_requested', 'pending') THEN
    RAISE EXCEPTION 'cette demande ne peut plus etre annulee (statut : %)', v_dec.status
      USING ERRCODE = '22023';
  END IF;

  UPDATE saas_immobilier.payment_declarations d
     SET status = 'cancelled', cancelled_at = now(),
         cancel_reason = NULLIF(btrim(COALESCE(p_reason, '')), '')
   WHERE d.id = v_dec.id;

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id, actor_kind, note)
  VALUES (v_dec.id, v_dec.agency_id, 'cancelled', v_dec.status, 'cancelled',
          auth.uid(), 'agency', NULLIF(btrim(COALESCE(p_reason, '')), ''));

  RETURN jsonb_build_object('id', v_dec.id, 'reference', v_dec.reference, 'status', 'cancelled');
END
$fn$;

REVOKE ALL ON FUNCTION public.agency_cancel_payment_request(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agency_cancel_payment_request(uuid, text) TO authenticated, service_role;

-- #############################################################################
-- §8  RPC — espace administrateur
-- #############################################################################

-- -----------------------------------------------------------------------------
-- 8.1 File des demandes avec filtres (statut, agence, période, moyen)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_payment_queue(
  p_status    text[]  DEFAULT NULL,
  p_agency_id uuid    DEFAULT NULL,
  p_method    text    DEFAULT NULL,
  p_from      date    DEFAULT NULL,
  p_to        date    DEFAULT NULL,
  p_search    text    DEFAULT NULL,
  p_limit     integer DEFAULT 100,
  p_offset    integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_rows   jsonb;
  v_counts jsonb;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_search text    := NULLIF(btrim(COALESCE(p_search, '')), '');
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT d.id,
             d.reference,
             d.agency_id,
             a.name  AS agency_name,
             a.slug  AS agency_slug,
             a.status AS agency_status,
             d.status,
             d.amount                 AS declared_amount,
             d.expected_amount,
             d.currency,
             d.duration_months,
             d.method,
             d.transaction_reference,
             d.paid_on,
             d.payer_name,
             d.proof_path,
             d.proof_mime,
             d.proof_size,
             d.note,
             d.review_note,
             d.reviewed_at,
             d.reviewed_by,
             d.created_at,
             d.submitted_at,
             d.expires_at,
             d.cancelled_at,
             d.cancel_reason,
             d.payment_id,
             d.plan_id,
             COALESCE(d.plan_name_snapshot, p.display_name, p.name) AS plan_name,
             s.status AS subscription_status,
             s.ends_at AS subscription_ends_at,
             (SELECT count(*) FROM saas_immobilier.payment_decision_log l
               WHERE l.declaration_id = d.id) AS history_count
        FROM saas_immobilier.payment_declarations d
        JOIN saas_immobilier.agencies a ON a.id = d.agency_id
        LEFT JOIN saas_immobilier.plans p ON p.id = d.plan_id
        LEFT JOIN LATERAL (
          SELECT s2.status, s2.ends_at
            FROM saas_immobilier.agency_subscriptions s2
           WHERE s2.agency_id = d.agency_id
           ORDER BY (s2.status = 'active') DESC, s2.created_at DESC
           LIMIT 1
        ) s ON true
       WHERE d.status <> 'awaiting_payment'
         AND (p_status    IS NULL OR d.status = ANY (p_status))
         AND (p_agency_id IS NULL OR d.agency_id = p_agency_id)
         AND (p_method    IS NULL OR d.method = p_method)
         AND (p_from      IS NULL OR d.created_at >= p_from::timestamptz)
         AND (p_to        IS NULL OR d.created_at <  (p_to::timestamptz + interval '1 day'))
         AND (v_search    IS NULL
              OR a.name ILIKE '%' || v_search || '%'
              OR COALESCE(d.reference, '') ILIKE '%' || v_search || '%'
              OR COALESCE(d.transaction_reference, '') ILIKE '%' || v_search || '%'
              OR COALESCE(d.payer_name, '') ILIKE '%' || v_search || '%')
       ORDER BY d.created_at DESC
       LIMIT v_limit OFFSET v_offset
    ) q;

  SELECT jsonb_build_object(
           'pending',              count(*) FILTER (WHERE d.status = 'pending'),
           'correction_requested', count(*) FILTER (WHERE d.status = 'correction_requested'),
           'approved',             count(*) FILTER (WHERE d.status = 'approved'),
           'rejected',             count(*) FILTER (WHERE d.status = 'rejected'),
           'cancelled',            count(*) FILTER (WHERE d.status = 'cancelled'),
           'expired',              count(*) FILTER (WHERE d.status = 'expired')
         )
    INTO v_counts
    FROM saas_immobilier.payment_declarations d
   WHERE d.status <> 'awaiting_payment';

  RETURN jsonb_build_object(
    'rows', v_rows,
    'counts', v_counts,
    'limit', v_limit,
    'offset', v_offset
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_payment_queue(text[], uuid, text, date, date, text, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_payment_queue(text[], uuid, text, date, date, text, integer, integer) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8.2 Détail d'une demande + historique des décisions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_payment_detail(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_dec    record;
  v_history jsonb;
  v_agency jsonb;
  v_sub    jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT d.*, COALESCE(d.plan_name_snapshot, p.display_name, p.name) AS plan_name,
         p.price_monthly AS plan_price, p.currency AS plan_currency
    INTO v_dec
    FROM saas_immobilier.payment_declarations d
    LEFT JOIN saas_immobilier.plans p ON p.id = d.plan_id
   WHERE d.id = p_request_id;

  IF v_dec.id IS NULL THEN
    RAISE EXCEPTION 'demande introuvable' USING ERRCODE = 'P0002';
  END IF;

  SELECT jsonb_build_object(
           'id', a.id, 'name', a.name, 'slug', a.slug, 'status', a.status,
           'email', a.email, 'phone', a.phone, 'city', a.city,
           'created_at', a.created_at)
    INTO v_agency
    FROM saas_immobilier.agencies a WHERE a.id = v_dec.agency_id;

  SELECT jsonb_build_object(
           'id', s.id, 'status', s.status, 'starts_at', s.starts_at,
           'ends_at', s.ends_at, 'trial_ends_at', s.trial_ends_at,
           'plan_id', s.plan_id)
    INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = v_dec.agency_id
   ORDER BY (s.status = 'active') DESC, s.created_at DESC
   LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', l.id, 'action', l.action, 'from_status', l.from_status,
           'to_status', l.to_status, 'actor_kind', l.actor_kind,
           'actor_label', l.actor_label, 'note', l.note, 'amount', l.amount,
           'created_at', l.created_at
         ) ORDER BY l.created_at), '[]'::jsonb)
    INTO v_history
    FROM saas_immobilier.payment_decision_log l
   WHERE l.declaration_id = p_request_id;

  RETURN jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_dec.id, 'reference', v_dec.reference, 'status', v_dec.status,
      'amount', v_dec.amount, 'expected_amount', v_dec.expected_amount,
      'currency', v_dec.currency, 'duration_months', v_dec.duration_months,
      'plan_id', v_dec.plan_id, 'plan_name', v_dec.plan_name,
      'method', v_dec.method, 'transaction_reference', v_dec.transaction_reference,
      'paid_on', v_dec.paid_on, 'payer_name', v_dec.payer_name,
      'proof_path', v_dec.proof_path, 'proof_mime', v_dec.proof_mime,
      'proof_size', v_dec.proof_size,
      'note', v_dec.note, 'review_note', v_dec.review_note,
      'reviewed_at', v_dec.reviewed_at, 'reviewed_by', v_dec.reviewed_by,
      'created_at', v_dec.created_at, 'submitted_at', v_dec.submitted_at,
      'expires_at', v_dec.expires_at, 'cancelled_at', v_dec.cancelled_at,
      'cancel_reason', v_dec.cancel_reason, 'payment_id', v_dec.payment_id,
      'amount_matches', (v_dec.expected_amount IS NULL
                         OR v_dec.amount = v_dec.expected_amount)
    ),
    'agency', v_agency,
    'subscription', v_sub,
    'history', v_history
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_payment_detail(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_payment_detail(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8.3 DÉCISION ADMINISTRATEUR — approuver / refuser / demander une correction
-- -----------------------------------------------------------------------------
-- Une seule transaction. Verrous FOR UPDATE : deux clics simultanés ne peuvent
-- pas activer deux fois le même abonnement (le second voit status <> 'pending'
-- et échoue proprement).
CREATE OR REPLACE FUNCTION public.admin_review_payment(
  p_request_id uuid,
  p_decision   text,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
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

  -- Verrou de ligne : sérialise les décisions concurrentes.
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

  -- ======================= REFUS =========================================
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

  -- ================= DEMANDE DE CORRECTION ===============================
  IF p_decision = 'correction_requested' THEN
    UPDATE saas_immobilier.payment_declarations d
       SET status = 'correction_requested', reviewed_by = auth.uid(),
           reviewed_at = now(), review_note = v_note
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
      'L''administrateur demande une correction sur la demande ' ||
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

  -- ======================= APPROBATION ===================================
  -- (1) le montant déclaré doit correspondre au montant attendu
  v_amount := v_dec.amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'montant declare invalide' USING ERRCODE = '22023';
  END IF;
  IF v_dec.expected_amount IS NOT NULL AND v_amount <> v_dec.expected_amount THEN
    RAISE EXCEPTION 'montant declare (%) different du montant attendu (%)',
      v_amount, v_dec.expected_amount USING ERRCODE = '22023';
  END IF;

  -- (2) la référence ne doit pas déjà avoir validé un autre paiement
  IF EXISTS (
    SELECT 1 FROM saas_immobilier.payment_declarations d
     WHERE d.transaction_reference_norm = v_dec.transaction_reference_norm
       AND d.status = 'approved'
       AND d.id <> v_dec.id
  ) THEN
    RAISE EXCEPTION 'cette reference de transaction a deja valide un autre paiement'
      USING ERRCODE = '23505';
  END IF;

  -- (3) l'offre facturée
  SELECT p.* INTO v_plan FROM saas_immobilier.plans p WHERE p.id = v_dec.plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable pour cette demande' USING ERRCODE = 'P0002';
  END IF;
  v_months := GREATEST(COALESCE(v_dec.duration_months, 1), 1);

  -- (4) l'abonnement de l'agence (verrouillé)
  SELECT s.* INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = v_dec.agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1
     FOR UPDATE;

  v_prev_end := v_sub.ends_at;
  v_plan_from := v_sub.plan_id;

  IF v_sub.id IS NULL THEN
    v_start := CURRENT_DATE::timestamptz;
    v_end   := (CURRENT_DATE + (v_months || ' month')::interval)::timestamptz;
    INSERT INTO saas_immobilier.agency_subscriptions
      (agency_id, plan_id, status, starts_at, ends_at)
    VALUES (v_dec.agency_id, v_plan.id, 'active', v_start, v_end)
    RETURNING id INTO v_new_sub_id;
    -- Relecture par identifiant scalaire : on ne lit jamais un champ d'un
    -- enregistrement qui n'a pas encore été affecté (erreur 55000).
    SELECT s.* INTO v_sub FROM saas_immobilier.agency_subscriptions s WHERE s.id = v_new_sub_id;
  ELSE
    -- Renouvellement : un abonnement encore valable est PROLONGÉ (les jours
    -- restants ne sont jamais perdus) ; un abonnement expiré repart du jour.
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

  IF v_plan_from IS NOT NULL AND v_plan_from <> v_plan.id THEN
    SELECT COALESCE(pl.display_name, pl.name) INTO v_plan_from_name
      FROM saas_immobilier.plans pl WHERE pl.id = v_plan_from;
  END IF;

  -- (5) l'encaissement (unique par déclaration : index partiel)
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

  -- (6) la demande devient validée
  UPDATE saas_immobilier.payment_declarations d
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         review_note = v_note, payment_id = v_payment,
         expected_amount = COALESCE(d.expected_amount, v_amount)
   WHERE d.id = v_dec.id;

  -- (7) réactivation d'une agence suspendue / en attente
  UPDATE saas_immobilier.agencies a
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL
   WHERE a.id = v_dec.agency_id AND a.status IN ('suspended', 'pending');

  -- (8) journal d'abonnement (table existante, alimentée par les autres flux)
  INSERT INTO saas_immobilier.subscription_events (
    agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
    payment_id, amount, reference, reason, actor_id
  ) VALUES (
    v_dec.agency_id, 'payment_validated', v_plan_from, v_plan.id, v_plan_from_name,
    COALESCE(v_plan.display_name, v_plan.name), v_payment, v_amount,
    v_dec.transaction_reference,
    'Paiement manuel valide — demande ' || COALESCE(v_dec.reference, ''), auth.uid()
  );

  -- (9) historique de facturation
  INSERT INTO saas_immobilier.activity_log
    (agency_id, user_id, action, entity_type, entity_id, summary)
  VALUES (
    v_dec.agency_id, auth.uid(), 'payment_approved', 'payment_declarations', v_dec.id,
    'Paiement valide : ' || v_amount || ' ' || COALESCE(v_dec.currency, 'XOF') ||
    ' (' || COALESCE(v_dec.reference, '') || ') — abonnement ' ||
    COALESCE(v_plan.display_name, v_plan.name) || ' jusqu''au ' ||
    to_char(v_end, 'DD/MM/YYYY')
  );

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id,
     actor_kind, actor_label, amount, note)
  VALUES (v_dec.id, v_dec.agency_id, 'approved', 'pending', 'approved', auth.uid(),
          'platform_admin', v_admin_label, v_amount, v_note);

  -- (10) notification in-app
  PERFORM saas_immobilier.notify_agency(
    v_dec.agency_id, 'billing',
    'Paiement valide — abonnement active',
    'Votre paiement de ' || v_amount || ' ' || COALESCE(v_dec.currency, 'XOF') ||
      ' a ete verifie. L''offre ' || COALESCE(v_plan.display_name, v_plan.name) ||
      ' est active jusqu''au ' || to_char(v_end, 'DD/MM/YYYY') || '.',
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
$fn$;

REVOKE ALL ON FUNCTION public.admin_review_payment(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_review_payment(uuid, text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8.4 Ancienne porte d'entrée : redirigée vers le chemin unique ci-dessus
-- -----------------------------------------------------------------------------
-- `review_payment_declaration` reste appelable (compatibilité) mais délègue à
-- admin_review_payment : impossible de contourner les contrôles ci-dessus.
CREATE OR REPLACE FUNCTION public.review_payment_declaration(
  p_declaration_id uuid,
  p_decision       text,
  p_note           text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_res jsonb;
BEGIN
  v_res := public.admin_review_payment(p_declaration_id, p_decision, p_note);
  RETURN NULLIF(v_res->>'payment_id', '')::uuid;
END
$fn$;

REVOKE ALL ON FUNCTION public.review_payment_declaration(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_payment_declaration(uuid, text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8.5 Réglages des moyens de paiement (administrateurs de la plateforme)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_save_payment_methods(
  p_methods         jsonb,
  p_proof_required  boolean DEFAULT false,
  p_note            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_code  text;
  v_block jsonb;
  v_num   text;
  v_conf  jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF p_methods IS NULL OR jsonb_typeof(p_methods) <> 'object' THEN
    RAISE EXCEPTION 'configuration invalide' USING ERRCODE = '22023';
  END IF;

  FOREACH v_code IN ARRAY ARRAY['orange_money', 'moov_money', 'wave'] LOOP
    v_block := COALESCE(p_methods->v_code, '{}'::jsonb);
    v_num   := btrim(COALESCE(v_block->>'number', ''));
    IF v_num <> '' AND v_num !~ '^[0-9+() .-]{6,24}$' THEN
      RAISE EXCEPTION 'numero invalide pour % : caracteres autorises 0-9 + ( ) . -', v_code
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_block->'enabled') = 'boolean'
       AND (v_block->>'enabled')::boolean
       AND v_num = '' THEN
      RAISE EXCEPTION 'le moyen % est active mais aucun numero n''est renseigne', v_code
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  v_conf := saas_immobilier.normalize_payment_config(jsonb_build_object(
    'methods', p_methods,
    'proof_required', COALESCE(p_proof_required, false),
    'note', COALESCE(btrim(p_note), '')
  ));

  INSERT INTO saas_immobilier.platform_settings (key, value, updated_by)
  VALUES ('payment_instructions', v_conf, auth.uid())
  ON CONFLICT (key) DO UPDATE
     SET value = v_conf, updated_by = auth.uid(), updated_at = now();

  RETURN saas_immobilier.payment_config();
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_save_payment_methods(jsonb, boolean, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_save_payment_methods(jsonb, boolean, text) TO authenticated, service_role;

-- #############################################################################
-- §9  Rappels d'échéance (pg_cron) — notifications RÉELLES, idempotentes
-- #############################################################################
CREATE OR REPLACE FUNCTION public.billing_run_reminders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub       record;
  v_plan_name text;
  v_days      integer;
  v_sent      integer := 0;
  v_reminders jsonb := '[5, 0]'::jsonb;
  v_day       integer;
  v_agency    text;
BEGIN
  SELECT COALESCE(value->'reminder_days', '[5,0]'::jsonb) INTO v_reminders
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_reminders IS NULL OR jsonb_typeof(v_reminders) <> 'array' THEN
    v_reminders := '[5, 0]'::jsonb;
  END IF;

  -- 1) Approche de l'expiration (J-5, J-0 …)
  FOR v_sub IN
    SELECT s.id, s.agency_id, s.status, s.ends_at, s.plan_id
      FROM saas_immobilier.agency_subscriptions s
      JOIN saas_immobilier.agencies a ON a.id = s.agency_id
     WHERE s.ends_at IS NOT NULL
       AND s.status IN ('active', 'past_due', 'trial')
       AND a.status = 'active'
       AND s.ends_at >= now()
  LOOP
    v_days := floor(extract(epoch FROM (v_sub.ends_at - now())) / 86400.0)::int;
    SELECT COALESCE(pl.display_name, pl.name) INTO v_plan_name
      FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
    SELECT a.name INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = v_sub.agency_id;

    FOR v_day IN SELECT (jsonb_array_elements_text(v_reminders))::int LOOP
      IF v_days = v_day THEN
        PERFORM saas_immobilier.notify_agency(
          v_sub.agency_id, 'billing',
          CASE WHEN v_day = 0 THEN 'Abonnement a echeance aujourd''hui'
               ELSE 'Abonnement a echeance dans ' || v_day || ' jour(s)' END,
          'Votre offre ' || COALESCE(v_plan_name, '') || ' expire le ' ||
            to_char(v_sub.ends_at, 'DD/MM/YYYY') || '. Reglez pour eviter la suspension.',
          jsonb_build_object('kind', 'subscription_expiring', 'ends_at', v_sub.ends_at,
                             'days_left', v_days, 'agency', v_agency),
          'expiring_' || v_sub.id::text || '_' || to_char(v_sub.ends_at, 'YYYYMMDD') || '_' || v_day
        );
        v_sent := v_sent + 1;
      END IF;
    END LOOP;
  END LOOP;

  -- 2) Expiration effective (une seule notification par échéance)
  FOR v_sub IN
    SELECT s.id, s.agency_id, s.ends_at, s.plan_id
      FROM saas_immobilier.agency_subscriptions s
     WHERE s.ends_at IS NOT NULL
       AND s.ends_at < now()
       AND s.status IN ('active', 'past_due')
  LOOP
    SELECT COALESCE(pl.display_name, pl.name) INTO v_plan_name
      FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
    PERFORM saas_immobilier.notify_agency(
      v_sub.agency_id, 'billing',
      'Abonnement expire',
      'Votre offre ' || COALESCE(v_plan_name, '') || ' a expire le ' ||
        to_char(v_sub.ends_at, 'DD/MM/YYYY') || '. Regularisez votre paiement.',
      jsonb_build_object('kind', 'subscription_expired', 'ends_at', v_sub.ends_at, 'plan', v_plan_name),
      'expired_' || v_sub.id::text || '_' || to_char(v_sub.ends_at, 'YYYYMMDD')
    );
    v_sent := v_sent + 1;
  END LOOP;

  RETURN jsonb_build_object('reminders_sent', v_sent, 'run_at', now());
END
$fn$;

REVOKE ALL ON FUNCTION public.billing_run_reminders() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.billing_run_reminders() TO service_role;

-- #############################################################################
-- §10  Planification (quotidienne, 06:00 UTC) — idempotente
-- #############################################################################
SELECT cron.unschedule('sofia-billing-reminders')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sofia-billing-reminders');

SELECT cron.schedule(
  'sofia-billing-reminders',
  '0 6 * * *',
  $$SELECT public.billing_run_reminders()$$
);

-- #############################################################################
-- §11  Contrôles post-migration (doivent renvoyer 0)
-- #############################################################################
DO $chk$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM information_schema.columns
   WHERE table_schema = 'saas_immobilier'
     AND table_name = 'payment_declarations'
     AND column_name IN ('reference', 'plan_id', 'expected_amount', 'duration_months',
                         'submitted_at', 'expires_at', 'transaction_reference_norm');
  IF v_missing <> 7 THEN
    RAISE EXCEPTION 'migration incomplete : % colonnes sur 7', v_missing;
  END IF;
END
$chk$;

COMMIT;
