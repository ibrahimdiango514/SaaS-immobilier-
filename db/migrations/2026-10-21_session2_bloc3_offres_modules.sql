-- =============================================================================
-- SESSION 2 — BLOC 3 : FONCTIONNALITÉS PAR OFFRE (réellement appliquées)
-- Projet : xbuuhfwobrafcbgtdgjx — appliqué le 2026-10-21 via execute_query
-- Rollback : db/rollback/2026-10-21_session2_bloc3_offres_modules.sql
--
-- Répartition demandée :
--   ESSENTIEL : biens, contacts, pipeline, VISITES, vue d'ensemble + graphique CA
--   PRO       : Essentiel + automatisations, CA filtres de période, CA export CSV,
--               assistant IA du dashboard
--   PREMIUM   : Pro + statistiques avancées, rapports mensuels, support prioritaire
--
-- DEUX colonnes des 3 lignes de `plans` sont modifiées, et rien d'autre :
--   • `modules`  — c'est la colonne qui PILOTE l'application (`agency_has_module`,
--                  page Mon offre, comparatif d'offres, menu et routes).
--   • `features` — mise en cohérence sur les mêmes clés, pour que les deux
--                  lectures affichent la même répartition.
-- Les anciennes valeurs sont recopiées mot pour mot dans le rollback.
--
-- ANOMALIES corrigées au passage (constatées avant modification) :
--   • `visites` MANQUAIT dans Essentiel (présent seulement en Pro/Premium) alors
--     que la page Visites est un module complet et fonctionnel ;
--   • `assistant_ia` n'était dans AUCUNE offre, y compris Pro et Premium — le
--     module ajouté au BLOC 8 n'était donc déclaré nulle part dans le catalogue.
-- =============================================================================

UPDATE saas_immobilier.plans SET
  modules = '["biens","contacts","pipeline","visites","dashboard","ca_chart"]'::jsonb,
  features = '{"crm":true,"sofia":true,"biens":true,"contacts":true,"pipeline":true,"visites":true,"dashboard":true,"ca_chart":true}'::jsonb
 WHERE name = 'starter';

UPDATE saas_immobilier.plans SET
  modules = '["biens","contacts","pipeline","visites","dashboard","ca_chart","automatisations","ca_filters","ca_export_csv","assistant_ia"]'::jsonb,
  features = '{"crm":true,"sofia":true,"biens":true,"contacts":true,"pipeline":true,"visites":true,"dashboard":true,"ca_chart":true,"automatisations":true,"ca_filters":true,"ca_export_csv":true,"assistant_ia":true,"whatsapp":true,"analytics":true}'::jsonb
 WHERE name = 'pro';

UPDATE saas_immobilier.plans SET
  modules = '["biens","contacts","pipeline","visites","dashboard","ca_chart","automatisations","ca_filters","ca_export_csv","assistant_ia","stats_avancees","rapports_mensuels","support_prioritaire"]'::jsonb,
  features = '{"crm":true,"sofia":true,"biens":true,"contacts":true,"pipeline":true,"visites":true,"dashboard":true,"ca_chart":true,"automatisations":true,"ca_filters":true,"ca_export_csv":true,"assistant_ia":true,"whatsapp":true,"analytics":true,"stats_avancees":true,"rapports_mensuels":true,"priority_support":true}'::jsonb
 WHERE name = 'enterprise';

-- Vérification
SELECT name, display_name, price_monthly, modules::text
  FROM saas_immobilier.plans ORDER BY price_monthly;

-- Vérification fonctionnelle : le module `visites` doit être accordé aux 3 offres,
-- `assistant_ia` seulement à Pro et Premium.
SELECT a.slug,
       public.agency_has_module(a.id, 'visites')      AS a_visites,
       public.agency_has_module(a.id, 'assistant_ia') AS a_assistant,
       public.agency_has_module(a.id, 'automatisations') AS a_automatisations
  FROM saas_immobilier.agencies a ORDER BY a.slug;
