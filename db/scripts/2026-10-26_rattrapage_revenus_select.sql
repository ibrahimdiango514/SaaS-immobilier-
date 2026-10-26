-- =============================================================================
-- RATTRAPAGE DES REVENUS — SCRIPT EN LECTURE SEULE (AUCUNE ÉCRITURE)
-- =============================================================================
-- ⚠️  Ce fichier ne contient QUE des SELECT. Il ne crée, ne modifie et ne
-- supprime aucune ligne. Il sert à MESURER ce qu'un rattrapage créerait, pour
-- décider en connaissance de cause.
--
-- Contexte mesuré le 2026-10-26 :
--   * SBC AI Agency Demo : offre Pro (100 000/mois), 1 paiement de 50 000 ;
--   * Immo Diango        : offre Pro (100 000/mois), AUCUN paiement.
--
-- À exécuter par blocs séparés (l'éditeur SQL n'aime pas les gros lots).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Vue d'ensemble : ce qui est attendu vs ce qui est encaissé
-- -----------------------------------------------------------------------------
SELECT
  a.name                                   AS agence,
  COALESCE(pl.display_name, pl.name)       AS offre,
  pl.price_monthly                         AS prix_mensuel,
  s.status                                 AS statut_abonnement,
  s.starts_at::date                        AS debut,
  s.ends_at::date                          AS fin,
  COALESCE((SELECT SUM(sp.amount)
              FROM saas_immobilier.subscription_payments sp
             WHERE sp.agency_id = a.id), 0) AS total_encaisse,
  (SELECT count(*)
     FROM saas_immobilier.subscription_payments sp
    WHERE sp.agency_id = a.id)              AS nb_paiements
FROM saas_immobilier.agency_subscriptions s
JOIN saas_immobilier.agencies a  ON a.id = s.agency_id
JOIN saas_immobilier.plans pl    ON pl.id = s.plan_id
WHERE s.status = 'active'
ORDER BY a.name;

-- -----------------------------------------------------------------------------
-- B. Anomalies explicites
-- -----------------------------------------------------------------------------
-- B1. Agences ACTIVES sans AUCUN paiement (le cas d'Immo Diango).
SELECT a.name AS agence, COALESCE(pl.display_name, pl.name) AS offre, pl.price_monthly,
       s.starts_at::date AS debut, s.ends_at::date AS fin
  FROM saas_immobilier.agency_subscriptions s
  JOIN saas_immobilier.agencies a ON a.id = s.agency_id
  JOIN saas_immobilier.plans pl   ON pl.id = s.plan_id
 WHERE s.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM saas_immobilier.subscription_payments sp
                    WHERE sp.agency_id = s.agency_id);

-- B2. Agences actives dont l'encaissé est inférieur au prix mensuel (sous-paiement).
SELECT a.name AS agence, COALESCE(pl.display_name, pl.name) AS offre, pl.price_monthly,
       COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp
                  WHERE sp.agency_id = a.id), 0) AS total_encaisse,
       pl.price_monthly - COALESCE((SELECT SUM(sp.amount)
                                      FROM saas_immobilier.subscription_payments sp
                                     WHERE sp.agency_id = a.id), 0) AS manque
  FROM saas_immobilier.agency_subscriptions s
  JOIN saas_immobilier.agencies a ON a.id = s.agency_id
  JOIN saas_immobilier.plans pl   ON pl.id = s.plan_id
 WHERE s.status = 'active'
   AND COALESCE((SELECT SUM(sp.amount) FROM saas_immobilier.subscription_payments sp
                  WHERE sp.agency_id = a.id), 0) < pl.price_monthly;

-- -----------------------------------------------------------------------------
-- C. APERÇU de ce qu'un rattrapage créerait — un mois facturable par ligne
--    manquante, au prix de l'offre, avec la période couverte correspondante.
--    Lecture seule : rien n'est inséré.
-- -----------------------------------------------------------------------------
WITH mois_actifs AS (
  SELECT s.id            AS subscription_id,
         s.agency_id,
         s.plan_id,
         a.name          AS agence,
         COALESCE(pl.display_name, pl.name) AS offre,
         pl.price_monthly,
         pl.currency,
         s.starts_at
    FROM saas_immobilier.agency_subscriptions s
    JOIN saas_immobilier.agencies a ON a.id = s.agency_id
    JOIN saas_immobilier.plans pl   ON pl.id = s.plan_id
   WHERE s.status = 'active'
),
mois AS (
  SELECT m.subscription_id, m.agency_id, m.plan_id, m.agence, m.offre,
         m.price_monthly, m.currency,
         g.mois::date                              AS period_start,
         (g.mois + interval '1 month' - interval '1 day')::date AS period_end
    FROM mois_actifs m
    CROSS JOIN LATERAL generate_series(
           date_trunc('month', m.starts_at),
           date_trunc('month', now()),
           interval '1 month') AS g(mois)
)
SELECT mois.agence,
       mois.offre,
       mois.price_monthly                     AS montant_a_creer,
       mois.currency,
       mois.period_start,
       mois.period_end,
       'aucun paiement couvrant cette periode' AS motif
  FROM mois
 WHERE NOT EXISTS (
         SELECT 1 FROM saas_immobilier.subscription_payments sp
          WHERE sp.agency_id = mois.agency_id
            AND sp.period_start <= mois.period_start
            AND sp.period_end   >= mois.period_end
       )
 ORDER BY mois.agence, mois.period_start;

-- -----------------------------------------------------------------------------
-- D. Total qui serait créé par le rattrapage (chiffre à valider avant accord)
-- -----------------------------------------------------------------------------
-- ⚠️  LIRE AVANT DE CHIFFRER : la condition « aucune période ne couvre ce mois
-- EN ENTIER » est STRICTE. Un paiement partiel (ex. 50 000 pour un mois à
-- 100 000, du 21/10 au 20/11) ne couvre aucun mois entier : les mois concernés
-- ressortent donc comme « manquants » alors qu'ils sont partiellement payés.
-- Le total ci-dessous est donc un MAJORANT. Le détail ligne par ligne (bloc C)
-- permet de distinguer « aucun paiement » de « paiement partiel ».
WITH mois_actifs AS (
  SELECT s.id AS subscription_id, s.agency_id, s.plan_id, a.name AS agence,
         pl.price_monthly, pl.currency, s.starts_at
    FROM saas_immobilier.agency_subscriptions s
    JOIN saas_immobilier.agencies a ON a.id = s.agency_id
    JOIN saas_immobilier.plans pl   ON pl.id = s.plan_id
   WHERE s.status = 'active'
),
mois AS (
  SELECT m.agency_id, m.price_monthly, m.currency,
         g.mois::date AS period_start,
         (g.mois + interval '1 month' - interval '1 day')::date AS period_end
    FROM mois_actifs m
    CROSS JOIN LATERAL generate_series(
           date_trunc('month', m.starts_at),
           date_trunc('month', now()),
           interval '1 month') AS g(mois)
)
SELECT count(*)                    AS nb_lignes_a_creer,
       COALESCE(SUM(price_monthly), 0) AS montant_total_a_creer,
       min(currency)               AS devise
  FROM mois
 WHERE NOT EXISTS (
         SELECT 1 FROM saas_immobilier.subscription_payments sp
          WHERE sp.agency_id = mois.agency_id
            AND sp.period_start <= mois.period_start
            AND sp.period_end   >= mois.period_end
       );

-- -----------------------------------------------------------------------------
-- D2. Le chiffre INCONTESTABLE : agences actives n'ayant AUCUN paiement du tout.
--     C'est le seul montant que l'on peut affirmer sans interprétation.
-- -----------------------------------------------------------------------------
SELECT a.name AS agence,
       COALESCE(pl.display_name, pl.name) AS offre,
       pl.price_monthly                   AS montant_du,
       pl.currency
  FROM saas_immobilier.agency_subscriptions s
  JOIN saas_immobilier.agencies a ON a.id = s.agency_id
  JOIN saas_immobilier.plans pl   ON pl.id = s.plan_id
 WHERE s.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM saas_immobilier.subscription_payments sp
                    WHERE sp.agency_id = s.agency_id);

-- -----------------------------------------------------------------------------
-- D3. Écart de sous-paiement sur la période en cours (SBC : 50 000 sur 100 000).
-- -----------------------------------------------------------------------------
SELECT a.name                                   AS agence,
       COALESCE(pl.display_name, pl.name)       AS offre,
       pl.price_monthly                         AS prix_mensuel,
       COALESCE(SUM(sp.amount), 0)              AS encaisse,
       pl.price_monthly - COALESCE(SUM(sp.amount), 0) AS manque
  FROM saas_immobilier.agency_subscriptions s
  JOIN saas_immobilier.agencies a ON a.id = s.agency_id
  JOIN saas_immobilier.plans pl   ON pl.id = s.plan_id
  LEFT JOIN saas_immobilier.subscription_payments sp ON sp.agency_id = a.id
 WHERE s.status = 'active'
 GROUP BY a.name, pl.display_name, pl.name, pl.price_monthly
HAVING COALESCE(SUM(sp.amount), 0) < pl.price_monthly;
