-- =============================================================================
-- ROLLBACK — BLOC 10 audits sécurité
-- Annule db/migrations/2026-10-21_bloc10_audit_securite.sql
--
-- ⚠️ Ce rollback rétablit DEUX FAILLES d'isolation. Ne l'exécuter que si les
-- correctifs cassent un parcours (redeem d'invitation, dépôt de preuve de
-- paiement). Il est fourni pour conformité avec la règle « tout correctif
-- appliqué sans accord préalable doit être réversible ».
-- =============================================================================

-- --- Correctif 2 : politique d'INSERT du bucket payment-proofs ---------------
DROP POLICY IF EXISTS payment_proofs_insert ON storage.objects;
CREATE POLICY payment_proofs_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payment-proofs');

-- --- Correctif 1 : invitation_attempts --------------------------------------
DROP POLICY IF EXISTS invitation_attempts_select_admin
  ON saas_immobilier.invitation_attempts;

ALTER TABLE saas_immobilier.invitation_attempts DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON saas_immobilier.invitation_attempts TO authenticated;

-- NB : l'état d'origine accordait aussi ces privilèges à `authenticated` via un
-- GRANT par défaut ; `anon` n'avait aucun privilège enregistré sur la table et
-- reste sans privilège après ce rollback.
