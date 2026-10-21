-- =============================================================================
-- LOT A — RETOUR ARRIÈRE COMPLET
-- Projet Supabase : xbuuhfwobrafcbgtdgjx
-- =============================================================================
-- Ce script annule intégralement la migration db/migrations/2026-10-20_lot_a.sql
-- dans l'ordre inverse de sa création.
--
-- Il ne supprime AUCUNE donnée métier préexistante : les 3 lignes de `plans`
-- sont remises exactement aux valeurs relevées avant migration, et les agences
-- conservent leur plan_id d'origine (aucun abonnement n'est recréé ni déplacé).
--
-- Exécution : bloc par bloc, dans l'ordre. Chaque bloc est indépendant et
-- idempotent (IF EXISTS / IF NOT EXISTS), le script peut donc être relancé.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Désactiver puis retirer le job pg_cron
-- -----------------------------------------------------------------------------
-- Désactivation sans suppression (le job reste défini mais ne tourne plus) :
--   UPDATE cron.job SET active = false WHERE jobname = 'sofia-lot-a-suspend-overdue';
-- Suppression définitive :
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('sofia-lot-a-suspend-overdue');
  END IF;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'cron.job absent : rien à désordonnancer.';
END $$;


-- -----------------------------------------------------------------------------
-- 2. Supprimer les triggers de limites de plan (créés au §5 de la migration)
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS properties_enforce_plan_limit    ON saas_immobilier.properties;
DROP TRIGGER IF EXISTS property_media_enforce_photo_limit ON saas_immobilier.property_media;
DROP TRIGGER IF EXISTS agency_members_enforce_plan_limit ON saas_immobilier.agency_members;


-- -----------------------------------------------------------------------------
-- 3. Supprimer les politiques RLS ajoutées (§6 de la migration)
--    Aucune politique préexistante n'est touchée.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS agency_invitations_select_admin      ON saas_immobilier.agency_invitations;
DROP POLICY IF EXISTS agency_invitations_insert_admin      ON saas_immobilier.agency_invitations;
DROP POLICY IF EXISTS agency_invitations_update_admin      ON saas_immobilier.agency_invitations;
DROP POLICY IF EXISTS agency_invitations_delete_admin      ON saas_immobilier.agency_invitations;

DROP POLICY IF EXISTS payment_declarations_insert_member   ON saas_immobilier.payment_declarations;
DROP POLICY IF EXISTS payment_declarations_select_member   ON saas_immobilier.payment_declarations;
DROP POLICY IF EXISTS payment_declarations_admin_all       ON saas_immobilier.payment_declarations;

DROP POLICY IF EXISTS plan_change_requests_insert_member   ON saas_immobilier.plan_change_requests;
DROP POLICY IF EXISTS plan_change_requests_select_member   ON saas_immobilier.plan_change_requests;
DROP POLICY IF EXISTS plan_change_requests_admin_all       ON saas_immobilier.plan_change_requests;

DROP POLICY IF EXISTS platform_settings_select_authenticated ON saas_immobilier.platform_settings;
DROP POLICY IF EXISTS platform_settings_admin_write          ON saas_immobilier.platform_settings;

DROP POLICY IF EXISTS subscription_payments_select_member  ON saas_immobilier.subscription_payments;


-- -----------------------------------------------------------------------------
-- 4. Supprimer les fonctions ajoutées (§4 de la migration)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.enforce_property_limit();
DROP FUNCTION IF EXISTS public.enforce_photo_limit();
DROP FUNCTION IF EXISTS public.enforce_member_limit();

DROP FUNCTION IF EXISTS public.agency_current_plan(uuid);
DROP FUNCTION IF EXISTS public.plan_limit_value(uuid, text);
DROP FUNCTION IF EXISTS public.agency_usage_snapshot(uuid);
DROP FUNCTION IF EXISTS public.agency_has_module(uuid, text);
DROP FUNCTION IF EXISTS public.agency_billing_state(uuid);

DROP FUNCTION IF EXISTS public.create_agency_invitation(uuid, text);
DROP FUNCTION IF EXISTS public.redeem_agency_invitation(text, text, text);
DROP FUNCTION IF EXISTS public.revoke_agency_invitation(uuid);
DROP FUNCTION IF EXISTS public.agency_seat_availability(uuid);

DROP FUNCTION IF EXISTS public.request_plan_change(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.admin_handle_plan_change(uuid, text, text);
DROP FUNCTION IF EXISTS public.admin_change_agency_plan(uuid, uuid);

DROP FUNCTION IF EXISTS public.submit_payment_declaration(uuid, numeric, text, text, date, text);
DROP FUNCTION IF EXISTS public.review_payment_declaration(uuid, text, text);

DROP FUNCTION IF EXISTS public.suspend_overdue_agencies();
DROP FUNCTION IF EXISTS public.reactivate_agency(uuid, text);


-- -----------------------------------------------------------------------------
-- 5. Supprimer les index puis les 4 nouvelles tables
-- -----------------------------------------------------------------------------
DROP INDEX IF EXISTS saas_immobilier.ux_agency_invitations_token_hash;
DROP INDEX IF EXISTS saas_immobilier.ix_agency_invitations_agency;
DROP INDEX IF EXISTS saas_immobilier.ix_payment_declarations_status;
DROP INDEX IF EXISTS saas_immobilier.ix_payment_declarations_agency;
DROP INDEX IF EXISTS saas_immobilier.ix_plan_change_requests_status;
DROP INDEX IF EXISTS saas_immobilier.ix_plan_change_requests_agency;

DROP TABLE IF EXISTS saas_immobilier.agency_invitations;
DROP TABLE IF EXISTS saas_immobilier.payment_declarations;
DROP TABLE IF EXISTS saas_immobilier.plan_change_requests;
DROP TABLE IF EXISTS saas_immobilier.platform_settings;


-- -----------------------------------------------------------------------------
-- 6. Retirer les colonnes ajoutées (§1 de la migration)
-- -----------------------------------------------------------------------------
ALTER TABLE saas_immobilier.plans
  DROP COLUMN IF EXISTS display_name,
  DROP COLUMN IF EXISTS setup_fee,
  DROP COLUMN IF EXISTS max_photos_per_property,
  DROP COLUMN IF EXISTS monthly_agent_messages,
  DROP COLUMN IF EXISTS monthly_follow_ups,
  DROP COLUMN IF EXISTS modules,
  DROP COLUMN IF EXISTS sort_order;

ALTER TABLE saas_immobilier.subscription_payments
  DROP COLUMN IF EXISTS declaration_id,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS provider_reference,
  DROP COLUMN IF EXISTS provider_status;

ALTER TABLE saas_immobilier.user_profiles
  DROP COLUMN IF EXISTS must_change_password;

ALTER TABLE saas_immobilier.agencies
  DROP COLUMN IF EXISTS suspended_at,
  DROP COLUMN IF EXISTS suspended_reason,
  DROP COLUMN IF EXISTS auto_suspend_disabled_until;


-- -----------------------------------------------------------------------------
-- 7. Remettre les 3 lignes de `plans` aux valeurs EXACTES d'avant migration
--    (valeurs relevées par SELECT avant exécution, le 2026-10-20)
--    Aucune ligne n'est insérée ni supprimée : UPDATE par id uniquement.
-- -----------------------------------------------------------------------------
UPDATE saas_immobilier.plans SET
  name                    = 'starter',
  description             = 'SBC AI Agency Starter',
  price_monthly           = 0.00,
  currency                = 'XOF',
  max_members             = 3,
  max_properties          = 50,
  max_whatsapp_connections = 1,
  monthly_ai_tokens       = 100000,
  monthly_conversations   = 500,
  features                = '{"crm": true, "sofia": true}'::jsonb
WHERE id = '4f457a46-b1b2-407f-9c75-30347d6d9ae0';

UPDATE saas_immobilier.plans SET
  name                    = 'pro',
  description             = 'Plan Pro Agence — Idéal pour les agences en croissance à Bamako',
  price_monthly           = 75000.00,
  currency                = 'XOF',
  max_members             = 10,
  max_properties          = 250,
  max_whatsapp_connections = 3,
  monthly_ai_tokens       = 500000,
  monthly_conversations   = 2500,
  features                = '{"crm": true, "sofia": true, "whatsapp": true, "analytics": true}'::jsonb
WHERE id = '940bb1ac-6116-42f8-a3d1-2c7d9178692f';

UPDATE saas_immobilier.plans SET
  name                    = 'enterprise',
  description             = 'Plan Enterprise — Portefeuille illimité et multi-agents',
  price_monthly           = 195000.00,
  currency                = 'XOF',
  max_members             = 50,
  max_properties          = 2000,
  max_whatsapp_connections = 10,
  monthly_ai_tokens       = 2500000,
  monthly_conversations   = 15000,
  features                = '{"crm": true, "sofia": true, "whatsapp": true, "analytics": true, "priority_support": true}'::jsonb
WHERE id = 'b7a4ea74-7de5-4b99-9dd6-86bf9b03247a';


-- -----------------------------------------------------------------------------
-- 8. Retirer l'extension pg_cron SI ET SEULEMENT SI la migration l'a installée.
--    Vérifier d'abord : SELECT * FROM pg_extension WHERE extname='pg_cron';
--    Avant la migration du 2026-10-20, pg_cron n'était PAS installé
--    (extensions présentes : btree_gist, pg_stat_statements, pgcrypto,
--     plpgsql, supabase_vault, uuid-ossp).
-- -----------------------------------------------------------------------------
-- DROP EXTENSION IF EXISTS pg_cron;


-- -----------------------------------------------------------------------------
-- 9. Bucket de stockage privé des captures de paiement
--    (Supabase Storage : les objets doivent partir avant le bucket)
-- -----------------------------------------------------------------------------
-- DELETE FROM storage.objects WHERE bucket_id = 'payment-proofs';
-- DELETE FROM storage.buckets WHERE id = 'payment-proofs';


-- -----------------------------------------------------------------------------
-- 10. Vérification post-retour arrière
-- -----------------------------------------------------------------------------
-- Le résultat attendu est 0 partout :
--   SELECT
--     (SELECT count(*) FROM information_schema.columns
--        WHERE table_schema='saas_immobilier' AND table_name='plans'
--          AND column_name IN ('display_name','setup_fee','max_photos_per_property',
--                              'monthly_agent_messages','monthly_follow_ups',
--                              'modules','sort_order'))            AS plans_cols,
--     (SELECT count(*) FROM information_schema.tables
--        WHERE table_schema='saas_immobilier'
--          AND table_name IN ('agency_invitations','payment_declarations',
--                             'plan_change_requests','platform_settings')) AS new_tables,
--     (SELECT count(*) FROM pg_trigger t
--        JOIN pg_class c ON c.oid=t.tgrelid
--        JOIN pg_namespace n ON n.oid=c.relnamespace
--        WHERE n.nspname='saas_immobilier'
--          AND t.tgname IN ('properties_enforce_plan_limit',
--                           'property_media_enforce_photo_limit',
--                           'agency_members_enforce_plan_limit'))  AS new_triggers;
--
-- Et les 3 plans doivent retrouver leurs valeurs d'origine :
--   SELECT name, price_monthly, max_members, max_properties,
--          max_whatsapp_connections, monthly_ai_tokens, monthly_conversations
--     FROM saas_immobilier.plans ORDER BY price_monthly;
