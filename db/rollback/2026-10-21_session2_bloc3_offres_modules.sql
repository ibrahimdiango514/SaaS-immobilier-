-- =============================================================================
-- ROLLBACK — SESSION 2 BLOC 3 : fonctionnalités par offre
-- Annule db/migrations/2026-10-21_session2_bloc3_offres_modules.sql
--
-- Valeurs d'ORIGINE, relevées avant modification.
-- ⚠️ Ce rollback retire `visites` de l'offre Essentiel et retire `assistant_ia`
--    de TOUTES les offres : la page Visites redevient verrouillée pour l'agence
--    de démonstration, et l'assistant IA ne serait déclaré par aucun plan.
-- =============================================================================

UPDATE saas_immobilier.plans SET
  modules = '["biens","contacts","pipeline","dashboard","ca_chart"]'::jsonb,
  features = '{"crm":true,"sofia":true}'::jsonb
 WHERE name = 'starter';

UPDATE saas_immobilier.plans SET
  modules = '["biens","contacts","pipeline","dashboard","ca_chart","visites","automatisations","ca_filters","ca_export_csv"]'::jsonb,
  features = '{"crm":true,"sofia":true,"whatsapp":true,"analytics":true}'::jsonb
 WHERE name = 'pro';

UPDATE saas_immobilier.plans SET
  modules = '["biens","contacts","pipeline","dashboard","ca_chart","visites","automatisations","ca_filters","ca_export_csv","stats_avancees","rapports_mensuels","support_prioritaire"]'::jsonb,
  features = '{"crm":true,"sofia":true,"whatsapp":true,"analytics":true,"priority_support":true}'::jsonb
 WHERE name = 'enterprise';

SELECT name, display_name, modules::text FROM saas_immobilier.plans ORDER BY price_monthly;
