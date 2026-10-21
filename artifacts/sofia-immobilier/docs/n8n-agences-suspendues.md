# Workflow n8n — Ne jamais traiter les messages d'une agence suspendue

> Objectif : dès qu'une agence est suspendue côté Supabase (dashboard désactivé),
> l'agent n8n **n traite plus aucun de ses messages** jusqu'à la réactivation.
> Le statut est lu **à chaque exécution** (temps réel, aucun cache).

## 1. Placez ce nœud EN PREMIER (juste après le déclencheur de message)

**Nœud : Supabase** (opération `Execute Query` / SQL)

```sql
SELECT
  a.id,
  a.name,
  a.status,
  (a.status <> 'suspended') AS agent_autorise
FROM saas_immobilier.agencies a
WHERE a.id = $1
```

- `$1` = l'`agency_id` porté par le message entrant (paramètre du nœud, ex.
  `{{ $json.agency_id }}` ou la clé utilisée par votre déclencheur).
- Connexion : les identifiants Supabase de votre workflow (clé **service_role**
  recommandée — elle contourne RLS, ce qui est le rôle de ce workflow).
- **Important :** ne stockez pas ce résultat en mémoire entre exécutions
  (désactivez toute option de cache/mémorisation de nœud). Chaque message =
  une lecture fraîche.

### Alternative sans nœud SQL (requête HTTP)

Si votre workflow parle à l'API REST :

- **Méthode :** `POST`
- **URL :** `https://xbuuhfwobrafcbgtdgjx.supabase.co/rest/v1/rpc/agence_active`
- **En-têtes :**
  - `apikey: <VOTRE_CLE_SERVICE_ROLE>`
  - `Authorization: Bearer <VOTRE_CLE_SERVICE_ROLE>`
  - `Content-Type: application/json`
- **Corps :** `{ "p_agency_id": "{{ $json.agency_id }}" }`
- **Réponse :** `true` (agence active) ou `false` (agence suspendue).

> La fonction `saas_immobilier.agence_active(uuid)` est SECURITY DEFINER,
> lecture seule, temps réel, et **interdite aux appels anonymes**
> (réservée `service_role` + `authenticated`).

## 2. Nœud conditionnel IF juste après

**Nœud : IF** (ou Switch)

- **Condition :** `agent_autorise` **est égal à** `false`
  (si vous utilisez `agence_active` : `{{ $json }}` **est égal à** `false`)
- Si vous préférez la forme positive : `agent_autorise est égal à true` →
  branche **Vrai = poursuivre le traitement**, branche **Faux = stopper**.

## 3. Que faire du message selon la branche

| Branche | Action |
|---|---|
| **Agence active** → poursuivre | Enchaînez normalement vers votre agent IA / réponse. |
| **Agence suspendue** → stopper | **Ne pas répondre, ne pas appeler l'IA.** Journalisez l'ignoré puis terminez le workflow : |

Recommandé sur la branche « suspendue » :

1. **Set** (journalisation) :
   - `skipped_reason = "agence_suspendue"`
   - `agency_id`, `message_id`, `skipped_at = {{ $now }}`
2. Optionnel : écriture du même payload dans votre table/sheet de suivi
   (chaîne de messages JSON, ex. `{{ JSON.stringify($json) }}`).
3. **No Operation / End** : le flux s'arrête là.

> Au retour du statut `active` (réactivation par l'admin), le même IF renvoie
> « active » dès le message suivant : **aucune reconfiguration n8n n'est
> nécessaire**, aucun rejeu des messages suspendus n'a été effectué (ils ont
> été ignorés, pas mis en file).

## 4. Résumé du flux

```
[Déclencheur message entrant]
        │
        ▼
[Supabase] SELECT status, (status <> 'suspended') AS agent_autorise …
   (lecture fraîche à chaque exécution, pas de cache)
        │
        ▼
[IF] agent_autorise = false ?
   │                         │
   OUI (suspendue)           NON (active)
   ▼                         ▼
[Set journal] + End      [Agent IA / réponse normale]
```

## 5. Points de contrôle

- Suspendre une agence depuis l'espace admin → le **message suivant** est
  ignoré immédiatement (pas de délai de cache).
- Réactiver l'agence → le traitement reprend au message suivant.
- L'admin de la plateforme n'est jamais concerné (ce garde-fou ne vise que
  le statut `agencies.status = 'suspended'`).
