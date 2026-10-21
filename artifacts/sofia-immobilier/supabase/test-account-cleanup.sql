-- =============================================================================
-- SUPPRESSION DU COMPTE DE TEST « AGENCE DÉSACTIVÉE »
-- À EXÉCUTER AVANT LA MISE EN PRODUCTION (SQL Editor Supabase, projet
-- xbuuhfwobrafcbgtdgjx). Aucun autre compte n'est touché.
--
-- Supprime, dans l'ordre : l'appartenance, l'agence de test, puis l'utilisateur
-- auth. Les opérations CA, photos et le journal de cette agence sont supprimés
-- en cascade ; les entrées du journal conservent agency_id = NULL.
-- =============================================================================

-- 1. Appartenance (membre propriétaire du compte de test)
DELETE FROM saas_immobilier.agency_members
WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'agence.desactivee.test@example.com');

-- 2. Abonnements, horaires, relances, contacts, biens... de l'agence de test
--    (supprimés en cascade avec l'agence : conversations, visites, pipeline,
--     property_media, photos Storage restent orphelines côté fichier uniquement
--     si des photos avaient été envoyées — impossible depuis un compte suspendu)
DELETE FROM saas_immobilier.agencies
WHERE slug = 'agence-test-suspendue';

-- 3. Profil applicatif
DELETE FROM saas_immobilier.user_profiles
WHERE id IN (SELECT id FROM auth.users WHERE email = 'agence.desactivee.test@example.com');

-- 4. Identité puis compte auth
DELETE FROM auth.identities
WHERE user_id IN (SELECT id FROM auth.users WHERE email = 'agence.desactivee.test@example.com');

DELETE FROM auth.users
WHERE email = 'agence.desactivee.test@example.com';

-- Vérification finale (doit renvoyer 0 ligne)
SELECT (SELECT count(*) FROM auth.users WHERE email = 'agence.desactivee.test@example.com')
     + (SELECT count(*) FROM saas_immobilier.agencies WHERE slug = 'agence-test-suspendue')
     AS reste, 0 AS attendu;
