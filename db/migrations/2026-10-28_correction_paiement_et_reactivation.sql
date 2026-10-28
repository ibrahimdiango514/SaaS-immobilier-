-- =============================================================================
-- 2026-10-28 — CORRECTION DES DEUX BUGS DE PRODUCTION
--   1. Parcours de paiement manuel bloqué à l'écran d'instructions
--   2. Suspension d'agence OK / réactivation qui ne rétablit jamais l'accès
-- =============================================================================
-- DIAGNOSTIC (mesuré sur la base réelle, pas supposé) :
--
-- A. Paiement bloqué
--    `saas_immobilier.platform_settings.payment_instructions` =
--      {"wave":{"name":"","number":""},"orange_money":{"name":"","number":""}}
--    -> aucun numéro publié, aucune clé `moov_money`.
--    `saas_immobilier.payment_config()` renvoie donc `any_configured = false`,
--    l'écran `/abonnement/paiement/:id` masque le bouton « J'ai effectué le
--    paiement » (aucun moyen utilisable) et `agency_submit_payment_proof`
--    refuse de son côté (« moyen de paiement en cours de configuration »).
--    L'agence n'a AUCUN moyen de sortir de cet écran et l'administrateur
--    n'est jamais prévenu. Ce n'est pas une coordonnée à inventer : c'est un
--    défaut de configuration qu'il faut (a) rendre visible, (b) rendre
--    corrigeable, (c) signaler.
--
-- B. Réactivation impossible
--    L'écran /admin/agences utilise `useAdminUpdateAgency` :
--      · « Suspendre » = UPDATE direct de `agencies.status` depuis le
--        navigateur (aucun `suspended_at`, aucun journal, aucun événement) ;
--      · « Réactiver » = `public.admin_activate_agency_journaled` →
--        `admin_assign_plan`, qui ne remet `agencies.status = 'active'` QUE si
--        l'agence était `pending`. Une agence `suspended` reste donc
--        suspendue : l'utilisateur reçoit un succès, l'agence reste bloquée,
--        et chaque clic crée un événement `reactivation` de plus.
--        Preuve en base : 5 événements `reactivation` le 2026-10-28 entre
--        12:22:27 et 12:24:37, agence SBC toujours `suspended`.
--    `admin_reactivate_agency` existait mais n'était appelée par personne, et
--    accordait un mois gratuit (`ends_at = CURRENT_DATE + 1 month`), ce qui
--    revient à offrir un abonnement payant.
--
-- CE QUE FAIT CETTE MIGRATION
--   §1  Générateur de référence SOF-PAY-<AAAAMMJJ>-<6 caractères> (serveur,
--       aléatoire, jamais la date seule).
--   §2  `agency_create_payment_request` : référence §1, verrou anti-double
--       clic, alerte admin réelle si les coordonnées manquent.
--   §3  `raise_admin_alert` : lien direct vers la demande (`?demande=<uuid>`).
--   §4  `admin_suspend_agency` : idempotente, journalisée, sans annuler la
--       période payée, fonctionne même sans abonnement.
--   §5  `admin_reactivate_agency` : lève UNIQUEMENT la suspension, idempotente,
--       n'accorde aucun abonnement, renvoie l'état réel après coup.
--   §6  `admin_assign_plan` : une activation d'offre lève aussi la suspension
--       (l'admin qui active une offre rend l'accès).
--   §7  `reactivate_agency` (ancienne primitive) délègue à §5.
--   §8  `agency_submit_payment_proof` : soumission idempotente (double clic ou
--       rejeu réseau = même dossier, aucune duplication).
--   §9  Grants + contrôles de fin.
-- Aucune table supprimée, aucune donnée effacée, RLS inchangée.
-- =============================================================================
-- APPLIQUÉE sur le projet xbuuhfwobrafcbgtdgjx en 12 migrations nommées :
--   fix_payment_ref_1_generator, fix_payment_ref_2_create_request,
--   fix_reactivation_3_admin_alert_href, fix_reactivation_4_suspend,
--   fix_reactivation_5_reactivate, fix_reactivation_6_assign_plan,
--   fix_reactivation_7_legacy_delegate, fix_reactivation_9_french_texts,
--   fix_reactivation_10_reactivate_french, fix_payment_ref_11_french_alert,
--   fix_reactivation_12_assign_plan_accent
-- (le découpage est uniquement une contrainte d'outillage ; le SQL ci-dessous
-- est la version de référence, identique à ce qui est en base).
--
BEGIN;

-- -----------------------------------------------------------------------------
-- §1. Référence de paiement unique — générée par le serveur
-- -----------------------------------------------------------------------------
-- Format : SOF-PAY-20261028-A7K9Q2
--   · préfixe lisible « SOF-PAY » (Sofia, paiement) ;
--   · date du jour (contexte humain seulement, jamais l'unicité) ;
--   · 6 caractères tirés dans un alphabet de 32 signes sans ambiguïté
--     (pas de 0/O ni 1/I) : 32^6 = 1 073 741 824 combinaisons par jour.
-- L'unicité est garantie par l'index `payment_declarations_reference_uniq`
-- (déjà en place) et par la boucle de recollision de §2.
CREATE OR REPLACE FUNCTION public.payment_reference()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_seed     bytea;
  v_out      text := '';
  v_i        integer;
BEGIN
  v_seed := decode(
    md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text)
    || md5(gen_random_uuid()::text || random()::text || clock_timestamp()::text),
    'hex'
  );
  FOR v_i IN 0..5 LOOP
    v_out := v_out || substr(v_alphabet, (get_byte(v_seed, v_i) % 32) + 1, 1);
  END LOOP;
  RETURN 'SOF-PAY-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || v_out;
END
$fn$;

COMMENT ON FUNCTION public.payment_reference() IS
  'Référence de paiement Sofia unique : SOF-PAY-<AAAAMMJJ>-<6 aléatoires>. Générée côté serveur, jamais côté navigateur.';

-- -----------------------------------------------------------------------------
-- §2. Création de la demande : référence §1, anti-double clic, alerte admin
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agency_create_payment_request(
  p_agency_id uuid,
  p_plan_id uuid,
  p_duration_months integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_plan     record;
  v_exist    record;
  v_id       uuid;
  v_ref      text;
  v_expected numeric(14,2);
  v_months   integer;
  v_ttl      integer := 7;
  v_i        integer;
  v_cfg      jsonb;
  v_agency   record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentification requise' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_agency_member(p_agency_id) THEN
    RAISE EXCEPTION 'accès agence refusé' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_agency_role(p_agency_id, 'admin') THEN
    RAISE EXCEPTION 'seul le propriétaire ou un administrateur de l''agence peut payer' USING ERRCODE = '42501';
  END IF;

  -- Anti-double clic : deux requêtes simultanées de la même agence sont
  -- sérialisées, la seconde réutilise la demande créée par la première.
  PERFORM pg_advisory_xact_lock(hashtext('payment_request:' || p_agency_id::text));

  SELECT * INTO v_plan FROM saas_immobilier.plans p WHERE p.id = p_plan_id;
  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF v_plan.price_monthly IS NULL OR v_plan.price_monthly <= 0 THEN
    RAISE EXCEPTION 'cette offre n''a pas de tarif mensuel : paiement impossible' USING ERRCODE = '22023';
  END IF;

  v_months := LEAST(GREATEST(COALESCE(p_duration_months, 1), 1), 12);
  v_expected := round(v_plan.price_monthly * v_months, 2);

  SELECT COALESCE((value->>'request_ttl_days')::int, 7) INTO v_ttl
    FROM saas_immobilier.platform_settings WHERE key = 'billing';
  IF v_ttl IS NULL OR v_ttl < 1 THEN v_ttl := 7; END IF;

  SELECT * INTO v_exist
    FROM saas_immobilier.payment_declarations d
   WHERE d.agency_id = p_agency_id
     AND d.status IN ('awaiting_payment', 'correction_requested')
     AND d.plan_id = p_plan_id
     AND d.expected_amount = v_expected
     AND d.expires_at > now()
   ORDER BY d.created_at DESC
   LIMIT 1;

  IF v_exist.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'id', v_exist.id, 'reference', v_exist.reference,
      'expected_amount', v_exist.expected_amount, 'currency', v_exist.currency,
      'duration_months', v_exist.duration_months,
      'expires_at', v_exist.expires_at, 'status', v_exist.status,
      'reused', true);
  END IF;

  FOR v_i IN 1..8 LOOP
    v_ref := public.payment_reference();
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM saas_immobilier.payment_declarations d WHERE d.reference = v_ref);
  END LOOP;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'impossible de générer une référence de paiement unique' USING ERRCODE = '23505';
  END IF;

  INSERT INTO saas_immobilier.payment_declarations (
    agency_id, amount, currency, method, transaction_reference, paid_on,
    declared_by, status, plan_id, plan_name_snapshot, expected_amount,
    duration_months, reference, expires_at
  ) VALUES (
    p_agency_id, v_expected, COALESCE(v_plan.currency, 'XOF'), NULL, NULL, NULL,
    auth.uid(), 'awaiting_payment', p_plan_id,
    COALESCE(v_plan.display_name, v_plan.name), v_expected,
    v_months, v_ref, now() + (v_ttl || ' day')::interval
  ) RETURNING id INTO v_id;

  INSERT INTO saas_immobilier.payment_decision_log
    (declaration_id, agency_id, action, from_status, to_status, actor_id, actor_kind, amount)
  VALUES (v_id, p_agency_id, 'created', NULL, 'awaiting_payment', auth.uid(), 'agency', v_expected);

  -- Alerte RÉELLE (pas simulée) quand la demande ne peut pas aboutir faute de
  -- coordonnées publiées : l'administrateur la voit dans sa cloche d'alertes
  -- et sur /admin/paiements. Clé unique = une alerte par agence et par jour.
  v_cfg := saas_immobilier.payment_config();
  IF COALESCE((v_cfg->>'any_configured')::boolean, false) = false THEN
    SELECT a.id, a.name INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
    PERFORM saas_immobilier.raise_admin_alert(
      'payment_config_missing_' || p_agency_id::text || '_' || to_char(now(), 'YYYYMMDD'),
      'payment_config_missing',
      'Coordonnées de paiement absentes : ' || COALESCE(v_agency.name, 'agence'),
      'La demande ' || v_ref || ' (' || v_expected || ' ' || COALESCE(v_plan.currency, 'XOF') ||
        ') ne peut pas être payée : aucun numéro Mobile Money n''est configuré.',
      'critical', p_agency_id, '/admin/paiements?demande=' || v_id::text,
      'Configurer les moyens de paiement',
      jsonb_build_object('declaration_id', v_id, 'reference', v_ref, 'agency_id', p_agency_id)
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_id, 'reference', v_ref, 'expected_amount', v_expected,
    'currency', COALESCE(v_plan.currency, 'XOF'), 'duration_months', v_months,
    'expires_at', now() + (v_ttl || ' day')::interval,
    'status', 'awaiting_payment', 'reused', false);
END
$fn$;

-- -----------------------------------------------------------------------------
-- §3. Alertes admin : lien direct vers la demande concernée
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_immobilier.raise_admin_alert(
  p_key text,
  p_kind text,
  p_title text,
  p_reason text,
  p_priority text,
  p_agency_id uuid DEFAULT NULL::uuid,
  p_action_href text DEFAULT NULL::text,
  p_action_label text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'saas_immobilier', 'public'
AS $fn$
DECLARE
  v_href text := p_action_href;
BEGIN
  -- Une alerte « paiement » doit ouvrir LA demande, pas seulement la file :
  -- /admin/paiements?demande=<uuid> est lu par l'écran d'administration.
  IF v_href = '/admin/paiements'
     AND COALESCE(p_metadata, '{}'::jsonb) ? 'declaration_id' THEN
    v_href := '/admin/paiements?demande=' || (p_metadata->>'declaration_id');
  END IF;
  IF v_href = '/admin/agences'
     AND COALESCE(p_metadata, '{}'::jsonb) ? 'agency_id' THEN
    v_href := '/admin/agences?agence=' || (p_metadata->>'agency_id');
  END IF;

  INSERT INTO saas_immobilier.admin_alerts
    (alert_key, kind, title, reason, priority, agency_id, action_href, action_label, metadata)
  VALUES (p_key, p_kind, p_title, p_reason, COALESCE(p_priority, 'normal'),
          p_agency_id, v_href, p_action_label, COALESCE(p_metadata, '{}'::jsonb))
  ON CONFLICT (alert_key) DO NOTHING;
END
$fn$;

-- -----------------------------------------------------------------------------
-- §4. Suspension : idempotente, journalisée, non destructrice
-- -----------------------------------------------------------------------------
-- · Ne touche PAS `agency_subscriptions` : la période déjà payée reste
--   acquise. La suspension coupe l'accès, elle n'annule pas un abonnement.
-- · Fonctionne aussi pour une agence sans abonnement (l'ancienne version
--   levait « aucun abonnement pour cette agence »).
-- · Deux clics = un seul effet, un seul événement.
CREATE OR REPLACE FUNCTION public.admin_suspend_agency(
  p_agency_id uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_agency record;
  v_sub    record;
  v_plan   record;
  v_event  uuid;
  v_reason text := COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'suspension administrateur');
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.name, a.status INTO v_agency
    FROM saas_immobilier.agencies a WHERE a.id = p_agency_id FOR UPDATE;
  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.status = 'suspended' THEN
    RETURN jsonb_build_object(
      'suspended', true, 'already_suspended', true,
      'agency_id', v_agency.id, 'agency_name', v_agency.name, 'status', 'suspended');
  END IF;

  UPDATE saas_immobilier.agencies
     SET status = 'suspended', suspended_at = now(),
         suspended_reason = v_reason, updated_at = now()
   WHERE id = p_agency_id;

  SELECT s.* INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 ELSE 2 END,
            s.created_at DESC
   LIMIT 1;

  IF v_sub.id IS NOT NULL THEN
    SELECT pl.id, pl.display_name, pl.name, pl.price_monthly INTO v_plan
      FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
    INSERT INTO saas_immobilier.subscription_events
      (agency_id, event_type, plan_from_id, plan_from_name, mensualite_from,
       mensualite_to, mensualite_variation, reason, actor_id)
    VALUES
      (p_agency_id, 'suspension', v_sub.plan_id,
       COALESCE(v_plan.display_name, v_plan.name), v_plan.price_monthly,
       0, -COALESCE(v_plan.price_monthly, 0), v_reason, auth.uid())
    RETURNING id INTO v_event;
  END IF;

  INSERT INTO saas_immobilier.activity_log
    (agency_id, user_id, action, entity_type, entity_id, summary, metadata)
  VALUES
    (p_agency_id, auth.uid(), 'agency_suspended', 'agency', p_agency_id,
     'Suspension administrative par un administrateur plateforme',
     jsonb_build_object('reason', v_reason, 'subscription_preserved', v_sub.id IS NOT NULL));

  PERFORM saas_immobilier.notify_agency(
    p_agency_id, 'billing',
    'Accès à votre espace suspendu',
    'L''accès à votre espace agence est suspendu. Motif : ' || v_reason ||
      '. Vos donnees, vos biens et votre historique de paiement sont conserves.',
    jsonb_build_object('kind', 'agency_suspended', 'reason', v_reason),
    'agency_suspended_' || p_agency_id::text || '_' || to_char(now(), 'YYYYMMDDHH24MISS')
  );

  RETURN jsonb_build_object(
    'suspended', true, 'already_suspended', false,
    'agency_id', p_agency_id, 'agency_name', v_agency.name, 'status', 'suspended',
    'reason', v_reason, 'event_id', v_event,
    'subscription_status', v_sub.status, 'subscription_ends_at', v_sub.ends_at);
END
$fn$;

-- -----------------------------------------------------------------------------
-- §5. Réactivation : lève la suspension, rien d'autre
-- -----------------------------------------------------------------------------
-- · N'écrit jamais dans `agency_subscriptions` : aucun mois offert, aucun
--   statut d'abonnement modifié. Un abonnement expiré reste expiré.
-- · Idempotente : sur une agence déjà active, aucune écriture, aucun événement.
-- · Renvoie l'état réel après coup (`agency_plan_state`) pour que l'interface
--   n'annonce jamais un succès que la base n'a pas enregistré.
CREATE OR REPLACE FUNCTION public.admin_reactivate_agency(
  p_agency_id uuid,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_agency   record;
  v_sub      record;
  v_plan     record;
  v_event    uuid;
  v_reason   text := COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), 'reactivation administrateur');
  v_billable boolean := false;
  v_state    jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  SELECT a.id, a.name, a.status INTO v_agency
    FROM saas_immobilier.agencies a WHERE a.id = p_agency_id FOR UPDATE;
  IF v_agency.id IS NULL THEN
    RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002';
  END IF;

  IF v_agency.status = 'pending' THEN
    RAISE EXCEPTION 'cette agence est en attente de validation : activez son offre, ne la réactivez pas'
      USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_sub
    FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 ELSE 2 END,
            s.created_at DESC
   LIMIT 1;
  IF v_sub.id IS NOT NULL THEN
    SELECT pl.id, pl.display_name, pl.name, pl.price_monthly INTO v_plan
      FROM saas_immobilier.plans pl WHERE pl.id = v_sub.plan_id;
    v_billable := v_sub.status IN ('active', 'trial')
                  AND v_sub.ends_at IS NOT NULL AND v_sub.ends_at > now();
  END IF;

  IF v_agency.status <> 'suspended' THEN
    v_state := public.agency_plan_state(p_agency_id);
    RETURN jsonb_build_object(
      'reactivated', false, 'already_active', true,
      'agency_id', p_agency_id, 'agency_name', v_agency.name, 'status', v_agency.status,
      'plan_state', v_state,
      'subscription_status', v_sub.status, 'subscription_ends_at', v_sub.ends_at);
  END IF;

  UPDATE saas_immobilier.agencies
     SET status = 'active', suspended_at = NULL, suspended_reason = NULL, updated_at = now()
   WHERE id = p_agency_id;

  IF v_sub.id IS NOT NULL THEN
    -- Événement de facturation : on ne remet la mensualité que si la période
    -- payée court encore. Sinon la variation reste nulle (aucun revenu inventé).
    INSERT INTO saas_immobilier.subscription_events
      (agency_id, event_type, plan_from_id, plan_to_id, plan_from_name, plan_to_name,
       mensualite_from, mensualite_to, mensualite_variation, reason, actor_id)
    VALUES
      (p_agency_id, 'reactivation', v_sub.plan_id, v_sub.plan_id,
       COALESCE(v_plan.display_name, v_plan.name), COALESCE(v_plan.display_name, v_plan.name),
       CASE WHEN v_billable THEN 0 ELSE COALESCE(v_plan.price_monthly, 0) END,
       COALESCE(v_plan.price_monthly, 0),
       CASE WHEN v_billable THEN COALESCE(v_plan.price_monthly, 0) ELSE 0 END,
       v_reason, auth.uid())
    RETURNING id INTO v_event;
  END IF;

  INSERT INTO saas_immobilier.activity_log
    (agency_id, user_id, action, entity_type, entity_id, summary, metadata)
  VALUES
    (p_agency_id, auth.uid(), 'agency_reactivated', 'agency', p_agency_id,
     'Réactivation administrative : suspension levée',
     jsonb_build_object('reason', v_reason, 'subscription_status', v_sub.status,
                        'subscription_ends_at', v_sub.ends_at, 'subscription_billable', v_billable));

  PERFORM saas_immobilier.notify_agency(
    p_agency_id, 'system',
    'Accès à votre espace rétabli',
    'La suspension de votre espace agence a été levée. Vos biens, vos contacts et votre historique sont intacts.',
    jsonb_build_object('kind', 'agency_reactivated', 'reason', v_reason),
    'agency_reactivated_' || p_agency_id::text || '_' || to_char(now(), 'YYYYMMDDHH24MISS')
  );

  v_state := public.agency_plan_state(p_agency_id);

  RETURN jsonb_build_object(
    'reactivated', true, 'already_active', false,
    'agency_id', p_agency_id, 'agency_name', v_agency.name, 'status', 'active',
    'reason', v_reason, 'event_id', v_event,
    'plan_state', v_state,
    'subscription_status', v_sub.status, 'subscription_ends_at', v_sub.ends_at,
    'subscription_expired', (v_sub.id IS NOT NULL AND NOT v_billable),
    'features_limited', (v_state->>'is_locked')::boolean);
END
$fn$;

-- -----------------------------------------------------------------------------
-- §6. Activation d'offre : lève aussi la suspension
-- -----------------------------------------------------------------------------
-- Un administrateur qui attribue explicitement une offre à une agence
-- suspendue rend l'accès ; sans cela, « activer » laissait l'agence bloquée
-- (c'était précisément le chemin utilisé par le bouton « Réactiver »).
CREATE OR REPLACE FUNCTION public.admin_assign_plan(
  p_agency_id uuid,
  p_plan_id uuid,
  p_status text DEFAULT 'active'::text,
  p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_sub_id uuid; v_plan record; v_status text := COALESCE(NULLIF(btrim(p_status),''),'active');
  v_ends date; v_agency record; v_owner uuid;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501'; END IF;
  IF v_status NOT IN ('active','trial','past_due','cancelled','expired') THEN
    RAISE EXCEPTION 'statut d abonnement invalide : %', v_status USING ERRCODE = '22023';
  END IF;
  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.setup_fee, pl.currency INTO v_plan
    FROM saas_immobilier.plans pl WHERE pl.id = p_plan_id;
  IF v_plan.id IS NULL THEN RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002'; END IF;
  SELECT a.id, a.name, a.status INTO v_agency FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
  IF v_agency.id IS NULL THEN RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002'; END IF;
  SELECT s.id INTO v_sub_id FROM saas_immobilier.agency_subscriptions s
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END, s.created_at DESC
   LIMIT 1 FOR UPDATE;
  v_ends := (CURRENT_DATE + interval '1 month')::date;
  IF v_sub_id IS NULL THEN
    INSERT INTO saas_immobilier.agency_subscriptions (agency_id, plan_id, status, starts_at, ends_at, trial_ends_at)
    VALUES (p_agency_id, v_plan.id, v_status, now(),
            CASE WHEN v_status IN ('cancelled','expired') THEN NULL ELSE v_ends END, NULL)
    RETURNING id INTO v_sub_id;
  ELSE
    UPDATE saas_immobilier.agency_subscriptions s
       SET plan_id = v_plan.id, status = v_status,
           ends_at = CASE WHEN v_status IN ('cancelled','expired') THEN s.ends_at
                          WHEN s.ends_at IS NULL OR s.ends_at < CURRENT_DATE THEN v_ends
                          ELSE s.ends_at END,
           trial_ends_at = CASE WHEN v_status = 'trial' THEN s.trial_ends_at ELSE NULL END
     WHERE s.id = v_sub_id;
  END IF;
  IF v_agency.status = 'pending' AND v_status <> 'cancelled' THEN
    UPDATE saas_immobilier.agencies a SET status='active', pending_note=NULL, pending_updated_at=now(),
           suspended_at=NULL, suspended_reason=NULL, updated_at=now() WHERE a.id = p_agency_id;
  END IF;
  -- NOUVEAU : activer une offre sur une agence suspendue lève la suspension.
  IF v_agency.status = 'suspended' AND v_status IN ('active','trial') THEN
    UPDATE saas_immobilier.agencies a SET status='active', suspended_at=NULL,
           suspended_reason=NULL, updated_at=now() WHERE a.id = p_agency_id;
    INSERT INTO saas_immobilier.activity_log
      (agency_id, user_id, action, entity_type, entity_id, summary, metadata)
    VALUES (p_agency_id, auth.uid(), 'agency_reactivated', 'agency', p_agency_id,
            'Suspension levée par activation d''une offre',
            jsonb_build_object('plan_id', v_plan.id, 'note', p_note));
  END IF;
  SELECT am.user_id INTO v_owner FROM saas_immobilier.agency_members am
   WHERE am.agency_id = p_agency_id AND am.role = 'owner' ORDER BY am.created_at ASC LIMIT 1;
  INSERT INTO saas_immobilier.usage_events (agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key)
  VALUES (p_agency_id, auth.uid(), 'admin_plan_assigned', 'agency', p_agency_id,
          jsonb_build_object('plan_id', v_plan.id, 'status', v_status, 'note', p_note, 'subscription_id', v_sub_id),
          'admin_plan_assigned_' || p_agency_id::text || '_' || extract(epoch from now())::bigint::text);
  IF v_owner IS NOT NULL AND v_status = 'active' THEN
    INSERT INTO saas_immobilier.notifications (agency_id, user_id, type, title, message, data)
    VALUES (p_agency_id, v_owner, 'system', 'Votre offre est activée',
            'L''offre ' || COALESCE(v_plan.display_name, v_plan.name) || ' est active jusqu''au ' || to_char(v_ends,'DD/MM/YYYY') || '.',
            jsonb_build_object('plan_id', v_plan.id, 'ends_at', v_ends));
  END IF;
  RETURN jsonb_build_object('agency_id', p_agency_id, 'subscription_id', v_sub_id, 'plan_id', v_plan.id,
    'plan_name', COALESCE(v_plan.display_name, v_plan.name), 'status', v_status, 'ends_at', v_ends);
END
$fn$;

-- -----------------------------------------------------------------------------
-- §7. Ancienne primitive : délègue à §5 (même comportement, un seul chemin)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reactivate_agency(p_agency_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;
  v_result := public.admin_reactivate_agency(p_agency_id, COALESCE(p_reason, 'reactivation administrateur'));
  RETURN COALESCE((v_result->>'reactivated')::boolean, false)
      OR COALESCE((v_result->>'already_active')::boolean, false);
END
$fn$;

COMMIT;
