# Étape 0 - Etat réel du tableau de bord (lecture seule)

**Date** : 2026-10-26
**Projet** : `xbuuhfwobrafcbgtdgjx`
**Branche** : `arena/258827d7-saas-immobilier` @ `0b8573d`
**Aucune écriture effectuée.** Toutes les requêtes de ce document sont des SELECT.

---

## 1. Agences actives

| Agence | Offre | Mensualité | Début abonnement | Fin abonnement | Paiements | Encaissé brut |
|---|---|---|---|---|---|---|
| Immo Diango | Pro | 100 000 | 2026-10-21 | 2026-11-21 | 1 | 100 000 |
| SBC AI Agency Demo | Premium | 200 000 | 2026-08-16 | 2026-11-25 | 2 | 150 000 |
| **Total** | | **300 000** | | | **3** | **250 000** |

Aucune agence suspendue, aucune agence en attente : 2 agences, 2 actives.

---

## 2. Totaux

| Indicateur | Valeur en base | Ce que le KPI affiche aujourd'hui |
|---|---|---|
| Mensualité (revenu récurrent) | **300 000 FCFA** | 300 000 |
| Encaissé brut (`subscription_payments`) | **250 000 FCFA** | 250 000 |
| Encaissé **avec preuve** (définition retenue) | **0 FCFA** | *non distingué* |
| Factures en attente | **concept inexistant** | — |

**Point central : aucun des 3 paiements n'a de preuve.** Il n'existe aucune
déclaration de paiement dans la base (`payment_declarations` = 0 ligne), donc
`declaration_id` est NULL sur les 3 lignes. Au sens de la définition que tu
viens de poser — « encaissé = paiements validés **avec preuve** » — l'encaissé
réel est **0 FCFA**, pas 250 000.

---

## 3. Liste des paiements existants et leur origine

| # | Agence | Montant | Date | Source | Référence | Preuve | Note | Créé le |
|---|---|---|---|---|---|---|---|---|
| 1 | SBC | 50 000 | 2026-10-21 | `manual` | — | **aucune** | « Paiement reçu — formule starter » | 2026-10-21 00:40 |
| 2 | Immo Diango | 100 000 | 2026-10-21 | `admin_validation` | `ADMIN-DEMO-20261026-6e5b9943-PRO` | **aucune** | « Demonstration : rattrapage activation Pro du 2026-10-21 » | 2026-10-26 21:35 |
| 3 | SBC | 100 000 | 2026-10-26 | `admin_validation` | `ADMIN-DEMO-20261026-10d464cf-ENTERPRISE` | **aucune** | « Demonstration : changement d offre par administrateur » | 2026-10-26 21:42 |

Toutes enregistrées par `b7e561f9-8872-4a27-addb-8dc0492e9b20`.

---

## 4. Journal des changements d'offre (5 opérations)

| Date | Agence | Offre d'arrivée | Prix | Motif |
|---|---|---|---|---|
| 2026-10-21 12:38 | Immo Diango | Pro | 100 000 | changement direct par administrateur |
| 2026-10-21 12:40 | SBC | Pro | 100 000 | changement direct par administrateur |
| 2026-10-26 21:20 | Immo Diango | Essentiel | 50 000 | changement direct par administrateur |
| 2026-10-26 21:42 | SBC | Premium | 200 000 | Demonstration : changement d offre |
| 2026-10-26 21:43 | Immo Diango | Pro | 100 000 | Demonstration : changement d offre |

L'offre de **départ** n'est enregistrée nulle part. Elle est déduite par
`lag()` sur l'événement précédent, ce qui laisse deux trous :

- le premier événement de chaque agence n'a pas de prédécesseur : SBC
  (2026-10-21 12:40) et Immo Diango (2026-10-21 12:38) apparaissent sans offre
  de départ connue, alors que SBC était en Essentiel depuis le 2026-08-16 ;
- aucun événement n'existe pour les suspensions ou réactivations, qui ne sont
  pas journalisées du tout.

**La table `revenue_operations` ne peut pas servir de journal** : elle concerne
les ventes de biens (`property_id`, `commission`, `operation_type`), pas les
abonnements. Un journal dédié est nécessaire.

---

## 5. Objets présents en base

| Objet | Etat |
|---|---|
| `admin_change_agency_plan_billed` | présente, `anon` retiré |
| `admin_activate_agency_and_bill` | présente, `anon` retiré |
| `admin_activate_agency_billed` | présente, `anon` retiré |
| `admin_bill_subscription` | présente, `anon` retiré |
| `admin_assign_plan`, `review_payment_declaration` | présentes, intactes |
| `platform_revenue_report` | présente : renvoie `encaisse`, `revenu_mois`, journal reconstitué |
| Table de factures | **absente** |
| Journal dédié des changements d'offre | **absent** |
| Fonction de prorata | **absente** |

---

## 6. Anomalie active à trancher

**La facturation automatique sur changement d'offre contredit la règle que tu
viens de poser.** Aujourd'hui `admin_change_agency_plan_billed` écrit un
paiement dans `subscription_payments` à chaque montée d'offre. C'est ce qui a
produit la ligne 3 (100 000 FCFA sur SBC à 21:42).

Ta règle dit l'inverse : un changement d'offre crée une **facture en attente**,
et l'encaissé ne bouge qu'à la validation d'un paiement avec preuve.

Deuxième effet, non résolu : à 21:43, la montée Essentiel → Pro d'Immo Diango
n'a créé **aucun** paiement, parce que sa référence
`ADMIN-DEMO-20261026-6e5b9943-PRO` était identique à celle de la ligne 2. Le
contrôle d'idempotence a renvoyé la ligne existante. La collision de référence
que tu demandes de corriger s'est donc déjà produite en conditions réelles.

---

## 7. Étape 1 - écritures de test proposées à correction

Aucune suppression. Pour chaque ligne retenue, on ajoute une écriture de
correction de montant négatif qui annule son effet sur l'encaissé, l'original
restant visible dans le journal.

### Ligne 2 - Immo Diango, 100 000, rattrapage

| | |
|---|---|
| Nature | Écriture de démonstration que j'ai créée le 2026-10-26 à ta demande (décision C) |
| Preuve | aucune |
| Verdict proposé | **à corriger** : ce n'est pas de l'argent reçu |
| Impact si retenue | encaissé **− 100 000** |

### Ligne 3 - SBC, 100 000, changement d'offre Pro → Premium

| | |
|---|---|
| Nature | Générée automatiquement par l'enveloppe, pas un encaissement |
| Preuve | aucune |
| Verdict proposé | **à corriger** : contredit la règle « pas d'encaissé sur changement d'offre » |
| Impact si retenue | encaissé **− 100 000** |

### Ligne 1 - SBC, 50 000, paiement manuel du 2026-10-21

| | |
|---|---|
| Nature | Saisie par l'ancien encart « Paiement reçu » (insert direct navigateur), avant l'existence des déclarations |
| Preuve | aucune |
| Note d'origine | « Paiement reçu — formule starter », cohérente avec l'offre Essentiel de l'époque |
| Verdict proposé | **à toi de trancher** : elle peut correspondre à un vrai paiement client dont la preuve n'a jamais été archivée. La corriger efface un encaissement peut-être réel ; la garder laisse un encaissé sans preuve. |
| Impact si retenue | encaissé **− 50 000** |

### Récapitulatif des impacts

| Scénario | Encaissé après correction |
|---|---|
| Les 3 lignes corrigées | **0** |
| Lignes 2 et 3 corrigées, ligne 1 conservée | **50 000** |
| Aucune correction | 250 000 (dont 0 avec preuve) |

Ma recommandation : corriger les lignes 2 et 3 sans hésiter, et pour la ligne 1
demander à l'agence SBC son justificatif. Tant qu'il n'arrive pas, la marquer
« sans preuve » plutôt que la corriger — on ne corrige pas un encaissement
possiblement réel sur une intuition.

---

## 8. Ce que l'étape 2 devra construire

1. Table de factures (`subscription_invoices`) : agence, offre visée, montant,
   période, statut (en attente / payée / annulée), référence.
2. Fonction de prorata en SQL : jours restants / jours du mois, jamais dans le
   front.
3. Enveloppe de changement d'offre : met à jour l'offre, calcule la mensualité,
   crée la facture en attente, journalise — sans écrire de paiement.
4. Journal dédié : type, offre de départ, offre d'arrivée, variation de
   mensualité, montant facturé, statut.
5. `platform_revenue_report` : `mensualite_total`, `mensualite_par_offre`,
   `encaisse` (avec preuve uniquement), `factures_en_attente`, `operations`.
6. Références horodatées : `ADMIN-<AAAAMMJJHHMISS>-<agence8>-<OFFRE>`.

Rien de tout cela n'est appliqué. J'attends ta décision ligne par ligne pour
l'étape 1, puis ton accord pour l'étape 2.
