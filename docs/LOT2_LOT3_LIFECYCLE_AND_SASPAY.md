# LOT 2 & LOT 3 — Cycle d’abonnement, Facturation mensuelle & Intégration SasPay complète

## 1. Chronologie métier officielle implémentée (LOT 2)

| Jalon | Statut Agence | Statut Abonnement | Accès Dashboard & Quotas | Facturation & Automatisation |
| :--- | :--- | :--- | :--- | :--- |
| **Inscription → Installation** | `pending` | *(aucun)* | Fermé (`PendingValidationPage`) | Frais d’installation physique suivis séparément (hors SasPay). |
| **Activation Admin (`J0 → J14`)** | `trial` | `trial` | **100 % complet** (quotas & modules de l’offre) | Essai gratuit 14 jours. Rappels dédupliqués à `J9` (`J-5`) et `J12` (`J-2`). Zéro paiement réclamé. |
| **Fin d’essai (`J14`)** | `active` | `active` | **100 % complet** | Ouverture auto du 1er mois `[J14 → E1]` (`E1 = J14 + 1 mois`) + génération idempotente de la 1re facture `first_subscription` (`amount = price_monthly`, **0 frais d’installation**). |
| **1er mois (`J14 → E1`)** | `active` | `active` | **100 % complet** (même si facture `pending`) | Rappels à `E1 - 5j` et `E1 - 2j` si facture encore ouverte. Paiement en 1 clic via SasPay. |
| **Échéance `E1` déjà réglée** | `active` | `active` | **100 % complet** | Ouverture transparente de `[E1 → E2]` + facture `renewal` due à `E2`. |
| **Grâce de 5 jours (`E1 → E1 + 5j`)** | `active` | `past_due` | **100 % complet maintenu** | Bandeau prioritaire avec compte à rebours + alertes `E1` et `E1 + 3j`. |
| **Après `E1 + 5 jours` sans paiement** | `suspended` (`unpaid`) | `past_due` | Modules fermés (`SuspendedAgencyPage`) | Suspension automatique uniquement après expiration complète des 5 jours de grâce. |
| **Confirmation d’un paiement** | `active` | `active` | **Rétabli immédiatement à 100 %** | Solde la facture, met à jour `paid_through_at` / périodes et réactive automatiquement toute agence suspendue pour impayé. |

## 2. Intégration SasPay complète (LOT 3)

### Les 4 motifs officiels (`online_payments.purpose`)
1. `first_subscription` : Règlement de la 1re facture mensuelle générée à `J14` (`50 000` / `100 000` / `200 000` FCFA, sans frais d’installation).
2. `renewal` : Règlement d’une échéance mensuelle ouverte ou renouvellement anticipé d’un mois.
3. `plan_change` : Montée d’offre immédiate en cours d’abonnement payant au **prorata calculé exclusivement côté serveur** (`public.saspay_preview_plan_upgrade` / `saas_immobilier.prepare_plan_change_invoice`).
4. `reactivation` : Régularisation d’une agence suspendue pour impayé (`suspended_reason = 'unpaid'`), déclenchant la réactivation immédiate dès vérification serveur.

### Garanties de sécurité & d’idempotence
- **Zéro montant fourni par le navigateur** : `public.saspay_create_checkout` calcule le montant exclusivement en base de données.
- **Zéro frais de 4 % imposés côté Sofia** (Décision 3) : Sofia transmet uniquement le montant net exact de l’offre/prorata ; les frais éventuels dépendent du moyen de paiement choisi côté SasPay.
- **Double contrôle serveur-à-serveur** : `saspay-verify`, `saspay-webhook` et `saspay-reconcile` contrôlent `/checkout-sessions/{id}/status/` + `/payments/{tx_id}/verify/` et bloquent toute divergence de montant ou de devise (`billing_reconciliation_exceptions` + alerte critique `admin_alerts`).
- **Signature webhook HMAC-SHA256** : vérification WebCrypto en temps constant (`X-Webhook-Signature`, fenêtre anti-rejeu de 300s) et journalisation dans `saas_immobilier.saspay_webhook_events`.

## 3. Fichiers livrés dans le workspace

- Migrations SQL :
  - `db/migrations/2026-11-05_lot1_onboarding_pending_admin_activation.sql`
  - `db/migrations/2026-11-05_lot2_subscription_billing_lifecycle.sql`
  - `db/migrations/2026-11-05_lot3_saspay_complete_integration.sql`
- Rollbacks non-destructifs :
  - `db/rollback/2026-11-05_lot1_onboarding_pending_admin_activation_rollback.sql`
  - `db/rollback/2026-11-05_lot2_subscription_billing_lifecycle_rollback.sql`
  - `db/rollback/2026-11-05_lot3_saspay_complete_integration_rollback.sql`
- Edge Functions Supabase (déployées et actives sur Lab `yswsildmbeomjlyofnrk` uniquement) :
  - `supabase/functions/saspay-checkout/index.ts`
  - `supabase/functions/saspay-verify/index.ts`
  - `supabase/functions/saspay-webhook/index.ts`
  - `supabase/functions/saspay-reconcile/index.ts`
- Frontend Agence & Admin :
  - `artifacts/sofia-immobilier/src/lib/saspay-api.ts`
  - `artifacts/sofia-immobilier/src/pages/suspended.tsx`
  - `artifacts/sofia-immobilier/src/pages/payment-return.tsx`
  - `artifacts/sofia-immobilier/src/pages/my-offer.tsx`
  - `artifacts/sofia-immobilier/src/components/plan-status-banner.tsx`
  - `artifacts/sofia-immobilier/src/pages/admin/subscriptions.tsx`
  - `artifacts/sofia-immobilier/src/pages/admin/billing.tsx`
  - `artifacts/sofia-immobilier/src/App.tsx`
  - `artifacts/sofia-immobilier/src/lib/data-hooks.ts`
  - `artifacts/sofia-immobilier/src/lib/plan-limits.ts`

## 4. Secrets SasPay à renseigner avant encaissement réel

Sur le projet Supabase cible (`Edge Functions → Secrets`) :
- `SASPAY_SECRET_KEY` : clé secrète API SasPay (`Bearer ...`)
- `SASPAY_WEBHOOK_SECRET` : secret HMAC-SHA256 des webhooks SasPay
- `SOFIA_APP_BASE_URL` : URL publique HTTPS de l’application (ex. `https://app.sofia-immobilier.ml`)
- `SASPAY_CRON_SECRET` : secret d’au moins 32 caractères pour l’appel planifié de `saspay-reconcile`
