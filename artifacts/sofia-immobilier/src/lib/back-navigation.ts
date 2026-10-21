/**
 * BLOC 9 — Navigation « retour » déterministe.
 *
 * Le bug : le bouton retour n'existait que dans la barre supérieure (masquée
 * sous 760 px), et l'espace admin n'avait aucun en-tête mobile. Résultat : sur
 * téléphone et dans les previews, aucune flèche de retour.
 *
 * Ce module centralise :
 *  1. la carte route → page parente (repli fiable quand il n'y a pas
 *     d'historique, ou quand l'historique vient d'un autre site) ;
 *  2. un journal des navigations internes, pour n'utiliser `history.back()`
 *     QUE si la page précédente fait bien partie de l'application.
 *
 * `history.back()` seul est dangereux : sur une preview intégrée ou après un
 * rafraîchissement, il peut faire quitter l'application.
 */

/** Chemin racine de chaque espace. */
export const AGENCY_HOME = '/dashboard';
export const ADMIN_HOME = '/admin';

/** Journal des chemins visités dans l'application (le plus récent en dernier). */
const internalHistory: string[] = [];

/**
 * Enregistre un changement de route interne. À appeler depuis un `useEffect`
 * sur `useLocation()` dans chaque shell.
 */
export function trackRoute(path: string): void {
  const last = internalHistory[internalHistory.length - 1];
  if (last === path) return;
  internalHistory.push(path);
  if (internalHistory.length > 30) internalHistory.shift();
}

/** Chemin visité juste avant `path`, s'il existe et s'il est différent. */
export function previousInternalRoute(path: string): string | undefined {
  for (let i = internalHistory.length - 2; i >= 0; i -= 1) {
    const candidate = internalHistory[i];
    if (candidate && candidate !== path) return candidate;
  }
  return undefined;
}

/** Vrai si un `history.back()` reste dans l'application. */
export function canUseNativeBack(path: string): boolean {
  // Il faut au moins une navigation interne enregistrée, et une pile native.
  return previousInternalRoute(path) !== undefined && typeof window !== 'undefined' && window.history.length > 1;
}

/** Supprime le journal (changement d'espace ou de session). */
export function resetRouteTracking(): void {
  internalHistory.length = 0;
}

/**
 * Page parente d'un chemin.
 * `space` indique l'espace courant pour `/profil` et les pages publiques.
 */
export function parentRouteFor(path: string, space: 'admin' | 'agency' = 'agency'): string {
  if (!path || path === '/') return space === 'admin' ? ADMIN_HOME : AGENCY_HOME;

  // --- Espace admin -------------------------------------------------------
  if (path === ADMIN_HOME) return AGENCY_HOME; // retour à l'espace agence
  if (path.startsWith(`${ADMIN_HOME}/`)) return ADMIN_HOME;

  // --- Détails : on remonte à la liste ------------------------------------
  const detail = path.match(/^\/(biens|contacts)\/[^/]+/);
  if (detail) return `/${detail[1]}`;

  // --- Profil : dépend de l'espace ----------------------------------------
  if (path === '/profil') return space === 'admin' ? ADMIN_HOME : AGENCY_HOME;

  // --- Pages publiques ----------------------------------------------------
  if (path === '/inscription') return '/login';
  if (path === '/login') return '/';
  if (path === '/rejoindre') return '/login';
  if (path === '/onboarding') return AGENCY_HOME;
  if (path === '/mot-de-passe') return '/login';

  // --- Toute autre page de l'espace agence ---------------------------------
  return AGENCY_HOME;
}

/** Libellé lisible de la destination de retour. */
export function backLabelFor(path: string, space: 'admin' | 'agency' = 'agency'): string {
  const parent = parentRouteFor(path, space);
  if (parent === ADMIN_HOME) return 'Retour à la vue d’ensemble administration';
  if (parent === AGENCY_HOME) return 'Retour à la vue d’ensemble';
  if (parent === '/biens') return 'Retour à la liste des biens';
  if (parent === '/contacts') return 'Retour à la liste des contacts';
  if (parent === '/login') return 'Retour à la connexion';
  if (parent === '/') return 'Retour à l’accueil';
  return 'Retour';
}
