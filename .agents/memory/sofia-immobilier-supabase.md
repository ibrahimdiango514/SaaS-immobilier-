---
name: Sofia Immobilier scope and Supabase boundary
description: Product requirements and data-security limits for the Sofia Immobilier SaaS.
---

Sofia Immobilier is a French-language SaaS for real-estate agencies in Bamako, Mali. It must reuse the existing Supabase business schema `saas_immobilier` and the existing business tables, including `agencies`, `agency_members`, `user_profiles`, `properties`, `property_media`, `contacts`, and `sales_pipeline`.

Do not create tables, migrations, SQL functions, or RLS policies without the user's explicit authorization. Respect Supabase Auth and existing RLS. Never assume a user belongs to an agency; only expose agencies and records for which the authenticated user is a permitted member. Never put a service-role key or other secret in browser code. Do not present invented business data as real; if connection, authentication, or permissions fail, show an explicit error instead.

For the initial milestone, the user asked only for the application structure, navigation, and initial dashboard design. Wait for the user's validation before building business modules.

**Why:** The user explicitly set these product, security, and rollout requirements in the initial brief.

**How to apply:** Before adding data-backed functionality, re-check the current Supabase connection, use the existing `saas_immobilier` tables and policies without schema changes, establish the user's authenticated session and agency membership, and keep unavailable or unauthorized data visibly unavailable rather than substituting mock records.
