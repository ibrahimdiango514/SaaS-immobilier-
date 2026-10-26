# Session 5 - mensualite, encaisse, factures et journal

**Date** : 2026-10-26
**Projet** : `xbuuhfwobrafcbgtdgjx`
**Branche** : `arena/258827d7-saas-immobilier`
**Commits** : `41e45ba` (base), `3da92ae` (front). `main` intact a `66ccc75`.

---

## 1. Etat avant / apres

| Indicateur | Avant | Apres |
|---|---|---|
| Mensualite | 300 000 | **300 000** (inchangee) |
| Encaisse | 250 000 | **150 000** |
| Factures en attente | concept inexistant | **100 000** (1 facture) |
| Paiements enregistres | 3 | 4 (3 valides + 1 ecriture contraire) |
| Evenements de journal | 0 | 9 |

Detail de l'encaisse apres correction :

| Ligne | Montant | Effet |
|---|---|---|
| SBC, 50 000, manuel | 50 000 | conserve |
| Immo Diango, 100 000, validation admin | 100 000 | conserve |
| SBC, 100 000, genere par changement d'offre | +100 000 | annule |
| SBC, ecriture contraire | -100 000 | annule la ligne precedente |
| **Net** | **150 000** | |

---

## 2. SELECT de controle

```
mensualite              300000.00
encaisse                150000.00
factures_en_attente     100000.00  (1 facture)
encaisse_brut           250000.00
ecritures_contraires    100000.00
mensualite_par_offre    {"pro": 100000, "enterprise": 200000}
```

Les trois chiffres de reference demandes sont exacts. Aucun ecart.

Prorata verifie sur trois cas :

| Cas | Resultat |
|---|---|
| 100 000, changement le 26 octobre (31 j) | 6 jours restants, 19 354.84 |
| 100 000, changement le 1er novembre (30 j) | 30 jours, 100 000 (mois entier) |
| 50 000, changement le 14 fevrier (28 j) | 15 jours, 26 785.71 |

---

## 3. Deux decisions techniques prises sans arbitrage

### 3.1 Ecriture compensatoire : ecriture contraire, pas de montant negatif

`subscription_payments` porte `CHECK (amount >= 0)`. Une ligne negative est donc
impossible. Deux options :

- retirer la contrainte : elle protege une table financiere, je ne l'ai pas fait ;
- ajouter `entry_kind` (`payment` | `reversal`) : l'ecriture contraire porte un
  montant positif et se soustrait dans les sommes.

Retenu : la seconde. L'original reste visible, rien n'est supprime, la
contrainte reste en place, et l'ecriture contraire est une ligne a part entiere,
traçable, reliee a l'original par `reversal_of`.

### 3.2 Mensualite historique : null, pas 0

`admin_assign_plan` reecrit `plan_id` sur place : l'offre d'un mois passe n'est
pas conservée. Reconstituer la mensualite des mois anterieurs produirait des
chiffres faux sur un tableau de bord financier reel. Les mois passes renvoient
`null`, et le graphique ne trace une barre que pour le mois en cours. La legende
l'indique explicitement. L'encaisse, lui, est reel sur les 12 mois.

---

## 4. Corrige

**Collision de reference.** L'ancienne forme `ADMIN-<AAAAMMJJ>-<agence>-<OFFRE>`
avait deja avale la montee d'offre d'Immo Diango le 26/10 a 21:43 : meme
reference que le rattrapage, l'idempotence a renvoye la ligne existante au lieu
de facturer. Nouvelle forme : `ADMIN-<AAAAMMJJHHMISS>-<agence8>-<OFFRE>`.

**Facturation automatique sur changement d'offre.** Supprimee. L'enveloppe
`admin_change_agency_plan_journaled` met a jour l'offre, calcule le prorata,
cree la facture en attente et journalise. Aucun encaissement.

**Activation.** `admin_activate_agency_journaled` journalise l'evenement et ne
cree aucun encaissement. `admin_activate_agency` n'est pas redirigee : ce serait
une recursion infinie.

---

## 5. Non modifie, comme demande

`admin_assign_plan`, `review_payment_declaration`, `admin_activate_agency`, et
les RLS existantes sont intacts. Les deux nouvelles tables ont leur propre RLS,
en lecture reservee a `is_platform_admin()`.

Aucune ligne supprimee. Aucune fonction supprimee. Rien fusionne dans `main`.

---

## 6. A tester dans le navigateur

1. **Valider une agence** : la mensualite monte immediatement, l'encaisse ne
   bouge pas, une ligne « Activation » apparait.
2. **Changer son offre** : la mensualite change, une facture en attente
   apparait au prorata, l'encaisse ne bouge pas.
3. **Valider le paiement de la facture** (bouton « Valider le paiement » dans
   la table des factures) : l'encaisse monte, la facture passe a « Payee », et
   l'ensemble se met a jour sans rechargement.

---

## 7. Limites signalees

- Le bouton « Passer en <offre> » propose la premiere offre differente de
  l'offre courante. Sur trois offres, ce n'est pas forcement la montee
  attendue : a remplacer par un selecteur d'offre si besoin.
- Les evenements anterieurs a cette session n'ont ni offre de depart ni
  variation : ils restent a « — ». Les inventer aurait ete pire.
- `admin_suspend_agency` et `admin_reactivate_agency` existent et journalisent,
  mais l'ecran de suspension des agences n'a pas ete rebranche dessus. La
  mensualite ne baisse donc pas encore automatiquement sur une suspension
  faite depuis cet ecran.
