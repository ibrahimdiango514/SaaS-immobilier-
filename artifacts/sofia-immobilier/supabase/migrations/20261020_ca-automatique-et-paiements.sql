-- =============================================================================
-- Migration : Chiffre d'affaires automatique + historique des paiements
-- Projet : xbuuhfwobrafcbgtdgjx  ·  Date : 2026-10-20  ·  ADDITIF UNIQUEMENT
--
-- Appliquée ce jour via l'API Supabase (voir recap lot « CA automatique »).
-- Retour arrière : supabase/rollback/20261020_ca-automatique-abonnements.sql
--
-- Contenu :
--   1. Colonnes de commission (agence + bien)
--   2. Colonne revenue_operations.source + index unique anti-doublon
--   3. RLS : membres en lecture seule sur revenue_operations, admin complet
--   4. Trigger SECURITY DEFINER (search_path=public) de synchronisation du CA
--   5. Table subscription_payments + RLS admin
--   6. Rétroactif (exécuté : 0 ligne créée — aucun bien sold/rented à ce jour)
-- =============================================================================

-- 1. Taux de commission -------------------------------------------------------
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN commission_rate numeric NOT NULL DEFAULT 5
  CHECK (commission_rate >= 0 AND commission_rate <= 100);
ALTER TABLE saas_immobilier.agencies
  ADD COLUMN rental_commission_rate numeric NOT NULL DEFAULT 100
  CHECK (rental_commission_rate >= 0 AND rental_commission_rate <= 500);
ALTER TABLE saas_immobilier.properties
  ADD COLUMN commission_rate numeric NULL
  CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 100));
ALTER TABLE saas_immobilier.properties
  ADD COLUMN rental_commission_rate numeric NULL
  CHECK (rental_commission_rate IS NULL OR (rental_commission_rate >= 0 AND rental_commission_rate <= 500));

-- 2. Source des lignes de CA + anti-doublon -----------------------------------
ALTER TABLE saas_immobilier.revenue_operations
  ADD COLUMN source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'auto'));
CREATE UNIQUE INDEX revenu_source_auto_uniq
  ON saas_immobilier.revenue_operations (property_id)
  WHERE source = 'auto' AND status <> 'cancelled';

-- 3. RLS : membres lecture seule ; admin plateforme complet --------------------
DROP POLICY IF EXISTS revenue_operations_insert_member ON saas_immobilier.revenue_operations;
DROP POLICY IF EXISTS revenue_operations_update_member ON saas_immobilier.revenue_operations;
DROP POLICY IF EXISTS revenue_operations_delete_admin ON saas_immobilier.revenue_operations;
CREATE POLICY revenue_operations_admin_all
  ON saas_immobilier.revenue_operations
  FOR ALL TO authenticated
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());
-- revenue_operations_select_member conservé telle quelle.

-- 4. Trigger de synchronisation du CA -----------------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.sync_property_revenue()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_rate numeric;
  v_commission numeric;
  v_type text;
BEGIN
  IF NEW.status IN ('sold', 'rented') THEN
    v_type := CASE WHEN NEW.status = 'sold' THEN 'sale' ELSE 'rental' END;

    -- Une ligne manuelle déjà enregistrée pour ce bien fait foi (aucun doublon).
    IF EXISTS (
      SELECT 1 FROM saas_immobilier.revenue_operations r
      WHERE r.property_id = NEW.id AND r.source = 'manual' AND r.status <> 'cancelled'
    ) THEN
      UPDATE saas_immobilier.revenue_operations
      SET status = 'cancelled', updated_at = now()
      WHERE property_id = NEW.id AND source = 'auto' AND status <> 'cancelled';
      RETURN NEW;
    END IF;

    -- Taux effectif : valeur du bien, sinon valeur de l'agence.
    SELECT CASE
             WHEN v_type = 'sale' THEN COALESCE(NEW.commission_rate, a.commission_rate)
             ELSE COALESCE(NEW.rental_commission_rate, a.rental_commission_rate)
           END
      INTO v_rate
      FROM saas_immobilier.agencies a
     WHERE a.id = NEW.agency_id;

    IF v_rate IS NULL THEN
      v_rate := CASE WHEN v_type = 'sale' THEN 5 ELSE 100 END;
    END IF;

    v_commission := round(coalesce(NEW.price, 0) * v_rate / 100, 2);

    INSERT INTO saas_immobilier.revenue_operations
      (agency_id, property_id, operation_type, amount, commission, operation_date,
       status, source, note, created_by)
    VALUES
      (NEW.agency_id, NEW.id, v_type, coalesce(NEW.price, 0), v_commission, CURRENT_DATE,
       'completed', 'auto',
       CASE WHEN v_type = 'sale'
            THEN 'Enregistré automatiquement (bien vendu)'
            ELSE 'Enregistré automatiquement (bien loué)' END,
       (SELECT auth.uid()))
    ON CONFLICT (property_id) WHERE source = 'auto' AND status <> 'cancelled'
    DO UPDATE SET agency_id = EXCLUDED.agency_id,
                  operation_type = EXCLUDED.operation_type,
                  amount = EXCLUDED.amount,
                  commission = EXCLUDED.commission,
                  status = 'completed',
                  updated_at = now();
  ELSE
    UPDATE saas_immobilier.revenue_operations
    SET status = 'cancelled', updated_at = now()
    WHERE property_id = NEW.id AND source = 'auto' AND status <> 'cancelled';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_sync_property_revenue
 AFTER INSERT OR UPDATE OF status, price, commission_rate, rental_commission_rate,
                          agency_id, transaction_type
 ON saas_immobilier.properties
 FOR EACH ROW
 EXECUTE FUNCTION saas_immobilier.sync_property_revenue();

-- 5. Historique des paiements d'abonnements -----------------------------------
CREATE TABLE IF NOT EXISTS saas_immobilier.subscription_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES saas_immobilier.agencies(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES saas_immobilier.agency_subscriptions(id) ON DELETE CASCADE,
  amount numeric NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'XOF',
  paid_at date NOT NULL DEFAULT CURRENT_DATE,
  period_start date NULL,
  period_end date NULL,
  method text NOT NULL DEFAULT 'manual',
  recorded_by uuid NULL,
  note text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_payments_paid_at_idx
  ON saas_immobilier.subscription_payments (paid_at);
ALTER TABLE saas_immobilier.subscription_payments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE policyname = 'subscription_payments_admin'
                   AND tablename = 'subscription_payments') THEN
    CREATE POLICY subscription_payments_admin
      ON saas_immobilier.subscription_payments
      FOR ALL TO authenticated
      USING (public.is_platform_admin())
      WITH CHECK (public.is_platform_admin());
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON saas_immobilier.subscription_payments TO authenticated;
GRANT ALL ON saas_immobilier.subscription_payments TO service_role;
REVOKE ALL ON saas_immobilier.subscription_payments FROM anon;

-- 6. Rétroactif — exécuté le 2026-10-20 : 0 ligne créée (aucun bien sold/rented).
WITH candidates AS (
  SELECT p.id, p.agency_id, p.status, p.price, p.commission_rate,
         p.rental_commission_rate, p.updated_at
  FROM saas_immobilier.properties p
  WHERE p.status IN ('sold', 'rented')
    AND p.price > 0
    AND NOT EXISTS (
      SELECT 1 FROM saas_immobilier.revenue_operations r
      WHERE r.property_id = p.id AND r.status <> 'cancelled'
    )
)
INSERT INTO saas_immobilier.revenue_operations
  (agency_id, property_id, operation_type, amount, commission, operation_date,
   status, source, note, created_by)
SELECT c.agency_id, c.id,
       CASE WHEN c.status = 'sold' THEN 'sale' ELSE 'rental' END,
       c.price,
       round(c.price * CASE
                        WHEN c.status = 'sold' THEN COALESCE(c.commission_rate, a.commission_rate)
                        ELSE COALESCE(c.rental_commission_rate, a.rental_commission_rate)
                      END / 100, 2),
       COALESCE(c.updated_at::date, CURRENT_DATE),
       'completed', 'auto',
       'Rétroactif — bien déjà ' || CASE WHEN c.status = 'sold' THEN 'vendu' ELSE 'loué' END,
       NULL
FROM candidates c
JOIN saas_immobilier.agencies a ON a.id = c.agency_id;
