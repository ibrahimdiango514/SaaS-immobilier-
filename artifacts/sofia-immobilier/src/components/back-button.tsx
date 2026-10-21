/**
 * BLOC 9 puis BLOC 11 (bug 5) — Bouton retour partagé.
 *
 * CAUSES RACINES DU BUG RESTANT, corrigées ici :
 *
 * 1. `window.history.back()` était encore utilisé dès qu'une route interne
 *    précédente existait. Dans une preview intégrée (iframe) l'historique est
 *    partagé avec la page hôte : `history.back()` peut donc remonter l'application
 *    HÔTE au lieu de la nôtre, ou ne rien faire du tout si l'iframe n'a qu'une
 *    seule entrée. Même chose sur un lien ouvert directement.
 *    → Plus AUCUN appel à l'historique du navigateur. La navigation passe
 *      exclusivement par wouter (`navigate`), donc elle reste toujours dans
 *      l'application, quel que soit le contexte.
 *
 * 2. Ordre de résolution : on préfère la route interne précédente (retour
 *    naturel, respecte la profondeur de navigation), sinon la page parente
 *    déterministe de la carte des routes (historique vide, lien direct).
 *
 * Cible tactile >= 44 x 44 px, `aria-label` et `title` explicites.
 */
import type { ComponentType } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useLocation } from 'wouter';
import {
  backLabelFor,
  parentRouteFor,
  previousInternalRoute,
} from '@/lib/back-navigation';

type BackButtonProps = {
  /** Espace courant : sert au repli de `/admin` et `/profil`. */
  space?: 'admin' | 'agency';
  /** Chemin courant, si différent de celui du routeur (pages publiques). */
  path?: string;
  /** Destination imposée (ignore la carte des parents et l'historique interne). */
  to?: string;
  /** Libellé accessible imposé. */
  label?: string;
  variant?: 'desktop' | 'mobile';
  className?: string;
  testId?: string;
  icon?: ComponentType<{ size?: number }>;
  /**
   * Force le masquage. Utilisé par l'espace admin : un administrateur plateforme
   * sans adhésion agence n'a PAS d'espace agence à rejoindre — `WorkspaceGate` le
   * renverrait immédiatement sur `/admin`, ce qui donnait un bouton retour
   * visuellement présent mais sans aucun effet.
   */
  hidden?: boolean;
};

export function BackButton({
  space = 'agency',
  path,
  to,
  label,
  variant = 'mobile',
  className,
  testId,
  icon: Icon = ChevronLeft,
  hidden = false,
}: BackButtonProps) {
  const [routePath, navigate] = useLocation();
  const current = path ?? routePath;
  const parent = parentRouteFor(current, space);
  const previous = previousInternalRoute(current);
  const target = to ?? previous ?? parent;

  // Rien à remonter : racine de l'espace, ou masquage explicite.
  if (hidden || current === target) return null;

  const handleBack = () => {
    navigate(target);
  };

  const accessibleLabel = label ?? backLabelFor(current, space);

  const classes = [
    'icon-button',
    'back-button',
    variant === 'desktop' ? 'topbar-back' : 'mobile-back',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      onClick={handleBack}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      data-testid={testId ?? 'button-back'}
    >
      <Icon size={16} />
    </button>
  );
}

export default BackButton;
