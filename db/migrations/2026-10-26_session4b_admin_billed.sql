-- =============================================================================
-- APPLIQUEE EN BASE le 2026-10-26 (voir docs/JOURNAL-APPLICATION-2026-10-26_session4b.md)
-- Session 4b : chaque validation ou changement d'offre par l'admin produit un
--              paiement, dans la meme transaction.
-- Date : 2026-10-26
-- Branche : arena/258827d7-saas-immobilier (cddc257)
--
-- REGLE METIER VISE : une action admin qui valide une agence ou change son
-- offre vaut un paiement recu. Ecriture dans subscription_payments, portant
-- plan_id, une reference generee, la date, et une source admin_validation.
-- Idempotent sur la reference.
--
-- PRINCIPE DIRECTEUR : admin_assign_plan n'est PAS modifiee. On ajoute des
-- enveloppes qui l'appellent, puis on redirige les appelants. Le changement
-- d'offre et l'ecriture du paiement vivent dans la meme transaction plpgsql :
-- si l'un echoue, l'autre est annule automatiquement.
--
-- Aucune RLS n'est touchee. Aucune fonction existante n'est modifiee dans ce
-- fichier : les redirections sont proposees separement, en section 4, et
-- commentees.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. public.admin_change_agency_plan_billed
-- -----------------------------------------------------------------------------
-- Enveloppe autour de public.admin_assign_plan (inchangee).
--   1. lit l'offre courante AVANT que admin_assign_plan ne la reecrive ;
--   2. delegue le changement d'offre a admin_assign_plan ;
--   3. calcule le montant du selon le mode retenu ;
--   4. ecrit le paiement via admin_bill_subscription.
--
-- p_amount_mode :
--   'difference' (defaut, decision A proposee) = prix nouvelle offre - prix
--      offre courante, jamais negatif ;
--   'full' = prix complet de la nouvelle offre.
-- Le mode est un parametre pour que la decision A se tranche sans reecrire le
-- corps de la fonction : seul le DEFAULT change.
--
-- Ne facture rien et ne touche a rien si l'offre demandee est identique a
-- l'offre courante, ou si le montant du est nul (descente d'offre en mode
-- difference).
CREATE OR REPLACE FUNCTION public.admin_change_agency_plan_billed(
  p_agency_id   uuid,
  p_plan_id     uuid,
  p_amount_mode text DEFAULT 'difference',
  p_paid_on     date DEFAULT CURRENT_DATE,
  p_reference   text DEFAULT NULL,
  p_note        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_old_plan_id uuid;
  v_old_price   numeric := 0;
  v_new_plan    record;
  v_amount      numeric;
  v_ref         text;
  v_assignment  jsonb;
  v_payment     jsonb := NULL;
  v_mode        text;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  v_mode := lower(COALESCE(NULLIF(btrim(p_amount_mode), ''), 'difference'));
  IF v_mode NOT IN ('difference', 'full') THEN
    RAISE EXCEPTION 'mode de facturation invalide : %', v_mode USING ERRCODE = '22023';
  END IF;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.currency
    INTO v_new_plan
    FROM saas_immobilier.plans pl
   WHERE pl.id = p_plan_id;
  IF v_new_plan.id IS NULL THEN
    RAISE EXCEPTION 'offre introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- Offre courante, lue avant toute ecriture.
  SELECT s.plan_id, COALESCE(pl.price_monthly, 0)
    INTO v_old_plan_id, v_old_price
    FROM saas_immobilier.agency_subscriptions s
    LEFT JOIN saas_immobilier.plans pl ON pl.id = s.plan_id
   WHERE s.agency_id = p_agency_id
   ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'trial' THEN 1
                          WHEN 'past_due' THEN 2 ELSE 3 END,
            s.created_at DESC
   LIMIT 1;

  -- Offre identique : rien a faire, rien a facturer.
  IF v_old_plan_id IS NOT DISTINCT FROM p_plan_id THEN
    RETURN jsonb_build_object(
      'agency_id', p_agency_id,
      'assignment', NULL,
      'payment', NULL,
      'reason', 'offre inchangee'
    );
  END IF;

  -- 1. Changement d'offre par le chemin existant, NON modifie.
  v_assignment := public.admin_assign_plan(
                    p_agency_id, p_plan_id, 'active',
                    COALESCE(p_note, 'changement direct par administrateur'));

  -- 2. Montant du.
  v_amount := CASE
                WHEN v_mode = 'full' THEN v_new_plan.price_monthly
                ELSE GREATEST(v_new_plan.price_monthly - COALESCE(v_old_price, 0), 0)
              END;

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object(
      'agency_id', p_agency_id,
      'assignment', v_assignment,
      'payment', NULL,
      'reason', 'aucun montant du'
    );
  END IF;

  -- 3. Reference generee. Le suffixe d'offre n'est pas decoratif : sans lui,
  --    deux operations reelles le meme jour sur la meme agence (activation
  --    puis montee d'offre) produiraient la meme reference, et la seconde
  --    serait avalee par l'idempotence au lieu d'etre facturee.
  v_ref := COALESCE(
             NULLIF(btrim(p_reference), ''),
             'ADMIN-DEMO-'
             || to_char(COALESCE(p_paid_on, CURRENT_DATE), 'YYYYMMDD')
             || '-' || left(replace(p_agency_id::text, '-', ''), 8)
             || '-' || upper(v_new_plan.name));

  -- 4. Ecriture du paiement, meme transaction.
  v_payment := public.admin_bill_subscription(
                 p_agency_id, p_plan_id, v_amount,
                 COALESCE(p_paid_on, CURRENT_DATE),
                 'admin_validation', v_ref,
                 COALESCE(p_note,
                          'Demonstration : changement d offre facture par validation administrateur'));

  RETURN jsonb_build_object(
    'agency_id', p_agency_id,
    'assignment', v_assignment,
    'payment', v_payment,
    'reason', 'facture',
    'amount_mode', v_mode,
    'amount', v_amount,
    'reference', v_ref
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_change_agency_plan_billed(uuid, uuid, text, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_change_agency_plan_billed(uuid, uuid, text, date, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_change_agency_plan_billed(uuid, uuid, text, date, text, text) TO authenticated;


-- -----------------------------------------------------------------------------
-- 2. public.admin_activate_agency_and_bill
-- -----------------------------------------------------------------------------
-- Enveloppe autour de public.admin_activate_agency (inchangee).
-- Le montant n'est PAS fourni par l'appelant : il est lu dans le catalogue
-- cote base, pour que le front n'ait jamais a calculer un prix.
--
-- Le nom differe volontairement de admin_activate_agency_billed (deja creee,
-- 7 arguments, montant impose). Deux raisons :
--   * celle deja en place reste disponible pour les ecritures de rattrapage,
--     ou le montant est justement impose et non deductible du catalogue ;
--   * une surcharge du meme nom, avec un 3e argument tantot numeric tantot
--     date, preterait a confusion a l'appel.
CREATE OR REPLACE FUNCTION public.admin_activate_agency_and_bill(
  p_agency_id uuid,
  p_plan_id   uuid DEFAULT NULL,
  p_paid_on   date DEFAULT CURRENT_DATE,
  p_reference text DEFAULT NULL,
  p_note      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_activation jsonb;
  v_plan_id    uuid;
  v_plan       record;
  v_ref        text;
  v_payment    jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
  END IF;

  -- 1. Activation par le chemin existant, NON modifie. Il resout l'offre
  --    (pending_plan_id, puis abonnement existant, puis catalogue).
  v_activation := public.admin_activate_agency(p_agency_id, p_plan_id);
  v_plan_id    := (v_activation->>'plan_id')::uuid;

  SELECT pl.id, pl.name, pl.display_name, pl.price_monthly, pl.currency
    INTO v_plan
    FROM saas_immobilier.plans pl
   WHERE pl.id = v_plan_id;

  IF v_plan.id IS NULL OR v_plan.price_monthly IS NULL THEN
    RETURN jsonb_build_object(
      'activation', v_activation,
      'payment', NULL,
      'reason', 'offre sans prix au catalogue'
    );
  END IF;

  v_ref := COALESCE(
             NULLIF(btrim(p_reference), ''),
             'ADMIN-DEMO-'
             || to_char(COALESCE(p_paid_on, CURRENT_DATE), 'YYYYMMDD')
             || '-' || left(replace(p_agency_id::text, '-', ''), 8)
             || '-' || upper(v_plan.name));

  v_payment := public.admin_bill_subscription(
                 p_agency_id, v_plan_id, v_plan.price_monthly,
                 COALESCE(p_paid_on, CURRENT_DATE),
                 'admin_validation', v_ref,
                 COALESCE(p_note,
                          'Demonstration : activation facturee par validation administrateur'));

  RETURN jsonb_build_object(
    'activation', v_activation,
    'payment', v_payment,
    'amount', v_plan.price_monthly,
    'reference', v_ref
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_activate_agency_and_bill(uuid, uuid, date, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_activate_agency_and_bill(uuid, uuid, date, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_activate_agency_and_bill(uuid, uuid, date, text, text) TO authenticated;


-- -----------------------------------------------------------------------------
-- 3. Pourquoi admin_bill_subscription porte bien les 4 attributs demandes
-- -----------------------------------------------------------------------------
--   plan_id    : parametre p_plan_id, ecrit dans la colonne plan_id ;
--   reference  : parametre p_reference ; idempotence sur (agency_id, reference) ;
--   date       : p_paid_on -> paid_at et period_start ; period_end = +1 mois -1 j ;
--   source     : p_method = 'admin_validation'. La table n'a pas de colonne
--                "source" ; method est la colonne prevue, sans contrainte
--                CHECK (verifie : seules contraintes = cle primaire, 3 cles
--                etrangere, CHECK amount >= 0). Aucune migration necessaire.
--   demo       : le prefixe ADMIN-DEMO et la note "Demonstration : ..." rendent
--                chaque ecriture identifiable comme ecriture de demonstration.


-- =============================================================================
-- 4. REDIRECTIONS PROPOSEES - COMMENTEES, A ACTIVER SUR ACCORD
-- =============================================================================
-- Analyse de recursion, a lire avant d'appliquer quoi que ce soit.

-- 4.1 public.admin_activate_pending_agency  ->  redirection SURE
-- L'enveloppe and_bill appelle admin_activate_agency. Rediriger
-- admin_activate_pending_agency vers and_bill ne cree aucune boucle :
--   pending_agency -> and_bill -> activate_agency -> assign_plan
--
-- CREATE OR REPLACE FUNCTION public.admin_activate_pending_agency(p_agency_id uuid)
-- RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
-- SET search_path TO 'pg_catalog', 'public'
-- AS $fn$
-- DECLARE v_status text;
-- BEGIN
--   IF NOT public.is_platform_admin() THEN
--     RAISE EXCEPTION 'administrateur plateforme requis' USING ERRCODE = '42501';
--   END IF;
--   SELECT a.status INTO v_status FROM saas_immobilier.agencies a WHERE a.id = p_agency_id;
--   IF v_status IS NULL THEN RAISE EXCEPTION 'agence introuvable' USING ERRCODE = 'P0002'; END IF;
--   IF v_status <> 'pending' THEN
--     RAISE EXCEPTION 'cette agence n''est pas en attente de validation (statut : %)', v_status
--       USING ERRCODE = '22023';
--   END IF;
--   -- SEULE LIGNE MODIFIEE : admin_activate_agency -> admin_activate_agency_and_bill
--   RETURN public.admin_activate_agency_and_bill(p_agency_id, NULL, CURRENT_DATE, NULL,
--                                                'activation administrateur');
-- END
-- $fn$;

-- 4.2 public.admin_change_agency_plan  ->  redirection SURE
-- L'enveloppe billed appelle admin_assign_plan, PAS admin_change_agency_plan.
--   change_agency_plan -> change_agency_plan_billed -> assign_plan
--
-- CREATE OR REPLACE FUNCTION public.admin_change_agency_plan(p_agency_id uuid, p_plan_id uuid)
-- RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
-- SET search_path TO 'pg_catalog', 'public'
-- AS $fn$
-- BEGIN
--   PERFORM public.admin_change_agency_plan_billed(p_agency_id, p_plan_id, 'difference');
--   RETURN true;
-- END
-- $fn$;
--
-- Effet de bord voulu : admin_handle_plan_change appelle deja
-- admin_change_agency_plan. Il herite donc de la facturation SANS modification.
-- Aucune ligne de admin_handle_plan_change n'est a toucher.

-- 4.3 public.admin_activate_agency  ->  NE PAS REDIRIGER (recursion infinie)
-- admin_activate_agency_and_bill appelle admin_activate_agency. Si on
-- redirigeait admin_activate_agency vers and_bill, l'appel se rappellerait
-- lui-meme a l'infini.
-- admin_activate_agency reste donc la primitive interne, non appelee
-- directement par le front apres redirection du point 5.1.
-- Aucune modification de cette fonction n'est proposee.

-- 4.4 public.admin_assign_plan  ->  INCHANGEE
-- Conformement a la consigne. Aucune modification proposee.


-- =============================================================================
-- 5. RATTRAPAGE (decision B) - NE PAS EXECUTER SANS ACCORD ECRIT
-- =============================================================================
-- Aucune ecriture ici. Le bloc ci-dessous est le modele qui serait utilise,
-- agence par agence, apres accord. Les montants doivent etre RECALCULES au
-- moment de l'execution : l'etat a change le 2026-10-26 a 21:20 UTC.
--
-- Etat verifie le 2026-10-26 apres ce changement :
--   Immo Diango        : Essentiel (starter) 50 000, active, 0 paiement
--   SBC AI Agency Demo : Pro 100 000, active, 50 000 payes (Essentiel a l'origine)
--
-- Modele, pour une agence donnee :
--
-- SELECT public.admin_bill_subscription(
--   p_agency_id  => '<uuid agence>',
--   p_plan_id    => '<uuid de l offre effectivement due>',
--   p_amount     => <montant>,
--   p_paid_on    => '<date>',
--   p_method     => 'admin_validation',
--   p_reference  => 'ADMIN-DEMO-<AAAAMMJJ>-<agence8>-<OFFRE>',
--   p_note       => 'Demonstration : ecriture de rattrapage, accord explicite du <date>'
-- );
--
-- Points de vigilance avant de l'executer :
--   * admin_bill_subscription prolonge l'abonnement a paid_on + 1 mois, sans
--     jamais le raccourcir (GREATEST). Choisir p_paid_on de sorte que la fin
--     calculee ne depasse pas la fin actuelle, sinon la date de fin bouge ;
--     SBC finit le 2026-11-20 (p_paid_on 2026-10-21 donne 2026-11-20, sans
--     effet), Immo Diango finit le 2026-11-21 ;
--   * le montant de SBC depend de la decision A : en mode difference, 50 000
--     (Pro 100 000 - Essentiel 50 000 deja paye) ; en mode full, 100 000.
