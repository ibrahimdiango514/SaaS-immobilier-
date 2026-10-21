-- =============================================================================
-- BLOC 7 — CONSOMMATION IA + CANAL WHATSAPP
-- =============================================================================
-- Migration STRICTEMENT ADDITIVE : aucune table, colonne, politique RLS ni
-- fonction existante n'est modifiée. On réutilise `saas_immobilier.agency_usage`,
-- `saas_immobilier.usage_events` et `saas_immobilier.whatsapp_connections`
-- (qui existe déjà) — aucune table dupliquée.
--
-- Rollback : db/rollback/2026-10-21_bloc7_usage_ia_whatsapp_rollback.sql
--
-- Trois nouvelles fonctions :
--   1. public.record_ai_usage(...)     → service_role UNIQUEMENT (n8n)
--   2. public.agency_ai_usage(uuid)    → l'agence lit sa propre consommation
--   3. public.platform_agency_usage()  → tableau de bord plateforme (admin)
--
-- Deux pièges évités ici (documentés pour la suite) :
--   a) Une fonction SECURITY DEFINER s'exécute avec current_user = le PROPRIÉTAIRE
--      (postgres), jamais 'service_role'. Le contrôle « service_role uniquement »
--      passe donc par `auth.role()` (claim du JWT), pas par `current_user`.
--      (C'est exactement pourquoi l'existante `record_usage_event` ne peut pas
--      fonctionner en service_role : elle teste `current_user = 'service_role'`.)
--   b) Les paramètres de `record_ai_usage` portent les noms demandés
--      (agency_id, tokens_in, …). `agency_id` entre en collision avec la colonne
--      du même nom → toutes les références SQL sont qualifiées
--      (`au.agency_id` / `record_ai_usage.agency_id`) pour lever l'ambiguïté que
--      plpgsql signalerait à l'exécution.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. record_ai_usage — incrémente agency_usage. service_role ONLY.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_ai_usage(
  agency_id      uuid,
  tokens_in      bigint  DEFAULT 0,
  tokens_out     bigint  DEFAULT 0,
  messages       bigint  DEFAULT 0,
  conversations  bigint  DEFAULT 0,
  event_key      text    DEFAULT NULL,
  user_id        uuid    DEFAULT NULL,
  metadata       jsonb   DEFAULT '{}'::jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_period   date := date_trunc('month', timezone('UTC', clock_timestamp()))::date;
  v_usage    saas_immobilier.agency_usage;
  v_dup      uuid;
  v_limit    bigint;
  v_msg_cap  integer;
BEGIN
  -- JAMAIS appelable depuis le navigateur : la clé service_role ne vit que dans
  -- les secrets Supabase / n8n.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'record_ai_usage est reservee au role service_role.'
      USING ERRCODE = '42501';
  END IF;

  IF record_ai_usage.agency_id IS NULL THEN
    RAISE EXCEPTION 'agency_id est obligatoire.' USING ERRCODE = '22023';
  END IF;
  IF tokens_in < 0 OR tokens_out < 0 OR messages < 0 OR conversations < 0 THEN
    RAISE EXCEPTION 'les increments ne peuvent pas etre negatifs.' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM saas_immobilier.agencies a WHERE a.id = record_ai_usage.agency_id) THEN
    RAISE EXCEPTION 'agence introuvable.' USING ERRCODE = 'P0002';
  END IF;

  -- Même contrôle que pour les photos : une agence suspendue ne consomme plus.
  IF NOT saas_immobilier.agence_active(record_ai_usage.agency_id) THEN
    RAISE EXCEPTION 'agency_suspended' USING ERRCODE = '42501';
  END IF;

  -- Idempotence optionnelle (n8n peut rejouer un webhook).
  -- PAS d'ON CONFLICT ici : usage_events n'a AUCUNE contrainte unique sur
  -- (agency_id, event_key), un ON CONFLICT lèverait l'erreur 42P10.
  IF event_key IS NOT NULL AND btrim(event_key) <> '' THEN
    SELECT ue.id INTO v_dup
      FROM saas_immobilier.usage_events ue
     WHERE ue.agency_id = record_ai_usage.agency_id
       AND ue.event_key = record_ai_usage.event_key
     LIMIT 1;

    IF v_dup IS NOT NULL THEN
      RETURN public.agency_ai_usage(record_ai_usage.agency_id)
             || jsonb_build_object('deduplicated', true);
    END IF;

    INSERT INTO saas_immobilier.usage_events
      (agency_id, user_id, event_key, event_type, entity_type, entity_id, metadata, created_at)
    VALUES
      (record_ai_usage.agency_id, record_ai_usage.user_id, record_ai_usage.event_key,
       'ai_request', 'agency', record_ai_usage.agency_id,
       COALESCE(record_ai_usage.metadata, '{}'::jsonb), clock_timestamp());
  END IF;

  -- La contrainte unique (agency_id, period_start) EXISTE sur agency_usage.
  INSERT INTO saas_immobilier.agency_usage (agency_id, period_start)
  VALUES (record_ai_usage.agency_id, v_period)
  ON CONFLICT (agency_id, period_start) DO NOTHING;

  UPDATE saas_immobilier.agency_usage au
     SET ai_requests_count   = au.ai_requests_count + CASE WHEN (tokens_in + tokens_out) > 0 THEN 1 ELSE 0 END,
         ai_tokens_input     = au.ai_tokens_input  + tokens_in,
         ai_tokens_output    = au.ai_tokens_output + tokens_out,
         messages_count      = au.messages_count   + messages,
         conversations_count = au.conversations_count + conversations,
         updated_at          = clock_timestamp()
   WHERE au.agency_id   = record_ai_usage.agency_id
     AND au.period_start = v_period
  RETURNING * INTO v_usage;

  SELECT pl.monthly_ai_tokens, pl.monthly_agent_messages
    INTO v_limit, v_msg_cap
    FROM public.agency_current_plan(record_ai_usage.agency_id) pl;

  RETURN jsonb_build_object(
    'deduplicated',        false,
    'agency_id',           record_ai_usage.agency_id,
    'period_start',        v_period,
    'ai_tokens_input',     COALESCE(v_usage.ai_tokens_input, 0),
    'ai_tokens_output',    COALESCE(v_usage.ai_tokens_output, 0),
    'ai_tokens_total',     COALESCE(v_usage.ai_tokens_input,0) + COALESCE(v_usage.ai_tokens_output,0),
    'ai_requests_count',   COALESCE(v_usage.ai_requests_count, 0),
    'messages_count',      COALESCE(v_usage.messages_count, 0),
    'conversations_count', COALESCE(v_usage.conversations_count, 0),
    'monthly_ai_tokens_limit', v_limit,
    'monthly_messages_limit',  v_msg_cap,
    -- Signal pour n8n : l'agence a dépassé son quota du mois.
    'quota_exceeded',      (COALESCE(v_limit, 0) > 0
                            AND (COALESCE(v_usage.ai_tokens_input,0) + COALESCE(v_usage.ai_tokens_output,0)) > v_limit)
  );
END
$function$;

-- -----------------------------------------------------------------------------
-- 2. agency_ai_usage — consommation du mois + quotas + état du canal WhatsApp
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_ai_usage(p_agency_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_period  date := date_trunc('month', timezone('UTC', clock_timestamp()))::date;
  v_usage   saas_immobilier.agency_usage;
  v_plan    saas_immobilier.plans;
  v_tokens  bigint;
  v_service boolean := (auth.role() = 'service_role');
BEGIN
  IF NOT v_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentification requise.' USING ERRCODE = '42501';
  END IF;
  -- Un membre de l'agence, ou un administrateur de la plateforme.
  IF NOT v_service
     AND NOT (public.is_agency_member(p_agency_id) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Acces refuse a la consommation de cette agence.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_usage FROM saas_immobilier.agency_usage au
   WHERE au.agency_id = p_agency_id AND au.period_start = v_period;

  SELECT * INTO v_plan FROM public.agency_current_plan(p_agency_id);
  v_tokens := COALESCE(v_usage.ai_tokens_input, 0) + COALESCE(v_usage.ai_tokens_output, 0);

  RETURN jsonb_build_object(
    'agency_id',    p_agency_id,
    'period_start', v_period,
    'plan', jsonb_build_object(
      'id',                       v_plan.id,
      'name',                     v_plan.name,
      'display_name',             COALESCE(v_plan.display_name, v_plan.name),
      'monthly_ai_tokens',        v_plan.monthly_ai_tokens,
      'monthly_agent_messages',   v_plan.monthly_agent_messages,
      'monthly_conversations',    v_plan.monthly_conversations,
      'max_whatsapp_connections', v_plan.max_whatsapp_connections
    ),
    'usage', jsonb_build_object(
      'ai_tokens_input',     COALESCE(v_usage.ai_tokens_input, 0),
      'ai_tokens_output',    COALESCE(v_usage.ai_tokens_output, 0),
      'ai_tokens_total',     v_tokens,
      'ai_requests_count',   COALESCE(v_usage.ai_requests_count, 0),
      'messages_count',      COALESCE(v_usage.messages_count, 0),
      'conversations_count', COALESCE(v_usage.conversations_count, 0),
      'storage_bytes',       COALESCE(v_usage.storage_bytes, 0)
    ),
    'ratios', jsonb_build_object(
      'ai_tokens',     CASE WHEN COALESCE(v_plan.monthly_ai_tokens,0) > 0
                            THEN round(100.0 * v_tokens / v_plan.monthly_ai_tokens, 1)
                            ELSE 0 END,
      'messages',      CASE WHEN COALESCE(v_plan.monthly_agent_messages,0) > 0
                            THEN round(100.0 * COALESCE(v_usage.messages_count,0) / v_plan.monthly_agent_messages, 1)
                            ELSE 0 END,
      'conversations', CASE WHEN COALESCE(v_plan.monthly_conversations,0) > 0
                            THEN round(100.0 * COALESCE(v_usage.conversations_count,0) / v_plan.monthly_conversations, 1)
                            ELSE 0 END
    ),
    -- Alertes à 80 % puis à 100 % (exigence Bloc 7).
    'alerts', jsonb_build_object(
      'ai_tokens',     CASE WHEN COALESCE(v_plan.monthly_ai_tokens,0) <= 0 THEN 'unlimited'
                            WHEN v_tokens >= v_plan.monthly_ai_tokens THEN 'reached'
                            WHEN v_tokens >= 0.8 * v_plan.monthly_ai_tokens THEN 'warning'
                            ELSE 'ok' END,
      'messages',      CASE WHEN COALESCE(v_plan.monthly_agent_messages,0) <= 0 THEN 'unlimited'
                            WHEN COALESCE(v_usage.messages_count,0) >= v_plan.monthly_agent_messages THEN 'reached'
                            WHEN COALESCE(v_usage.messages_count,0) >= 0.8 * v_plan.monthly_agent_messages THEN 'warning'
                            ELSE 'ok' END,
      'conversations', CASE WHEN COALESCE(v_plan.monthly_conversations,0) <= 0 THEN 'unlimited'
                            WHEN COALESCE(v_usage.conversations_count,0) >= v_plan.monthly_conversations THEN 'reached'
                            WHEN COALESCE(v_usage.conversations_count,0) >= 0.8 * v_plan.monthly_conversations THEN 'warning'
                            ELSE 'ok' END
    ),
    'whatsapp', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',                wc.id,
               'connection_name',   wc.connection_name,
               'provider',          wc.provider,
               'provider_label',    CASE wc.provider
                                      WHEN 'meta_cloud_api' THEN 'Meta Cloud API'
                                      WHEN '360dialog'      THEN '360dialog'
                                      WHEN 'evolution_api'  THEN 'Evolution API'
                                      ELSE COALESCE(wc.provider, 'Non renseigné')
                                    END,
               'official',          (wc.provider IS DISTINCT FROM 'evolution_api'),
               'phone_number',      wc.phone_number,
               'status',            wc.status,
               'last_connected_at', wc.last_connected_at,
               'last_activity_at',  GREATEST(COALESCE(wc.last_connected_at, wc.updated_at), wc.updated_at)
             ) ORDER BY wc.updated_at DESC)
        FROM saas_immobilier.whatsapp_connections wc
       WHERE wc.agency_id = p_agency_id
    ), '[]'::jsonb)
  );
END
$function$;

-- -----------------------------------------------------------------------------
-- 3. platform_agency_usage — tableau plateforme : une ligne par agence
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.platform_agency_usage()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_period date := date_trunc('month', timezone('UTC', clock_timestamp()))::date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Acces reserve aux administrateurs de la plateforme.' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'period_start', v_period,

    -- Une ligne par agence. Pas de jointure sur whatsapp_connections ici :
    -- un LEFT JOIN LATERAL ... LIMIT 1 évite tout effet d'éventail.
    'agencies', (
      SELECT COALESCE(jsonb_agg(t.data ORDER BY t.tokens_total DESC, t.agency_name), '[]'::jsonb)
        FROM (
          SELECT
            a.name AS agency_name,
            (COALESCE(au.ai_tokens_input,0) + COALESCE(au.ai_tokens_output,0)) AS tokens_total,
            jsonb_build_object(
              'agency_id',          a.id,
              'agency_name',        a.name,
              'agency_slug',        a.slug,
              'agency_status',      a.status,
              'plan_name',          COALESCE(pl.display_name, pl.name),
              'plan_id',            pl.id,
              'ai_tokens_input',    COALESCE(au.ai_tokens_input, 0),
              'ai_tokens_output',   COALESCE(au.ai_tokens_output, 0),
              'tokens_total',       COALESCE(au.ai_tokens_input,0) + COALESCE(au.ai_tokens_output,0),
              'tokens_limit',       COALESCE(pl.monthly_ai_tokens, 0),
              'tokens_ratio',       CASE WHEN COALESCE(pl.monthly_ai_tokens,0) > 0
                                         THEN round(100.0 * (COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0)) / pl.monthly_ai_tokens, 1)
                                         ELSE 0 END,
              'tokens_alert',       CASE WHEN COALESCE(pl.monthly_ai_tokens,0) <= 0 THEN 'unlimited'
                                         WHEN COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0) >= pl.monthly_ai_tokens THEN 'reached'
                                         WHEN COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0) >= 0.8*pl.monthly_ai_tokens THEN 'warning'
                                         ELSE 'ok' END,
              'ai_requests_count',   COALESCE(au.ai_requests_count, 0),
              'messages_count',      COALESCE(au.messages_count, 0),
              'messages_limit',      COALESCE(pl.monthly_agent_messages, 0),
              'messages_ratio',      CASE WHEN COALESCE(pl.monthly_agent_messages,0) > 0
                                          THEN round(100.0 * COALESCE(au.messages_count,0) / pl.monthly_agent_messages, 1)
                                          ELSE 0 END,
              'messages_alert',      CASE WHEN COALESCE(pl.monthly_agent_messages,0) <= 0 THEN 'unlimited'
                                          WHEN COALESCE(au.messages_count,0) >= pl.monthly_agent_messages THEN 'reached'
                                          WHEN COALESCE(au.messages_count,0) >= 0.8*pl.monthly_agent_messages THEN 'warning'
                                          ELSE 'ok' END,
              'conversations_count', COALESCE(au.conversations_count, 0),
              'conversations_limit', COALESCE(pl.monthly_conversations, 0),
              'conversations_ratio', CASE WHEN COALESCE(pl.monthly_conversations,0) > 0
                                          THEN round(100.0 * COALESCE(au.conversations_count,0) / pl.monthly_conversations, 1)
                                          ELSE 0 END,
              -- Canal WhatsApp : fournisseur, numéro, état, dernière activité.
              'whatsapp_provider',         w.provider,
              'whatsapp_provider_label',   CASE w.provider
                                             WHEN 'meta_cloud_api' THEN 'Meta Cloud API'
                                             WHEN '360dialog'      THEN '360dialog'
                                             WHEN 'evolution_api'  THEN 'Evolution API'
                                             ELSE NULL END,
              'whatsapp_official',         (w.provider IS DISTINCT FROM 'evolution_api'),
              'whatsapp_phone_number',     w.phone_number,
              'whatsapp_status',           w.status,
              'whatsapp_last_activity_at', w.last_activity_at,
              'whatsapp_connections',      COALESCE(w.total, 0)
            ) AS data
          FROM saas_immobilier.agencies a
          LEFT JOIN LATERAL public.agency_current_plan(a.id) pl ON true
          LEFT JOIN saas_immobilier.agency_usage au
                 ON au.agency_id = a.id AND au.period_start = v_period
          LEFT JOIN LATERAL (
            SELECT wc.provider, wc.phone_number, wc.status,
                   GREATEST(COALESCE(wc.last_connected_at, wc.updated_at), wc.updated_at) AS last_activity_at,
                   count(*) OVER () AS total
              FROM saas_immobilier.whatsapp_connections wc
             WHERE wc.agency_id = a.id
             ORDER BY (wc.status = 'connected') DESC, wc.updated_at DESC
             LIMIT 1
          ) w ON true
        ) t
    ),

    -- Totaux plateforme. Aucun JOIN sur whatsapp_connections ici : cela
    -- multiplierait les sommes (plusieurs connexions par agence).
    'totals', (
      SELECT jsonb_build_object(
        'agencies',            count(*),
        'tokens_total',        COALESCE(sum(COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0)),0),
        'requests_total',      COALESCE(sum(COALESCE(au.ai_requests_count,0)),0),
        'messages_total',      COALESCE(sum(COALESCE(au.messages_count,0)),0),
        'conversations_total', COALESCE(sum(COALESCE(au.conversations_count,0)),0),
        'agencies_at_warning', count(*) FILTER (
          WHERE COALESCE(pl.monthly_ai_tokens,0) > 0
            AND (COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0)) >= 0.8*pl.monthly_ai_tokens
            AND (COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0)) <  pl.monthly_ai_tokens),
        'agencies_at_limit', count(*) FILTER (
          WHERE COALESCE(pl.monthly_ai_tokens,0) > 0
            AND (COALESCE(au.ai_tokens_input,0)+COALESCE(au.ai_tokens_output,0)) >= pl.monthly_ai_tokens),
        'agencies_with_whatsapp', (SELECT count(DISTINCT wc.agency_id)
                                     FROM saas_immobilier.whatsapp_connections wc)
      )
      FROM saas_immobilier.agencies a
      LEFT JOIN LATERAL public.agency_current_plan(a.id) pl ON true
      LEFT JOIN saas_immobilier.agency_usage au
             ON au.agency_id = a.id AND au.period_start = v_period
    )
  );
END
$function$;

-- -----------------------------------------------------------------------------
-- 4. Droits d'exécution
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_ai_usage(uuid, bigint, bigint, bigint, bigint, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agency_ai_usage(uuid)   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.platform_agency_usage() FROM PUBLIC, anon, authenticated, service_role;

-- record_ai_usage : service_role UNIQUEMENT (n8n). Jamais authenticated/anon.
GRANT EXECUTE ON FUNCTION public.record_ai_usage(uuid, bigint, bigint, bigint, bigint, text, uuid, jsonb)
  TO service_role;
-- Lecture : l'agence pour elle-même, la plateforme pour toutes.
GRANT EXECUTE ON FUNCTION public.agency_ai_usage(uuid)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_agency_usage() TO authenticated, service_role;
