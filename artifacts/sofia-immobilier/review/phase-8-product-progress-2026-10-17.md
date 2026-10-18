# Phase 8 — état fonctionnel et priorités produit

**Périmètre :** inspection du code local et premier lot local uniquement. Aucune connexion à Supabase, requête distante, modification de données, exécution SQL, changement de schéma, RLS, permission, Auth ou Storage n’a été effectué.

## Fonctions visibles dans le code

| Domaine | État constaté dans le code | Limites / vérification restante |
|---|---|---|
| Biens | Liste avec recherche et filtres, création/modification, détail et galerie média. Suppression limitée dans l’interface aux rôles `owner`/`admin`. | L’interface ne prouve pas le schéma ni les droits distants. La suppression dépend du RPC localement typé `delete_property_if_no_media`, dont l’existence et les permissions n’ont pas été confirmées. |
| Contacts | Liste, recherche, filtre de statut, création/modification, fiche et historique fondé sur les opportunités associées. | Pas de suppression visible; les données et permissions distantes ne sont pas vérifiées. |
| Pipeline | Création/modification, recherche et association contact–bien. Le formulaire existant porte `date_visite`. | Pas de suppression ni de catalogue d’étapes contrôlé visible. Le résultat gagné/perdu d’une opportunité n’est pas modélisé. |
| Visites | **Premier lot livré :** agenda calculé à partir des `sales_pipeline.date_visite` déjà utilisées par le pipeline; filtres toutes/à venir/passées, recherche, compteurs, liste des opportunités sans date, liens vers les fiches, et modification de date via le formulaire de pipeline existant. | C’est une date sans horaire ni état de visite dédié, pas un calendrier de rendez-vous complet. Aucun objet ou table supplémentaire n’a été supposé. |
| Tâches / rappels | Aucun type, hook ou modèle correspondant repéré dans les fichiers applicatifs inspectés. | Bloqué tant que le modèle métier, la table, les règles d’accès et les capacités de persistance ne sont pas confirmés. Aucune donnée locale fictive ou tâche uniquement navigateur n’a été créée. |
| Dashboard / statistiques | Comptes de biens, contacts, membres et opportunités, répartition par étape et ajouts récents. | Le taux de conversion reste « Non calculable » : aucune issue gagnée/perdue par opportunité. Le statut vendu/loué d’un bien ne permet pas d’attribuer une conversion à un contact. |
| Autres modules | WhatsApp, Assistant IA et Automatisations restent des placeholders; notifications également indiquées comme bientôt disponibles. | Hors du premier lot. |

## Ordre de priorité proposé

1. **Biens** — socle de l’inventaire et référence des dossiers; confirmer les dépendances distantes avant d’élargir les opérations sensibles, notamment la suppression.
2. **Contacts** — fiabiliser les fiches et leur rattachement aux opportunités; l’écran CRUD existe déjà, mais aucune suppression n’est proposée.
3. **Pipeline** — consolider les étapes et le suivi des dossiers, qui relient déjà les contacts aux biens et portent la date de visite.
4. **Visites** — rendre immédiatement utile la date déjà présente sans inventer de schéma : agenda dérivé livré dans ce lot.
5. **Tâches et rappels** — définir d’abord un modèle et ses accès; ne pas créer de table ou de persistance supposée.
6. **Statistiques du dashboard** — les comptes sont déjà présents; ne calculer une conversion qu’après ajout/confirmation d’un résultat d’opportunité fiable.

## Détails du lot Visites

- Réutilise `usePipeline`, `useContacts`, `useProperties` et le formulaire `PipelineDialog`; aucune nouvelle requête ni mutation de schéma n’a été ajoutée.
- Les données restent demandées avec l’agence active via les hooks existants; les erreurs de lecture et d’écriture continuent de passer par les états d’erreur existants. Les contrôles d’accès serveur restent indispensables et n’ont pas été modifiés.
- Le rendu distingue aujourd’hui, à venir et passé, trie les prochaines visites d’abord, et signale les dates illisibles. Les dossiers sans date peuvent être ouverts dans le formulaire existant pour être planifiés.
- Aucun horaire, rappel automatique ou état « effectué/annulé » n’est simulé.

## Vérifications locales du lot

- `pnpm --filter @workspace/sofia-immobilier test` — 13/13 tests réussis (utilitaires média préexistants et utilitaires de date ajoutés).
- `pnpm --filter @workspace/sofia-immobilier typecheck` — réussi.
- `PORT=4173 BASE_PATH=/ pnpm --filter @workspace/sofia-immobilier build` — réussi. Avertissements Vite préexistants de sourcemap (`tooltip.tsx`, `label.tsx`) et de chunk JavaScript supérieur à 500 kB; aucune régression bloquante.
- Le premier appel build sans variables a été arrêté par la configuration Vite qui exige `PORT` et `BASE_PATH`; le build relancé avec ces variables a réussi.
- Aucun test d’intégration avec les données réelles et aucun accès Supabase n’ont été réalisés.
