# Diagnostic — revenus abonnements de l'espace admin

Date : 2026-10-26. Projet Supabase : `xbuuhfwobrafcbgtdgjx`, schéma `saas_immobilier`, RPC `public`.
**Toutes les requêtes de ce diagnostic étaient des SELECT.** Aucune donnée n'a été modifiée.

## 1. Ce que l'écran affiche

- « Revenus du mois » : 50 000 FCFA
- « Revenus sur 12 mois » : 50 000 FCFA — « 1 paiement(s) · 1 agence(s) »
- Graphique : un seul point, en octobre.

## 2. Ce qu'il y a réellement en base

### Paiements enregistrés (`subscription_payments`) — 1 ligne au total

| Agence | Montant | Payé le | Période couverte | Offre de l'abonnement | Prix de l'offre |
|---|---|---|---|---|---|
| SBC AI Agency Demo | 50 000 | 2026-10-21 | 2026-10-21 → 2026-11-20 | Pro | **100 000** |

Une seule ligne, donc : un seul mois non nul (2026-10), et tous les autres mois à 0.

### Abonnements actifs (`agency_subscriptions`) — 2 lignes

| Agence | Offre | Statut | Début | Fin | Paiements |
|---|---|---|---|---|---|
| SBC AI Agency Demo | Pro (100 000) | active | 2026-08-16 | 2026-11-20 | 1 (50 000) |
| Immo Diango | Pro (100 000) | active | 2026-10-21 | 2026-11-21 | **0** |

### Déclarations de paiement (`payment_declarations`) — 0 ligne

Aucune déclaration n'a jamais été soumise. Le seul paiement existant a donc été
saisi à la main (bouton « Enregistrer le paiement »), sans déclaration liée.

## 3. Conclusion : cause CONFIRMÉE

**Oui, deux agences actives ne sont pas correctement représentées dans les revenus.**

- **Immo Diango est active en Pro avec ZÉRO paiement enregistré.** Elle
  n'apparaît donc nulle part dans les revenus. C'est le cas le plus net.
- **SBC a payé 50 000 pour une offre à 100 000** : sous-paiement de 50 %.

Le mécanisme est exactement celui supposé :

1. `public.platform_subscription_revenue` ne somme que `subscription_payments`.
   Elle est donc juste *par rapport à son entrée* — c'est l'entrée qui est
   incomplète.
2. `public.admin_assign_plan` est le **seul** chemin d'écriture d'une offre
   (utilisé par `admin_activate_agency`, `admin_activate_pending_agency` et
   `admin_change_agency_plan`). Il crée ou prolonge `agency_subscriptions`,
   écrit une entrée `usage_events` et une `notifications`… **mais n'écrit
   jamais dans `subscription_payments`.**

Donc toute agence activée par l'administrateur (cas d'une agence en attente
validée après paiement déclaré, ou activée directement) devient un client
payant **sans trace financière**. Le revenu existe pour le client, pas pour le
tableau de bord.

3. `public.review_payment_declaration` est, lui, **correct** : il insère bien
   une ligne dans `subscription_payments` (montant, `paid_on`, période, lien
   `declaration_id`) et prolonge l'abonnement d'un mois. Le contrôle est
   toutefois purement manuel : il n'existe aujourd'hui aucune vérification que
   le montant déclaré correspond au prix de l'offre (d'où le 50 000 sur une
   offre à 100 000).
4. `admin_change_agency_plan` et `admin_handle_plan_change` passent par
   `admin_assign_plan` : **aucun mouvement financier** n'est généré par un
   changement d'offre.

### Défaut annexe relevé (interface)

`useRecordSubscriptionPayment` (`src/lib/data-hooks.ts`) écrit le paiement
**directement depuis le navigateur**, sans passer par une RPC, et n'invalide
pas la clé de cache `platform_subscription_revenue`. Après un enregistrement
manuel, le graphique et les KPI ne bougent donc pas avant rechargement — ce qui
contredit directement l'exigence « mise à jour sans recharger la page ».
Il impose aussi `ends_at = aujourd'hui + 30 j`, ce qui peut **raccourcir** un
abonnement déjà payé plus loin.

## 4. Rattrapage : ce qui serait créé

Mesuré par `db/scripts/2026-10-26_rattrapage_revenus_select.sql` (lecture seule).

| Interprétation | Lignes | Montant |
|---|---|---|
| Agence active sans **aucun** paiement (incontestable) | 1 | **100 000 FCFA** (Immo Diango, période 2026-10-01 → 2026-10-31) |
| Mois non couverts **en entier** (majorant) | 4 | **400 000 FCFA** |

Détail du majorant : Immo Diango (1 mois) + SBC (août, septembre, octobre), car
le paiement unique de SBC (21/10 → 20/11) ne couvre aucun mois entier.

**Chiffre à retenir : 100 000 FCFA certains, jusqu'à 400 000 FCFA selon la
règle de rattrapage choisie.** Le script ne crée rien sans accord explicite.

## 5. Proposition technique (en attente d'accord)

Fichier : `db/migrations/2026-10-26_session4_revenus_abonnements.sql` — **additif**.
Rollback : `db/rollback/2026-10-26_session4_revenus_abonnements_rollback.sql`.

1. **`subscription_payments.plan_id` et `.reference`** (colonnes nullables).
   Sans `plan_id`, les barres empilées par offre seraient fausses dès qu'une
   agence change d'offre : la répartition suivrait l'offre actuelle, pas celle
   payée. `reference` porte le n° de transaction Mobile Money.
2. **`public.admin_bill_subscription(...)`** : écrit un paiement ET prolonge
   l'abonnement, en une transaction, avec idempotence sur `reference`
   (protection contre le double clic et le rejeu réseau). Remplace l'insertion
   directe depuis le navigateur.
3. **`public.admin_activate_agency_billed(...)`** : enveloppe additive autour de
   `admin_activate_agency` (inchangée) qui active **et** encaisse atomiquement.
   Si l'encaissement échoue, l'activation est annulée.
4. **`public.platform_revenue_report(p_months)`** : nouvelle fonction, sans
   toucher à `platform_subscription_revenue` (conservée intacte). Elle renvoie :
   - `months[]` : 12 mois **toujours présents**, avec `collected` (encaissé, par
     date de paiement), `recognized` (revenu reconnu au prorata de la période
     couverte), `payments_count`, `agencies_count` et `by_plan` (montant par
     code d'offre, pour les barres empilées) ;
   - `ledger[]` : une ligne par opération (date, agence, offre, montant, devise,
     référence, méthode, période, source) — pour le tableau et le CSV ;
   - `totals` : totaux, **MRR attendu** du parc actif, et deux anomalies
     calculées côté base : `active_without_payment` et `underpaid`. L'écran ne
     peut donc plus afficher un revenu sans signaler l'incohérence.

Aucune fonction existante n'est modifiée, aucune RLS n'est touchée.

## 6. Étape 3 (graphique comptable) — plan, non implémenté

Dépend de la fonction `platform_revenue_report` ci-dessus : le front ne peut pas
lire ces données avant que la migration soit appliquée. D'où l'ordre proposé :
accord → migration → interface.

Travaux prévus une fois la migration appliquée :

- **`lib/admin-billing-api.ts`** : `useRevenueReport(months)` sur la nouvelle
  RPC ; `useRecordSubscriptionPayment` réécrit pour appeler
  `admin_bill_subscription` (plus d'écriture directe depuis le navigateur) et
  invalider la clé du rapport.
- **`pages/admin/overview.tsx`** : deux KPI nommés explicitement « Encaissé » et
  « Revenu reconnu » ; graphique 12 mois à barres empilées par offre (Essentiel,
  Pro, Premium) avec total par mois, 0 explicite, infobulle détaillée (montant,
  nombre de paiements, agences).
- **`pages/admin/revenue.tsx`** : tableau des opérations (date, agence, offre,
  montant, référence) + export CSV, montants en FCFA avec séparateurs de
  milliers (`Intl.NumberFormat('fr-FR')`).
- Invalidation systématique du rapport après validation d'une déclaration, et
  bandeau d'alerte si `active_without_payment` n'est pas vide.
