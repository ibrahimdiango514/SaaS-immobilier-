/**
 * BLOC 9 — Bouton retour partagé (espace agence, espace admin, pages publiques).
 *
 * - Zone tactile >= 44 x 44 px (exigence accessibilité mobile).
 * - Repli déterministe sur la page parente quand il n'y a pas d'historique
 *   interne (première visite, rafraîchissement, preview intégrée).
 * - `history.back()` n'est utilisé que si la page précédente fait partie de
 *   l'application, pour ne jamais en sortir.
 * - Variantes `desktop` (barre supérieure) et `mobile` (en-tête mobile),
 *   mêmes cibles tactiles.
 */
import type { ComponentType } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useLocation } from 'wouter';
import {
  backLabelFor,
  canUseNativeBack,
  parentRouteFor,
} from '@/lib/back-navigation';

type BackButtonProps = {
  /** Espace courant : sert au repli de `/admin` et `/profil`. */
  space?: 'admin' | 'agency';
  /** Chemin courant, si différent de celui du routeur (pages publiques). */
  path?: string;
  /** Destination imposée (ignore la carte des parents). */
  to?: string;
  /** Libellé accessible imposé. */
  label?: string;
  variant?: 'desktop' | 'mobile';
  className?: string;
  testId?: string;
  icon?: ComponentType<{ size?: number }>;
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
}: BackButtonProps) {
  const [routePath, navigate] = useLocation();
  const current = path ?? routePath;
  const target = to ?? parentRouteFor(current, space);
  const accessibleLabel = label ?? backLabelFor(current, space);

  // Pas de retour sur la racine d'un espace : la flèche n'a rien à remonter.
  if (current === target) return null;

  const handleBack = () => {
    if (!to && canUseNativeBack(current)) {
      window.history.back();
      return;
    }
    navigate(target);
  };

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
