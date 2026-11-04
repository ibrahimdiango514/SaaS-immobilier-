-- =============================================================================
-- STAGING ISOLE — Sofia Immobilier / SasPay
-- Copie fidèle (schema + gardes + donnees de configuration) du projet
-- xbuuhfwobrafcbgtdgjx, extraite en LECTURE SEULE le 2026-11-03, servie dans
-- un PostgreSQL local (PGlite) pour tester les migrations AVANT toute
-- application en production. Aucune donnee client reelle : les agences et
-- utilisateurs sont synthétiques.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Roles Supabase + schema auth (stubs exacts des defs de production)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY,
  email text
);
GRANT SELECT ON auth.users TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS
$function$
  select
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS
$function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS
$function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

-- ---------------------------------------------------------------------------
-- Schema metier
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS saas_immobilier;
GRANT USAGE ON SCHEMA saas_immobilier TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- public.set_updated_at (utilise par les triggers updated_at de production)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS
$function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- plans
-- ---------------------------------------------------------------------------
CREATE TABLE saas_immobilier.plans (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL UNIQUE,
  description              text,
  price_monthly            numeric(14,2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  currency                 text NOT NULL DEFAULT 'XOF',
  max_members              integer NOT NULL DEFAULT 1 CHECK (max_members > 0),
  max_properties           integer NOT NULL DEFAULT 50 CHECK (max_properties > 0),
  max_whatsapp_connections integer NOT NULL DEFAULT 1 CHECK (max_whatsapp_connections > 0),
  monthly_ai_tokens        bigint NOT NULL DEFAULT 0 CHECK (monthly_ai_tokens >= 0),
  monthly_conversations    integer NOT NULL DEFAULT 0,
  features                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  display_name             text,
  setup_fee                numeric NOT NULL DEFAULT 0,
  max_photos_per_property  integer NOT NULL DEFAULT 10,
  monthly_agent_messages   integer NOT NULL DEFAULT 0,
  monthly_follow_ups       integer NOT NULL DEFAULT 0,
  modules                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order               integer NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- user_profiles / auth.users liens
-- ---------------------------------------------------------------------------
CREATE TABLE saas_immobilier.user_profiles (
  id                   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name            text,
  phone                text,
  avatar_url           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  email                text,
  role                 text NOT NULL DEFAULT 'agency' CHECK (role IN ('admin','agency')),
  must_change_password boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------------
-- agencies
-- ---------------------------------------------------------------------------
CREATE TABLE saas_immobilier.agencies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  slug                     text NOT NULL UNIQUE,
  legal_name               text,
  phone                    text,
  email                    text,
  address                  text,
  city                     text,
  country                  text NOT NULL DEFAULT 'ML',
  timezone                 text NOT NULL DEFAULT 'Africa/Bamako',
  currency                 text NOT NULL DEFAULT 'XOF',
  status                   text NOT NULL DEFAULT 'trial'
                           CHECK (status IN ('active','pending','suspended','trial','cancelled')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  logo_url                 text,
  description              text,
  commission_rate          numeric NOT NULL DEFAULT 5
                           CHECK (commission_rate >= 0 AND commission_rate <= 100),
  rental_commission_rate   numeric NOT NULL DEFAULT 100
                           CHECK (rental_commission_rate >= 0 AND rental_commission_rate <= 500),
  suspended_at             timestamptz,
  suspended_reason         text,
  auto_suspend_disabled_until timestamptz,
  pending_plan_id          uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  pending_note             text,
  pending_updated_at       timestamptz
);

-- ---------------------------------------------------------------------------
-- agency_members / platform_admins
-- ---------------------------------------------------------------------------
CREATE TABLE saas_immobilier.agency_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES saas_immobilier.user_profiles(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'agent'
             CHECK (role IN ('owner','admin','manager','agent','viewer')),
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','invited','suspended','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, user_id)
);

CREATE TABLE saas_immobilier.platform_admins (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'platform_owner' CHECK (role = 'platform_owner'),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- abonnements / factures / journal / encaissements
-- ---------------------------------------------------------------------------
CREATE TABLE saas_immobilier.agency_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL REFERENCES saas_immobilier.plans(id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'trial'
                 CHECK (status IN ('pending','trial','active','past_due','expired','suspended','cancelled')),
  starts_at      timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz,
  trial_ends_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CHECK (trial_ends_at IS NULL OR trial_ends_at >= starts_at)
);

CREATE TABLE saas_immobilier.subscription_invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  plan_from_id          uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_to_id            uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_from_name        text,
  plan_to_name          text,
  amount                numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency              text NOT NULL DEFAULT 'XOF',
  prorata_applied       boolean NOT NULL DEFAULT false,
  prorata_days          integer,
  prorata_days_in_month integer,
  period_start          date,
  period_end            date,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','paid','cancelled')),
  reference             text UNIQUE,
  note                  text,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  paid_at               timestamptz,
  paid_payment_id       uuid,
  source_payment_id     uuid
);

CREATE TABLE saas_immobilier.subscription_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id         uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  subscription_id   uuid REFERENCES saas_immobilier.agency_subscriptions(id) ON DELETE CASCADE,
  plan_id           uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  amount            numeric NOT NULL CHECK (amount >= 0),
  currency          text NOT NULL DEFAULT 'XOF',
  paid_at           date NOT NULL DEFAULT CURRENT_DATE,
  period_start      date,
  period_end        date,
  method            text NOT NULL DEFAULT 'manual',
  recorded_by       uuid,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  declaration_id    uuid,
  provider          text,
  provider_reference text,
  provider_status   text,
  reference         text,
  entry_kind        text NOT NULL DEFAULT 'payment' CHECK (entry_kind IN ('payment','reversal')),
  reversal_of       uuid REFERENCES saas_immobilier.subscription_payments(id) ON DELETE RESTRICT,
  invoice_id        uuid REFERENCES saas_immobilier.subscription_invoices(id) ON DELETE SET NULL
);

CREATE TABLE saas_immobilier.subscription_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  event_type         text NOT NULL CHECK (event_type IN (
                       'activation','plan_change','suspension',
                       'reactivation','payment_validated','payment_reclassified')),
  plan_from_id       uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_to_id         uuid REFERENCES saas_immobilier.plans(id) ON DELETE SET NULL,
  plan_from_name     text,
  plan_to_name       text,
  mensualite_from    numeric,
  mensualite_to      numeric,
  mensualite_variation numeric,
  invoice_id         uuid REFERENCES saas_immobilier.subscription_invoices(id) ON DELETE SET NULL,
  payment_id         uuid REFERENCES saas_immobilier.subscription_payments(id) ON DELETE SET NULL,
  amount             numeric,
  reference          text,
  reason             text,
  actor_id           uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_events_agency_idx
  ON saas_immobilier.subscription_events (agency_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- declarations manuelles (conservées telles quelles), reglages, journaux
-- ---------------------------------------------------------------------------
CREATE TABLE saas_immobilier.payment_declarations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id             uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  amount                numeric NOT NULL,
  currency              text NOT NULL DEFAULT 'XOF',
  method                text NOT NULL,
  transaction_reference text NOT NULL,
  paid_on               date NOT NULL,
  proof_path            text,
  declared_by           uuid,
  status                text NOT NULL DEFAULT 'pending',
  note                  text,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_note           text,
  payment_id            uuid,
  provider              text,
  provider_reference    text,
  provider_status       text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  reference             text,
  plan_id               uuid,
  plan_name_snapshot    text,
  expected_amount       numeric(14,2),
  duration_months       integer NOT NULL DEFAULT 1,
  payer_name            text,
  proof_mime            text,
  proof_size            bigint,
  proof_uploaded_at     timestamptz,
  submitted_at          timestamptz,
  expires_at            timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  transaction_reference_norm text GENERATED ALWAYS AS
    (upper(regexp_replace(COALESCE(transaction_reference, ''), '[^A-Za-z0-9]', '', 'g'))) STORED
);
CREATE INDEX IF NOT EXISTS ix_payment_declarations_status
  ON saas_immobilier.payment_declarations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_payment_declarations_agency
  ON saas_immobilier.payment_declarations (agency_id, created_at DESC);

CREATE TABLE saas_immobilier.platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_immobilier.activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid,
  user_id     uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  summary     text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_immobilier.notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES saas_immobilier.user_profiles(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  message    text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_immobilier.usage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  user_id     uuid,
  event_type  text NOT NULL,
  entity_type text,
  entity_id   uuid,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  event_key   text NOT NULL
);

CREATE TABLE saas_immobilier.payment_decision_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  declaration_id uuid NOT NULL,
  agency_id      uuid NOT NULL,
  action         text NOT NULL,
  from_status    text,
  to_status      text,
  actor_id       uuid,
  actor_kind     text,
  actor_label    text,
  amount         numeric,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Garde-fous d'autorisation (defs exactes de production, 2026-11-03)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS
$function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.platform_admins pa
    WHERE pa.user_id = (SELECT auth.uid())
      AND pa.status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS
$function$
  SELECT EXISTS (
    SELECT 1
    FROM saas_immobilier.platform_admins pa
    WHERE pa.user_id = (SELECT auth.uid())
      AND pa.role = 'platform_owner'
      AND pa.status = 'active'
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_agency_member(target_agency_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$SELECT EXISTS(SELECT 1 FROM saas_immobilier.agency_members am JOIN saas_immobilier.agencies a ON a.id=am.agency_id WHERE am.agency_id=target_agency_id AND am.user_id=(SELECT auth.uid()) AND am.status='active' AND a.status<>'suspended') OR public.is_platform_admin();$function$;

CREATE OR REPLACE FUNCTION public.has_agency_role(target_agency_id uuid, required_role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$function$SELECT EXISTS(SELECT 1 FROM saas_immobilier.agency_members am JOIN saas_immobilier.agencies a ON a.id=am.agency_id WHERE am.agency_id=target_agency_id AND am.user_id=(SELECT auth.uid()) AND am.status='active' AND (am.role=required_role OR (required_role='admin' AND am.role='owner')) AND a.status<>'suspended') OR public.is_platform_admin();$function$;

CREATE OR REPLACE FUNCTION public.agence_active(p_agency_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog', 'public' AS
$function$
  SELECT EXISTS (
    SELECT 1 FROM saas_immobilier.agencies a
     WHERE a.id = p_agency_id
       AND a.status IN ('active', 'trial')
  );
$function$;

-- ---------------------------------------------------------------------------
-- Donnees de configuration (miroir production) + donnees de test synthetiques
-- ---------------------------------------------------------------------------
INSERT INTO saas_immobilier.plans
  (id, name, description, price_monthly, currency, max_members, max_properties,
   max_whatsapp_connections, monthly_ai_tokens, monthly_conversations, features,
   display_name, setup_fee, max_photos_per_property, monthly_agent_messages,
   monthly_follow_ups, modules, sort_order)
VALUES
  ('4f457a46-b1b2-407f-9c75-30347d6d9ae0', 'starter', 'SBC AI Agency Starter', 50000, 'XOF', 3, 30, 1,
   100000, 500, '{"crm":true,"biens":true,"sofia":true,"visites":true,"ca_chart":true,"contacts":true,"pipeline":true,"dashboard":true}',
   'Essentiel', 150000, 10, 1000, 100,
   '["biens","contacts","pipeline","visites","dashboard","ca_chart"]', 1),
  ('940bb1ac-6116-42f8-a3d1-2c7d9178692f', 'pro', 'Plan Pro Agence', 100000, 'XOF', 10, 150, 3,
   500000, 2500, '{"crm":true,"biens":true,"sofia":true,"visites":true,"ca_chart":true,"contacts":true,"pipeline":true,"whatsapp":true,"analytics":true,"dashboard":true,"ca_filters":true,"assistant_ia":true,"ca_export_csv":true,"automatisations":true}',
   'Pro', 250000, 30, 3000, 300,
   '["biens","contacts","pipeline","visites","dashboard","ca_chart","automatisations","ca_filters","ca_export_csv","assistant_ia"]', 2),
  ('b7a4ea74-7de5-4b99-9dd6-86bf9b03247a', 'enterprise', 'Plan Enterprise', 200000, 'XOF', 2000000000, 2000000000, 10,
   2500000, 15000, '{"crm":true,"biens":true,"sofia":true,"visites":true,"ca_chart":true,"contacts":true,"pipeline":true,"whatsapp":true,"analytics":true,"dashboard":true,"ca_filters":true,"assistant_ia":true,"ca_export_csv":true,"stats_avancees":true,"automatisations":true,"priority_support":true,"rapports_mensuels":true}',
   'Premium', 400000, 2000000000, 8000, 1000,
   '["biens","contacts","pipeline","visites","dashboard","ca_chart","automatisations","ca_filters","ca_export_csv","assistant_ia","stats_avancees","rapports_mensuels","support_prioritaire"]', 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO saas_immobilier.platform_settings (key, value) VALUES
  ('payment_instructions',
   '{"orange_money":{"name":"Sofia Immobilier","number":"+223 76 00 00 00"},"wave":{"name":"Sofia Immobilier","number":"+223 76 00 00 01"}}'::jsonb),
  ('billing', '{"grace_days":5,"reminder_days":[5,0]}'::jsonb),
  ('signup', '{"require_admin_validation":true,"trial_days":14}'::jsonb),
  ('trial', '{"agent_messages":200}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Utilisateurs de test synthetiques (aucune donnee reelle)
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner.demo@test.example'),
  ('22222222-2222-2222-2222-222222222222', 'agent.demo@test.example'),
  ('33333333-3333-3333-3333-333333333333', 'admin.demo@test.example'),
  ('44444444-4444-4444-4444-444444444444', 'outsider.demo@test.example'),
  ('99999999-9999-9999-9999-999999999999', 'platform.admin@test.example')
ON CONFLICT (id) DO NOTHING;

INSERT INTO saas_immobilier.user_profiles (id, full_name, email, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Proprietaire Demo', 'owner.demo@test.example', 'admin'),
  ('22222222-2222-2222-2222-222222222222', 'Agent Demo', 'agent.demo@test.example', 'agency'),
  ('33333333-3333-3333-3333-333333333333', 'Admin Plateforme', 'admin.demo@test.example', 'admin'),
  ('44444444-4444-4444-4444-444444444444', 'Autre Agence', 'outsider.demo@test.example', 'agency'),
  ('99999999-9999-9999-9999-999999999999', 'Super Admin', 'platform.admin@test.example', 'admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO saas_immobilier.platform_admins (user_id) VALUES
  ('99999999-9999-9999-9999-999999999999')
ON CONFLICT (user_id) DO NOTHING;

-- Agences de test :
--   A1 : pending, offre choisie (parcours installation)
--   A2 : active + abonnement actif (renouvellement)
--   A3 : active + essai valide 14 j (essai unique preserve)
--   A4 : autre agence (isolation)
INSERT INTO saas_immobilier.agencies (id, name, slug, status, city, pending_plan_id, country) VALUES
  ('aaaaaaa1-0000-0000-0000-000000000001', 'Agence En Attente', 'agence-attente', 'pending', 'Bamako',
   '940bb1ac-6116-42f8-a3d1-2c7d9178692f', 'ML'),
  ('aaaaaaa1-0000-0000-0000-000000000002', 'Agence Active', 'agence-active', 'active', 'Bamako',
   NULL, 'ML'),
  ('aaaaaaa1-0000-0000-0000-000000000003', 'Agence En Essai', 'agence-essai', 'trial', 'Bamako',
   NULL, 'ML'),
  ('aaaaaaa1-0000-0000-0000-000000000004', 'Agence Tierce', 'agence-tierce', 'active', 'Sikoro',
   NULL, 'ML')
ON CONFLICT (id) DO NOTHING;

INSERT INTO saas_immobilier.agency_members (agency_id, user_id, role) VALUES
  ('aaaaaaa1-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaa1-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaa1-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'agent'),
  ('aaaaaaa1-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaa1-0000-0000-0000-000000000004', '44444444-4444-4444-4444-444444444444', 'owner')
ON CONFLICT DO NOTHING;

-- A2 : abonnement actif Pro, echeance dans 10 jours
INSERT INTO saas_immobilier.agency_subscriptions (id, agency_id, plan_id, status, starts_at, ends_at, trial_ends_at)
VALUES
  ('bbbbbbb2-0000-0000-0000-000000000002', 'aaaaaaa1-0000-0000-0000-000000000002',
   '940bb1ac-6116-42f8-a3d1-2c7d9178692f', 'active',
   now() - interval '20 days', now() + interval '10 days', NULL),
  -- A3 : essai 14 jours encore valide (j+10)
  ('bbbbbbb2-0000-0000-0000-000000000003', 'aaaaaaa1-0000-0000-0000-000000000003',
   '4f457a46-b1b2-407f-9c75-30347d6d9ae0', 'trial',
   now() - interval '4 days', now() + interval '10 days', now() + interval '10 days')
ON CONFLICT (id) DO NOTHING;
