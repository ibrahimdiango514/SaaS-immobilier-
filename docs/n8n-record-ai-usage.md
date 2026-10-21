# n8n — Enregistrer la consommation IA d'une agence

> BLOC 7 · Fonction SQL `public.record_ai_usage(...)` · projet Supabase `xbuuhfwobrafcbgtdgjx`
>
> Cette fonction incrémente les compteurs du mois en cours dans
> `saas_immobilier.agency_usage` (et, si vous fournissez un `event_key`, écrit une
> ligne dans `saas_immobilier.usage_events`). Elle est **réservée au rôle
> `service_role`** : elle ne peut **jamais** être appelée depuis le navigateur.

---

## 1. Signature

```sql
public.record_ai_usage(
  agency_id      uuid,              -- obligatoire
  tokens_in      bigint  DEFAULT 0, -- tokens IA en entrée
  tokens_out     bigint  DEFAULT 0, -- tokens IA en sortie
  messages       bigint  DEFAULT 0, -- messages WhatsApp/agent comptabilisés
  conversations  bigint  DEFAULT 0, -- nouvelles conversations
  event_key      text    DEFAULT NULL,  -- idempotence (voir §4)
  user_id        uuid    DEFAULT NULL,  -- membre à l'origine, si connu
  metadata       jsonb   DEFAULT '{}'   -- contexte libre (workflow, modèle, nœud…)
) RETURNS jsonb
```

## 2. Contrôles appliqués (rien à faire côté n8n)

| Contrôle | Comportement |
|---|---|
| Rôle | Refusée si le rôle du JWT n'est pas `service_role` (`42501`). |
| Agence | Refusée si `agency_id` est inconnu (`P0002`). |
| **Agence suspendue** | Refusée avec l'erreur `agency_suspended` (`42501`) — **même contrôle que pour les photos**. Une agence suspendue ne consomme plus. |
| Incréments négatifs | Refusés (`22023`). |
| Période | Toujours le mois UTC en cours (`date_trunc('month', now())`). La ligne `agency_usage` est créée si elle n'existe pas. |

## 3. Appel depuis n8n

### Option A — nœud **Supabase** (recommandé)

Le nœud Supabase de n8n n'expose pas les RPC dans toutes les versions. Le plus
fiable est le nœud **HTTP Request** vers PostgREST :

```
POST https://xbuuhfwobrafcbgtdgjx.supabase.co/rest/v1/rpc/record_ai_usage
```

En-têtes :

```
apikey:        <SUPABASE_SERVICE_ROLE_KEY>
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
Content-Type:  application/json
```

Corps :

```json
{
  "agency_id": "00000000-0000-0000-0000-000000000000",
  "tokens_in": 1250,
  "tokens_out": 640,
  "messages": 1,
  "conversations": 0,
  "event_key": "n8n:whatsapp:{{ $json.messageId }}",
  "metadata": { "workflow": "sofia-whatsapp-ia", "model": "llama-3.3-70b-versatile" }
}
```

> **La clé `service_role` ne doit vivre que dans les identifiants n8n**
> (Credentials → Header Auth), jamais dans un nœud Code, jamais dans le dépôt,
> jamais dans le navigateur.

### Option B — nœud **Postgres**

Si votre n8n a un accès direct à la base :

```sql
SELECT public.record_ai_usage(
  $1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::text
);
```

⚠️ Le contrôle de rôle teste `auth.role()`, c'est-à-dire le **claim `role` du
JWT** défini par PostgREST. En connexion Postgres directe, ce claim est absent :
positionnez-le avant l'appel.

```sql
SELECT set_config('request.jwt.claims',
                  json_build_object('role', 'service_role')::text, true);
SELECT public.record_ai_usage('…', 1250, 640, 1, 0, NULL);
```

## 4. Idempotence (important pour les webhooks rejoués)

`usage_events` n'a **aucune contrainte unique** sur `(agency_id, event_key)`.
La fonction fait donc elle-même la déduplication : si un `event_key` existe déjà
pour cette agence, **rien n'est incrémenté** et la réponse contient
`"deduplicated": true`.

Utilisez un `event_key` déterministe, par exemple :

- message WhatsApp : `wa:<id_du_message>`
- requête d'assistant : `assistant:<agency_id>:<id_du_message_utilisateur>`
- tâche planifiée : `cron:<workflow>:<AAAA-MM-JJ>`

## 5. Réponse

```json
{
  "deduplicated": false,
  "agency_id": "…",
  "period_start": "2026-10-01",
  "ai_tokens_input": 12500,
  "ai_tokens_output": 6400,
  "ai_tokens_total": 18900,
  "ai_requests_count": 42,
  "messages_count": 130,
  "conversations_count": 9,
  "monthly_ai_tokens_limit": 100000,
  "monthly_messages_limit": 1000,
  "quota_exceeded": false
}
```

`quota_exceeded` passe à `true` dès que `ai_tokens_total` dépasse le quota de
l'offre : branchez dessus une notification (e-mail, WhatsApp, alerte interne)
ou un arrêt du workflow IA de cette agence.

## 6. Où lire les compteurs

| Écran | Fonction SQL |
|---|---|
| Espace plateforme → **Consommation IA** (`/admin/consommation`) | `public.platform_agency_usage()` |
| Espace agence → **Mon offre** (« Utilisation IA ce mois ») | `public.agency_ai_usage(agency_id)` |

Les deux renvoient les ratios et le niveau d'alerte (`ok` / `warning` à 80 % /
`reached` à 100 % / `unlimited`), ainsi que l'état du canal WhatsApp de l'agence
(fournisseur, numéro, statut, dernière activité, badge « non officiel » pour
Evolution API).

## 7. Dépannage

| Erreur | Cause | Correction |
|---|---|---|
| `record_ai_usage est reservee au role service_role.` | Appel avec la clé `anon`/`publishable`, ou connexion Postgres sans claim de rôle. | Utiliser la clé **service_role** (options A ou B ci-dessus). |
| `agency_suspended` | L'agence est suspendue (abonnement échu après le délai de grâce). | Réactiver l'agence ou valider sa déclaration de paiement, puis rejouer. |
| `agence introuvable.` | `agency_id` invalide. | Vérifier l'UUID ; il doit exister dans `saas_immobilier.agencies`. |
| `les increments ne peuvent pas etre negatifs.` | Valeur négative transmise. | Corriger le mapping du nœud précédent. |
| Réponse avec `"deduplicated": true` | `event_key` déjà enregistré. | Comportement attendu : aucun double comptage. |

---

### Note de sécurité

`public.record_ai_usage` est `SECURITY DEFINER` et ne fait **qu'incrémenter** les
compteurs de l'agence indiquée. Elle ne lit ni n'écrit aucune autre donnée
métier, et ne renvoie aucun contenu de message. Le contrôle
`current_user = 'service_role'` utilisé par l'ancienne `record_usage_event` ne
fonctionne pas dans une fonction `SECURITY DEFINER` (le `current_user` y devient
le propriétaire, `postgres`) : c'est pourquoi celle-ci teste `auth.role()`.
