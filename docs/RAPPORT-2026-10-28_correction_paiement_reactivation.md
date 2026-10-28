# Correctif — parcours de paiement manuel bloqué et réactivation d'agence impossible

Date : 2026-10-28 · Projet Supabase : `xbuuhfwobrafcbgtdgjx` · Schéma métier : `saas_immobilier`
Branche : `arena/69b6afc4-saas-immobilier` · Commit de départ : `6e83913`

---

## 1. Ce qui était cassé, et pourquoi (mesuré sur la base réelle)

### Bug A — Le parcours de paiement s'arrête à l'écran d'instructions

**Cause exacte** : la plateforme n'a **aucun numéro Mobile Money publié**.

```
saas_immobilier.platform_settings.payment_instructions =
{ "wave": {"name":"", "number":""}, "orange_money": {"name":"", "number":""} }
```

* Aucune clé `moov_money`, deux numéros vides, `updated_at = 2026-10-20` (valeur de départ, jamais modifiée).
* `saas_immobilier.payment_config()` normalise cette valeur → `any_configured = false`,
  `methods.orange_money.configured = false`, idem pour Wave/Moov.
* L'écran `/abonnement/paiement/:requestId` calcule `usable = méthodes réellement configurées`.
  Avec `usable.length === 0`, il affiche « Moyen de paiement en cours de configuration »
  et **ne rend pas** le bouton « J'ai effectué le paiement » : le parcours s'arrête là, sans
  aucun moyen d'en sortir.
* Côté serveur, `public.agency_submit_payment_proof` refuse de son côté
  (« moyen de paiement en cours de configuration ») : la garde est correcte, elle n'était simplement
  jamais expliquée ni signalée à l'administrateur.
* Vérifié en direct : `admin_save_payment_methods` fonctionne (test transactionnel avec un numéro
  fictif → `any_configured = true`, `orange_money.configured = true`, `moov_money.configured = false`).
  Ce n'est donc **pas** un bug d'enregistrement : c'est une **configuration manquante**, et rien
  dans l'application ne la rendait visible côté administration.

**Ce qui empêchait de s'en sortir** :

| Problème | Conséquence |
|---|---|
| Aucun bandeau admin « aucun moyen configuré » | L'administrateur ne sait pas que toutes les agences sont bloquées |
| Aucune trace en base à la création d'une demande impossible à payer | Aucun signal persistant, aucune relance possible |
| Message agence sans marche à suivre | L'agence tourne en rond, recrée des demandes |
| Référence de demande non explicite dans le formulaire | L'agence ne sait pas quoi mettre dans le libellé du transfert |

**Corrigé, sans inventer aucune coordonnée** :

* Bandeau critique sur `/admin/paiements` et dans `Réglages → Moyens de paiement` dès que
  `payment_config().any_configured = false` (état réel, pas un texte statique).
* À la création d'une demande alors qu'aucun moyen n'est publié : alerte admin **persistante**
  (`admin_alerts`, clé unique par agence/jour, priorité `critical`, lien direct vers la demande).
* Écran agence : la référence est conservée et affichée, l'agence est invitée à prévenir
  l'administrateur ; le blocage est expliqué, jamais contourné.
* `/abonnement` prévient **avant** de créer une demande qu'aucun numéro n'est publié.

> **Bloqueur produit restant (non contournable par du code)** : le parcours ne peut pas aboutir
> tant qu'un vrai numéro Orange Money ou Moov Money n'est pas saisi par l'administrateur dans
> `Réglages → Moyens de paiement`. Aucune valeur n'a été inventée ni écrite en production.

### Bug B — « Suspendre » fonctionne, « Réactiver » ne rétablit jamais l'accès

**Cause exacte** — l'écran `/admin/agences` utilisait `useAdminUpdateAgency` :

* « Suspendre » faisait un **UPDATE direct de `agencies.status` depuis le navigateur**
  (`data-hooks.ts`) : aucun `suspended_at`, aucun motif, aucune entrée d'audit, aucun événement.
* « Réactiver » appelait `public.admin_activate_agency_journaled`
  → `public.admin_assign_plan`, qui ne remet `agencies.status = 'active'` **que depuis `pending`** :

```sql
IF v_agency.status = 'pending' AND v_status <> 'cancelled' THEN
  UPDATE saas_immobilier.agencies SET status='active', ... ;
END IF;
```

Une agence `suspended` **restait donc suspendue**, alors que l'appel réussissait.
`public.admin_reactivate_agency` existait mais n'était appelée nulle part — et elle offrait un mois
gratuit (`ends_at = CURRENT_DATE + interval '1 month'`), donc un abonnement payant offert.

**Preuve en base (avant correctif)** : agence `SBC AI Agency Demo`
`10d464cf-ad26-43de-a5eb-aa9ed70a4e55` → `status = 'suspended'`, `suspended_at = NULL`,
abonnement `active` jusqu'au 2026-11-27, **5 événements `reactivation` créés entre 12:22:27 et
12:24:37** par des clics successifs — l'interface annonçait un succès à chaque fois, l'agence
restait bloquée et ses utilisateurs ne pouvaient plus se connecter (`mon_etat_compte()` →
`agency_status = 'suspended'`, garde `App.tsx`).

**Corrigé** :

| Intention | Fonction serveur | Effet |
|---|---|---|
| Suspendre | `public.admin_suspend_agency` | `status='suspended'`, `suspended_at`, motif, audit, événement, notification agence. **N'annule plus l'abonnement.** Idempotente. Fonctionne même sans abonnement. |
| Réactiver | `public.admin_reactivate_agency` | `status='active'`, efface `suspended_at`/`suspended_reason`. **Ne touche jamais `agency_subscriptions`** : aucun mois offert, aucun statut d'abonnement modifié. Idempotente. Renvoie l'état réel (`agency_plan_state`). |
| Activer (agence `pending`) | `public.admin_activate_agency_journaled` | inchange, et lève en plus une éventuelle suspension (`admin_assign_plan`) |

* Le client envoie désormais le **statut courant** (`currentStatus`) : sans lui, une réactivation
  d'agence suspendue était jouée comme une activation d'offre.
* Le succès n'est affiché qu'après **relecture du statut en base** ; en cas d'écart, l'interface
  affiche une erreur explicite au lieu d'un faux succès.
* Boutons désactivés pendant l'appel ; double clic = `already_suspended` / `already_active`, un seul
  événement, une seule notification.
* `public.reactivate_agency` (ancienne primitive) délègue à la version corrigée : un seul chemin.

**Distinction des notions de statut** (aucun champ supprimé) :

| Notion | Champ | Effet de la réactivation |
|---|---|---|
| Suspension administrative | `agencies.status='suspended'` + `suspended_at` / `suspended_reason` | **Levée** |
| Abonnement expiré / impayé | `agency_subscriptions.status`, `ends_at`, grâce `billing.grace_days` | **Inchangé** : l'offre reste limitée selon les règles existantes (`agency_plan_state`) |
| Suspension automatique pour impayé | `agencies.auto_suspend_disabled_until` | Non modifié par la réactivation manuelle |
| Compte utilisateur désactivé | `agency_members.status`, `user_profiles` | **Non touché** : réactiver l'agence ne réactive pas un compte utilisateur |
| Agence en attente de validation | `agencies.status='pending'` | Refusé : « activez son offre, ne la réactivez pas » |

### Correctifs complémentaires (nécessaires au parcours)

* **Référence unique** générée côté serveur : `public.payment_reference()` →
  `SOF-PAY-<AAAAMMJJ>-<6 caractères>` (alphabet de 32 signes sans `0/O/1/I`), unicité garantie par
  l'index `payment_declarations_reference_uniq` + boucle de recollision. Jamais générée par le
  navigateur, jamais régénérée au rechargement (portée par la ligne en base).
* **Anti-double clic** : verrou d'avis PostgreSQL par agence dans `agency_create_payment_request`
  (`pg_advisory_xact_lock`) ; la seconde requête réutilise la demande existante (`reused = true`).
* **Double soumission de preuve** : le serveur refuse (statut déjà `pending`) ; le client relit la
  demande et reconnaît le succès précédent si la référence de transaction est identique
  (`already_submitted`), sans créer de doublon ni afficher une erreur incompréhensible.
* **Formulaire de déclaration** : référence Sofia préfixée et en lecture seule
  (`input-proof-sofia-reference`), explication explicite qu'elle **n'est pas** une référence
  Mobile Money reconnue par Orange/Moov, référence de transaction SMS distincte, montant attendu en
  lecture seule, date bornée, payeur, pièce jointe (type/taille), case de certification.
* **Copie de référence** : repli `execCommand` si `navigator.clipboard` est indisponible, et message
  d'échec au lieu d'un faux « Copiée ».
* **Lien profond des alertes** : `saas_immobilier.raise_admin_alert` transforme
  `/admin/paiements` en `/admin/paiements?demande=<uuid>` ; l'écran admin ouvre directement le
  dossier (paramètre retiré de l'URL ensuite).

---

## 2. Fichiers modifiés

Base de données (appliquée en 14 migrations `fix_*`, SQL de référence dans le dépôt) :

* `db/migrations/2026-10-28_correction_paiement_et_reactivation.sql`
* `db/rollback/2026-10-28_correction_paiement_et_reactivation_rollback.sql`

Frontend (`artifacts/sofia-immobilier/src`) :

* `lib/data-hooks.ts` — `useAdminUpdateAgency` : suspendre/réactiver/activer via leurs fonctions
  serveur, `currentStatus`, relecture du statut, invalidation de `sofia/account-state` et
  `plan/etat` ; `AGENCY_COLUMNS` expose `suspended_at`, `suspended_reason`,
  `auto_suspend_disabled_until`, `pending_note`.
* `lib/database.types.ts` — `AgencyRow` complété (mêmes champs, optionnels).
* `lib/billing-api.ts` — réconciliation de double soumission (`readSubmittedState`).
* `pages/admin/agencies.tsx` — actions serveur, confirmation après succès réel, motif/date de
  suspension affichés, libellés honnêtes (`Réactiver` vs `Valider l'offre`).
* `pages/admin/billing.tsx` — bandeau « aucun moyen configuré », ouverture directe
  `?demande=<uuid>`.
* `pages/admin/settings.tsx` — bandeau « aucun moyen publié » + rappel des moyens utilisables.
* `pages/subscription.tsx` — avertissement avant création de demande si aucun numéro publié.
* `pages/subscription-payment.tsx` — message actionnable quand rien n'est configuré, copie robuste,
  référence Sofia en lecture seule, distinction référence Sofia / référence Mobile Money,
  numéro de dossier à la confirmation, `copyText`.

Aucune table, colonne, politique RLS ni donnée supprimée.

---

## 3. Sécurité

* RLS inchangée et toujours active. Aucune politique assouplie.
* Toutes les écritures passent par des RPC `SECURITY DEFINER` avec
  `IF NOT public.is_platform_admin() THEN RAISE … 42501` pour l'administration et
  `is_agency_member` + `has_agency_role` pour l'agence.
* Aucune clé `service_role` ni secret dans le frontend ; justificatifs dans le bucket privé
  `payment-proofs` (URL signées 15 min).
* `public.payment_reference()` : `REVOKE` depuis `PUBLIC`, `anon`, `authenticated` (helper interne).
* Référence de transaction : unique (index partiel `payment_declarations_txn_ref_uniq`), validée et
  normalisée côté serveur ; un montant différent du montant attendu est refusé côté base.

---

## 4. Tests réellement exécutés (SQL live, transactions annulées)

Toutes les fixtures (agences `TEST …`, numéros fictifs) ont été créées **dans des transactions
`BEGIN … ROLLBACK`** : rien n'a été laissé en production. Les 18 scénarios demandés :

| # | Scénario | Résultat |
|---|---|---|
| 1 | L'agence démarre un paiement et obtient une référence unique | ✅ `SOF-PAY-20261028-DYYHAQ` (format `SOF-PAY-[0-9]{8}-[23456789A-HJ-NP-Z]{6}`) |
| 2 | Une seconde demande obtient une autre référence | ✅ `SOF-PAY-20261028-UDK3LV` |
| 3 | Référence stable / réutilisée au rechargement | ✅ même référence, `reused = true`, 2 demandes en base |
| 4 | Formulaire complété après les instructions | ✅ `agency_submit_payment_proof` → `pending` |
| 5 | Demande réellement stockée dans Supabase | ✅ `SOF-PAY-20261028-R3M9UV / Awa Traore / 2026-10-28`, montant 50 000, statut `pending` |
| 5b | Preuve visible côté agence | ✅ `agency_payment_access` → `pending`, `has_proof = true`, référence inchangée |
| 6 | Notification admin persistante | ✅ `admin_alerts.kind = payment_declared`, non lue, lien `/admin/paiements?demande=<uuid>`, motif « Demande SOF-PAY-… — déclaré : 50 000 XOF / attendu : 50 000 XOF — Orange Money — réf. transaction … — soumis le 28/10/2026 12:48 », `metadata.amount_matches = true` |
| 7 | L'admin ouvre et valide | ✅ file + détail (nom d'agence, montant attendu/déclaré), `admin_review_payment` |
| 8 | Abonnement activé exactement une fois | ✅ `2026-11-17 → 2026-12-17`, 1 seul `subscription_payments` |
| 8b | Double validation refusée | ✅ 2ᵉ appel bloqué, toujours 1 paiement |
| 9 | Refus = aucun accès payant | ✅ statut `rejected`, motif visible agence, abonnement inchangé, 0 paiement |
| 10 | Une agence ne lit pas les paiements d'une autre | ✅ `agency_payment_access(autre)` → 42501 ; 0 ligne lisible en direct (RLS) |
| 11 | Une agence ne peut pas valider/suspendre elle-même | ✅ `admin_review_payment` et `admin_suspend_agency` → bloqués |
| 12 | Suspension d'une agence de test | ✅ `status='suspended'`, `suspended_at` renseigné, motif enregistré, abonnement préservé |
| 12b | Suspension d'une agence sans abonnement | ✅ autorisée (l'ancienne version levait « aucun abonnement ») |
| 13 | Connexion de l'agence bloquée pendant la suspension | ✅ `mon_etat_compte()` → `agency_status='suspended'`, `agency_plan_state.state='suspended'`, `is_locked=true` |
| 13b | Agence suspendue ne peut pas payer | ✅ création de demande bloquée |
| 14 | Réactivation par l'admin | ✅ `status='active'`, `suspended_at`/motif effacés, statut relu en base |
| 15 | L'agence retrouve l'accès | ✅ `mon_etat_compte()` → `active`, `agency_plan_state.state='active'`, `is_locked=false` |
| 16 | Biens, membres, historique préservés | ✅ 1 membre, 1 abonnement, 1 paiement, échéance inchangée, identifiant d'agence conservé |
| 17 | Abonnement expiré non réactivé artificiellement | ✅ `ends_at` inchangé (2026-09-18), `subscription_expired=true`, `features_limited=true` |
| 18 | Erreurs réseau / clics répétés sans doublon | ✅ (a) double soumission bloquée, 1 demande ; (b) double création → `reused` ; (c) double suspension → `already_suspended`, 1 événement ; (d) double réactivation → `already_active`, 1 événement |
| 19 | L'admin peut publier un moyen et débloquer le parcours | ✅ `admin_save_payment_methods` → `any_configured=true`, Orange configuré, Moov non configuré (transaction annulée) |

Contrôles supplémentaires : `tsc --noEmit` → 0 erreur ; `vite build` → OK
(`index-CH2ZQa3b.js` 1 389,71 kB, CSS 248,68 kB). Migration de rollback vérifiée en
`BEGIN … ROLLBACK` (`ROLLBACK_PART_B_OK`, restauration de l'ancienne génération `SI-`).

---

## 5. Réparation de la production effectuée

L'agence `SBC AI Agency Demo` (`10d464cf-ad26-43de-a5eb-aa9ed70a4e55`) était restée `suspended`
après les clics de réactivation échoués, ce qui bloquait la connexion de ses utilisateurs.
Elle a été réactivée **par la fonction corrigée elle-même**
(`public.admin_reactivate_agency`, exécutée avec l'identité de l'administrateur plateforme) :

* `status = 'active'`, `suspended_at = NULL`, `suspended_reason = NULL` ;
* abonnement **inchangé** : `active` jusqu'au 2026-11-27 (aucun mois ajouté) ;
* `agency_plan_state.state = 'active'`, `is_locked = false` ;
* entrée `activity_log` `agency_reactivated` + notification « Accès à votre espace rétabli » ;
* 5 propriétés et 2 membres intacts.

---

## 6. Ce qui reste à faire (bloqueurs réels)

1. **Numéros Mobile Money réels** : impossible de terminer un paiement en production tant que
   l'administrateur n'a pas saisi au moins un numéro vérifié dans
   `Réglages → Moyens de paiement` (Orange Money ou Moov Money). Aucune valeur n'a été inventée.
   Dès la saisie, le parcours se débloque sans redéploiement.
2. **Test navigateur** : le sandbox ne peut pas joindre `*.supabase.co`
   (`SSL_ERROR_SYSCALL`), donc aucun test E2E navigateur n'a été exécuté. Les chemins vérifiés le
   sont au niveau base (RPC, RLS, contraintes) et par compilation TypeScript/build.
3. **Téléversement du justificatif** : la validation serveur du chemin/type/taille est testée ;
   l'upload Storage + URL signée n'a pas pu être exercé depuis le sandbox.
4. **Deux demandes de test** `SI-20261028-E45A99` et `SI-20261028-74CE5A` (statut
   `awaiting_payment`, agence SBC) subsistent en base : elles datent des essais précédents. Elles
   peuvent être annulées depuis `/abonnement` par l'agence ; aucune donnée n'a été supprimée.
5. Notifications historiques dupliquées (« Votre offre est activée », 12:23 et 12:24) issues des
   clics répétés d'avant correctif : conservées (aucune suppression de données).

## 7. Étapes manuelles pour l'utilisateur

1. Recharger la console d'administration (`Ctrl+Shift+R`) pour charger le nouveau bundle.
2. Aller dans **Réglages → Moyens de paiement** : saisir le bénéficiaire et le **vrai** numéro
   Orange Money ou Moov Money, cocher « Activé », enregistrer.
3. Vérifier le bandeau disparaît sur **Paiements & offres**.
4. Depuis l'espace agence, ouvrir **Abonnement**, choisir une offre : la référence
   `SOF-PAY-…` est générée, copiable, et le bouton « J'ai effectué le paiement » apparaît.
5. Se reconnecter à l'espace agence SBC si la session avait été coupée par la suspension.
