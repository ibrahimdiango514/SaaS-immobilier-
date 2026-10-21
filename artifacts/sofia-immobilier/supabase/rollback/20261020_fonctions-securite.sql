-- =============================================================================
-- FICHIER DE RETOUR ARRIÈRE — Fonctions de sécurité
-- Projet : xbuuhfwobrafcbgtdgjx  ·  Date : 2026-10-20
--
-- Ce fichier contient les définitions EXACTES des fonctions telles qu'elles
-- existaient AVANT le lot « agence suspendue » (2026-10-20).
-- Pour revenir en arrière en une commande : exécuter l'intégralité de ce
-- fichier dans l'ordre (SQL Editor Supabase ou psql), puis recharger l'app.
--
-- Fonctions restaurées :
--   1. public.is_agency_member               (avant : sans condition de statut agence)
--   2. public.has_agency_role                (idem)
--   3. saas_immobilier.can_write_property_object (idem)
--   4. saas_immobilier.can_delete_property_object (search_path d'origine)
--   5. saas_immobilier.log_activity          (search_path d'origine, journal)
--
-- Note : la table saas_immobilier.revenue_operations, les RPC mon_etat_compte /
-- agence_active et le compte de test désactivé sont ADDITIFS — ils restent en
-- place après ce rollback (aucune donnée n'est supprimée par ce fichier).
-- Pour les retirer également, voir la fin de ce fichier (section facultative).
-- =============================================================================

-- 1. public.is_agency_member -------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_agency_member(target_agency_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$SELECT EXISTS(SELECT 1 FROM saas_immobilier.agency_members am WHERE am.agency_id=target_agency_id AND am.user_id=(SELECT auth.uid()) AND am.status='active') OR public.is_platform_admin();$function$;

-- 2. public.has_agency_role ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_agency_role(target_agency_id uuid, required_role text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$SELECT EXISTS(SELECT 1 FROM saas_immobilier.agency_members am WHERE am.agency_id=target_agency_id AND am.user_id=(SELECT auth.uid()) AND am.status='active' AND (am.role=required_role OR (required_role='admin' AND am.role='owner'))) OR public.is_platform_admin();$function$;

-- 3. saas_immobilier.can_write_property_object --------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.can_write_property_object(object_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'saas_immobilier', 'public'
AS $function$
  SELECT
    public.is_platform_admin()
    OR (
      split_part(object_path, '/', 1) = 'properties'
      AND object_path NOT LIKE '%..%'
      AND (
        EXISTS (
          SELECT 1
          FROM saas_immobilier.property_media pm
          JOIN saas_immobilier.agency_members m ON m.agency_id = pm.agency_id
          WHERE pm.storage_path = object_path
            AND m.user_id = auth.uid()
            AND m.status = 'active'
        )
        OR EXISTS (
          SELECT 1
          FROM saas_immobilier.properties p
          JOIN saas_immobilier.agency_members m ON m.agency_id = p.agency_id
          WHERE left(
                  coalesce(
                    nullif(
                      upper(
                        regexp_replace(
                          btrim(p.reference),
                          '[^A-Za-z0-9_-]+',
                          '',
                          'g'
                        )
                      ),
                      ''
                    ),
                    'BIEN'
                  ),
                  24
                ) = split_part(object_path, '/', 2)
            AND m.user_id = auth.uid()
            AND m.status = 'active'
        )
      )
    );
$function$;

-- 4. saas_immobilier.can_delete_property_object (search_path d'origine) -------
CREATE OR REPLACE FUNCTION saas_immobilier.can_delete_property_object(object_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'saas_immobilier', 'public'
AS $function$
  SELECT
    public.is_platform_admin()
    OR saas_immobilier.can_write_property_object(object_path);
$function$;

-- 5. saas_immobilier.log_activity (search_path d'origine) ---------------------
CREATE OR REPLACE FUNCTION saas_immobilier.log_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = saas_immobilier, public
AS $$
DECLARE
  v_agency uuid;
  v_action text;
  v_entity text;
  v_entity_id uuid;
  v_summary text;
BEGIN
  v_action := CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END;
  v_entity := TG_ARGV[0];

  IF TG_OP = 'DELETE' THEN
    v_agency := to_jsonb(OLD) ->> 'agency_id';
    v_entity_id := to_jsonb(OLD) ->> 'id';
  ELSE
    v_agency := to_jsonb(NEW) ->> 'agency_id';
    v_entity_id := to_jsonb(NEW) ->> 'id';
  END IF;

  v_summary := CASE
    WHEN v_entity = 'properties' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Bien « ' || (to_jsonb(NEW) ->> 'title') || ' » créé'
        WHEN 'UPDATE' THEN 'Bien « ' || (to_jsonb(NEW) ->> 'title') || ' » modifié'
        ELSE 'Bien « ' || (to_jsonb(OLD) ->> 'title') || ' » supprimé'
      END
    WHEN v_entity = 'contacts' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Contact ' || (to_jsonb(NEW) ->> 'full_name') || ' (' || (to_jsonb(NEW) ->> 'status') || ')'
        WHEN 'UPDATE' THEN 'Contact ' || (to_jsonb(NEW) ->> 'full_name') || ' mis à jour'
        ELSE 'Contact ' || (to_jsonb(OLD) ->> 'full_name') || ' supprimé'
      END
    WHEN v_entity = 'agencies' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Agence « ' || (to_jsonb(NEW) ->> 'name') || ' » créée'
        WHEN 'UPDATE' THEN 'Agence « ' || (to_jsonb(NEW) ->> 'name') || ' » modifiée'
        ELSE 'Agence « ' || (to_jsonb(OLD) ->> 'name') || ' » supprimée'
      END
    WHEN v_entity = 'agency_members' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Accès membre ' || left((to_jsonb(NEW) ->> 'user_id')::text, 8) || '… — rôle ' || (to_jsonb(NEW) ->> 'role')
        WHEN 'UPDATE' THEN 'Accès membre modifié — rôle ' || (to_jsonb(NEW) ->> 'role') || ' / ' || (to_jsonb(NEW) ->> 'status')
        ELSE 'Accès membre supprimé'
      END
    WHEN v_entity = 'property_visits' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Visite (' || (to_jsonb(NEW) ->> 'status') || ')'
        WHEN 'UPDATE' THEN 'Visite mise à jour (' || (to_jsonb(NEW) ->> 'status') || ')'
        ELSE 'Visite supprimée'
      END
    WHEN v_entity = 'sales_pipeline' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Opportunité — étape « ' || (to_jsonb(NEW) ->> 'stage') || ' »'
        WHEN 'UPDATE' THEN 'Opportunité déplacée vers « ' || (to_jsonb(NEW) ->> 'stage') || ' »'
        ELSE 'Opportunité supprimée'
      END
    WHEN v_entity = 'conversations' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Conversation ouverte'
        WHEN 'UPDATE' THEN 'Conversation mise à jour'
        ELSE 'Conversation supprimée'
      END
    WHEN v_entity = 'property_media' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Photo « ' || (to_jsonb(NEW) ->> 'file_name') || ' » ajoutée'
        WHEN 'UPDATE' THEN 'Photo mise à jour'
        ELSE 'Photo supprimée'
      END
    WHEN v_entity = 'follow_ups' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Relance créée (' || (to_jsonb(NEW) ->> 'status') || ')'
        WHEN 'UPDATE' THEN 'Relance mise à jour (' || (to_jsonb(NEW) ->> 'status') || ')'
        ELSE 'Relance supprimée'
      END
    WHEN v_entity = 'agency_subscriptions' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Abonnement créé'
        WHEN 'UPDATE' THEN 'Abonnement modifié'
        ELSE 'Abonnement supprimé'
      END
    WHEN v_entity = 'whatsapp_connections' THEN
      CASE TG_OP
        WHEN 'INSERT' THEN 'Connexion WhatsApp enregistrée'
        WHEN 'UPDATE' THEN 'Connexion WhatsApp mise à jour'
        ELSE 'Connexion WhatsApp supprimée'
      END
    ELSE v_entity || ' : ' || v_action
  END;

  INSERT INTO saas_immobilier.activity_log (agency_id, user_id, action, entity_type, entity_id, summary, metadata)
  VALUES (
    v_agency,
    auth.uid(),
    v_action,
    v_entity,
    v_entity_id,
    v_summary,
    jsonb_build_object('table', TG_TABLE_NAME, 'op', TG_OP)
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =============================================================================
-- (FACULTATIF) — Pour retirer aussi les éléments ADDITIFS de ce lot :
--
-- DROP TRIGGER IF EXISTS activity_log_revenue_operations ON saas_immobilier.revenue_operations;
-- DROP TABLE IF EXISTS saas_immobilier.revenue_operations;
-- DROP FUNCTION IF EXISTS saas_immobilier.mon_etat_compte();
-- DROP FUNCTION IF EXISTS saas_immobilier.agence_active(uuid);
-- -- Compte de test désactivé (ou utiliser supabase/test-account-cleanup.sql) :
-- DELETE FROM saas_immobilier.agency_members WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'agence.desactivee.test@example.com');
-- DELETE FROM saas_immobilier.agencies WHERE slug = 'agence-test-suspendue';
-- DELETE FROM auth.users WHERE email = 'agence.desactivee.test@example.com';
-- =============================================================================
