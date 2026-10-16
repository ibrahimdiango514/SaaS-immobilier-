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
