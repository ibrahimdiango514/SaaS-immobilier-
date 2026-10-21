# État d'avancement — Sofia Immobilier

Dernière mise à jour : 2026-10-21 · branche `arena/eaaefdc5-saas-immobilier`

## Reprendre ici

```bash
cd /home/user/SaaS-immobilier-
git checkout arena/eaaefdc5-saas-immobilier   # déjà la branche courante
git log --oneline -3
```

**Commit de départ pour la prochaine session** : voir `git log -1`. Ne jamais
toucher `main` (`a02fc7b`) ni `arena/cffd2507-saas-immobilier` (branche Netlify,
crédits limités).

## Environnement de travail

```bash
export PATH="/usr/local/bin:$PATH"
corepack enable && corepack prepare pnpm@10.18.0 --activate
cd artifacts/sofia-immobilier && pnpm install --prefer-offline
pnpm run typecheck
PORT=3000 BASE_PATH=/ pnpm run build
```

Preview (port 3000, variables `VITE_SOFIA_PUBLIC_SUPABASE_URL` /
`VITE_SOFIA_PUBLIC_SUPABASE_KEY`, valeurs publiques dans `netlify.toml`).

## Conventions impératives (pièges déjà rencontrés)

- **Tables** via `db()` = `getSupabaseClient().schema('saas_immobilier')`
  (`data-hooks.ts:29`). Sans `.schema()`, PostgREST cherche dans `public` et
  échoue : `Could not find the table 'public.agency_members'`.
- **RPC** dans `public` : `agency_usage_snapshot`, `agency_seat_availability`,
  `request_plan_change`, `create_agency_member`, `redeem_agency_invitation`,
  `has_agency_role`, `property_photos_for_agent`.
- Exception : `agence_active` est dans `saas_immobilier`.
- `storage` et `auth` se prennent sur le client nu (indépendants du schéma).
- `database.types.ts` est incomplet : les `.rpc()` exigent un cast
  `(getSupabaseClient() as unknown as { rpc: ... })`.
- `REVOKE ... FROM PUBLIC` **ne suffit pas** sur Supabase : `anon` et
  `authenticated` ont des privilèges par défaut explicites. Toujours écrire
  `REVOKE ... FROM PUBLIC, anon, authenticated`.

## FAIT

### Point 0 — bug page Équipe
Accès tables alignés sur `saas_immobilier` dans `team.tsx` (2 sites) et
`force-password.tsx`. Les RPC étaient déjà corrects.

### Point 4 (LOT A) — Équipe
- `src/lib/agency-team-api.ts`, `src/pages/team.tsx`, `src/pages/rejoindre.tsx`,
  `src/pages/force-password.tsx`
- Création directe, lien d'invitation (copier + WhatsApp), page publique de
  rachat, compteur de places, désactivation/réactivation, verrou
  `must_change_password` dans `WorkspaceGate`, masquage nav pour les agents.
- Edge Functions déployées : `create-agency-member` v3,
  `invite-agency-member` v2, `redeem-agency-invitation` v1 (`verify_jwt: false`).
  Baselines dans `supabase/functions-deployed/`.

### Point A (LOT B) — photos pour Sofia
- `public_url` désormais écrit à l'upload (`data-hooks.ts`, 2 sites).
- Compression par paliers de qualité jusqu'à 5 Mo (`image-tools.ts`),
  `MAX_PROPERTY_IMAGE_SIZE` = 5 Mo, message aligné.
- `docs/n8n-photos-whatsapp.md`.

### Point B (LOT B) — Mon offre (partiel)
- `src/pages/my-offer.tsx`, route `/mon-offre` : offre, prix, échéance, jauges
  (biens / utilisateurs / photos), modules inclus et verrouillés (catalogue =
  union réelle des modules des plans en base), bouton « Passer au Pro/Premium »
  via `request_plan_change`, bandeau d'alerte 5 jours / retard.
- Le bouton « Payer mon abonnement » est **inerte** (message d'attente).

### Bloc 9 — navigation mobile
- Bouton retour ajouté au `mobile-header` (il n'existait que dans le `topbar`
  desktop). Zone tactile 44 px, `safe-area-inset-*` respectés, repli sur
  `/dashboard` sans historique.

## RESTE (non commencé)

| bloc | contenu |
|---|---|
| 1 | Paiement manuel agence : activer le bouton, formulaire, `submit_payment_declaration`, capture en bucket privé, instructions depuis `platform_settings`, état des déclarations |
| 2 | Admin : réglages, file « Paiements à valider » (`review_payment_declaration`), demandes de changement d'offre, changement en un clic (`admin_change_agency_plan`), graphique des abonnements |
| 3 | Compteur « 7/10 » à l'upload, refus partiel d'un envoi multiple |
| 4 | Infos agence + logo (bucket `agency-assets`), lecture seule agent, journal d'activité |
| 5 | Edge Function `reset-agent-password` + bouton dans la page Équipe |
| 6 | Suppression / archivage d'un bien, purge Storage, exclusion des archivés de la limite |
| 7 | Consommation IA + canal WhatsApp (admin + agence), `whatsapp_connections`, `record_ai_usage` |
| 8 | Assistant IA `dashboard-assistant` (Pro/Premium), Groq, lecture seule avec JWT utilisateur |
| 9 | **Reste** : bouton retour dans l'espace admin, pages publiques, déconnexion partout |
| 10 | Audits : mode clair/sombre, isolation inter-agences, rôles, agence suspendue, limites, parcours complets |

## Appliqué en base (tout est additif, rollbacks dans `db/rollback/`)

| migration | contenu | rollback |
|---|---|---|
| `2026-10-20_lot_a.sql` | LOT A complet | `2026-10-20_lot_a_rollback.sql` |
| `2026-10-20_lot_a_suite_invitation_status.sql` | `agency_invitation_status`, `invitation_attempts`, `register_invitation_attempt` | `2026-10-20_lot_a_suite_rollback.sql` |
| `2026-10-21_lot_b_photos_agent.sql` | `property_photos_for_agent` | `2026-10-21_lot_b_photos_agent_rollback.sql` |

Autres écritures en base :
- `public_url` rempli rétroactivement sur la photo orpheline (21/21 désormais).
- `pg_cron` job `sofia-lot-a-suspend-overdue` (`*/15 * * * *`, `job_id 1`).
  Désactiver : `UPDATE cron.job SET active=false WHERE jobname='sofia-lot-a-suspend-overdue';`
- Droits durcis : `agency_invitation_status`, `register_invitation_attempt` et
  `property_photos_for_agent` en `service_role` uniquement.

## Non déployé / non appliqué

- Aucune Edge Function nouvelle depuis `redeem-agency-invitation`.
- `GROQ_API_KEY` non défini (bloc 8 non commencé).
- `platform_settings` : `payment_instructions` volontairement vide.

## Comptes de test

| compte | rôle | agence |
|---|---|---|
| `nabilayediango910@gmail.com` | platform_owner | — |
| `ibrahimdiango514@gmail.com` | propriétaire | Diango agengy (Essentiel, 1/3 places, 1/30 biens) |
| `babergang009@gmail.com` | propriétaire | SBC AI Agency Demo (Essentiel) |
| `agence.desactivee.test@example.com` | propriétaire | Agence Test Suspendue |

## Ne pas refaire

- Ne pas chercher un « commit à jour » sur `main` : la base de travail est
  `arena/eaaefdc5-saas-immobilier`.
- Ne pas recréer les fonctions SQL listées ci-dessus, elles existent.
- Le refspec git local masque des branches : pour lister les branches distantes,
  utiliser `curl https://api.github.com/repos/ibrahimdiango514/SaaS-immobilier-/branches`.
- Le bac à sable **ne peut pas** appeler `*.supabase.co` (`SSL_ERROR_SYSCALL`) :
  les Edge Functions déployées ne sont testables que depuis un navigateur.

---

# SESSION 2026-10-21 (suite) — branche `arena/ffbfe14e-saas-immobilier`

> La branche de session Arena a changé. Le travail précédent
> (`arena/eaaefdc5-saas-immobilier`, commit `cd3aa50`) a été **fusionné** dans
> `arena/ffbfe14e-saas-immobilier`. Aucune branche existante n'a été réécrite.

## BLOC 1 — PAIEMENT MANUEL (agence) : FAIT

- Migration `db/migrations/2026-10-21_bloc1-2_paiements_admin.sql` **appliquée en base**
  (rollback : `db/rollback/2026-10-21_bloc1-2_paiements_admin_rollback.sql`).
  Additive : 3 fonctions SECURITY DEFINER dans `public`, aucune table/colonne/RLS touchée.
  - `public.agency_payment_access(uuid)` → instructions `platform_settings`,
    échéance (`agency_billing_state`), plan, montant attendu, déclarations de l'agence.
    Garde : `is_agency_member`. Droits : `authenticated` + `service_role` (revoke PUBLIC/anon).
  - `public.admin_update_platform_setting(text, jsonb)` → garde `is_platform_owner`
    (identique à la RLS existante `platform_settings_admin_write`, aucun droit élargi).
    Clés autorisées : `payment_instructions`, `billing`.
  - `public.platform_subscription_revenue(integer)` → garde `is_platform_admin`.
    Revenus par mois sur `subscription_payments` (donc paiements **validés** uniquement),
    répartition par plan réel, totaux (payantes, essai, suspendues, échéances, files d'attente).
- `src/lib/payments-api.ts` : hooks `useAgencyPaymentAccess`, `useSubmitPaymentDeclaration`,
  `usePaymentProofUrl`. Capture dans le bucket **privé** `payment-proofs` au chemin
  `<agency_id>/<uuid>-<nom>` — imposé par la politique existante
  `payment_proofs_owner_select` qui lit `public.storage_agency_id(name)`.
  Compensation : si la déclaration échoue après l'envoi, le fichier est supprimé.
- `src/components/payment-panel.tsx` : instructions (Orange Money / Wave + bénéficiaire),
  formulaire (montant, date, moyen, référence obligatoire, capture 5 Mo jpg/png/webp/pdf),
  historique avec état **en attente / validée / rejetée + motif**.
  Bouton « Payer mon abonnement » réservé à `can_manage` (owner/admin), lecture seule sinon.
- `src/pages/my-offer.tsx` : bouton inerte remplacé par `<PaymentSection/>`, échéance datée.
- CSS : jetons **manquants** définis (`--si-text-muted`, `--si-panel`, `--si-panel-subtle`,
  `--si-success-text`, `--si-info-text`) — 15 usages existants retombaient sur une valeur
  héritée, donc contraste imprévisible en clair comme en sombre.
- `pnpm run typecheck` OK · `pnpm run build` OK.
- Non testé sans navigateur : l'envoi réel de la capture et l'appel RPC.

## BLOC 2 — ADMIN (offres et paiements) : FAIT

- **Réglages** `src/pages/admin/settings.tsx` → route `/admin/reglages` :
  numéros Orange Money / Wave + titulaires, nom du bénéficiaire, consigne affichée,
  délai de grâce. Écriture via `public.admin_update_platform_setting`
  (garde `is_platform_owner`) ; un admin non propriétaire voit l'écran en lecture seule.
- **File « Paiements à valider » + demandes de changement d'offre**
  `src/pages/admin/billing.tsx` → route `/admin/paiements`, deux onglets avec compteurs.
  - Validation / rejet avec motif **obligatoire au rejet** via `review_payment_declaration`
    (prolonge l'abonnement d'1 mois, crée le paiement, réactive l'agence suspendue).
  - Approbation / refus des demandes via `admin_handle_plan_change`.
  - Capture lisible en URL signée 15 min (`payment_proofs_select` = is_platform_admin).
- **Changement d'offre en un clic** dans `/admin/abonnements` : sélecteur d'offre +
  « Appliquer » → `admin_change_agency_plan`, avec confirmation.
- **Graphique des abonnements** de la vue d'ensemble admin **rebranché** sur
  `public.platform_subscription_revenue` : revenus par mois et agences payantes calculés
  **en base** sur `subscription_payments` (= paiements validés), KPI agences payantes /
  en essai / suspendues / variation, répartition par offre réelle (display_name) et
  revenus cumulés par offre, bandeau des files d'attente en attente.
- `src/lib/admin-billing-api.ts` : hooks admin (déclarations, demandes, réglages, revenus,
  URL de capture, review, handle, change plan, update setting).
- Pastille de compteur sur l'entrée de menu admin « Paiements & offres ».
- `useAllAgencies` projette désormais `display_name`, `sort_order`, `setup_fee`,
  `max_photos_per_property`, `monthly_agent_messages`, `modules` ; `PlanRow` complété.
  Les écrans admin affichent « Essentiel / Pro / Premium » au lieu de `starter/pro/enterprise`.
- `pnpm run typecheck` OK · `pnpm run build` OK.

## BLOC 3 — PHOTOS (compteur et limite) : FAIT

- `src/lib/plan-limits.ts` : `useAgencyPlan` (RPC existant `public.agency_current_plan`),
  `usePhotoQuota` → `{ limit, used, remaining, reached, unlimited, planName }`,
  `formatQuota` (« 7/10 »), `splitByPhotoQuota` (découpe d'un envoi multiple),
  `useUpgradeTargets` + `pickUpgradeTarget` + `useRequestUpgrade`.
- `src/components/photo-quota.tsx` : jauge + compteur, et à la limite un encadré
  « Limite atteinte : 10/10 photos avec l'offre Essentiel » avec bouton
  **« Passer au Pro/Premium »** (→ `request_plan_change`, réservé owner/admin)
  et lien « Voir mon offre ».
- `useUploadPropertyMediaBatch` ne s'interrompt plus au premier échec : il renvoie
  `{ uploaded, failed }`. Les photos qui passent sont conservées, les refusées nommées.
- Fiche bien (`PropertyDetailPage`) : compteur dans l'en-tête de galerie, jauge,
  envoi multiple découpé selon la place restante, message listant les photos refusées
  et le motif ; mention « illimité » remplacée par la limite réelle de l'offre.
- Formulaire de bien (`PropertyDialog`) : même compteur (photos enregistrées + photos
  préparées), refus dès la sélection avec noms des fichiers non retenus.
- La limite reste appliquée **côté base** par le trigger `enforce_photo_limit`
  (aucune fonction existante modifiée).
- `pnpm run typecheck` OK · `pnpm run build` OK.

## BLOC 4 — INFORMATIONS DE L'AGENCE ET LOGO : FAIT

- `src/lib/agency-logo.ts` (nouveau) : PNG/JPG/WebP uniquement, **2 Mo maximum**
  (message avec le poids réel), **redimensionné à 512 px** en conservant le ratio
  et la transparence (WebP), repli sur une qualité plus basse puis sur l'original
  si le canvas 2D n'est pas disponible.
  `useUploadAgencyLogo` (envoi + `agencies.logo_url` + compensation Storage en cas
  d'échec de l'UPDATE) et `useDeleteAgencyLogo` (fichier + colonne remise à `null`).
  Chemin imposé par les politiques existantes `agency_assets_*` :
  `agencies/<agency_id>/<uuid>-<nom>` dans le bucket public `agency-assets`.
- `src/components/agency-logo-card.tsx` : aperçu 92 px, « Remplacer le logo »,
  « Supprimer le logo » (avec confirmation), contraintes affichées, états occupés,
  et **encart lecture seule pour un agent** (la RLS `agencies_update_admin` refuse
  déjà l'écriture — le bouton n'est simplement pas proposé).
- Carte intégrée aux Paramètres (`SettingsPage`), après « Informations de l'agence ».
- `AgencyLogo` (`lib/workspace-ui.tsx`) : logo ou initiale en repli (y compris si le
  fichier ne se charge pas). Affiché dans **la barre latérale** (sélecteur d'agence),
  **l'en-tête** (fil d'Ariane desktop + en-tête mobile) et la **fiche Agence**.
- Traçabilité : le trigger `activity_log_agencies` journalise déjà chaque UPDATE ;
  `src/lib/agency-activity.ts` ajoute une entrée précise listant les champs réellement
  changés (`diffAgencyFields` + `traceAgencySettingsChange`), et le logo écrit
  « Logo de l'agence mis à jour / supprimé » avec le chemin Storage et le poids.
  Un échec de journalisation ne bloque jamais l'action.
- Onboarding aligné sur les mêmes règles (avant : SVG accepté, 3 Mo).
- `pnpm run typecheck` OK · `pnpm run build` OK. Aucune migration nécessaire
  (`agencies.logo_url` et le bucket `agency-assets` existent déjà).

## BLOC 5 — RÉINITIALISATION DU MOT DE PASSE D'UN MEMBRE : FAIT ET DÉPLOYÉ

- **Edge Function `reset-agent-password` DÉPLOYÉE** (projet `xbuuhfwobrafcbgtdgjx`,
  version 1, `verify_jwt = true`, id `fee21315-0f35-4d23-b996-fe54c208508f`).
  Source : `supabase/functions/reset-agent-password/index.ts`.
- Garde-fous côté serveur (rien n'est cru depuis le corps de requête) :
  1. appelant authentifié via son JWT ;
  2. membership cible **résolu par le serveur** (`agency_members`) → l'agence est
     déduite de la cible, donc même agence par construction ;
  3. appelant owner/admin de l'agence de la cible (`public.has_agency_role`,
     avec repli sur lecture directe si la résolution RPC échoue — jamais si elle
     renvoie `false`) ;
  4. **la cible ne doit pas être le propriétaire** (`owner_password_cannot_be_reset`) ;
  5. la cible ne doit pas être l'appelant (`cannot_reset_own_password`) ;
  6. agence non suspendue (`agency_suspended`).
- Mot de passe **généré côté serveur** : 14 caractères, alphabet sans caractères
  ambigus (0/O, 1/l/I), composition garantie (≥1 majuscule, ≥1 minuscule, ≥1 chiffre),
  `crypto.getRandomValues`. Renvoyé **une seule fois** dans la réponse.
- `must_change_password = true` posé **dans `auth.user_metadata` ET dans
  `saas_immobilier.user_profiles`** (c'est ce dernier que lit le verrou `WorkspaceGate`).
- Traçabilité : entrée `activity_log` (action `updated`, entité `agency_members`)
  avec e-mail cible, rôle, `reset_by` = id de l'appelant. Un échec de journalisation
  ne fait jamais échouer l'opération.
- Front : `resetAgentPassword()` dans `lib/agency-team-api.ts` (+ 8 nouveaux libellés
  d'erreur en français) ; bouton « Réinitialiser le mot de passe » (icône `RotateCcw`)
  sur chaque ligne de membre **sauf le propriétaire et soi-même** (page Équipe),
  panneau de confirmation expliquant les conséquences, puis encart « Nouveau mot de
  passe à transmettre » avec copie et avertissement d'affichage unique.
- `pnpm run typecheck` OK · `pnpm run build` OK. Aucune migration nécessaire.
- ⚠️ Non testable depuis le sandbox (pas d'accès réseau à `*.supabase.co`) :
  le test réel se fait depuis le navigateur — voir la liste de tests manuels.

## BLOC 6 — SUPPRESSION ET ARCHIVAGE D'UN BIEN : FAIT, MIGRATION APPLIQUÉE

**Migration appliquée en base** (`create_migration`, nom `bloc6_archive_suppression`) :
`db/migrations/2026-10-21_bloc6_archive_suppression.sql`
+ rollback `db/rollback/2026-10-21_bloc6_archive_suppression_rollback.sql`.

- `saas_immobilier.properties.is_archived boolean NOT NULL DEFAULT false`
  et `archived_at timestamptz` (additifs) + 2 index partiels.
- **Découverte décisive** : le trigger existant `trg_sync_property_revenue`
  (`AFTER UPDATE OF status, price, …`) **annule** l'opération de CA automatique dès
  que le statut quitte `sold`/`rented`. Passer un bien vendu à `status='archived'`
  aurait donc **effacé son CA**. → L'archivage utilise la colonne dédiée
  `is_archived` et ne touche jamais au `status` : le CA, l'historique et les
  statistiques restent intacts, **sans modifier aucun trigger existant**.
- **Seule modification d'une fonction existante** (validée par l'utilisateur,
  « vas-y continue » après présentation de l'option recommandée) :
  `public.enforce_property_limit()` recréée avec `AND is_archived = false` dans le
  COUNT. Plafond, offre, message et HINT `plan_limit_properties` inchangés.
  Le rollback restaure la définition d'origine à l'identique.
- 3 nouvelles fonctions `SECURITY DEFINER`, `GRANT EXECUTE` à `authenticated,
  service_role` uniquement (révoqué `PUBLIC, anon`) :
  - `public.property_delete_impact(uuid) → jsonb` (STABLE, garde `is_agency_member`) :
    photos, opérations de CA + montant, opportunités, visites, RDV, `can_delete`,
    `can_archive`, `archive_suggested`.
  - `public.archive_property(uuid, boolean) → jsonb` (garde `has_agency_role(...,'admin')`).
  - `public.delete_property_with_media(uuid) → jsonb` (garde `admin`) : renvoie les
    chemins Storage **avant** le CASCADE, puis supprime le bien.
- Clés étrangères vérifiées : `property_media`, `sales_pipeline`, `property_visits`,
  `property_recommendations`, `property_availability` = **ON DELETE CASCADE** ;
  `revenue_operations` et `appointments` = **ON DELETE SET NULL** → le CA survit à
  la suppression du bien (détaché), les opportunités/visites disparaissent.
  Aucun RESTRICT : la suppression ne peut pas échouer sur un bien avec du CA.

**Front**
- `src/components/property-lifecycle.tsx` :
  - `PropertyLifecyclePanel` (fiche bien) : bouton **Archiver** (libellé renforcé
    « Archiver ce bien vendu/loué » quand `status ∈ sold, rented`), **Restaurer**,
    **Supprimer définitivement**. Confirmation dans une feuille dédiée avec la liste
    chiffrée de l'impact (photos purgées, opérations de CA conservées mais détachées,
    opportunités et visites perdues) et un avertissement « pensez à archiver » dès
    qu'il y a du CA. Après suppression : purge du bucket `property-images` puis
    retour à `/biens`.
  - `ArchivedPropertiesPanel` (page Biens) : tiroir « Biens archivés » replié par
    défaut, compteur, mention « Non comptés dans la limite de biens de votre offre ·
    CA et historique conservés », actions Restaurer / Supprimer.
  - **Lecture seule pour un agent** : encart `permission-note`, aucun bouton.
- `useProperties` exclut désormais les biens archivés (`.eq('is_archived', false)`) ;
  nouveau `useArchivedProperties`. Les 3 listes de colonnes dupliquées
  (create/update/all-properties) sont remplacées par la constante `PROPERTY_COLUMNS`.
- La fiche d'un bien archivé reste consultable (recherche dans les deux requêtes)
  avec un bandeau « Bien archivé le … ».
- Espace plateforme (`pages/admin/properties.tsx`) : pastille « Archivé par l'agence »
  pour distinguer l'archivage agence (`is_archived`) de la modération plateforme
  (`status='archived'`), dans le tableau et le tiroir de détail.
- `pnpm run typecheck` OK · `pnpm run build` OK.

## BLOC 7 — CONSOMMATION IA + CANAL WHATSAPP : FAIT, 3 FONCTIONS APPLIQUÉES

**Migration STRICTEMENT ADDITIVE appliquée en base** :
`db/migrations/2026-10-21_bloc7_usage_ia_whatsapp.sql`
+ rollback `db/rollback/2026-10-21_bloc7_usage_ia_whatsapp_rollback.sql`.
Aucune table, colonne, politique RLS ni fonction existante modifiée. Réutilise
`agency_usage`, `usage_events`, `whatsapp_connections` et `plans` — **aucune
table dupliquée** (`whatsapp_connections` existait déjà, comme annoncé).

### Fonctions créées (droits vérifiés en base)
| Fonction | Rôle | Droits |
|---|---|---|
| `public.record_ai_usage(agency_id, tokens_in, tokens_out, messages, conversations, event_key, user_id, metadata) → jsonb` | incrémente `agency_usage` (mois UTC courant) | **service_role UNIQUEMENT** — vérifié : anon=false, authenticated=false, service_role=true |
| `public.agency_ai_usage(uuid) → jsonb` | consommation du mois + quotas + ratios + alertes + canaux WhatsApp | authenticated (garde interne `is_agency_member` OU `is_platform_admin`), service_role |
| `public.platform_agency_usage() → jsonb` | tableau plateforme : 1 ligne/agence + totaux | authenticated (garde interne `is_platform_admin()`) |

`record_ai_usage` applique **le même contrôle `agence_active` que les photos** :
une agence suspendue lève `agency_suspended` et ne consomme plus.

### Deux pièges techniques découverts et contournés (à retenir)
1. **`current_user` ne vaut JAMAIS `'service_role'` dans une fonction
   `SECURITY DEFINER`** (il devient le propriétaire, `postgres` — vérifié en base :
   `current_user = 'postgres'`). Le contrôle service_role passe donc par
   **`auth.role()`** (claim `role` du JWT). Conséquence : l'existante
   `public.record_usage_event` teste `current_user = 'service_role'` → son chemin
   service_role est **mort** ; elle exige toujours `auth.uid()` + un
   `p_conversation_id`. À traiter au BLOC 10.
2. **`usage_events` n'a aucune contrainte unique sur `(agency_id, event_key)`** →
   un `ON CONFLICT (agency_id, event_key)` lève `42P10`. C'est précisément ce que
   fait `record_usage_event` (donc elle échoue aussi pour cette raison).
   `record_ai_usage` déduplique par un `SELECT` préalable et renvoie
   `"deduplicated": true`. **Ne pas ajouter d'`ON CONFLICT` sur cette table.**

### Front
- `src/lib/usage-api.ts` : types + `useAgencyAiUsage` + `usePlatformAgencyUsage`,
  `compactNumber`, `isUnlimitedLimit`, `whatsappStatusLabel`, `ALERT_LABELS`.
- `src/components/usage-gauge.tsx` : `UsageGauge` (jauge à 3 états : `ok`,
  `warning` à 80 %, `reached` à 100 %, `unlimited`) et `WhatsAppBadge`
  (fournisseur + **badge « non officiel » pour Evolution API** + numéro + état +
  `+N` si plusieurs connexions).
- **Espace plateforme** : nouvelle page `src/pages/admin/usage.tsx` →
  `/admin/consommation`, entrée de nav « Consommation IA » (icône `Gauge`).
  4 KPI (tokens du mois + requêtes, quotas sous tension 80 %/100 %, messages +
  conversations, agences avec canal WhatsApp), bandeau d'alerte global avec lien
  vers Abonnements, recherche, filtres (à 80 %, quota atteint, avec WhatsApp),
  tri (tokens / alerte / nom), tableau **par agence** : tokens IA du mois / quota
  avec jauge, messages / plafond, conversations, **colonne canal WhatsApp**
  (fournisseur, numéro, état, badge non officiel), dernière activité. Export CSV.
  Table responsive (passe en cartes sous 900 px). Encart rappelant que l'écran
  est en lecture seule.
- **Espace agence** : panneau « Utilisation IA ce mois » dans `Mon offre`
  (`pages/my-offer.tsx`) — 3 jauges (tokens, messages, conversations), détail
  entrées/sorties, alerte à 80 %/100 % avec invitation à passer à l'offre
  supérieure pour owner/admin, et état du canal WhatsApp de l'agence.
- `pnpm run typecheck` OK · `pnpm run build` OK.

### Données réelles observées
« SBC AI Agency Demo » a 1 connexion **Evolution API** (`+22300000000`,
`disconnected`, dernière activité 2026-08-17) → le badge « non officiel »
s'affichera. Les 3 agences sont à 0 token ce mois (aucune consommation IA
enregistrée à ce jour). « Agence Test Suspendue » n'a aucune offre active :
l'écran affiche « Aucune offre active » et des jauges non plafonnées.

### Guide n8n
`docs/n8n-record-ai-usage.md` : signature, contrôles, appel HTTP PostgREST
(`/rest/v1/rpc/record_ai_usage`) avec la clé service_role en Header Auth,
variante nœud Postgres (avec `set_config('request.jwt.claims', …)` puisque le
claim de rôle n'existe pas en connexion directe), idempotence par `event_key`,
format de réponse, exploitation de `quota_exceeded`, et table de dépannage.

## BLOC 8 — ASSISTANT IA DU TABLEAU DE BORD : FAIT ET DÉPLOYÉ (clé Groq à poser)

### Edge Function `dashboard-assistant` DÉPLOYÉE
Projet `xbuuhfwobrafcbgtdgjx`, version 1, **`verify_jwt = true`**,
id `71a0653e-cd9b-4282-9eff-ad3464571c87`. Source :
`supabase/functions/dashboard-assistant/index.ts`.

Chaîne de contrôles, dans l'ordre (tout côté serveur) :
1. appelant authentifié via son JWT ;
2. **agence DÉDUITE DU JWT** (membership actif). Aucun `agency_id` du navigateur
   n'est lu. Multi-agences : choix déterministe (rôle le plus élevé, puis
   adhésion la plus ancienne) et l'agence retenue est renvoyée dans la réponse ;
3. agence **non suspendue** (`agence_active` + `agencies.status`) ;
4. offre **Pro ou Premium** (`agency_current_plan`, `name ∈ {pro, enterprise}`) ;
5. **quota mensuel de tokens IA non atteint** (`agency_ai_usage` → `alerts.ai_tokens`) ;
6. **limite par utilisateur et par minute** = 8 messages, comptée **en base**
   (`usage_events` où `event_type='assistant_message'` sur 60 s glissantes) donc
   fiable entre les isolats Deno — pas une variable mémoire ;
7. **longueur maximale** du message = 1 200 caractères ; historique borné à
   8 messages de 600 caractères.

### Données : outils en lecture seule, exécutés AVEC le JWT utilisateur
Aucun SQL libre — la liste des requêtes est figée dans la fonction. La RLS
s'applique donc à chaque outil, et l'assistant ne peut pas voir une autre agence.
`biens`, `contacts`, `pipeline`, `visites`, `offre_et_consommation` pour tous ;
**`chiffre_affaires` et `abonnement` uniquement pour owner/admin** (un agent
n'obtient rien, et la règle 9 du prompt système le lui fait dire).

Corrections apportées après vérification du schéma réel (les colonnes attendues
n'existaient pas toutes) :
- `sales_pipeline` porte **`etape`, `probabilite`, `date_visite`** et **aucun
  montant** → la valeur est déduite du prix du bien lié (`properties(...)`
  embarqué) et pondérée par la probabilité ;
- `property_visits` n'a **pas de date planifiée** (seulement `visited_at`) →
  les visites à venir viennent de **`appointments.start_at`**, et
  `property_visits` sert aux visites enregistrées / sans compte rendu ;
- `agency_billing_state` renvoie `has_due_date, sub_status, ends_at, days_to_due,
  grace_days, is_due_soon, is_overdue, is_past_grace, in_valid_trial` (pas de
  `plan_name` ni `agency_status`) — l'outil utilise ces clés exactes.

### Modèle et sécurité du prompt
- Modèle **Groq `llama-3.3-70b-versatile`**, `temperature 0.2`, `max_tokens 700`.
- Clé dans le secret **`GROQ_API_KEY`** (jamais dans le code, jamais dans le
  navigateur). Sans ce secret : réponse `assistant_not_configured` (503).
- Prompt système en français : lecture seule stricte, chiffres uniquement issus
  du bloc `DONNÉES`, « Je ne dispose pas de cette information » sinon, 4 à 8
  lignes, suggestion d'action finale.
- **Anti-injection** : les textes des fiches (titres, descriptions, notes,
  messages clients) sont placés dans un bloc délimité `<<<DEBUT_DONNEES>>>` /
  `<<<FIN_DONNEES>>>` et la règle 5 interdit de les traiter comme des consignes.
  Ils sont aussi tronqués (`clip`, 240 caractères) pour limiter la surface.
- Les tokens sont enregistrés via `public.record_ai_usage()` (service_role) avec
  `event_key = assistant:<uuid>` → idempotent.

### Front
- `src/lib/assistant-api.ts` : `askAssistant`, `askDailySummary`,
  `assistantErrorLabel` (17 codes traduits), `assistantErrorCode`,
  `useAssistantAccess` (garde d'affichage Pro/Premium), suggestions.
- `src/components/assistant-chat.tsx` : fil de discussion, suggestions, compteur
  de caractères, état « réflexion… », **transparence** (outils utilisés + tokens
  affichés sous chaque réponse), rappel « lecture seule » permanent.
- `src/pages/assistant.tsx` **réécrit** : l'ancien assistant par mots-clés côté
  client est remplacé par le vrai assistant. Offre insuffisante → **aperçu
  verrouillé** (questions réelles, réponses floutées), bénéfices, et bouton
  **« Passer au Pro/Premium »** (`request_plan_change`, owner/admin uniquement)
  + lien « Voir mon offre ».
- `src/components/assistant-fab.tsx` : **bouton flottant** monté dans `AppShell`,
  panneau mobile-first (pleine largeur et safe-area sous 640 px, cible 56 px,
  fermeture par Échap / clic extérieur / croix 44 px). Offre non éligible → le
  panneau affiche un cadenas et renvoie vers l'aperçu.
- `src/components/smart-alerts.tsx` :
  - `SmartAlertsCard` — **alertes intelligentes CALCULÉES** (aucun token
    consommé, disponibles pour toutes les offres) : biens sans photo, prospects
    sans suivi depuis 7 jours, rendez-vous à venir, échéance d'abonnement
    proche/dépassée, limites presque atteintes (biens 80 %, utilisateurs 80 %,
    photos, tokens IA 80 %/100 %). Chaque alerte a un libellé, un détail chiffré
    et un lien vers l'écran concerné. État « Rien à signaler » sinon.
  - `DailySummaryCard` — **« Résumé du jour »** sur la vue d'ensemble, généré
    **à la demande** (jamais au chargement, pour ne pas brûler le quota),
    avec heure de génération, bouton « Régénérer », et variante verrouillée
    « Débloquer avec l'offre Pro ».
- `pnpm run typecheck` OK · `pnpm run build` OK.

### ⚠️ À FAIRE PAR VOUS — poser la clé Groq (ne la donnez jamais dans le chat)
```bash
supabase secrets set GROQ_API_KEY=<votre_clé_groq> --project-ref xbuuhfwobrafcbgtdgjx
```
Vérification : `supabase secrets list --project-ref xbuuhfwobrafcbgtdgjx`
Tant que ce secret est absent, l'assistant répond
`assistant_not_configured` → « L'assistant n'est pas encore configuré côté
serveur ». Tout le reste de l'application fonctionne normalement.

### Non testable depuis le sandbox
Le sandbox ne joint pas `*.supabase.co` : la fonction déployée ne peut être
exercée que depuis un navigateur. Voir la liste de tests manuels en fin de document.
