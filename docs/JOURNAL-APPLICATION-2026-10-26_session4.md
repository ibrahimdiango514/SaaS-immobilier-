# Journal d'application - migration session 4 (revenus abonnements)

**Date d'application** : 2026-10-26, 21:15 UTC (ordre de grandeur : quelques
minutes apres la sauvegarde de 21:15:38 UTC)
**Projet** : `xbuuhfwobrafcbgtdgjx` (schema `saas_immobilier`, RPC dans `public`)
**Branche** : `arena/258827d7-saas-immobilier`
**Commit de depart** : `039fbe41618166c4fc85b63e89396365d1d311a7`
**Fichier applique** : `db/migrations/2026-10-26_session4_revenus_abonnements.sql`
**Mode** : SQL direct, une seule transaction `BEGIN; ... COMMIT;`
**Resultat** : succes, aucune erreur, transaction validee
**Sauvegarde prealable** : `db/rollback/2026-10-26_session4_etat_avant.sql`

Ce fichier est un journal factuel. Il ne contient aucune donnee metier nouvelle
et ne consigne aucune ecriture dans les tables de production : aucun paiement
n'a ete cree, aucune ligne existante n'a ete modifiee.


## 1. Etat AVANT (mesure juste avant application)

| Objet | Etat |
|---|---|
| Colonnes de `subscription_payments` | 16 (positions 1 a 16) |
| `subscription_payments_plan_id_idx` | absent |
| `public.platform_revenue_report(integer)` | absent |
| `public.admin_bill_subscription(7 args)` | absent |
| `public.admin_activate_agency_billed(7 args)` | absent |
| `public.platform_subscription_revenue(integer)` | present, md5 `36645bbc22f6426307de02c5745e42b8` |
| `public.admin_assign_plan(uuid, uuid, text, text)` | present, md5 `fdebfdd8c93ce245c7095604a39d68db` |
| `public.review_payment_declaration(uuid, text, text)` | present, md5 `61082028404ef9a8596238e45be999fb` |
| `subscription_payments` lignes | 1 |
| Somme `amount` | 50 000 XOF |
| Empreinte 16 colonnes de la ligne SBC | `9fb9fcf747a9de1cd688bc13313de1f4` |
| `payment_declarations` lignes | 0 |
| `agency_subscriptions` lignes | 2 (dont 2 `active`) |


## 2. Etat APRES (mesure juste apres COMMIT)

| Objet | Etat | Attendu |
|---|---|---|
| Colonnes de `subscription_payments` | 18 | 18 |
| Position 17 | `plan_id` uuid, null autorise | conforme |
| Position 18 | `reference` text, null autorise | conforme |
| `subscription_payments_plan_id_idx` | present (btree sur `plan_id`) | conforme |
| `public.platform_revenue_report(integer)` | present, md5 `5edaa6ebeaf7f0ef5553002fb9255f83` | conforme |
| `public.admin_bill_subscription(uuid, uuid, numeric, date, text, text, text)` | present, md5 `1bbaf850f2eba97a14606d07833cdba4` | conforme |
| `public.admin_activate_agency_billed(uuid, uuid, numeric, date, text, text, text)` | present, md5 `31944efe31b0ebbf3c5d0734abff68e4` | conforme |
| `public.platform_subscription_revenue(integer)` | md5 `36645bbc22f6426307de02c5745e42b8` | **inchangee** |
| `public.admin_assign_plan(uuid, uuid, text, text)` | md5 `fdebfdd8c93ce245c7095604a39d68db` | **inchangee** |
| `public.review_payment_declaration(uuid, text, text)` | md5 `61082028404ef9a8596238e45be999fb` | **inchangee** |
| `subscription_payments` lignes | 1 | inchange |
| Somme `amount` | 50 000 XOF | inchangee |
| Empreinte 16 colonnes de la ligne SBC | `9fb9fcf747a9de1cd688bc13313de1f4` | **identique** |
| Lignes avec `plan_id` renseigne | 0 | inchange (aucun remplissage) |
| Lignes avec `reference` renseignee | 0 | inchange (aucun remplissage) |

Les trois fonctions preexistantes sont byte pour byte identiques : meme
empreinte md5 avant et apres l'application.


## 3. Test a blanc de `platform_revenue_report`

Appel en lecture, en simulant un administrateur plateforme authentifie
(`set_config('request.jwt.claims', ...)`, utilisateur `b7e561f9-...`, le seul
compte `platform_admins` actif). Aucun effet de bord : la fonction est `STABLE`
et ne contient aucune ecriture.

Structure renvoyee, conforme : `months` (12 entrees), `ledger`, `totals`,
`by_plan`. Aucune erreur.

Serie des 12 derniers mois (2025-11 a 2026-10), zeros explicites :

| Mois | Encaisse | Reconnu | Paiements | Agences | Par offre |
|---|---|---|---|---|---|
| 2025-11 | 0 | 0.00 | 0 | 0 | `{}` |
| 2025-12 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-01 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-02 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-03 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-04 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-05 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-06 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-07 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-08 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-09 | 0 | 0.00 | 0 | 0 | `{}` |
| 2026-10 | 50 000 | 17 741.94 | 1 | 1 | `{"pro": 50000}` |

Lecture : octobre encaisse 50 000 (tresorerie, date de paiement) mais ne
reconnait que 17 741.94 en revenu. C'est le prorata attendu du paiement du
21/10 au 20/11 : 11 jours sur 31 en octobre. La difference est correcte, pas un
bug.

Totaux renvoyes :

- `collected_period` : 50 000
- `collected_all` : 50 000
- `payments_period` : 1
- `agencies_period` : 1
- `active_agencies` : 2
- `mrr_expected` : 200 000 (2 agences actives x 100 000)
- `active_without_payment` : 1 entree, **Immo Diango** (Pro, 100 000, du
  2026-10-21 au 2026-11-21)
- `underpaid` : 2 entrees, Immo Diango (0 paye) et SBC (50 000 payes)

Journal (`ledger`) : 1 entree, SBC AI Agency Demo, 50 000 XOF, paye le
2026-10-21, offre Pro, `reference` a null, source `manuel`.


## 4. Constats a arbitrer (rien n'a ete modifie)

### 4.1 SBC : ce n'est pas un sous-paiement, c'est une montee en offre offerte

La note du paiement existant est explicite :

> « Paiement recu - formule starter »

et le journal `usage_events` montre, 12 heures plus tard :

> 2026-10-21 12:40:42, `admin_plan_assigned`, plan_id `940bb1ac-...` (Pro),
> note « changement direct par administrateur »

Donc SBC a paye 50 000 FCFA, le prix exact de l'offre **Essentiel**, puis a ete
passee en **Pro** (100 000 FCFA) par un administrateur, sans encaissement
correspondant. Il ne s'agit ni d'une remise, ni d'un paiement partiel, ni d'une
erreur de saisie : c'est la meme cause racine qu'Immo Diango, a savoir une
activation ou un changement d'offre qui ne produit aucune ecriture financiere.

Consequence technique : le detecteur `underpaid` de `platform_revenue_report`
compare le total paye au prix de l'offre **actuelle**. Il signale donc SBC comme
sous-payant alors que son paiement etait correct pour l'offre de l'epoque. Ce
detecteur doit etre affine (comparer au prix de l'offre figee sur le paiement,
via `plan_id`, ou au prorata de la duree de chaque offre). A traiter dans un
correctif ulterieur : aucune modification n'a ete faite ici.

### 4.2 Droit `anon` sur les trois nouvelles fonctions

Les trois fonctions creees portent :

```
postgres=X ; anon=X ; authenticated=X ; service_role=X
```

Le `anon=X` provient des privileges par defaut du projet appliques a la
creation. Le `REVOKE ALL ... FROM PUBLIC` de la migration a bien retire le
droit de `PUBLIC`, mais pas ce droit nominatif accorde a `anon`.

Impact reel : faible mais non nul. Les deux fonctions d'ecriture verifient
`is_platform_admin()` avant toute action et echouent en `42501` pour un appelant
anonyme ; `platform_revenue_report` fait de meme. Aucune donnee n'est exposable.
Reste une incoherence par rapport aux autres fonctions du projet, qui n'ont pas
ce droit.

Correctif propose, **non applique** (il faudrait l'accord) :

```sql
REVOKE ALL ON FUNCTION public.admin_bill_subscription(uuid, uuid, numeric, date, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_activate_agency_billed(uuid, uuid, numeric, date, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.platform_revenue_report(integer) FROM anon;
```


## 5. Ce qui n'a PAS ete fait (conforme aux consignes)

- Aucun paiement cree, pour aucune agence, y compris Immo Diango.
- Aucune ligne de `subscription_payments` modifiee : `plan_id` et `reference`
  restent a null sur la ligne SBC, qui n'a pas ete rattachee a l'offre payee.
- Aucun changement de RLS, de GRANT existant, de `admin_assign_plan`, de
  `review_payment_declaration` ni de `platform_subscription_revenue`.
- Aucun appel a `admin_bill_subscription` pour ecrire une donnee reelle.
- Aucun changement front.
- Rien de fusionne dans `main`.


## 6. Retour arriere

Voir `db/rollback/2026-10-26_session4_revenus_abonnements_rollback.sql` :
suppression des trois fonctions, de l'index et des deux colonnes. La suppression
des colonnes y est laissee commentee, car destructive pour un eventuel contenu.
