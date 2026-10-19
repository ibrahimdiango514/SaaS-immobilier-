# Configuration Vite et Supabase — Sofia Immobilier

Ce document décrit la configuration réelle utilisée par `artifacts/sofia-immobilier/`,
en particulier la lecture des variables d’environnement et le parcours d’inscription.

## 1. Variables d’environnement Vite

Le client Supabase (`src/lib/supabase.ts`) lit deux variables **publiques**, injectées
par Vite via `import.meta.env` :

| Variable | Rôle |
| --- | --- |
| `VITE_SOFIA_PUBLIC_SUPABASE_URL` | URL du projet Supabase |
| `VITE_SOFIA_PUBLIC_SUPABASE_KEY` | **Clé publique (publishable/anon)** du projet |

Règles à respecter :

- Ces variables doivent être définies dans `.env.local` (jamais commité) au développement,
  et dans l’environnement de build/deploy (Netlify) en production.
- `.env.example` sert uniquement de modèle de nommage. Ne jamais y mettre de secret.
- **Ne jamais** mettre une clé `service_role` (ou toute autre clé privée) dans une
  variable préfixée `VITE_` : Vite inclut ces valeurs dans le bundle navigateur.
- Si les deux variables sont absentes, l’application reste utilisable en lecture seule
  partielle mais affiche une erreur de configuration explicite (`configurationError`)
  au lieu d’inventer des données.

## 2. Contrat de `vite.config.ts`

`vite.config.ts` exige deux variables **Node** (non préfixées `VITE_`, lues au démarrage
du serveur/de build) :

| Variable | Rôle |
| --- | --- |
| `PORT` | Port du serveur de dev/preview (`strictPort`, hôtes `0.0.0.0`) |
| `BASE_PATH` | Chemin de base public (`base`) servi par l’application |

Le build échoue explicitement si l’une des deux manque (`PORT`/`BASE_PATH` requis).
Exemple de build local :

```sh
PORT=4173 BASE_PATH=/ pnpm run build
```

Autres points du contrat Vite :

- Alias `@` → `src/`, `@assets` → `attached_assets/`.
- Sortie de build : `artifacts/sofia-immobilier/dist/public`.
- Plugins : `@vitejs/plugin-react`, `@tailwindcss/vite`, overlay d’erreurs runtime
  (et les plugins Replit uniquement en dev quand `REPL_ID` est défini).

## 3. Client Supabase et schéma métier

- Le client est créé par `getSupabaseClient()` avec
  `persistSession: true`, `autoRefreshToken: true`, `detectSessionInUrl: true`.
- Les requêtes métier ciblent le schéma `saas_immobilier` via `.schema('saas_immobilier')`
  (les tables ne sont pas exposées dans le schéma `public`).
- Les types de `src/lib/database.types.ts` couvrent ce schéma ; la génération de types
  par défaut de Supabase ne couvre que `public`, ne pas s’y fier.

## 4. Parcours d’inscription (Auth)

Le parcours d’inscription (`/inscription`) repose sur `src/lib/auth-flow.js` et
`src/lib/auth-diagnostics.js` :

1. `supabase.auth.signUp()` peut renvoyer deux issues :
   - **session renvoyée** (confirmation e-mail désactivée) → `resolveSignupOutcome`
     renvoie `session-active` ;
   - **utilisateur sans session** (confirmation e-mail requise) →
     `email-confirmation-required`, aucune redirection n’a lieu tant qu’aucune
     session n’existe.
2. Lorsqu’une session est renvoyée, elle est **restaurée puis vérifiée**
   (`verifySessionReady()` → `auth.getSession()` → `verifySessionBeforeRedirect`)
   **avant toute redirection** vers l’espace agence. Si la vérification échoue,
   la redirection est bloquée et l’erreur est présentée comme une erreur de
   **récupération de session** (`session-recovery-error`), jamais comme une erreur
   d’inscription.
3. Les diagnostics (`diagnoseAuthError(error, phase)`) distinguent explicitement :
   - `signup-error` (phase `signup`) : compte déjà inscrit, mot de passe trop faible,
     e-mail invalide, inscriptions désactivées… ;
   - `session-recovery-error` (phase `session-restore`) : session absente, jeton de
     rafraîchissement refusé, session expirée… ;
   - `authentication-error` (phases `signin`/`signout`) : identifiants incorrects…
   Chaque diagnostic expose `code`, `category`, `phase`, `userMessage` et
   `technicalDetail` (message technique d’origine, affiché nulle part en clair dans
   l’UI mais conservé pour le débogage).
4. L’adhésion à une agence (`agency_members`) est **distincte** de la création du
   compte : un compte nouvellement inscrit sans adhésion voit l’accès aux données
   d’agence refusé explicitement par les politiques RLS existantes.

## 5. Vérifications locales

```sh
# Tests unitaires du parcours Auth et des modules métier
node --test artifacts/sofia-immobilier/src/lib/*.test.mjs

# Vérification de types
pnpm --filter @workspace/sofia-immobilier typecheck

# Build de production (PORT et BASE_PATH obligatoires)
cd artifacts/sofia-immobilier && PORT=4173 BASE_PATH=/ pnpm run build
```

Aucun de ces tests n’appelle Supabase : ils couvrent la logique pure
(décision de parcours, diagnostics). L’inscription réelle sur le projet Supabase
de production n’a pas été testée par cette suite et reste à valider manuellement.
