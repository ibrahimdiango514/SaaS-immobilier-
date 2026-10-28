# Paiement manuel Mobile Money — bout en bout

**Date** : 2026-10-28
**Projet Supabase** : `xbuuhfwobrafcbgtdgjx` (eu-central-1, PostgreSQL 17.6)
**Schéma métier** : `saas_immobilier` (RPC dans `public`)
**Branche** : `arena/69b6afc4-saas-immobilier`
**Migrations appliquées** : `payment_manual_1_schema` → `payment_manual_10_reminder_counter`, puis `payment_manual_11_harden_platform_admin`

---

## 1. Diagnostic de départ (ce qui existait réellement)

| Élément | État constaté avant travaux |
|---|---|
| `payment_declarations` | Table présente. Montant **saisi librement par l'agence**, aucun montant attendu, aucune référence de commande, aucun lien avec une offre. |
| `submit_payment_declaration` | Acceptait n'importe quel montant > 0 et seulement 2 moyens (`orange_money`, `wave`). Aucune vérification de la configuration des moyens de paiement. |
| `review_payment_declaration` | Ne comparait **pas** le montant déclaré au montant attendu, n'empêchait **pas** la réutilisation d'une référence de transaction, n'offrait pas de « demande de correction », n'écrivait aucune notification. |
| Statuts | `pending / approved / rejected` uniquement ; aucune machine à états. |
| `agency_subscriptions` | RLS laissait un **propriétaire d'agence** modifier sa propre ligne (`agency_subscriptions_update_admin` / `_insert_admin`) : il pouvait repousser lui-même sa date d'expiration. |
| `payment_declarations` | Politique `payment_declarations_insert_member` : un membre pouvait insérer une déclaration avec le statut de son choix. |
| Moyens de paiement | `platform_settings.payment_instructions` = **tous les numéros vides** (`{name:"",number:""}`), aucune notion de moyen « configuré ». |
| Droits admin | `public.is_platform_admin()` = ligne active dans `platform_admins` **OU** `user_profiles.role = 'admin'`. Or `user_profiles_update_self` laisse chaque utilisateur modifier sa propre ligne ⇒ **élévation de privilèges** triviale. |
| Frontend | `payments-api.ts` (2 moyens codés en dur, montant libre), `components/payment-panel.tsx`, `pages/admin/billing.tsx` validant en un clic, sans comparatif de montant ni historique de décision. |
| Rappels | Aucun. |
| Storage | Bucket `payment-proofs` déjà privé (5 Mo, jpeg/png/webp/pdf) avec politiques `is_agency_member` / `is_platform_admin`. |

Aucune donnée n'a été supprimée. Aucune table métier n'a été recréée : `payment_declarations` a été **étendue** pour porter la demande de paiement complète.

---

## 2. Ce qui a été livré

### 2.1 Base de données (appliqué)

`payment_declarations` devient la **demande de paiement** :

| Colonne ajoutée | Rôle |
|---|---|
| `reference` | Référence générée par le serveur (`SI-AAAAMMJJ-XXXXXX`), unique. |
| `plan_id`, `plan_name_snapshot` | Offre facturée, figée à la création. |
| `expected_amount` | Montant attendu, calculé côté serveur (`prix mensuel × durée`), **non modifiable par l'agence**. |
| `duration_months` | Durée choisie (1 à 12). |
| `payer_name`, `proof_mime`, `proof_size`, `proof_uploaded_at` | Preuve de paiement. |
| `submitted_at`, `expires_at`, `cancelled_at`, `cancel_reason` | Cycle de vie. |
| `transaction_reference_norm` | Colonne **générée** (majuscules, sans espaces) portant l'unicité. |

Garanties en base (pas seulement dans l'interface) :

- `payment_declarations_txn_ref_uniq` — une référence Mobile Money ne peut valider qu'**une** demande `pending`/`approved`, toutes agences confondues.
- `payment_declarations_one_pending_per_agency` — une seule demande en vérification par agence (double clic impossible).
- `subscription_payments_declaration_uniq` — un encaissement ne peut être rattaché qu'à une seule déclaration (approbation rejouée impossible).
- `payment_declarations_submitted_fields_check` — méthode, référence et date obligatoires dès la soumission.
- `payment_declarations_status_check` — `awaiting_payment | pending | correction_requested | approved | rejected | cancelled | expired`.
- `agency_subscriptions_status_check` — `pending | trial | active | past_due | expired | suspended | cancelled`.

Nouvelle table **`payment_decision_log`** (append-only, écrite uniquement par les fonctions `SECURITY DEFINER`) : `created → submitted → approved / rejected / correction_requested / cancelled`.

### 2.2 RPC (toutes `SECURITY DEFINER`, dans `public`)

| Fonction | Garde | Rôle |
|---|---|---|
| `agency_payment_access(uuid)` | membre actif de l'agence | Offres, moyens configurés, abonnement, échéance, demandes. |
| `agency_create_payment_request(uuid,uuid,int)` | owner/admin de l'agence | Crée la demande + référence serveur, montant = prix × durée, anti-double-clic (`reused`). |
| `agency_submit_payment_proof(uuid,text,numeric,text,date,text,text,text,bigint,bool)` | owner/admin | Vérifie montant = attendu, moyen **réellement configuré**, format/référence/date, unicité, TTL. Passe en `pending`. |
| `agency_cancel_payment_request(uuid,text)` | owner/admin | Annulation tant que la demande n'est pas en vérification. |
| `admin_payment_queue(text[],uuid,text,date,date,text,int,int)` | `is_platform_admin()` | File filtrée + compteurs par statut. |
| `admin_payment_detail(uuid)` | `is_platform_admin()` | Détail, comparatif de montant, agence, abonnement, historique des décisions. |
| `admin_review_payment(uuid,text,text)` | `is_platform_admin()` | Décision **transactionnelle** (verrou `FOR UPDATE`). |
| `admin_save_payment_methods(jsonb,bool,text)` | `is_platform_admin()` | Configuration Orange / Moov / Wave. |
| `billing_run_reminders()` | `service_role` | Rappels d'échéance, idempotents (`pg_cron`, 06:00 UTC). |

`review_payment_declaration` et `submit_payment_declaration` (anciennes portes d'entrée) subsistent pour compatibilité mais **délèguent** au nouveau chemin : impossible de contourner les contrôles.

### 2.3 Abonnement et activation

`admin_review_payment` réalise dans **une seule transaction** :

1. vérifie que la demande existe et est encore `pending` (verrou) ;
2. refuse si le montant déclaré ≠ montant attendu ;
3. refuse si la référence de transaction a déjà validé un autre paiement ;
4. prolonge l'abonnement existant s'il est encore valide (**les jours restants sont conservés**), sinon repart de la date du jour ;
5. enregistre l'encaissement (`subscription_payments`, période + référence + `declaration_id` unique) ;
6. met à jour l'agence (réactivation si `suspended`/`pending`) ;
7. écrit `subscription_events`, `activity_log`, `payment_decision_log` ;
8. envoie une notification in-app à l'agence.

Un refus ne touche **jamais** l'abonnement (testé).

### 2.4 Sécurité

- RLS resserrée : plus d'écriture agence sur `agency_subscriptions` ni sur `payment_declarations` (écriture par RPC uniquement). Lecture limitée aux membres de l'agence ; l'admin plateforme lit tout.
- Justificatifs : bucket privé, URL **signée 15 min**, aucune URL publique.
- `is_platform_admin()` **durci** : uniquement `platform_admins` (statut actif). La branche `user_profiles.role = 'admin'` est supprimée.
- Trigger `guard_profile_role_trg` : un utilisateur ne peut plus s'attribuer `role='admin'` (erreur 42501) ; l'administrateur réel et les contextes techniques restent autorisés.
- Frontend : `getPlatformRole()` ne déduit plus `isAdmin` de `user_profiles.role`.

---

## 3. Parcours agence (interface)

| Écran | Route | Fichier |
|---|---|---|
| Abonnement et facturation | `/abonnement` | `src/pages/subscription.tsx` |
| Paiement dédié (4 étapes) | `/abonnement/paiement/:requestId` | `src/pages/subscription-payment.tsx` |
| Panneau repris dans « Mon offre » / écran d'attente | — | `src/components/payment-panel.tsx` |

1. **Offres** : prix, durée, quotas et modules lus dans `plans` ; total = prix × durée ; aucune remise inventée.
2. **Moyens de paiement** : un moyen sans numéro affiche « **Moyen de paiement en cours de configuration** » et la soumission est bloquée (client **et** serveur).
3. **Demande** : référence serveur affichée et copiable, montant exact, validité (`expires_at`).
4. **Preuve** : méthode, montant en lecture seule, référence de transaction, date (≤ aujourd'hui), payeur, justificatif JPG/PNG/WebP/PDF ≤ 5 Mo (refus des `.exe`, `.svg`, etc.), case de confirmation.
5. **Confirmation** : « En attente de vérification », référence, statut, montant.
6. **Historique** : demandes en cours / traitées, motif de refus ou de correction visible, encaissements enregistrés.

## 4. Parcours administration

`/admin/paiements` (`src/pages/admin/billing.tsx`) :

- file filtrable par **statut, agence, moyen, période**, recherche plein texte, compteurs ;
- carte par demande : montant **attendu** vs **déclaré**, écart signalé, présence du justificatif ;
- tiroir de détail : agence, abonnement, justificatif (URL signée), **comparatif de montant**, **historique complet des décisions** ;
- trois décisions : **valider**, **refuser** (motif obligatoire), **demander une correction** (motif obligatoire) ;
- **récapitulatif de confirmation** avant validation (agence, offre, montant, référence, effet sur l'échéance) ;
- écran de résultat : nouvelle échéance, `plan`, montant.

Réglages (`/admin/reglages`, `panel-payment-settings`) : bénéficiaire, numéro, consignes, activation et justificatif obligatoire **par moyen** (Orange Money, Moov Money, Wave), consigne générale.

---

## 5. Fichiers

**Ajoutés**

- `db/migrations/2026-10-28_paiement_manuel_bout_en_bout.sql`
- `db/migrations/2026-10-28_paiement_manuel_durcissement_admin.sql`
- `db/rollback/2026-10-28_paiement_manuel_bout_en_bout_rollback.sql`
- `artifacts/sofia-immobilier/src/lib/billing-api.ts`
- `artifacts/sofia-immobilier/src/pages/subscription.tsx`
- `artifacts/sofia-immobilier/src/pages/subscription-payment.tsx`
- `docs/RAPPORT-2026-10-28_paiement_manuel_bout_en_bout.md`

**Modifiés**

- `src/App.tsx` (routes `/abonnement`, `/abonnement/paiement/:id`, entrée de navigation)
- `src/components/payment-panel.tsx` (réécrit sur `billing-api`)
- `src/pages/admin/billing.tsx` (console de vérification)
- `src/pages/admin/settings.tsx` (éditeur des moyens de paiement)
- `src/lib/data-hooks.ts` (`isAdmin` = `platform_admins` uniquement)
- `src/lib/admin-billing-api.ts` (constante du bucket)
- `src/index.css` (styles facturation + responsive)

**Supprimé**

- `src/lib/payments-api.ts` (ancienne couche : montants libres, 2 moyens, statuts incomplets)

---

## 6. Tests exécutés

Tous les tests base ont été exécutés **sur la base réelle** via l'API de gestion Supabase, dans une transaction terminée par `ROLLBACK` (aucune donnée de test persistée).

### 6.1 Parcours complet (TEST E2E, 2026-10-28)

| # | Étape | Résultat |
|---|---|---|
| 0 | Configuration de 2 moyens | `configured_count = 2` |
| 1 | Création demande Pro × 3 mois | `awaiting_payment`, `SI-20261028-A922DE`, `300000.00`, `3` |
| 2 | Double clic sur « Choisir » | `reused = true` (aucune seconde demande) |
| 3 | Soumission avec mauvais montant | refusée : « le montant declare (1000) ne correspond pas au montant attendu (300000.00) » |
| 4 | Soumission correcte | `pending`, `300000` |
| 5 | File admin + détail | `pending = 1`, attendu `300000.00` = déclaré `300000`, `amount_matches = true` |
| 6 | Historique des décisions | `created → submitted` |
| 7 | Approbation | nouvelle échéance `2027-02-25` (= 2026-11-25 + 3 mois, jours restants conservés) |
| 8 | Seconde approbation | refusée : « cette demande a deja ete traitee (statut : approved) » |
| 9 | État agence après validation | `status=active`, `ends_at=2027-02-25`, `plan=pro`, demande `approved` |
| 10 | Encaissement | 1 ligne `subscription_payments`, période `2026-11-25 → 2027-02-25` |
| 11 | Notifications | `payment_submitted`, `payment_approved` |
| 12 | Réutilisation de la même référence | refusée : « cette reference de transaction est deja utilisee » |
| 13 | Refus avec motif | `rejected`, motif visible côté agence, abonnement **inchangé** (`2027-02-25`) |
| 14 | L'agence tente une décision admin | refusée : « administrateur plateforme requis » (42501) |

### 6.2 Durcissement des droits admin

| Test | Résultat |
|---|---|
| Un agent d'agence exécute `update user_profiles set role='admin'` | **refusé** (42501, `guard_profile_role`) |
| Un agent : `is_platform_admin()` | `false` |
| Un agent : lecture `payment_declarations` / `payment_decision_log` | `0` ligne |
| Un agent : `admin_payment_queue()` | refusé (42501) |
| Administrateur réel : `admin_payment_queue()` | `jsonb` valide, compteurs à 0 |
| Administrateur réel : changement de `role` d'un profil | autorisé (testé puis annulé) |

### 6.3 Réglages des moyens de paiement

| Test | Résultat |
|---|---|
| `admin_save_payment_methods` avec le payload exact du frontend | configuration normalisée renvoyée, `configured_count = 1` |
| Activation de Moov Money sans numéro | refusée : « le moyen moov_money est active mais aucun numero n est renseigne » |

### 6.4 Retour arrière

- `db/rollback/2026-10-28_paiement_manuel_bout_en_bout_rollback.sql` : sections §1 à §9 exécutées **puis annulées** (`ROLLBACK`) sur la base réelle — aucune erreur. Les garde-fous (statuts nouveaux encore utilisés, champs NOT NULL) ont été vérifiés.

### 6.5 Frontend

| Vérification | Résultat |
|---|---|
| `tsc -p artifacts/sofia-immobilier/tsconfig.json --noEmit` | **0 erreur** |
| `vite build` (production) | **succès**, 2542 modules, CSS 248 Ko / JS 1,38 Mo |

### 6.6 Ce qui **n'a pas** pu être testé (et pourquoi)

- **Parcours navigateur réel (E2E UI, mobile et desktop)** : le bac à sable n'a **aucun accès réseau à `*.supabase.co`** (`curl` → `SSL_ERROR_SYSCALL`, HTTP 000). Un navigateur lancé ici ne pourrait ni s'authentifier ni lire la base : aucun test d'interface n'est revendiqué.
- **Téléversement binaire d'un justificatif vers Storage** : nécessite une session utilisateur réelle (API Storage), impossible sans accès réseau. La validation du chemin, du type MIME, de la taille et du dossier a en revanche été testée en SQL (migration 1, TEST D), et les politiques Storage ont été vérifiées (`payment_proofs_insert`, `payment_proofs_owner_select`).
- **Envoi réel d'e-mails/SMS** : aucun fournisseur n'est configuré dans ce projet. Les notifications sont **in-app** (table `notifications`, cloche) ; rien n'est simulé.

---

## 7. Configuration restant à remplir (côté production)

Rien n'est inventé dans le code : tant que ces valeurs sont vides, l'interface affiche « Moyen de paiement en cours de configuration » et le serveur refuse la soumission.

1. **Numéros Mobile Money réels** — `/admin/reglages` → « Moyens de paiement » : bénéficiaire, numéro, consignes, activation pour **Orange Money** et **Moov Money** (Wave facultatif). Aujourd'hui : **tous vides** en production.
2. **Tarifs et durées** — `plans.price_monthly` / `setup_fee` existent déjà (Essentiel 50 000, Pro 100 000, Premium 200 000 XOF). Les durées proposées viennent de `platform_settings.billing.durations` (défaut `[1,3,6,12]`, modifiable en SQL).
3. **Justificatif obligatoire** — case globale et par moyen dans les réglages (désactivée par défaut).
4. **Délai de grâce** — `platform_settings.billing.grace_days` (5 par défaut).
5. **Rappels** — `platform_settings.billing.reminder_days` (`[5,0]` par défaut) et tâche `pg_cron` `sofia-billing-reminders` (quotidienne, 06:00 UTC, **déjà planifiée**).

---

## 8. Mises en production exactes

1. **Migrations déjà appliquées** sur `xbuuhfwobrafcbgtdgjx` (versions `payment_manual_1_schema` … `payment_manual_11_harden_platform_admin`). Pour un autre environnement :
   ```bash
   psql "$DATABASE_URL" -f db/migrations/2026-10-28_paiement_manuel_bout_en_bout.sql
   psql "$DATABASE_URL" -f db/migrations/2026-10-28_paiement_manuel_durcissement_admin.sql
   ```
2. **Vérifier** : `select * from cron.job where jobname='sofia-billing-reminders';` et `select public.is_platform_admin();` avec un compte admin.
3. **Configurer les numéros** dans `/admin/reglages` (étapes du §7) — sans cela, aucun paiement ne peut aboutir.
4. **Déployer le frontend** (`pnpm --filter @workspace/sofia-immobilier build`) sur l'hébergement habituel.
5. **Contrôle manuel recommandé** (navigateur, une fois les numéros saisis) : créer une demande, transmettre une preuve, vérifier la file admin, valider, vérifier l'échéance et la notification.

---

## 9. Limites connues / points d'attention

1. **Validation humaine obligatoire** : le système n'affirme jamais qu'un paiement est encaissé avant la décision de l'administrateur ; le récapitulatif rappelle explicitement de vérifier l'arrivée des fonds.
2. **Deux chemins de changement d'offre** subsistent : la demande de changement d'offre historique (`request_plan_change`, validée par un admin sans paiement) et le nouveau parcours payant. Choix à trancher côté produit : soit la demande de changement d'offre déclenche une demande de paiement, soit elle est réservée aux gestes commerciaux.
3. **`must_change_password`** reste modifiable par l'utilisateur lui-même (hors périmètre de ce chantier) — même famille de risque que `role`, à traiter séparément.
4. **Aucun test navigateur** n'a pu être exécuté depuis le bac à sable (voir §6.6) : les tests d'interface restent à faire côté navigateur.
5. **Pas de fournisseur e-mail/SMS** : les notifications sont in-app uniquement.
