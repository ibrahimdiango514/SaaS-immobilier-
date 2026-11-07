# Documentation Technique — LOT 4, LOT 5, LOT 6 & LOT 7
## Notifications Temps Réel, Rappels Datés (`Africa/Bamako`), Cas Limites & Cron Horaire, Mobile Android et Durcissement Sécurité RLS

**Date :** 2026-11-06  
**Environnement vérifié :** `Sofia Immobilier Lab` (`yswsildmbeomjlyofnrk`)  
**Environnement Production (`xbuuhfwobrafcbgtdgjx`) :** **INTACT — aucune migration ni Edge Function appliquée sans validation explicite**

---

## 1. Architecture LOT 4 — Notifications Agence, Rappels Automatiques & Alertes Admin

### 1.1 Garanties transverses
- **Idempotence stricte en base :**
  - `saas_immobilier.notifications` : index unique partiel `notifications_agency_event_key_uidx` sur `(agency_id, event_key) WHERE event_key IS NOT NULL` + helper atomique `saas_immobilier.billing_notify_once(...)`.
  - `saas_immobilier.admin_alerts` : index unique partiel `admin_alerts_event_key_uidx` sur `(COALESCE(agency_id, '00000000-0000-0000-0000-000000000000'), event_key) WHERE event_key IS NOT NULL` + helper atomique `saas_immobilier.admin_alert_once(...)`.
  - Les helpers historiques `emit_agency_notification_once` et `emit_admin_alert_once` délèguent désormais aux helpers LOT 4 avec normalisation de la clé `onboarding-created:<agency_id>` (zéro doublon à l'inscription).
- **Fuseau horaire unique `Africa/Bamako` (UTC+0) :**
  - Côté SQL : toutes les dates affichées dans les messages de notifications/alertes et tous les calculs calendaires (`J-7`, `J-3`, `J-1`, filtres `p_from_date` / `p_to_date`) utilisent `AT TIME ZONE 'Africa/Bamako'`.
  - Côté Frontend : `SOFIA_TIMEZONE = 'Africa/Bamako'` appliqué dans `formatDate`, `formatDateTime`, `monthShortLabel` et `safeFormat` (`src/lib/workspace-ui.tsx`).
- **Temps réel (`supabase_realtime`) :**
  - Tables publiées : `saas_immobilier.notifications`, `saas_immobilier.admin_alerts`, `saas_immobilier.online_payments`, `saas_immobilier.agency_subscriptions`.
  - Hooks client : `useAgencyNotificationsRealtime(agencyId)` et `useAdminAlertsRealtime()`.

### 1.2 Couverture complète des événements Agence (17+ événements)
| Famille | Événements couverts | Lien contextuel direct |
|---|---|---|
| **Onboarding & Installation** | Compte créé en attente, rendez-vous d'installation planifié (`scheduled`), installation validée (`completed`), agence officiellement activée | `/mon-offre`, `/dashboard` |
| **Essai gratuit 14 jours** | Début d'essai 14j, rappels automatiques `J-7`, `J-3`, `J-1`, fin d'essai & ouverture du 1er mois | `/mon-offre` |
| **Facturation & Échéances** | Nouvelle facture émise (`first_subscription`, `renewal`, `plan_change`, `reactivation`), rappels avant échéance `J-7`, `J-3`, `J-1`, échéance atteinte (`J0`) | `/mon-offre` |
| **Période de grâce 5j & Suspension** | Entrée en grâce de 5 jours, rappel milieu de grâce (`J-3`), dernier rappel (`J-1` avant suspension), suspension automatique pour impayé, réactivation automatique après paiement | `/mon-offre` |
| **Paiements SasPay & Offres** | Session SasPay initiée, paiement confirmé, paiement échoué / session expirée, changement d'offre immédiat | `/paiement/retour?payment=<id>`, `/mon-offre` |

### 1.3 Couverture complète des alertes de supervision Admin (12+ familles)
- Nouvelle inscription d'agence en attente d'installation physique (`onboarding-created:<id>`) + relance automatique si attente `> 48h` (`admin_scan_alerts`).
- Installation physique planifiée / complétée, agence activée + essai 14j démarré.
- Essai proche de la fin (`J-3` / `J-1`) et conversion automatique en 1er mois payant.
- Facture mensuelle émise, agence entrée en période de grâce de 5 jours (`high`), agence suspendue automatiquement (`critical`).
- Session SasPay initiée, paiement SasPay confirmé, paiement échoué / expiré (`high`), anomalie de vérification répétée (`>= 3` tentatives, `critical`), écart de montant SasPay bloqué (`payment_amount_mismatch`, `critical`).
- **Auto-résolution intelligente :** dès qu'un paiement régularise une agence, les alertes non lues de retard/grâce/suspension de cette agence sont automatiquement marquées traitées (`read_at = now()`).

---

## 2. Architecture LOT 5 — Cas Limites, Zéro Perte de Jours Payés & Cron Horaire

### 2.1 Règles métier financières garanties
1. **Zéro perte de jours payés lors d'une réactivation après suspension :**
   - Si une agence suspendue à `E1 + 5j` régularise sa facture le jour `T_pay > E1 + 5j`, la nouvelle période payée démarre à **`GREATEST(v_now, current_period_end)`** = `T_pay` pour **1 mois complet (`T_pay + 1 month`)**. L'agence ne paie jamais pour les jours où son accès était suspendu.
2. **Zéro perte de jours d'essai en cas de prépaiement anticipé :**
   - Si une agence règle son 1er mois pendant ses 14 jours d'essai gratuit (`T_pay < trial_ends_at`), le mois payé est ancré sur **`trial_ends_at → trial_ends_at + 1 month`** (aucun jour d'essai gratuit perdu).
3. **Double paiement / Webhook concurrent SasPay :**
   - Verrouillage pessimiste `FOR UPDATE` sur `online_payments` et `agency_subscriptions` ; un second appel webhook/verify/reconcile sur une transaction déjà `confirmed` retourne immédiatement l'état existant en idempotence (`already_confirmed = true`).
4. **Vérification stricte du montant (`payment_amount_mismatch`) :**
   - `apply_confirmed_subscription_payment` compare le montant confirmé au centime/franc près avec la facture cible et rejette toute divergence tout en levant une alerte `critical` côté Admin.
5. **Bouclier exceptionnel anti-suspension (`public.admin_set_suspension_shield`) :**
   - Permet à un administrateur plateforme d'accorder un délai exceptionnel (`+3j` à `+30j`, ancré sur `GREATEST(now(), grace_ends_at, ends_at)`) en cas de litige ou d'accord écrit, journalisé dans `activity_log`.

### 2.2 Automatisation horaire `pg_cron`
- Job actif sur Lab : **`sofia-subscription-lifecycle-hourly`** (`5 * * * *`) exécutant chaque heure :
  ```sql
  SELECT public.process_subscription_lifecycle(now());
  SELECT public.admin_scan_alerts();
  ```
- Supervision exposée dans l'interface Admin via `public.billing_automation_health()` (`/admin/activite` et `/admin/abonnements`).

---

## 3. Architecture LOT 6 — Centres UI Temps Réel & Responsivité Mobile Android

- **Cloches Temps Réel Desktop + Mobile Android (`<= 760px`) :**
  - Espace Agence : `<AgencyNotificationsBell />` intégré à la fois dans `.topbar` (Desktop) et `.mobile-header` (Android), avec compteur temps réel, aperçu enrichi et liens contextuels directs.
  - Espace Admin : `<AdminAlertsBell />` intégré dans `.admin-topbar` (Desktop) et `.admin-mobile-header` (Android).
- **Nouvelle page Agence `/notifications` (`src/pages/notifications.tsx`) :**
  - KPIs temps réel, onglets *Notifications & rappels* / *Historique des événements de facturation*, filtres par catégorie, statut lu/non-lu, période (`Africa/Bamako`) et recherche texte.
- **Page Admin `/admin/activite` enrichie (`src/pages/admin/activity.tsx`) :**
  - Bandeau de santé `pg_cron`, onglet *Centre d'alertes plateforme* (filtres serveur `admin_alerts_center`) + onglet *Journal d'activité SQL* avec export CSV.

---

## 4. Architecture LOT 7 — Audit & Durcissement Sécurité RLS

Migration : `db/migrations/2026-11-05_lot7_security_rls_hardening.sql` (vérifiée sur Lab) :
1. **RLS activé et politiques explicites** sur 100 % des tables de `saas_immobilier`, y compris `billing_automation_runs`, `subscription_plan_audit`, `agency_ai_usage_monthly`, `agency_invitations`, `ai_conversations` et `ai_messages`.
2. **Immutabilité des notifications côté client :**
   - `REVOKE INSERT, DELETE ON saas_immobilier.notifications FROM anon, authenticated;`
   - `GRANT UPDATE (read_at) ON saas_immobilier.notifications TO authenticated;` : un membre d'agence ne peut modifier **aucune autre colonne** (`title`, `message`, `data`, `event_key`, `agency_id` donnent `42501 permission denied`).
3. **Immutabilité des tables financières :**
   - `subscription_invoices`, `subscription_payments`, `online_payments`, `subscription_events` : lecture seule côté `authenticated` (filtrée par `billing_has_access(agency_id)`), écritures réservées aux fonctions transactionnelles serveur.
4. **Verrouillage des RPC `SECURITY DEFINER` internes :**
   - `REVOKE ALL ... FROM PUBLIC, anon, authenticated` appliqué sur `saas_immobilier.apply_confirmed_subscription_payment`, `ensure_cycle_invoice`, `billing_notify_once`, `admin_alert_once`, et sur les RPC serveur SasPay (`saspay_mark_checkout_ready`, `saspay_confirm_payment`, `saspay_record_failed`, `saspay_record_verification_failure`, `saspay_list_pending_for_reconcile` — exécutables uniquement par `service_role`).

---

## 5. Résultats de la Suite Automatisée sur Lab (`yswsildmbeomjlyofnrk`)

Tous les scénarios ont été exécutés en conditions réelles puis annulés proprement (`ROLLBACK`, `residual_test_agencies = 0`) :
- `pg_cron_active`: `true` (`sofia-subscription-lifecycle-hourly`)
- `cron_idempotency_passed`: `true` (0 notification ni facture en doublon lors de ré-exécutions successives)
- `signup_single_agency_notif`: `true` & `signup_single_admin_alert`: `true`
- `shield_prevented_suspension`: `true` & `auto_suspended_after_shield_expired`: `true`
- `reactivation_zero_lost_days`: `true`
- `trial_prepay_zero_lost_days`: `true`
- `duplicate_payment_idempotent`: `true`
- `stale_suspension_alerts_auto_resolved`: `true`
- `amount_mismatch_blocked`: `true`
- `cross_agency_rpc_blocked`: `true` (`42501`) & `cross_agency_rls_zero_rows`: `true`
- `notification_tampering_blocked`: `true` (`42501`) & `agency_mark_read_works`: `true`
- `non_admin_alerts_blocked`: `true` (`42501`)

---

## 6. Ordre Exact de Déploiement Futur vers Production (`xbuuhfwobrafcbgtdgjx`)
*(À exécuter uniquement après validation explicite de l'utilisateur)*

1. Appliquer dans l'ordre les migrations SQL :
   - `db/migrations/2026-11-05_lot1_onboarding_pending_admin_activation.sql`
   - `db/migrations/2026-11-05_lot2_subscription_billing_lifecycle.sql`
   - `db/migrations/2026-11-05_lot3_saspay_complete_integration.sql`
   - `db/migrations/2026-11-05_lot4_notifications_reminders_admin_alerts.sql`
   - `db/migrations/2026-11-05_lot5_lifecycle_edge_cases_and_cron.sql`
   - `db/migrations/2026-11-05_lot7_security_rls_hardening.sql`
2. Configurer les secrets SasPay Production sur `xbuuhfwobrafcbgtdgjx` (`SASPAY_BASE_URL`, `SASPAY_MERCHANT_ID`, `SASPAY_API_KEY`, `SASPAY_API_SECRET`, `SASPAY_WEBHOOK_SECRET`, `SOFIA_PUBLIC_APP_URL`).
3. Déployer les 4 Edge Functions : `saspay-checkout`, `saspay-verify` (`verify_jwt: true`), `saspay-webhook` (`verify_jwt: false`), `saspay-reconcile` (`verify_jwt: false`).
4. Vérifier que `SBC AI Agency Demo` (`10d464cf-ad26-43de-a5eb-aa9ed70a4e55`) conserve strictement son abonnement `Pro` actif jusqu'au `2026-12-27`.
