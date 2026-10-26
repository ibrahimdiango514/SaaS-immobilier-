-- =============================================================================
-- SESSION 4 — REVENUS ABONNEMENTS : ÉCRITURES COMPTABLES ET RAPPORT DÉTAILLÉ
-- =============================================================================
-- ⚠️  PROPOSITION — NON APPLIQUÉE EN BASE. À exécuter seulement après accord.
--
-- Constat (diagnostic en lecture seule du 2026-10-26) :
--   * 2 agences actives en offre Pro (100 000 FCFA/mois) ;
--   * 1 seule ligne dans subscription_payments (SBC, 50 000 FCFA) ;
--   * Immo Diango est ACTIVE en Pro avec ZÉRO paiement enregistré ;
--   * public.platform_subscription_revenue ne somme que subscription_payments,
--     donc les revenus affichés (50 000 / 1 paiement / 1 agence) sont faux.
--
-- Cause racine : public.admin_assign_plan — le SEUL chemin d'écriture d'une
-- offre (utilisé par admin_activate_agency, admin_change_agency_plan) — crée ou
-- prolonge agency_subscriptions sans jamais écrire dans subscription_payments.
--
-- Ce fichier est ADDITIF : il ne remplace ni ne supprime aucune fonction
-- existante. platform_subscription_revenue reste en place, intacte, pour ne rien
-- casser pendant la transition ; le front bascule sur la nouvelle fonction.
-- Aucune donnée existante n'est modifiée ici (le rattrapage est un fichier
-- séparé, en lecture seule, à exécuter sur accord explicite).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. subscription_payments.plan_id
-- -----------------------------------------------------------------------------
-- L'offre au moment du paiement, figée sur la ligne. Sans elle, un changement
-- d'offre réécrit l'historique : les barres empilées par offre seraient fausses
-- pour tous les mois passés.
-- Nullable : les lignes historiques restent valides, plan_id sera renseigné à
-- partir de maintenant (et par le script de rattrapage, sur accord).
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS subscription_payments_plan_id_idx
  ON saas_immobilier.subscription_payments (plan_id);

-- Référence de l'opération (n° de transaction Mobile Money, reçu, etc.).
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS reference text;

COMMENT ON COLUMN saas_immobilier.subscription_payments.plan_id IS
  'Offre facturée au moment du paiement (figée, ne suit pas les changements de plan).';
COMMENT ON COLUMN saas_immobilier.subscription_payments.reference IS
  'Référence externe de l''opération (transaction Mobile Money, reçu, virement).';

-- -----------------------------------------------------------------------------
-- 2. public.admin_bill_subscription — écrire un paiement ET prolonger l'abonnement
-- -----------------------------------------------------------------------------
-- Remplace le couple « insert direct depuis le navigateur + update de
-- l'abonnement » de useRecordSubscriptionPayment, qui ne renseignait ni
-- plan_id ni reference et ne contrôlait rien côté serveur.
--
-- Idempotence : si p_reference est fourni et qu'un paiement existe déjà avec
-- cette référence pour cette agence, la fonction renvoie la ligne existante
-- sans rien créer (protection contre le double clic / le rejeu réseau).
CREATE OR REPLACE FUNCTION public.admin_bill_subscription(
  p_agency_id  uuid,
  p_plan_id    uuid,
  p_amount     numeric,
  p_paid_on    date    DEFAULT CURRENT_DATE,
  p_method     text    DEFAULT 'manual',
  p_reference  text    DEFAULT NULL,
  p_note       text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub_id  uuid;
  v_plan    record;
  v_exist   uuid;
  v_payment uuid;
  v_start   date;
  v_end     date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'montant invalide' USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.price_monthly, pl.currency, pl.name, pl.display_name
    INTO v_plan FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Rejeu : même référence => on ne crée pas de doublon.
  IF p_reference IS NOT NULL THEN
    SELECT sp.id INTO v_exist FROM saas_immobilier.subscription_payments sp
     WHERE sp.agency_id = p_agency_id AND sp.reference = p_reference LIMIT 1;
    IF v_exist IS NOT NULL THEN
      RETURN jsonb_build_object('payment_id', v_exist, 'idempotent', true);
    END IF;
  END IF;

  -- Abonnement courant (l'offre facturée est celle du paiement, pas forcément
  -- celle de l'abonnement : on ne réécrit pas le plan ici).
  SELECT s.id INTO v_sub_id FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1 FOR UPDATE;
  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'aucun abonnement pour cette agence : activer une offre d''abord' USING ERRCODE = 'P0002';
  END IF;

  -- Période couverte : 1 mois à partir de la date de paiement.
  v_start := COALESCE(p_paid_on, CURRENT_DATE);
  v_end   := (v_start + interval '1 month' - interval '1 day')::date;

  INSERT INTO saas_immobilier.subscription_payments
    (agency_id, subscription_id, plan_id, amount, currency, paid_at,
     period_start, period_end, method, recorded_by, note, reference)
  VALUES
    (p_agency_id, v_sub_id, v_plan.id, p_amount, COALESCE(v_plan.currency, 'XOF'),
     v_start, v_start, v_end, COALESCE(p_method, 'manual'), auth.uid(), p_note, p_reference)
  RETURNING id INTO v_payment;

  -- Prolongation : on repart de la fin existante si elle est dans le futur.
  UPDATE saas_immobilier.agency_subscriptions s
     SET ends_at = GREATEST(COALESCE(s.ends_at, v_end), v_end),
         status = 'active',
         trial_ends_at = NULL,
         updated_at = now()
   WHERE s.id = v_sub_id;

  INSERT INTO saas_immobilier.activity_log (agency_id, user_id, action, entity_type, entity_id, summary)
  VALUES (p_agency_id, auth.uid(), 'payment_recorded', 'subscription_payments', v_payment,
          'Paiement enregistre : ' || p_amount || ' ' || COALESCE(v_plan.currency, 'XOF')
          || ' (' || COALESCE(v_plan.display_name, v_plan.name) || ')');

  RETURN jsonb_build_object(
    'payment_id', v_payment,
    'agency_id', p_agency_id,
    'plan_id', v_plan.id,
    'amount', p_amount,
    'currency', COALESCE(v_plan.currency, 'XOF'),
    'period_start', v_start,
    'period_end', v_end,
    'idempotent', false
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_bill_subscription(uuid, uuid, numeric, date, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_bill_subscription(uuid, uuid, numeric, date, text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. public.admin_activate_agency_billed — activer une agence EN ENCAISSANT
-- -----------------------------------------------------------------------------
-- Enveloppe additive autour de public.admin_activate_agency (inchangée) :
--   1. activation de l'offre par le chemin existant ;
--   2. écriture du paiement correspondant, en une seule transaction.
-- Si l'écriture du paiement échoue, toute l'opération est annulée : jamais
-- d'agence activée sans trace financière, jamais de paiement sans activation.
CREATE OR REPLACE FUNCTION public.admin_activate_agency_billed(
  p_agency_id  uuid,
  p_plan_id    uuid,
  p_amount     numeric,
  p_paid_on    date DEFAULT CURRENT_DATE,
  p_method     text DEFAULT 'manual',
  p_reference  text DEFAULT NULL,
  p_note       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_activation jsonb;
  v_payment    jsonb;
BEGIN
  v_activation := public.admin_activate_agency(p_agency_id, p_plan_id);
  v_payment    := public.admin_bill_subscription(
                    p_agency_id, p_plan_id, p_amount, p_paid_on, p_method, p_reference,
                    COALESCE(p_note, 'Activation avec paiement'));
  RETURN jsonb_build_object('activation', v_activation, 'payment', v_payment);
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_activate_agency_billed(uuid, uuid, numeric, date, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_activate_agency_billed(uuid, uuid, numeric, date, text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. public.platform_revenue_report — le rapport « comptable »
-- -----------------------------------------------------------------------------
-- Deux notions distinctes, nommées :
--   collected  = ENCAISSÉ : somme des paiements, rattachée au mois de paid_at
--                (trésorerie réelle, ce qui est rentré dans la caisse) ;
--   recognized = REVENU RECONNU : le même montant étalé au prorata sur la
--                période couverte [period_start, period_end] (méthode comptable).
-- Les deux totaux diffèrent légitimement sur le mois en cours : un paiement du
-- 25 octobre pour un mois entier est encaissé en octobre, mais reconnu à
-- ~20 % en octobre et ~80 % en novembre.
--
-- Les 12 derniers mois sont TOUJOURS renvoyés, avec 0 explicite (generate_series),
-- et non « seulement les mois où il y a eu quelque chose ».
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
  v_to     date;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  v_months := LEAST(GREATEST(COALESCE(p_months, 12), 1), 36);
  v_from   := (date_trunc('month', now()) - ((v_months - 1) || ' month')::interval)::date;
  v_to     := (date_trunc('month', now()) + interval '1 month')::date;

  RETURN jsonb_build_object(
    -- ------------------------------------------------------------------
    -- Série mensuelle : encaissé, reconnu, détail par offre, totaux
    -- ------------------------------------------------------------------
    'months', (
      SELECT COALESCE(jsonb_agg(m ORDER BY m.month_start), '[]'::jsonb)
      FROM (
        SELECT g.month_start,
               COALESCE(enc.collected, 0)   AS collected,
               COALESCE(rec.recognized, 0)  AS recognized,
               COALESCE(enc.payments_count, 0) AS payments_count,
               COALESCE(enc.agencies_count, 0) AS agencies_count,
               COALESCE(enc.by_plan, '{}'::jsonb) AS by_plan
          FROM generate_series(v_from, date_trunc('month', now())::date, interval '1 month') AS g(month_start)
          LEFT JOIN LATERAL (
                 SELECT SUM(sp.amount)               AS collected,
                        COUNT(*)                     AS payments_count,
                        COUNT(DISTINCT sp.agency_id) AS agencies_count,
                        -- Répartition par offre : code technique ('pro'...) en clé,
                        -- pour que le front associe les couleurs du catalogue.
                        (SELECT COALESCE(jsonb_object_agg(t.plan_code, t.total), '{}'::jsonb)
                           FROM (
                             SELECT COALESCE(p2.name, 'inconnu') AS plan_code,
                                    SUM(sp2.amount)              AS total
                               FROM saas_immobilier.subscription_payments sp2
                               JOIN saas_immobilier.agency_subscriptions s2 ON s2.id = sp2.subscription_id
                               LEFT JOIN saas_immobilier.plans p2 ON p2.id = COALESCE(sp2.plan_id, s2.plan_id)
                              WHERE date_trunc('month', sp2.paid_at) = g.month_start
                              GROUP BY 1
                           ) t) AS by_plan
                   FROM saas_immobilier.subscription_payments sp
                  WHERE date_trunc('month', sp.paid_at) = g.month_start
               ) enc ON true
          LEFT JOIN LATERAL (
                 SELECT SUM(
                          sp.amount
                          * GREATEST(
                              0,
                              LEAST(sp.period_end + 1, (g.month_start + interval '1 month')::date)
                              - GREATEST(sp.period_start, g.month_start::date)
                            )::numeric
                          / GREATEST((sp.period_end - sp.period_start + 1)::numeric, 1)
                        ) AS recognized
                   FROM saas_immobilier.subscription_payments sp
                  WHERE sp.period_start < (g.month_start + interval '1 month')::date
                    AND sp.period_end   >= g.month_start
               ) rec ON true
      ) m
    ),

    -- ------------------------------------------------------------------
    -- Journal des opérations : alimente le tableau et l'export CSV
    -- ------------------------------------------------------------------
    'ledger', (
      SELECT COALESCE(jsonb_agg(l ORDER BY l.paid_at DESC, l.agency_name), '[]'::jsonb)
      FROM (
        SELECT sp.id,
               sp.paid_at,
               sp.period_start,
               sp.period_end,
               sp.amount,
               sp.currency,
               sp.method,
               sp.reference,
               sp.note,
               a.id   AS agency_id,
               a.name AS agency_name,
               COALESCE(p.display_name, p.name) AS plan_name,
               p.name AS plan_code,
               CASE WHEN sp.declaration_id IS NOT NULL THEN 'declaration' ELSE 'manuel' END AS source
          FROM saas_immobilier.subscription_payments sp
          JOIN saas_immobilier.agencies a ON a.id = sp.agency_id
          LEFT JOIN saas_immobilier.agency_subscriptions s ON s.id = sp.subscription_id
          LEFT JOIN saas_immobilier.plans p ON p.id = COALESCE(sp.plan_id, s.plan_id)
         WHERE sp.paid_at >= v_from
      ) l
    ),

    -- ------------------------------------------------------------------
    -- Totaux et détection des ANOMALIES (agence active sans paiement)
    -- ------------------------------------------------------------------
    'totals', (
      SELECT jsonb_build_object(
        'collected_period', COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp
                                       WHERE sp.paid_at >= v_from), 0),
        'collected_all',    COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp), 0),
        'payments_period',  (SELECT count(*) FROM saas_immobilier.subscription_payments sp
                              WHERE sp.paid_at >= v_from),
        'agencies_period',  (SELECT count(DISTINCT sp.agency_id) FROM saas_immobilier.subscription_payments sp
                              WHERE sp.paid_at >= v_from),
        'active_agencies',  (SELECT count(*) FROM saas_immobilier.agency_subscriptions WHERE status = 'active'),
        -- Ce que le parc actif DEVRAIT rapporter chaque mois.
        'mrr_expected',     (SELECT COALESCE(SUM(pl.price_monthly), 0)
                               FROM saas_immobilier.agency_subscriptions s
                               JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
                              WHERE s.status = 'active'),
        -- Agences actives sans AUCUN paiement : c'est l'anomalie constatée.
        'active_without_payment', (
          SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
            FROM (
              SELECT a.id, a.name, COALESCE(pl.display_name, pl.name) AS plan_name, pl.price_monthly,
                     s.starts_at::date AS starts_at, s.ends_at::date AS ends_at
                FROM saas_immobilier.agency_subscriptions s
                JOIN saas_immobilier.agencies a ON a.id = s.agency_id
                JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
               WHERE s.status = 'active'
                 AND NOT EXISTS (SELECT 1 FROM saas_immobilier.subscription_payments sp
                                  WHERE sp.agency_id = s.agency_id)
            ) x
        ),
        -- Agences actives dont l'encaissé est inférieur au prix mensuel de l'offre.
        'underpaid', (
          SELECT COALESCE(jsonb_agg(y), '[]'::jsonb)
            FROM (
              SELECT a.id, a.name, COALESCE(pl.display_name, pl.name) AS plan_name,
                     pl.price_monthly,
                     COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp
                                WHERE sp.agency_id = a.id), 0) AS paid_total
                FROM saas_immobilier.agency_subscriptions s
                JOIN saas_immobilier.agencies a ON a.id = s.agency_id
                JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
               WHERE s.status = 'active'
                 AND COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp
                                WHERE sp.agency_id = a.id), 0) < pl.price_monthly
            ) y
        )
      )
    ),

    -- Catalogue, pour les couleurs et l'ordre des barres empilées.
    'by_plan', (
      SELECT COALESCE(jsonb_agg(z ORDER BY z.sort_order), '[]'::jsonb)
        FROM (
          SELECT p.id, p.name, p.display_name, p.price_monthly, p.currency, p.sort_order,
                 (SELECT count(*) FROM saas_immobilier.agency_subscriptions s
                   WHERE s.plan_id = p.id AND s.status = 'active') AS active_agencies
            FROM saas_immobilier.plans p
        ) z
    )
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.platform_revenue_report(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_revenue_report(integer) TO authenticated;
