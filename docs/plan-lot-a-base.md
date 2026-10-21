# LOT A — Changements prévus en base (EN ATTENTE DE VALIDATION)

Statut : **brouillon soumis pour accord**. Aucune instruction de ce fichier n'a été exécutée.
Projet Supabase : `xbuuhfwobrafcbgtdgjx` (eu-central-1, PostgreSQL 17.6.1.141).

Principe : **additif**. Aucune ligne existante supprimée. La seule entorse est la
mise à jour des 3 lignes de `plans`, demandée explicitement au point 2 du LOT A
et signalée comme telle plus bas (décision D1).

---

## 0. État vérifié avant changement

### Tables `saas_immobilier` (34)
activity_log, agencies, agency_ai_configs, agency_business_hours, agency_members,
agency_schedule_exceptions, agency_subscriptions, agency_usage, agent_availability,
ai_providers, ai_usage, appointments, contacts, conversation_handoffs,
conversation_messages, conversations, follow_ups, lead_scores, notifications, plans,
platform_admins, properties, property_availability, property_media,
property_recommendations, property_visits, revenue_operations, sales_pipeline,
sofia_configs, sofia_memory, subscription_payments, usage_events, user_profiles,
whatsapp_connections.

Le schéma `public` ne contient **aucune table** (0 ligne dans information_schema).

### `plans` — 3 lignes, colonnes actuelles
`id, name, description, price_monthly, currency, max_members, max_properties,
max_whatsapp_connections, monthly_ai_tokens, monthly_conversations, features,
created_at, updated_at`

| id | name | price_monthly | max_members | max_properties | max_whatsapp | ai_tokens | conversations |
|---|---|---|---|---|---|---|---|
| 4f457a46-b1b2-407f-9c75-30347d6d9ae0 | starter | 0 | 3 | 50 | 1 | 100 000 | 500 |
| 940bb1ac-6116-42f8-a3d1-2c7d9178692f | pro | 75 000 | 10 | 250 | 3 | 500 000 | 2 500 |
| b7a4ea74-7de5-4b99-9dd6-86bf9b03247a | enterprise | 195 000 | 50 | 2 000 | 10 | 2 500 000 | 15 000 |

Il n'existe **aucune** colonne d'installation, de relances ni de photos par bien.

### Abonnements
- `agency_subscriptions` : 2 lignes, toutes deux `plan = starter`, `status = active`,
  `ends_at = NULL`, `trial_ends_at = NULL`.
  - cbe08bac… → SBC AI Agency Demo
  - cac36096… → Diango agengy
- `subscription_payments` : **0 ligne**.
- `agency_usage` : **0 ligne**. `usage_events` : 10 lignes.
- `agencies` : 3 lignes — SBC AI Agency Demo (active), Diango agengy (active),
  Agence Test Suspendue (suspended).
- `agencies` n'a **aucune** colonne `plan_id`. Le lien agence→offre passe
  uniquement par `agency_subscriptions.plan_id`.
- `agencies.logo_url` **existe déjà** (text, nullable) → pas de colonne à ajouter
  pour le logo.

### Objets existants
- 39 triggers dans `saas_immobilier` (dont `set_updated_at`, `log_activity`,
  `provision_agency_defaults`, `sync_property_revenue`, `sofia_visit_status_guard`,
  `guard_user_profile_role`). Aucun ne vérifie une limite de plan.
- 8 fonctions dans `saas_immobilier`, **65 fonctions dans `public`**, dont déjà :
  `get_agency_subscription_dashboard(uuid) -> jsonb`,
  `get_agency_usage_dashboard(uuid) -> jsonb`,
  `get_platform_subscriptions() -> jsonb`,
  `get_platform_admin_subscription_directory(text,text,int,int) -> jsonb`,
  `get_platform_dashboard_summary() -> jsonb`,
  `create_agency_member(uuid,uuid,uuid,text)`,
  `provision_agency_member(...)`, `onboard_agency(text,text)`,
  `record_usage_event(...)`, `activate_my_agency_invitations()`,
  `is_agency_member(uuid)`, `has_agency_role(uuid,text)`,
  `is_platform_admin()`, `is_platform_owner()`.
- Aucune table de jetons d'invitation nulle part.
- `property_media` : 21 lignes, toutes `media_type = 'photo'`.
- `user_profiles` : 1 ligne `role='admin'`, 3 lignes `role='agency'`.

### Extensions
Installées : `btree_gist 1.7, pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0,
supabase_vault 0.3.1, uuid-ossp 1.1`.
Disponibles mais **non installées** : `pg_cron 1.6.4`, `pg_net 0.20.3`, `http 1.6`,
`pgjwt 0.2.0`, `pgsuppksodium 3.1.8`.
`pgcrypto` est donc déjà là → hachage SHA-256 des jetons d'invitation possible sans
nouvelle extension.

### Storage
3 buckets, **tous publics**, aucun `file_size_limit`, aucun `allowed_mime_types` :
`agency-assets`, `bsfood`, `property-images`.

### Mécanisme de suspension existant
`public.is_agency_member()` et `public.has_agency_role()` contiennent tous deux
`AND a.status <> 'suspended'`. Toutes les politiques SELECT métier
(`properties_select_member`, `contacts_select_member`, `sales_pipeline`,
`property_media_select_member`, `agencies_select_member`,
`agency_members_select_member`) passent par `is_agency_member`.
=> passer `agencies.status` à `'suspended'` bloque bien l'accès **RLS**.
Attention : les deux fonctions se terminent par `OR public.is_platform_admin()`.

### Edge Functions (5, présentes dans Supabase, ABSENTES du dépôt git)
`create-platform-agency` (v2), `create-agency-member` (v2),
`provision-platform-agency` (v1), `invite-agency-member` (v1),
`platform-dashboard-summary` (v1).
Le dépôt ne contient aucun dossier `supabase/` ni `functions/`.

Points bloquants relevés dans leur code :
- `create-agency-member` refuse explicitement un mot de passe :
  `return json({ error: 'password_not_supported_use_invitation' }, 400)`.
- Les deux fonctions d'invitation passent par `auth.admin.inviteUserByEmail(...)`,
  **qui nécessite un SMTP configuré**.
- URL de redirection codée en dur : `https://sbc-ai-agency-dashbord.netlify.app`.
- Rôles acceptés : `admin, manager, agent, viewer` (pas `owner`).

---

## 1. Colonnes ajoutées à des tables existantes

Toutes `ADD COLUMN`, toutes avec défaut ou nullable → aucune ligne existante
n'est réécrite de façon destructive.

### `saas_immobilier.plans` (+7)
```sql
ALTER TABLE saas_immobilier.plans
  ADD COLUMN IF NOT EXISTS display_name             text,
  ADD COLUMN IF NOT EXISTS setup_fee                numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_photos_per_property  integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS monthly_agent_messages   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_follow_ups       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS modules                  jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_order               integer NOT NULL DEFAULT 0;
```
Colonnes existantes conservées telles quelles : `max_whatsapp_connections`,
`monthly_ai_tokens`, `monthly_conversations`, `features`.

### `saas_immobilier.subscription_payments` (+4, structure agrégateur inactive)
```sql
ALTER TABLE saas_immobilier.subscription_payments
  ADD COLUMN IF NOT EXISTS declaration_id      uuid,
  ADD COLUMN IF NOT EXISTS provider            text,   -- NULL = manuel
  ADD COLUMN IF NOT EXISTS provider_reference  text,
  ADD COLUMN IF NOT EXISTS provider_status     text;
```
`method` garde son défaut `'manual'`. Aucun de ces 4 champs n'est écrit par le
LOT A ; ils préparent le branchement futur d'un agrégateur.

### `saas_immobilier.user_profiles` (+1)
```sql
ALTER TABLE saas_immobilier.user_profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
```
Sert à forcer le changement de mot de passe à la première connexion (méthode 1).

### `saas_immobilier.agencies` (+2, traçabilité de la suspension)
```sql
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN IF NOT EXISTS suspended_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text;
```
`logo_url` existe déjà → rien à ajouter pour le logo.

---

## 2. Valeurs écrites dans `plans` (3 UPDATE, pas d'INSERT)

Mapping appliqué — les agences existantes gardent leur `plan_id`, donc leur plan :

| Ligne existante | `name` | `display_name` | Devient |
|---|---|---|---|
| 4f457a46… | `starter` | Essentiel | **Essentiel** |
| 940bb1ac… | `pro` | Pro | **Pro** |
| b7a4ea74… | `enterprise` | Premium | **Premium** |

Conséquence pour les 2 agences actuelles : `SBC AI Agency Demo` et
`Diango agengy` sont toutes deux sur `starter` → elles passent automatiquement
sur **Essentiel** (50 000 F/mois, 30 biens, 10 photos/bien, 3 utilisateurs).
Aucun changement de `plan_id`, aucun réabonnement.

| Champ | Essentiel | Pro | Premium |
|---|---|---|---|
| price_monthly | 50 000 | 100 000 | 200 000 |
| setup_fee | 150 000 | 250 000 | 400 000 |
| max_properties | 30 | 150 | 2 000 000 000 |
| max_photos_per_property | 10 | 30 | 2 000 000 000 |
| max_members | 3 | 10 | 2 000 000 000 |
| monthly_agent_messages | 1 000 | 3 000 | 8 000 |
| monthly_follow_ups | 100 | 300 | 1 000 |
| sort_order | 1 | 2 | 3 |

`modules` :
- Essentiel : `["biens","contacts","pipeline","dashboard","ca_chart"]`
- Pro : Essentiel + `["visites","automatisations","ca_filters","ca_export_csv"]`
- Premium : Pro + `["stats_avancees","rapports_mensuels","support_prioritaire"]`

**Illimité** : valeur `2 000 000 000` (tient dans `integer`, max 2 147 483 647).
Règle d'affichage côté front : toute limite `>= 1 000 000 000` s'affiche « Illimité ».
Les triggers comparent normalement, donc aucun cas particulier en base.

Décision D1 : conserver `name = 'starter'` comme slug stable et n'écrire le libellé
que dans `display_name`, OU renommer `name` en `essentiel`. Voir question Q1.

---

## 3. Nouvelles tables (4)

### 3.1 `saas_immobilier.agency_invitations`
```sql
CREATE TABLE IF NOT EXISTS saas_immobilier.agency_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'agent',
  token_hash    text NOT NULL,
  invited_by    uuid,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  used_by       uuid,
  revoked_at    timestamptz,
  revoked_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_agency_invitations_token_hash
  ON saas_immobilier.agency_invitations (token_hash);
CREATE INDEX IF NOT EXISTS ix_agency_invitations_agency
  ON saas_immobilier.agency_invitations (agency_id, created_at DESC);
```
Jeton : 32 octets aléatoires encodés en base64url, renvoyé **une seule fois** à
l'appelant ; seule la version `digest(token,'sha256')` (pgcrypto) est stockée.
Validité 48 h (`expires_at = now() + interval '48 hours'`), usage unique
(`used_at`), révocable (`revoked_at`).

### 3.2 `saas_immobilier.payment_declarations`
```sql
CREATE TABLE IF NOT EXISTS saas_immobilier.payment_declarations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id            uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  amount               numeric NOT NULL,
  currency             text NOT NULL DEFAULT 'XOF',
  method               text NOT NULL,          -- orange_money | wave
  transaction_reference text NOT NULL,
  paid_on              date NOT NULL,
  proof_path           text,                   -- bucket privé payment-proofs
  declared_by          uuid,
  status               text NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  note                 text,
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_note          text,
  payment_id           uuid,                   -- subscription_payments.id une fois validé
  provider             text,                   -- réservé agrégateur
  provider_reference   text,                   -- réservé agrégateur
  provider_status      text,                   -- réservé agrégateur
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_declarations_status
  ON saas_immobilier.payment_declarations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_payment_declarations_agency
  ON saas_immobilier.payment_declarations (agency_id, created_at DESC);
```

### 3.3 `saas_immobilier.plan_change_requests`
```sql
CREATE TABLE IF NOT EXISTS saas_immobilier.plan_change_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  requested_plan_id  uuid NOT NULL REFERENCES saas_immobilier.plans(id),
  current_plan_id    uuid REFERENCES saas_immobilier.plans(id),
  requested_by       uuid,
  note               text,
  status             text NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  handled_by         uuid,
  handled_at         timestamptz,
  handle_note        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_plan_change_requests_status
  ON saas_immobilier.plan_change_requests (status, created_at DESC);
```

### 3.4 `saas_immobilier.platform_settings`
```sql
CREATE TABLE IF NOT EXISTS saas_immobilier.platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```
Clés prévues (INSERT initial, aucune donnée existante touchée) :
- `payment_instructions` → `{ orange_money: { name, number }, wave: { name, number } }`
- `billing` → `{ grace_days: 5, reminder_days: [5, 0] }`

---

## 4. Nouvelles fonctions

Lecture / limites :
- `public.agency_current_plan(p_agency_id uuid) RETURNS saas_immobilier.plans`
- `public.plan_limit_value(p_agency_id uuid, p_key text) RETURNS integer`
- `public.agency_usage_snapshot(p_agency_id uuid) RETURNS jsonb`
  → `{ properties, members_active, members_invited, invitations_pending,
       max_properties, max_members, max_photos_per_property, plan }`
- `public.agency_has_module(p_agency_id uuid, p_module text) RETURNS boolean`
- `public.agency_billing_state(p_agency_id uuid) RETURNS jsonb`
  → `{ ends_at, days_to_due, grace_days, is_due_soon, is_overdue }`

Triggers de limites :
- `public.enforce_property_limit() RETURNS trigger`
- `public.enforce_photo_limit() RETURNS trigger`
- `public.enforce_member_limit() RETURNS trigger`

Invitations :
- `public.create_agency_invitation(p_agency_id uuid, p_role text)
   RETURNS TABLE(invitation_id uuid, token_plain text, expires_at timestamptz)`
- `public.redeem_agency_invitation(p_token text, p_email text, p_full_name text)
   RETURNS TABLE(agency_id uuid, role text)`
- `public.revoke_agency_invitation(p_invitation_id uuid) RETURNS boolean`

Offre / paiement :
- `public.request_plan_change(p_agency_id uuid, p_plan_id uuid, p_note text) RETURNS uuid`
- `public.admin_handle_plan_change(p_request_id uuid, p_decision text, p_note text) RETURNS boolean`
- `public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid) RETURNS boolean`
- `public.submit_payment_declaration(p_agency_id uuid, p_amount numeric, p_method text,
   p_transaction_reference text, p_paid_on date, p_proof_path text) RETURNS uuid`
- `public.review_payment_declaration(p_declaration_id uuid, p_decision text, p_note text)
   RETURNS uuid` — à la validation : INSERT dans `subscription_payments`
  (`method='manual'`) + prolongation de `agency_subscriptions.ends_at` d'un mois.

Impayés :
- `public.suspend_overdue_agencies() RETURNS integer` — passe à `suspended` les
  agences dont `ends_at < now() - grace_days`, renseigne `suspended_at` et
  `suspended_reason='unpaid'`. Ne touche jamais une agence déjà suspendue pour
  une autre raison.

---

## 5. Nouveaux triggers (3)

```sql
CREATE TRIGGER properties_enforce_plan_limit
  BEFORE INSERT ON saas_immobilier.properties
  FOR EACH ROW EXECUTE FUNCTION public.enforce_property_limit();

CREATE TRIGGER property_media_enforce_photo_limit
  BEFORE INSERT ON saas_immobilier.property_media
  FOR EACH ROW EXECUTE FUNCTION public.enforce_photo_limit();

CREATE TRIGGER agency_members_enforce_plan_limit
  BEFORE INSERT ON saas_immobilier.agency_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_member_limit();
```

Règles :
- **INSERT uniquement** (pas d'UPDATE) → rien d'existant n'est jamais supprimé ni
  modifié. Un portefeuille déjà au-dessus de la limite reste intact ; seuls les
  nouveaux ajouts sont refusés jusqu'à revenir sous la limite.
- Photos : ne compte que `media_type = 'photo'` (les 21 lignes actuelles sont
  toutes de ce type). `video` et `document` ne sont pas comptés.
- Membres : compte `agency_members.status IN ('active','invited')` **+** les
  invitations en attente non expirées de `agency_invitations`. Le propriétaire
  est donc inclus dans les 3 / 10.
- Désactiver un agent = passer son `status` à `'suspended'` → il ne compte plus,
  la place est libérée, un nouvel ajout passe.
- Refus par `RAISE EXCEPTION` avec un code SQLState dédié et un message français
  explicite (ex. `plan_limit_properties`, `plan_limit_photos`,
  `plan_limit_members`) pour que le front affiche le bon écran « Passer au Pro ».

---

## 6. Nouvelles politiques RLS

```sql
-- agency_invitations
agency_invitations_select_admin   SELECT  has_agency_role(agency_id,'admin')
agency_invitations_insert_admin   INSERT  WITH CHECK has_agency_role(agency_id,'admin')
agency_invitations_update_admin   UPDATE  has_agency_role(agency_id,'admin')
agency_invitations_delete_admin   DELETE  has_agency_role(agency_id,'admin')
-- aucune lecture anon/authenticated : la rédemption passe par la fonction
-- SECURITY DEFINER redeem_agency_invitation()

-- payment_declarations
payment_declarations_insert_member  INSERT  WITH CHECK is_agency_member(agency_id)
payment_declarations_select_member  SELECT  is_agency_member(agency_id)
payment_declarations_admin_all      ALL     is_platform_admin()

-- plan_change_requests
plan_change_requests_insert_member  INSERT  WITH CHECK is_agency_member(agency_id)
plan_change_requests_select_member  SELECT  is_agency_member(agency_id)
plan_change_requests_admin_all      ALL     is_platform_admin()

-- platform_settings
platform_settings_select_authenticated  SELECT  to authenticated
platform_settings_admin_write           ALL     is_platform_owner()

-- lecture des paiements par l'agence (aujourd'hui impossible : la seule
-- politique de subscription_payments est réservée à is_platform_admin)
subscription_payments_select_member     SELECT  is_agency_member(agency_id)
```
Aucune politique existante n'est supprimée ni modifiée.

---

## 7. Storage

- **Nouveau bucket privé** `payment-proofs` (`public = false`) pour les captures
  de paiement, avec `file_size_limit = 5242880` et
  `allowed_mime_types = image/jpeg,image/png,image/webp,application/pdf`.
- `agency-assets` reste **public et inchangé** : un logo est par nature une
  ressource publique. La limite 2 Mo + png/jpg/webp + redimensionnement sont
  appliqués côté client et dans l'Edge Function, pas en modifiant la
  configuration existante du bucket.
- `property-images` et `bsfood` : inchangés.

---

## 8. Extensions

- `pgcrypto` : déjà installé → rien à faire.
- `pg_cron 1.6.4` : disponible, non installé. Nécessaire pour l'option A de la
  suspension automatique. Voir question Q2 — **non installé sans accord**.

---

## 9. Ce qui n'est PAS un changement de base

- Mode sombre : uniquement `artifacts/sofia-immobilier/src/index.css` + un
  toggle. Cause racine vérifiée :
  - `body { background: #f7f6f1 }` (index.css ~ligne 337) est écrit **hors**
    `@layer base`, donc il gagne sur le `@apply bg-background` et le fond reste
    beige clair même avec `.dark` actif ;
  - `.dark` (ligne 221) définit `--foreground: 40 26% 92%` (texte quasi blanc)
    → texte blanc sur fond beige = illisible ;
  - **263 occurrences** de couleurs en dur après la ligne 324 et **zéro** règle
    `.dark` après cette ligne : tout le CSS applicatif est écrit en clair seul ;
  - aucun code n'ajoute la classe `.dark` (grep sur `.tsx`/`.ts`/`index.html` :
    rien). `next-themes@0.4.6` est déjà dans les dépendances, utilisé seulement
    par `components/ui/sonner.tsx` qui n'est pas monté.
- `recharts@2.15.2` est déjà présent → graphiques CA et abonnements sans nouvelle
  dépendance.

---

## 10. Fichier de retour arrière

`db/rollback/lot_a_rollback.sql` sera créé avant toute exécution, dans cet ordre :
1. `DROP TRIGGER` des 3 triggers de limites ;
2. `DROP FUNCTION` des fonctions ajoutées ;
3. `DROP POLICY` des politiques ajoutées ;
4. `DROP TABLE` des 4 nouvelles tables ;
5. `DROP INDEX` associés ;
6. `ALTER TABLE ... DROP COLUMN` des 14 colonnes ajoutées ;
7. `UPDATE plans` remettant exactement les valeurs d'origine relevées plus haut
   (starter 0/3/50/1/100000/500, pro 75000/10/250/3/500000/2500,
   enterprise 195000/50/2000/10/2500000/15000) ;
8. suppression du bucket `payment-proofs` et de ses objets ;
9. `DROP EXTENSION pg_cron` si et seulement si je l'ai installé.
Les INSERT dans `platform_settings` seront supprimés par clé explicite.

---

## 11. Points non vérifiables ici (déclarés comme tels)

- **Accès n8n** : aucun rôle PostgreSQL `n8n` n'existe (`pg_roles` ne renvoie que
  anon, authenticated, postgres, service_role, supabase_admin) et aucune
  connexion n8n n'était visible dans `pg_stat_activity`. Si l'agent n8n utilise
  la clé `service_role`, il **contourne RLS** et le passage à `suspended` ne le
  bloquera pas. Impossible à trancher depuis ici → question Q4.
- Je n'ai pas pu balayer les 73 définitions de fonctions à la recherche d'une
  référence au slug `'starter'` : la requête sur `pg_get_functiondef` avec filtre
  de texte échoue systématiquement (`ERROR 42809: "array_agg" is an aggregate
  function`) côté API de gestion. Les fonctions inspectées une par une
  (`create_agency_for_self`, `onboard_agency`,
  `get_agency_subscription_dashboard`) ne filtrent pas sur le nom du plan —
  `create_agency_for_self` fait `ORDER BY price_monthly ASC LIMIT 1`. D'où la
  prudence de la décision D1.
- Le dépôt git ne contient pas le code des 5 Edge Functions : je ne peux pas
  diffuer leur version actuelle avant de les modifier → question Q3.
