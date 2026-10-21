# LOT A — Récapitulatif d'exécution (base de données)

Date : 2026-10-20 · Projet Supabase : `xbuuhfwobrafcbgtdgjx`
Migration : `db/migrations/2026-10-20_lot_a.sql`
Retour arrière : `db/rollback/2026-10-20_lot_a_rollback.sql`

---

## 1. Ce qui a été appliqué en base

Appliqué en 5 migrations atomiques (chacune annulable indépendamment) :

| Migration | Contenu |
|---|---|
| `lot_a_schema` | 15 colonnes ajoutées + valeurs des 3 plans + 4 tables + index + 2 réglages + 3 triggers `updated_at` |
| `lot_a_plan_functions_and_limits` | 6 fonctions de lecture + 3 fonctions trigger + 3 triggers de limites |
| `lot_a_invitations_payments_billing` | 9 fonctions (invitations, offre, paiement, impayés) |
| `lot_a_rls_grants_storage` | 14 politiques RLS + droits d'exécution + bucket privé + `storage_agency_id()` |
| `lot_a_enable_pg_cron` | `CREATE EXTENSION pg_cron` (1.6.4) |

### Colonnes ajoutées (aucune donnée existante modifiée)
- `plans` : `display_name`, `setup_fee`, `max_photos_per_property`,
  `monthly_agent_messages`, `monthly_follow_ups`, `modules`, `sort_order`
- `subscription_payments` : `declaration_id`, `provider`, `provider_reference`,
  `provider_status` (structure agrégateur, **non activée**)
- `user_profiles` : `must_change_password`
- `agencies` : `suspended_at`, `suspended_reason`, `auto_suspend_disabled_until`

### Nouvelles tables
`agency_invitations`, `payment_declarations`, `plan_change_requests`,
`platform_settings`

### Nouvelles fonctions (`public`)
`agency_current_plan`, `plan_limit_value`, `agency_has_module`,
`agency_seat_availability`, `agency_billing_state`, `agency_usage_snapshot`,
`enforce_property_limit`, `enforce_photo_limit`, `enforce_member_limit`,
`create_agency_invitation`, `redeem_agency_invitation`,
`revoke_agency_invitation`, `request_plan_change`, `admin_change_agency_plan`,
`admin_handle_plan_change`, `submit_payment_declaration`,
`review_payment_declaration`, `suspend_overdue_agencies`, `reactivate_agency`,
`storage_agency_id`

### Stockage
Bucket **privé** `payment-proofs` créé (`public = false`, 5 Mo max,
jpeg/png/webp/pdf). `agency-assets`, `property-images` et `bsfood` inchangés.

### Job planifié
`sofia-lot-a-suspend-overdue` · `job_id = 1` · `*/15 * * * *` ·
`SELECT public.suspend_overdue_agencies()`

Désactivation sans suppression :
```sql
UPDATE cron.job SET active = false WHERE jobname = 'sofia-lot-a-suspend-overdue';
```
Suppression :
```sql
SELECT cron.unschedule('sofia-lot-a-suspend-overdue');
```

---

## 2. Correspondance des offres appliquée

Mise à jour **par `id`**, aucun INSERT, aucun `plan_id` déplacé.

| id | slug `name` (conservé) | `display_name` | Prix/mois | Installation | Biens | Photos/bien | Utilisateurs | Messages agent | Relances |
|---|---|---|---|---|---|---|---|---|---|
| 4f457a46… | `starter` | **Essentiel** | 50 000 | 150 000 | 30 | 10 | 3 | 1 000 | 100 |
| 940bb1ac… | `pro` | **Pro** | 100 000 | 250 000 | 150 | 30 | 10 | 3 000 | 300 |
| b7a4ea74… | `enterprise` | **Premium** | 200 000 | 400 000 | illimité | illimité | illimité | 8 000 | 1 000 |

« Illimité » = `2 000 000 000` en base. Règle d'affichage à implémenter côté front :
toute limite `>= 1 000 000 000` s'affiche « Illimité ».

Colonnes existantes **non touchées** : `max_whatsapp_connections` (1/3/10),
`monthly_ai_tokens` (100 k/500 k/2,5 M), `monthly_conversations` (500/2 500/15 000),
`features`.

### Effet sur les agences existantes
Les deux agences réelles étaient sur `starter` → elles sont donc sur **Essentiel** :

| Agence | Plan | Biens | Sièges | Photos max sur un bien |
|---|---|---|---|---|
| SBC AI Agency Demo | Essentiel | 5 / 30 | 1 / 3 | 4 / 10 |
| Diango agengy | Essentiel | 1 / 30 | 1 / 3 | 1 / 10 |
| Agence Test Suspendue | aucun abonnement | 0 | 1 | 0 |

Aucune agence ne dépasse ses nouvelles limites : **rien n'est bloqué sur l'existant**.

---

## 3. Tests exécutés et résultats réels

Tous les tests ont été lancés dans une transaction **terminée par une exception**,
donc intégralement annulée. Contrôle après test : `properties = 6`,
`property_media = 21`, `agency_members = 3`, `agency_invitations = 0`,
`activity_log = 58` — valeurs identiques à l'avant-test.

Agence testée : `Diango agengy` (Essentiel, 1 bien, 1 membre, 1 photo).

| Test | Résultat obtenu |
|---|---|
| 11e photo sur un bien en Essentiel | **REFUSÉE** — « Limite de 10 photos par bien atteinte pour l offre Essentiel ( 10 / 10 ) » |
| Vidéo ajoutée au plafond de photos | **ACCEPTÉE** (les vidéos ne comptent pas dans la limite) |
| Sièges après 2 invitations en attente | `3/3`, disponible `0` — les invitations comptent bien |
| 4e utilisateur en Essentiel | **REFUSÉ** — « Limite de 3 utilisateurs » |
| Sièges après désactivation de l'agent | `2/3`, disponible `1` — la place est libérée |
| Nouvel agent après désactivation | Trigger **laisse passer** (échec ensuite sur la clé étrangère, attendu avec un `user_id` fictif) |
| 31e bien en Essentiel | **REFUSÉ** — « Limite de 30 biens » |
| `suspend_overdue_agencies()` | **0** — aucune agence suspendue (les 2 agences réelles n'ont pas de `ends_at`, garde-fou 1 respecté) |

Rapports bruts renvoyés par les blocs de test :
```
T1a[9 photos ajoutees, total=10] T1b[11e photo REFUSEE: Limite de 10 photos
par bien atteinte pour l offre Essentiel ( 10 / 10 )…] T1c[video au
plafond=ACCEPTEE] T2a[seats avant=1/3]
```
```
T2b:3/3 T2c:REFUSE_OK T3a:2/3 T3b:TRIGGER_OK_FK[insert or update on ]
T4a:30/30 T4b:REFUSE_OK
```

---

## 4. Comptes de test disponibles

Vérifié dans `saas_immobilier.user_profiles` et `platform_admins` :

| E-mail | Rôle | Agence | Usage |
|---|---|---|---|
| `nabilayediango910@gmail.com` | `platform_owner` (+ `user_profiles.role = 'admin'`) | aucune | **Espace admin plateforme** |
| `babergang009@gmail.com` | owner | SBC AI Agency Demo (active) | Espace agence, 5 biens, 4 photos/bien |
| `ibrahimdiango514@gmail.com` | owner | Diango agengy (active) | Espace agence, 1 bien — idéal pour tester les limites |
| `agence.desactivee.test@example.com` | owner | Agence Test Suspendue (**suspended**) | Vérifier le blocage d'une agence suspendue |

Les mots de passe ne sont pas stockés en clair et ne sont pas récupérables :
à saisir par toi.

### Point de sécurité à signaler
`public.is_platform_admin()` renvoie `true` si l'utilisateur est dans
`platform_admins` **OU** si `user_profiles.role = 'admin'`. Il existe donc deux
chemins vers les droits plateforme. Une seule ligne a actuellement
`role = 'admin'` (`nabilayediango910@gmail.com`), qui est déjà
`platform_owner`. La contrainte `user_profiles_role_check` limite `role` à
`('admin','agency')`. Je n'ai rien modifié ici : dis-moi si tu veux que je
restreigne `is_platform_admin()` au seul `platform_admins`.

---

## 5. Ce qui reste manuel / non fait

### Côté base
- **Instructions Orange Money et Wave** : la clé `payment_instructions` de
  `platform_settings` est volontairement vide
  (`{"orange_money":{"name":"","number":""},"wave":{"name":"","number":""}}`).
  À remplir depuis l'écran admin — rien n'est codé en dur.
- **Délai de grâce** : 5 jours, dans `platform_settings` → `billing` →
  `grace_days`. Modifiable sans migration.
- **Aucun abonnement n'a de `ends_at`** : tant que c'est le cas, le job ne
  suspendra jamais personne. La première échéance sera posée par la première
  validation de paiement (`review_payment_declaration` prolonge d'un mois).
- **`public.agency_is_active()`** (wrapper `public` pour n8n) : non créée,
  en attente de ton accord — voir `docs/n8n-controle-agence-suspendue.md`.

### Côté code (non commencé)
- **Mode sombre** : diagnostic posé, correctif non appliqué. Cause racine :
  `body { background: #f7f6f1 }` écrit hors `@layer base` gagne sur le thème
  `.dark` ; **224 couleurs distinctes en dur** (307 occurrences hex + 17 rgba)
  après la ligne 324 de `index.css`, avec **zéro** règle `.dark` dans cette
  zone ; et aucun code n'ajoute la classe `.dark`.
- **Pages à créer** : Mon offre, Équipe, Payer mon abonnement, espace admin
  complet, upload de logo, verrouillage des modules, compteur de photos,
  graphique de CA, bandeau d'échéance.
- **Edge Functions** : les 5 fonctions déployées ne sont toujours **pas** dans
  le dépôt. `create-agency-member` et `invite-agency-member` passent encore par
  `auth.admin.inviteUserByEmail`, qui exige un SMTP — donc inutilisables en
  l'état. À rapatrier puis réécrire.

---

## 6. Retour arrière

`db/rollback/2026-10-20_lot_a_rollback.sql` annule tout dans l'ordre inverse :
job pg_cron → triggers → politiques → fonctions → index → tables → colonnes →
valeurs d'origine des 3 plans (starter 0/3/50/1/100 000/500,
pro 75 000/10/250/3/500 000/2 500, enterprise 195 000/50/2 000/10/2 500 000/15 000)
→ extension pg_cron → bucket `payment-proofs`.

Les valeurs d'origine des plans sont écrites littéralement dans le fichier, pas
recalculées.
