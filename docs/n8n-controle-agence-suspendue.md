# Brancher le contrôle « agence suspendue » dans n8n

## Pourquoi ce guide existe

La suspension d'une agence pour impayé écrit `saas_immobilier.agencies.status = 'suspended'`.
Ce statut bloque **le dashboard** automatiquement, parce que toutes les politiques RLS
métier passent par `public.is_agency_member()` et `public.has_agency_role()`, qui
contiennent toutes deux la condition `AND a.status <> 'suspended'`.

**Mais RLS ne suffit pas pour n8n.** Si le workflow n8n se connecte avec la clé
`service_role` (ou en Postgres direct avec l'utilisateur `postgres`), les politiques
RLS sont contournées : l'agent continuerait de lire et d'écrire pour une agence
suspendue. Il faut donc un **point de contrôle explicite** en tête de workflow.

Vérifié le 2026-10-20 : aucun rôle PostgreSQL `n8n` n'existe sur le projet
(`pg_roles` ne renvoie que `anon`, `authenticated`, `postgres`, `service_role`,
`supabase_admin`), et aucune connexion n8n n'était visible dans `pg_stat_activity`.
Le workflow n'est pas encore créé — ce guide prépare son branchement.

---

## Le mécanisme : `agence_active(agency_id)`

Fonction **déjà existante** (elle n'a pas été créée par le LOT A) :

```sql
saas_immobilier.agence_active(p_agency_id uuid) RETURNS boolean
-- STABLE, SECURITY DEFINER
-- renvoie true si une agence avec cet id existe ET status <> 'suspended'
```

Elle renvoie `true` / `false`. C'est exactement le test d'arrêt dont n8n a besoin.

> Note : `agence_active()` n'a **pas** la clause `OR is_platform_admin()` que
> portent `is_agency_member()` et `has_agency_role()`. Pour un contrôle n8n
> c'est le comportement voulu : une agence suspendue est suspendue pour tout
> le monde, y compris pour un administrateur plateforme.

---

## Branchement pas à pas dans n8n

### Étape 1 — Rendre la fonction appelable par l'API REST

PostgREST n'expose que le schéma `public` par défaut. `agence_active` est dans
`saas_immobilier`. Deux options :

**Option A (recommandée) — exposer le schéma**
Dans le dashboard Supabase → *API* → *Exposed schemas*, ajouter `saas_immobilier`.
L'appel devient :

```
POST https://xbuuhfwobrafcbgtdgjx.supabase.co/rest/v1/rpc/agence_active
Headers:
  apikey: <SERVICE_ROLE_KEY>          # ou ANON_KEY + Authorization: Bearer <JWT>
  Authorization: Bearer <SERVICE_ROLE_KEY>
  Content-Type: application/json
Body:
  { "p_agency_id": "<uuid de l'agence>" }
```

Réponse : `true` ou `false` (booléen JSON brut).

**Option B — wrapper dans `public`** (si vous ne voulez pas exposer le schéma)

```sql
CREATE OR REPLACE FUNCTION public.agency_is_active(p_agency_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog','public'
AS $$ SELECT saas_immobilier.agence_active(p_agency_id) $$;
```

Puis appeler `/rest/v1/rpc/agency_is_active`.

> Cette fonction n'a **pas** été créée : elle attend votre feu vert, conformément
> à la règle « additif uniquement, sur accord ».

### Étape 2 — Nœud HTTP Request

1. Ajouter un nœud **HTTP Request** en **tout premier nœud** du workflow.
2. Method : `POST`.
3. URL : celle de l'étape 1.
4. Authentication : *Predefined Credential Type* → Supabase, ou *Header Auth*
   avec `apikey` et `Authorization`.
5. Body : JSON, `{ "p_agency_id": "={{ $json.agency_id }}" }`.
6. Cocher *Always Output Data* pour que le nœud produise toujours une sortie.

### Étape 3 — Nœud IF (arrêt du flux)

1. Ajouter un nœud **IF** après le HTTP Request.
2. Condition : `{{ $json }}` **equals** `true` (type *Boolean*).
3. Sortie **true** → le reste du workflow (agent IA, envois WhatsApp…).
4. Sortie **false** → un nœud **No Operation** nommé
   `Agence suspendue - arret`, ou mieux un nœud *Stop And Error* avec le message
   `Agence suspendue : traitement interrompu`.

Ne jamais laisser la branche *false* vide : un nœud explicite rend l'arrêt visible
dans l'historique d'exécution n8n.

### Étape 4 — Répéter le contrôle avant chaque écriture sensible

Le contrôle en tête de workflow protège l'exécution entière. Si un workflow est
long ou déclenché par un webhook récurrent, remettre un couple
`HTTP Request → IF` juste avant les nœuds qui écrivent
(`save_message`, `create_or_update_contact`, `update_sales_pipeline`,
`ai_notify_agency`…), pour couvrir une suspension survenue en cours d'exécution.

---

## Comportement attendu, cas par cas

| Situation | `agence_active()` | Effet sur n8n |
|---|---|---|
| Agence `active`, abonnement à jour | `true` | flux normal |
| Agence `suspended` (impayé) | `false` | arrêt sur la branche *false* |
| Agence `suspended` manuellement par l'admin | `false` | arrêt |
| Agence réactivée (`reactivate_agency`) | `true` | reprise immédiate |
| `agency_id` inconnu | `false` | arrêt (comportement sûr par défaut) |

---

## Délais à connaître

- Le job pg_cron `sofia-lot-a-suspend-overdue` tourne **toutes les 15 minutes**
  (`*/15 * * * *`). Une agence peut donc rester `active` jusqu'à 15 minutes après
  la fin de son délai de grâce.
- Délai de grâce : **5 jours** par défaut, configurable dans
  `saas_immobilier.platform_settings` → clé `billing` → `grace_days`.
- Le blocage côté dashboard est en revanche **immédiat** dès que le statut est
  écrit, puisqu'il est évalué à chaque requête par RLS.
- Une agence sans `ends_at`, ou dont l'essai est encore valide
  (`trial_ends_at > now()`), n'est **jamais** suspendue automatiquement.
- Une agence dont `auto_suspend_disabled_until` est dans le futur n'est pas
  suspendue : c'est le garde-fou qui protège une réactivation manuelle.

---

## Contrôler le job

```sql
-- état du job
SELECT jobid, jobname, schedule, active, nodename, database
  FROM cron.job WHERE jobname = 'sofia-lot-a-suspend-overdue';

-- dernières exécutions
SELECT jobid, status, return_message, start_time, end_time
  FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='sofia-lot-a-suspend-overdue')
 ORDER BY start_time DESC LIMIT 20;

-- mettre en pause SANS supprimer
UPDATE cron.job SET active = false WHERE jobname = 'sofia-lot-a-suspend-overdue';

-- réactiver
UPDATE cron.job SET active = true  WHERE jobname = 'sofia-lot-a-suspend-overdue';

-- supprimer définitivement
SELECT cron.unschedule('sofia-lot-a-suspend-overdue');
```
