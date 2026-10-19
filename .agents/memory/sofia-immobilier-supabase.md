---
name: Sofia Immobilier scope and Supabase boundary
description: Product requirements and data-security limits for the Sofia Immobilier SaaS.
---

Sofia Immobilier is a French-language SaaS for real-estate agencies in Bamako, Mali. It must reuse the existing Supabase business schema `saas_immobilier` and the existing business tables, including `agencies`, `agency_members`, `user_profiles`, `properties`, `property_media`, `contacts`, and `sales_pipeline`.

Do not create tables, migrations, SQL functions, or RLS policies without the user's explicit authorization. Respect Supabase Auth and existing RLS. Never assume a user belongs to an agency; only expose agencies and records for which the authenticated user is a permitted member. Never put a service-role key or other secret in browser code. Do not present invented business data as real; if connection, authentication, or permissions fail, show an explicit error instead.

The user approved the initial interface and authorized proceeding with business modules under the existing schema and security boundaries.

**Why:** The user explicitly set these product and security requirements, then confirmed the initial UI before work on business modules.

**How to apply:** Use only the existing `saas_immobilier` tables and policies without schema changes. Establish the authenticated session and active agency membership before business queries, and keep unavailable or unauthorized data visibly unavailable rather than substituting mock records.

Supabase tooling can be available through its MCP callbacks even when an integration search returns no matching entry; test the actual read-only callback before concluding that access is unavailable.

**Why:** In this workspace the project-list and schema-inspection callbacks worked despite an empty integration search.

**How to apply:** Load the Supabase MCP instructions and verify the connected project with a read-only call before suggesting connector setup.

The Supabase TypeScript type-generation helper returned only the `public` schema, not the business tables in `saas_immobilier`.

**Why:** The generated output omitted the custom schema even though its tables exist and are accessible through authenticated REST requests.

**How to apply:** Do not assume default type generation covers `saas_immobilier`; define the custom-schema types explicitly or verify a schema-specific generator option.

The user explicitly authorized schema changes for the 2026-10 correction pass (tables with FKs, strict RLS, journal). Applied on project `xbuuhfwobrafcbgtdgjx`: table `saas_immobilier.activity_log` (RLS: admin select/delete, member select/insert), function `saas_immobilier.log_activity()` (SECURITY DEFINER, never blocks business writes), 11 triggers `activity_log_<table>` on agencies, agency_members, agency_subscriptions, contacts, conversations, follow_ups, properties, property_media, property_visits, sales_pipeline, whatsapp_connections; 49 rows backfilled. The file `artifacts/sofia-immobilier/supabase/migrations/20261019_activity_log.sql` records the applied DDL. All other business tables/RLS were pre-existing and untouched.

**Why:** The correction/feature pass required an activity journal and full CRUD modules; the user authorized schema work in that task.

**How to apply:** Treat `activity_log` as part of the standard schema; real `entity_type` values are table names (e.g. `properties`, `property_visits`), mapped to French labels via `entityLabels` in `workspace-ui.tsx`.
