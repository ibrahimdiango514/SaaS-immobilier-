-- Journal d'activité global (Sofia Immobilier)
-- Appliqué le 2026-10-19 sur le projet Supabase xbuuhfwobrafcbgtdgjx.
-- Seule migration DDL ajoutée pour l'espace administration.

CREATE TABLE IF NOT EXISTS saas_immobilier.activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid REFERENCES saas_immobilier.agencies(id) ON DELETE SET NULL,
  user_id uuid,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  entity_type text NOT NULL,
  entity_id uuid,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_log_agency_id_idx ON saas_immobilier.activity_log (agency_id);
CREATE INDEX IF NOT EXISTS activity_log_created_at_idx ON saas_immobilier.activity_log (created_at DESC);

ALTER TABLE saas_immobilier.activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activity_log_select_admin ON saas_immobilier.activity_log;
CREATE POLICY activity_log_select_admin ON saas_immobilier.activity_log
  FOR SELECT TO authenticated USING (public.is_platform_admin());

DROP POLICY IF EXISTS activity_log_select_member ON saas_immobilier.activity_log;
CREATE POLICY activity_log_select_member ON saas_immobilier.activity_log
  FOR SELECT TO authenticated
  USING (agency_id IS NOT NULL AND public.is_agency_member(agency_id));

DROP POLICY IF EXISTS activity_log_insert_member ON saas_immobilier.activity_log;
CREATE POLICY activity_log_insert_member ON saas_immobilier.activity_log
  FOR INSERT TO authenticated
  WITH CHECK (agency_id IS NOT NULL AND public.is_agency_member(agency_id));

DROP POLICY IF EXISTS activity_log_delete_admin ON saas_immobilier.activity_log;
CREATE POLICY activity_log_delete_admin ON saas_immobilier.activity_log
  FOR DELETE TO authenticated USING (public.is_platform_admin());

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
  -- Ne jamais bloquer l'opération métier à cause du journal.
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  t record;
  entity_name text;
BEGIN
  FOR t IN
    SELECT tgname, tgrelid::regclass::text AS tbl
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname LIKE 'activity\_log\_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', t.tgname, t.tbl);
  END LOOP;

  FOREACH entity_name IN ARRAY ARRAY[
    'agencies', 'agency_members', 'agency_subscriptions', 'contacts', 'conversations',
    'follow_ups', 'properties', 'property_media', 'property_visits', 'sales_pipeline',
    'whatsapp_connections'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER activity_log_%s
         AFTER INSERT OR UPDATE OR DELETE ON saas_immobilier.%I
         FOR EACH ROW EXECUTE FUNCTION saas_immobilier.log_activity(%L)',
      entity_name, entity_name, entity_name
    );
  END LOOP;
END $$;
