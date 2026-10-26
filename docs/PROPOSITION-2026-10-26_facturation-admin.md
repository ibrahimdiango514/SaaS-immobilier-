# Proposition - facturation des actions admin (session 4b)

**Statut : PROPOSITION. Rien n'est applique.** Aucune ecriture en base, aucun
paiement cree, aucun fichier applicatif modifie.
**Date** : 2026-10-26
**Branche** : `arena/258827d7-saas-immobilier`, commit de depart `cddc257`
**Code propose** : `db/migrations/2026-10-26_session4b_admin_billed_PROPOSITION_NON_APPLIQUEE.sql`

---

## 1. Graphe d'appels reel (verifie en base, pas deduit du code)

Toutes les ecritures d'offre passent par une seule fonction :
`public.admin_assign_plan`. Les quatre fonctions citees sont des chemins
d'acces a cette derniere, avec deux niveaux d'indirection :

```
admin_activate_pending_agency  ->  admin_activate_agency  ->  admin_assign_plan
admin_activate_agency                                     ->  admin_assign_plan
admin_handle_plan_change       ->  admin_change_agency_plan -> admin_assign_plan
admin_change_agency_plan                                  ->  admin_assign_plan
```

Consequences concretes, verifiees dans `pg_get_functiondef` :

| Fonction | Corps actuel | Controle admin propre |
|---|---|---|
| `admin_activate_agency(uuid, uuid)` | `RETURN public.admin_assign_plan(...)` | oui |
| `admin_activate_pending_agency(uuid)` | `RETURN public.admin_activate_agency(p_agency_id, NULL)` | oui |
| `admin_change_agency_plan(uuid, uuid)` | `PERFORM public.admin_assign_plan(...)` puis `RETURN true` | **non**, repose sur `admin_assign_plan` |
| `admin_handle_plan_change(uuid, text, text)` | `PERFORM public.admin_change_agency_plan(...)` | oui |

`admin_change_agency_plan` est la seule sans controle d'acces propre : elle
retourne `true` a quiconque peut atteindre `admin_assign_plan`. Ce n'est pas
exploitable aujourd'hui (`admin_assign_plan` refuse en 42501), mais la nouvelle
enveloppe ajoute son propre controle en tete, ce qui ne peut que renforcer.

---

## 2. Les deux enveloppes proposees

### 2.1 `admin_change_agency_plan_billed(p_agency_id, p_plan_id, p_amount_mode, p_paid_on, p_reference, p_note)`

Sequence, en une seule transaction :

1. controle `is_platform_admin()` ;
2. lecture de l'offre **courante** et de son prix, avant toute ecriture ;
3. sortie immediate si l'offre demandee est identique (rien n'est ecrit) ;
4. `admin_assign_plan(...)` - fonction existante, non modifiee ;
5. calcul du montant selon `p_amount_mode` (`'difference'` par defaut, ou
   `'full'`) ;
6. sortie sans ecriture si le montant du est nul (descente d'offre en mode
   difference) ;
7. `admin_bill_subscription(...)` avec `method = 'admin_validation'`, le
   `plan_id`, la reference generee et une note marquee demonstration.

`p_amount_mode` est un parametre **pour que la decision A ne demande pas de
reecrire le corps de la fonction** : seul le `DEFAULT` change.

### 2.2 `admin_activate_agency_and_bill(p_agency_id, p_plan_id, p_paid_on, p_reference, p_note)`

1. controle `is_platform_admin()` ;
2. `admin_activate_agency(...)` - resout l'offre et active, non modifiee ;
3. lecture du prix de l'offre **dans le catalogue, cote base** ;
4. `admin_bill_subscription(...)` au prix de l'offre activee.

Le montant n'est pas un parametre : le front ne doit jamais calculer un prix.

**Pourquoi un nom different de `admin_activate_agency_billed` deja en place ?**
Celle deja creee prend un montant impose (7 arguments) et reste utile pour les
rattrapages, ou le montant vient d'une decision humaine. Une surcharge du meme
nom, avec un 3e argument tantot `numeric` tantot `date`, serait ambigue a
l'appel. Le code propose laisse donc la fonction existante intacte.

### 2.3 Ce que `admin_bill_subscription` fournit deja

| Exigence | Colonne / mecanisme | Statut |
|---|---|---|
| `plan_id` | colonne `plan_id` | deja en place |
| reference generee | colonne `reference`, idempotence sur `(agency_id, reference)` | deja en place |
| date | `p_paid_on` -> `paid_at` et `period_start`, `period_end` = +1 mois -1 jour | deja en place |
| source `admin_validation` | `method = 'admin_validation'` | **aucune migration necessaire** |
| identifiable demo | prefixe `ADMIN-DEMO-` + note « Demonstration : ... » | propose ici |

La table `subscription_payments` n'a pas de colonne `source`. `method` est la
colonne prevue, et elle n'a **aucune contrainte CHECK** : verifie en base, les
seules contraintes sont la cle primaire, trois cles etrangeres, et
`CHECK (amount >= 0)`. Ecrire `'admin_validation'` ne demande donc aucun
changement de schema.

---

## 3. Appelants a rediriger

### 3.1 Cote base

| # | Fonction | Modification proposee | Risque |
|---|---|---|---|
| 1 | `admin_activate_pending_agency` | une ligne : `admin_activate_agency` -> `admin_activate_agency_and_bill` | aucun, pas de recursion |
| 2 | `admin_change_agency_plan` | `PERFORM admin_assign_plan` -> `PERFORM admin_change_agency_plan_billed` | aucun, pas de recursion |
| 3 | `admin_handle_plan_change` | **rien a changer** : herite via `admin_change_agency_plan` | aucun |
| 4 | `admin_activate_agency` | **ne pas rediriger** | recursion infinie : l'enveloppe l'appelle |
| 5 | `admin_assign_plan` | inchangee, conformement a la consigne | - |

Le point 4 est le piege de ce chantier : l'enveloppe d'activation appelle
`admin_activate_agency`. Rediriger celle-ci vers l'enveloppe produirait une
boucle. `admin_activate_agency` reste donc une primitive interne, que le front
n'appelle plus directement.

Grace au point 2, `admin_handle_plan_change` n'a besoin d'aucune modification :
c'est le chemin le plus court vers le comportement demande.

### 3.2 Cote front (5 points d'appel)

| Fichier:ligne | Appel actuel | Action apres accord |
|---|---|---|
| `src/lib/data-hooks.ts:1788` | `rpc('admin_activate_agency')` | **rediriger** vers `admin_activate_agency_and_bill` |
| `src/lib/pending-api.ts:148` | `rpc('admin_activate_pending_agency')` | inchange, la redirection base suffit |
| `src/lib/admin-billing-api.ts:291` | `rpc('admin_change_agency_plan')` | inchange, la redirection base suffit |
| `src/pages/admin/agencies.tsx:83` | `rpc('admin_change_agency_plan')` | inchange, la redirection base suffit |
| `src/lib/admin-billing-api.ts:274` | `rpc('admin_handle_plan_change')` | inchange, herite via la base |

Une seule ligne de front a changer pour l'activation. Les changements d'offre
deviennent factures sans toucher au front.

---

## 4. Decisions en attente

### A. Montant enregistre lors d'un changement d'offre

Ta proposition : la difference. Trois consequences a valider :

- **Descente d'offre** (Pro -> Essentiel) : difference negative, ramenee a 0.
  Aucun paiement, mais un credit implicite non trace. Acceptable ?
- **Montants negatifs** : exclus par contrainte `amount >= 0`. Un remboursement
  ne peut donc pas s'ecrire dans cette table.
- **Periode couverte** : `admin_bill_subscription` ecrit `period_end` =
  `paid_on` + 1 mois. Une montee d'offre en milieu de mois paie donc une
  difference pour un **mois entier supplementaire**, sans prorata. C'est une
  approximation comptable assumee, pas un calcul exact. A valider, ou a
  remplacer par un prorata au jour.

### B. Retroactif

Le modele d'ecriture est pret (section 5 du fichier SQL). Il n'est pas execute.
Deux points ont change depuis le diagnostic et doivent etre tranches sur des
chiffres a jour :

- **Immo Diango** : le 2026-10-26 a 21:20:02 UTC, soit apres l'application de
  la migration et sans aucune action de ma part, une action admin l'a fait
  passer de **Pro (100 000) a Essentiel (50 000)**. Elle est donc aujourd'hui
  en Essentiel 50 000, active, avec zero paiement. L'ecriture manquante n'est
  donc plus 100 000 : c'est 50 000 si l'on constate l'offre actuelle. A toi de
  dire si le rattrapage doit refleter l'offre du jour ou l'historique.
- **SBC** : Pro 100 000, 50 000 payes pour Essentiel puis montee en Pro
  offerte. En mode difference : 50 000. En mode full : 100 000, qui
  double-compterait les 50 000 deja encaisses.

---

## 5. Prochaines etapes, dans l'ordre

1. ta reponse sur A et B ;
2. ton accord sur les redirections 3.1 (1 et 2) et sur la ligne de front 3.2 ;
3. application du fichier SQL en une transaction, puis SELECT de controle
   avant/apres ;
4. rattrapage B, agence par agence, avec reference explicite ;
5. front : invalidation de `platform_revenue_report` et
   `platform_subscription_revenue`, puis affichage 100 % issu du rapport.

Rien de tout cela n'est lance sans accord ecrit.
