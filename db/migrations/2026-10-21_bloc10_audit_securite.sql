-- =============================================================================
-- BLOC 10 — AUDITS : CORRECTIFS D'ISOLATION ET DE SÉCURITÉ
-- Projet Supabase : xbuuhfwobrafcbgtdgjx
-- Appliquée le 2026-10-21 via l'API (execute_query), requête par requête.
-- Rollback : db/rollback/2026-10-21_bloc10_audit_securite.sql
--
-- Deux failles d'isolation corrigées. Aucune donnée modifiée, aucune fonction
-- existante modifiée : uniquement des privilèges et une politique RLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- CORRECTIF 1 — saas_immobilier.invitation_attempts
--
-- État avant : RLS DÉSACTIVÉE (relrowsecurity = false, 0 politique) ET
-- SELECT/INSERT/UPDATE/DELETE accordés au rôle `authenticated`.
--
-- Conséquence : n'importe quel utilisateur connecté pouvait
--   • lire les `token_hash` et `ip_hash` de TOUS les liens d'invitation de la
--     plateforme (table de garde anti force brute),
--   • supprimer ces lignes, ce qui remettait les compteurs à zéro et annulait la
--     protection (5 tentatives / lien / heure, 20 tentatives / IP / heure),
--   • en insérer pour saturer un lien ou une IP et bloquer un tiers.
--
-- Les écritures légitimes passent exclusivement par
-- `public.register_invitation_attempt(p_token, p_ip)` : SECURITY DEFINER,
-- propriétaire `postgres`, et EXECUTE accordé à `service_role` SEULEMENT
-- (vérifié : anon = false, authenticated = false, service_role = true).
-- Elle est appelée par l'Edge Function `redeem-agency-invitation`.
-- Le navigateur n'a donc besoin d'AUCUN privilège direct sur la table.
--
-- ⚠️ Ne PAS utiliser FORCE ROW LEVEL SECURITY ici : elle soumet aussi le
-- propriétaire de la table. Comme la fonction est SECURITY DEFINER et
-- appartient à `postgres`, ses DELETE/INSERT internes seraient filtrés par la
-- RLS (il n'existe aucune politique INSERT) et le garde anti force brute
-- casserait. ENABLE seul suffit, les rôles applicatifs n'ayant plus de privilèges.
-- -----------------------------------------------------------------------------
REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON saas_immobilier.invitation_attempts FROM PUBLIC, anon, authenticated;

ALTER TABLE saas_immobilier.invitation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_immobilier.invitation_attempts NO FORCE ROW LEVEL SECURITY;

-- Lecture réservée à l'administration plateforme (audit des tentatives).
DROP POLICY IF EXISTS invitation_attempts_select_admin
  ON saas_immobilier.invitation_attempts;
CREATE POLICY invitation_attempts_select_admin
  ON saas_immobilier.invitation_attempts
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());


-- -----------------------------------------------------------------------------
-- CORRECTIF 2 — storage.objects / politique payment_proofs_insert
--
-- État avant : WITH CHECK (bucket_id = 'payment-proofs')
-- Le chemin n'était PAS contrôlé : tout utilisateur authentifié pouvait déposer
-- une capture dans `payment-proofs/<uuid_d_une_autre_agence>/…`, donc polluer ou
-- tenter de substituer une preuve de paiement appartenant à une autre agence.
--
-- État après : aligné sur la politique de lecture existante
-- `payment_proofs_owner_select`, qui s'appuie déjà sur
-- `public.storage_agency_id(name)` (premier dossier = UUID de l'agence).
-- Le format écrit par le front (src/lib/payments-api.ts) est
-- `<agency_id>/<uuid>-<nom>` : inchangé, aucune adaptation client nécessaire.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS payment_proofs_insert ON storage.objects;
CREATE POLICY payment_proofs_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'payment-proofs'
    AND (
      public.is_platform_admin()
      OR public.is_agency_member(public.storage_agency_id(name))
    )
  );


-- -----------------------------------------------------------------------------
-- VÉRIFICATIONS (valeurs attendues après application)
-- -----------------------------------------------------------------------------
-- relrowsecurity = true, relforcerowsecurity = false
SELECT c.relrowsecurity, c.relforcerowsecurity,
       has_table_privilege('authenticated','saas_immobilier.invitation_attempts','SELECT') AS auth_select,
       has_table_privilege('anon','saas_immobilier.invitation_attempts','SELECT')          AS anon_select,
       has_table_privilege('postgres','saas_immobilier.invitation_attempts','INSERT')      AS owner_insert
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'saas_immobilier' AND c.relname = 'invitation_attempts';
-- attendu : true | false | false | false | true

-- with_check = ((bucket_id = 'payment-proofs') AND (is_platform_admin()
--               OR is_agency_member(storage_agency_id(name))))
SELECT policyname, cmd, roles::text, with_check
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
   AND policyname = 'payment_proofs_insert';
