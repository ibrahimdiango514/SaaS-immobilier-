# Journal d'application - session 4b (facturation des actions admin)

**Date** : 2026-10-26, a partir de 21:20 UTC
**Projet** : `xbuuhfwobrafcbgtdgjx`
**Branche** : `arena/258827d7-saas-immobilier`, depart `18ce6fb`
**Decisions appliquees** : A (difference), B (baisse journalisee, encaisse
inchange), C (Immo Diango 100 000), D (mois entier, sans prorata).

---

## 1. Etat AVANT ecriture

| Indicateur | Valeur |
|---|---|
| Encaisse total | 50 000 FCFA |
| Revenu du mois (somme des offres actives) | 150 000 FCFA |
| Paiements enregistres | 1 |
| Immo Diango | Essentiel (50 000), active, **0 paiement** |
| SBC AI Agency Demo | Pro (100 000), active, 50 000 payes |
| `admin_change_agency_plan_billed` | absent |
| `admin_activate_agency_and_bill` | absent |
| Migration session4 (colonnes, `admin_bill_subscription`) | appliquee la veille, 21:15 UTC |

---

## 2. Etape 1 - objet appliques (transaction unique)

| Objet | Nature |
|---|---|
| `public.admin_change_agency_plan_billed` | nouvelle. Lit l'offre courante, delegue a `admin_assign_plan`, facture la difference, reference `ADMIN-DEMO-<AAAAMMJJ>-<agence8>-<OFFRE>` |
| `public.admin_activate_agency_and_bill` | nouvelle. Delegue a `admin_activate_agency`, lit le prix au catalogue, facture le prix plein |
| `public.admin_activate_pending_agency` | redirigee vers `admin_activate_agency_and_bill` |
| `public.admin_change_agency_plan` | redirigee vers `admin_change_agency_plan_billed` |
| `public.platform_revenue_report` | remplacee : `encaisse` et `revenu_mois` separes, journal des operations typé |
| `REVOKE ... FROM anon` | sur les 5 fonctions d'ecriture et de rapport |

`admin_activate_agency` **n'est pas redirigee** : l'enveloppe l'appelle, une
redirection creerait une recursion infinie. Elle reste la primitive interne.
`admin_assign_plan` et `review_payment_declaration` sont inchangees
(empreinte md5 `fdebfdd8c93ce245c7095604a39d68db` avant et apres).

Le retour de `admin_activate_agency_and_bill` est aplati
(`v_activation || jsonb_build_object(...)`) pour conserver `plan_name`,
`ends_at` et `subscription_id` au premier niveau : le front `pending-api`
lit ces cles telles quelles et n'a pas eu a changer.

---

## 3. Etape 2 - rattrapage Immo Diango

Ecriture unique via `admin_bill_subscription` :

| Champ | Valeur |
|---|---|
| Montant | 100 000 FCFA |
| Offre | Pro (`940bb1ac-6116-42f8-a3d1-2c7d9178692f`) |
| Date de paiement | 2026-10-21 (date de validation de l'agence, offre Pro en vigueur) |
| Periode | 2026-10-21 -> 2026-11-20 |
| Methode | `admin_validation` |
| Reference | `ADMIN-DEMO-20261026-6e5b9943-PRO` |
| Note | « Demonstration : rattrapage activation Pro du 2026-10-21, accord explicite du 2026-10-26 » |
| Identifiant cree | `7199c845-c27f-41a5-842f-fef54221359a` |

La date du 2026-10-21 est choisie volontairement : `admin_bill_subscription`
prolonge l'abonnement a `paid_on + 1 mois`. Cette date donne 2026-11-20, donc
inferieure a la fin existante (2026-11-21) : **aucune modification de
l'abonnement**. Verifie apres coup : `ends_at` toujours 2026-11-21.

SBC : **aucune ecriture**. Ses 50 000 FCFA sont deja la. Le complement de
50 000 naitra a la prochaine montee d'offre, via l'enveloppe.

---

## 4. SELECT de controle apres ecriture

| Indicateur | Avant | Apres |
|---|---|---|
| Encaisse total | 50 000 | **150 000** |
| Revenu du mois | 150 000 | **150 000** (inchange : Immo reste en Essentiel) |
| Paiements | 1 | **2** |
| Immo Diango - paiements | 0 | **1** |
| Immo Diango - `ends_at` | 2026-11-21 | **2026-11-21** (inchange) |
| Immo Diango - offre | Essentiel | Essentiel (inchangee) |
| Ligne SBC - empreinte 16 colonnes | `9fb9fcf747a9de1cd688bc13313de1f4` | **identique** |

Aucune ligne existante modifiee : seule une ligne a ete ajoutee.

Serie d'octobre 2026 : encaisse 150 000, repartition `{"pro": 150000}`.

---

## 5. Journal des operations restitue par la base

| Date | Agence | Type | Offre | Encaisse | Impact revenu |
|---|---|---|---|---|---|
| 2026-10-26 21:20 | Immo Diango | Baisse d offre | Essentiel | 0 | -50 000 |
| 2026-10-21 12:40 | SBC | Changement anterieur non trace | Pro | 0 | non trace |
| 2026-10-21 12:38 | Immo Diango | Activation | Pro | 0 | +100 000 |
| 2026-10-21 | SBC | Encaissement admin | Pro | 50 000 | 0 |
| 2026-10-21 | Immo Diango | Encaissement admin | Pro | 100 000 | 0 |

Le journal est reconstruit depuis `usage_events` (changements d'offre, y
compris les baisses, qui n'ecrivent aucun paiement) et `subscription_payments`
(encaissements). Deux limites assumees :

- **« Changement anterieur non trace »** : le premier evenement connu d'une
  agence dont l'abonnement existait deja avant l'evenement. L'offre precedente
  n'est pas enregistree, donc l'ecart ne peut pas etre calcule. SBC est dans ce
  cas (Essentiel vers Pro le 2026-10-21). Ne pas afficher de chiffre plutot que
  d'en inventer un.
- Les mois passes n'ont pas de `revenu_mois` : la somme des offres actives est
  une mesure instantanee, non reconstituable sans historique complet d'offre.
  Le champ vaut `null` pour ces mois, et le graphique ne trace pas de point.

---

## 6. Tests effectues

| Test | Resultat |
|---|---|
| `set_config` admin simule, appel `platform_revenue_report(12)` | 12 mois, 0 explicite, journal de 5 operations |
| Appel `admin_change_agency_plan_billed` avec l'offre deja en place | `{"reason":"offre inchangee","payment":null}` |
| Paiements apres ce test | toujours 2, encaisse 150 000 : aucune ecriture |

---

## 7. Reste a tester dans le navigateur

1. Passer une agence d'Essentiel a Pro : le revenu du mois monte de 50 000,
   l'encaisse gagne 50 000, la repartition par offre et le journal bougent
   **sans rechargement**.
2. La repasser en Essentiel : le revenu du mois redescend de 50 000,
   l'encaisse ne bouge pas, une ligne « Baisse d offre » apparait.
3. Valider une declaration de paiement : l'encaisse monte seul, le revenu du
   mois reste identique.
4. Basculer la periode 6 / 12 mois : les deux series suivent.
