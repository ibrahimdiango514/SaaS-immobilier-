# Point 4 — Équipe : tests manuels dans le navigateur

Prévisualisation : **https://3000-<sandbox>.e2b.app** (port 3000)

Ces tests sont à faire par vous : mon environnement ne peut pas appeler les Edge
Functions (`SSL_ERROR_SYSCALL` sur `*.supabase.co`, filtrage d'egress du bac à
sable). Tout ce qui passe par `create-agency-member`, `invite-agency-member` ou
`redeem-agency-invitation` n'a donc été validé par moi **qu'au niveau de la base**.

Comptes de test disponibles :

| compte | rôle | agence |
|---|---|---|
| `ibrahimdiango514@gmail.com` | propriétaire | Diango agengy (Essentiel, 3 places, 1 membre) |
| `babergang009@gmail.com` | propriétaire | SBC AI Agency Demo (Essentiel) |
| `agence.desactivee.test@example.com` | propriétaire | Agence Test Suspendue |

---

## T1 — La page Équipe s'ouvre et affiche le compteur

1. Connectez-vous en `ibrahimdiango514@gmail.com`.
2. Dans la barre latérale, cliquez sur **Équipe**.
3. **Attendu** : URL `/equipe`. Carte « Places utilisées » affichant **`1/3 utilisateurs`**, barre de progression, et le texte « 2 place(s) encore disponible(s). Les invitations en attente sont comptées. »

> Si le compteur affiche `0/3`, la fonction `agency_seat_availability` n'est pas
> atteignable : ouvrez la console navigateur et notez l'erreur réseau.

## T2 — Création directe d'un agent

1. Section **Créer un accès directement** : nom `Agent Test`, e-mail `agent.test.01@example.com`, rôle **Agent**.
2. Cliquez **Créer l'accès**.
3. **Attendu** : encart vert « Identifiants à transmettre » avec l'e-mail et un **mot de passe temporaire de 12 caractères**, deux boutons « copier », et le texte « Ce mot de passe ne sera plus affiché. »
4. **Attendu** : le compteur passe à **`2/3 utilisateurs`** et le nouveau membre apparaît dans la liste avec le rôle **Agent** et l'état **Actif**.
5. Rechargez la page.
6. **Attendu** : le mot de passe temporaire a **disparu** (il n'est jamais renvoyé).

**Notez le mot de passe temporaire : T4 en a besoin.**

## T3 — Bouton « copier »

1. Cliquez sur l'icône de copie à côté du mot de passe temporaire.
2. **Attendu** : l'icône devient une coche et le message « Copié dans le presse-papiers. » apparaît ~2,5 s.
3. Collez dans un champ texte. **Attendu** : le mot de passe exact.

## T4 — Connexion de l'agent créé et changement de mot de passe obligatoire

1. Déconnectez-vous, puis connectez-vous avec `agent.test.01@example.com` et le mot de passe temporaire noté en T2.
2. **Attendu** : vous **n'arrivez pas** sur le tableau de bord. Un écran plein « **Changer le mot de passe temporaire** » s'affiche, avec la mention « Étape obligatoire ».
3. Essayez d'aller directement sur `/dashboard` dans la barre d'adresse.
4. **Attendu** : l'écran de changement de mot de passe **reste** affiché — aucune page métier n'est accessible.
5. Saisissez un mot de passe de 6 caractères.
6. **Attendu** : « Le mot de passe doit contenir au moins 8 caractères. » et le bouton reste désactivé.
7. Saisissez deux mots de passe différents.
8. **Attendu** : « Les deux mots de passe ne correspondent pas. »
9. Saisissez deux fois `NouveauPass2026` et validez.
10. **Attendu** : l'espace de travail s'ouvre normalement.
11. Déconnectez-vous puis reconnectez-vous avec `NouveauPass2026`.
12. **Attendu** : connexion directe au tableau de bord, **sans** l'écran obligatoire (le drapeau `must_change_password` est levé).

## T5 — Masquage des pages réservées

1. Toujours connecté en tant qu'agent (`agent.test.01@example.com`).
2. Regardez la barre latérale.
3. **Attendu** : l'entrée **Équipe** est **absente**.
4. Tapez `/equipe` directement dans la barre d'adresse.
5. **Attendu** : pas de gestion possible — le message « La gestion de l'équipe est réservée au propriétaire et aux administrateurs de l'agence. » s'affiche.

> Le masquage de **Mon offre**, **Paiements** et **CA** n'est pas testable : ces
> pages relèvent du point 2, qui n'est pas encore construit.

## T6 — Désactivation puis réactivation (libération de la place)

1. Reconnectez-vous en propriétaire (`ibrahimdiango514@gmail.com`) → **Équipe**.
2. **Attendu** : compteur **`2/3 utilisateurs`**.
3. Sur la ligne de l'agent, cliquez sur l'icône **Désactiver** (silhouette barrée).
4. **Attendu** : l'état passe à **Désactivé**, le message « Accès désactivé : la place est libérée. » s'affiche, et le compteur redescend à **`1/3 utilisateurs`**.
5. Recliquez sur la même icône.
6. **Attendu** : état **Actif**, compteur de retour à **`2/3 utilisateurs`**.
7. Sur **votre propre** ligne, survolez l'icône.
8. **Attendu** : infobulle « Vous ne pouvez pas désactiver votre propre accès », bouton désactivé.
9. Repérez la ligne du **propriétaire**.
10. **Attendu** : aucune icône de désactivation — un cadenas doré la remplace.

## T7 — Lien d'invitation, copie et WhatsApp

1. Section **Lien d'invitation** : rôle **Agent**, puis **Générer le lien**.
2. **Attendu** : encart « Lien à partager » avec une URL de la forme `…/rejoindre?token=…`, un bouton copier, la date d'expiration (48 h), et un bouton **Ouvrir dans WhatsApp**.
3. Cliquez **Ouvrir dans WhatsApp**.
4. **Attendu** : WhatsApp s'ouvre avec un message pré-rempli en français contenant le lien, la mention « valable 48 heures », « ne fonctionne qu'une seule fois » et le nom de l'agence.
5. Rechargez la page. **Attendu** : le lien a **disparu**.
6. **Attendu** : le compteur n'a **pas** augmenté, mais la carte affiche « 1 invitation(s) en attente, déjà décomptée(s). »

## T8 — Page publique : jeton valide

1. Copiez le lien généré en T7.
2. Ouvrez-le dans une **fenêtre de navigation privée** (aucune session).
3. **Attendu** : page « Créer votre accès » avec Nom complet, E-mail, Mot de passe, Confirmer. **Aucun** champ ni texte ne révèle quelle agence vous attend.
4. Saisissez `Invité Test`, `invite.test.01@example.com`, un mot de passe de 5 caractères.
5. **Attendu** : « Le mot de passe doit contenir au moins 8 caractères. », bouton désactivé.
6. Saisissez `InvitePass2026` deux fois et validez.
7. **Attendu** : écran « Compte créé — Bienvenue chez **Diango agengy** » avec un bouton **Se connecter**. Le nom de l'agence n'apparaît **qu'à ce moment**.
8. Cliquez **Se connecter** et authentifiez-vous avec ces identifiants.
9. **Attendu** : accès à l'espace de travail de l'agence.

## T9 — Jeton déjà utilisé : message générique

1. Reprenez **le même lien** qu'en T7, dans la même fenêtre privée.
2. Saisissez n'importe quel nom, e-mail et mot de passe valides, puis validez.
3. **Attendu** : « Ce lien d'invitation n'est pas valide ou n'est plus utilisable. Demandez un nouveau lien. »
4. **Attendu — point de sécurité** : le message est **identique** à celui d'un jeton inventé (T10). Rien ne distingue « déjà utilisé », « expiré », « révoqué » ou « inexistant », et **aucun nom d'agence** ne fuit.

## T10 — Jeton inventé

1. Ouvrez `https://<preview>/rejoindre?token=ceci-n-est-pas-un-vrai-jeton`.
2. Saisissez des valeurs valides et validez.
3. **Attendu** : exactement le même message qu'en T9.

## T11 — Jeton expiré

Ce test demande d'attendre 48 h, ou de raccourcir l'expiration en base. Si vous
préférez la seconde option, dites-le moi et je vous donnerai la requête SQL
(`UPDATE … SET expires_at = now() - interval '1 hour'`) — je ne l'exécuterai pas
sans votre accord.

**Attendu** : toujours le même message générique qu'en T9 et T10.

## T12 — Limitation des tentatives

1. Sur la page publique, enchaînez **6 validations** avec le **même** jeton invalide.
2. **Attendu** : à la 6ᵉ tentative, « Trop de tentatives. Réessayez dans une heure. » (HTTP 429).
3. J'ai vérifié ce seuil en base : tentatives 1 à 5 autorisées, 6 et 7 refusées avec `too_many_attempts_for_this_link`.

## T13 — Refus du 4ᵉ utilisateur sur Essentiel

1. En propriétaire, créez des accès jusqu'à remplir les **3 places** de l'offre Essentiel.
2. **Attendu** : le compteur affiche `3/3 utilisateurs`, le bouton **Créer l'accès** est désactivé et le texte « Limite d'utilisateurs atteinte. » s'affiche.
3. **Attendu** : le bouton **Générer le lien** est également désactivé — les invitations en attente sont comptées comme des places prises.
4. Désactivez un agent.
5. **Attendu** : les boutons redeviennent actifs, compteur `2/3`.

## T14 — Un agent ne peut pas agir sur une autre agence

1. Connectez-vous en tant qu'agent.
2. **Attendu** : l'entrée **Équipe** est absente (T5) et `/equipe` renvoie le message de refus.
3. **Vérification côté serveur** : même en forgeant une requête avec un autre `agency_id`, `has_agency_role` est évalué sur le JWT de l'appelant et non sur le corps de la requête — le serveur renvoie `agency_admin_or_owner_required` (403). Ce chemin n'est pas testable depuis le navigateur.

---

## Ce qui n'est pas couvert par ces tests

- **Nouveau mot de passe temporaire pour un membre existant** : **non implémenté**. Cela exige une nouvelle Edge Function (`admin.updateUserById` nécessite la clé `service_role`, inutilisable depuis le navigateur). Je ne la déploierai pas sans votre accord.
- **Mon offre, paiements, CA** : masquage non testable, pages inexistantes (point 2).
- **Agence suspendue** : le blocage d'un agent d'agence suspendue repose sur `agence_active()` et le garde-fou existant `useAccountBlockGuard`, inchangés dans ce lot.
