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
