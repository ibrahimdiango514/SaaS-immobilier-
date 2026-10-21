// =============================================================================
// BLOC 8 — BOUTON FLOTTANT DE L'ASSISTANT IA
// =============================================================================
// Monté dans AppShell : accessible depuis tout l'espace agence.
// Mobile-first : cible tactile >= 44 px, panneau pleine largeur sur petit écran,
// respect des safe-areas, fermeture par Échap et par clic hors du panneau.
// Si l'offre n'inclut pas l'assistant, le panneau affiche un aperçu verrouillé
// avec « Passer au Pro » (renvoie vers la page Assistant IA).
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { Bot, Lock, Sparkles, X } from 'lucide-react';
import { useAgency } from '@/lib/agency-context';
import { AssistantChat } from '@/components/assistant-chat';
import { useAssistantAccess } from '@/lib/assistant-api';

export function AssistantFab() {
  const { activeAgencyId, activeMembership } = useAgency();
  const access = useAssistantAccess(activeAgencyId);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const isManager = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';

  // Échap ferme le panneau et rend le focus au bouton.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Clic hors du panneau.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  if (access.isLoading) return null;

  return (
    <>
      {open && (
        <div
          className="assistant-panel-float"
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Assistant IA Sofia"
          data-testid="panel-assistant-float"
        >
          <div className="assistant-panel-head">
            <span className="assistant-panel-mark"><Bot size={16} /></span>
            <div>
              <strong>Sofia · Assistant IA</strong>
              <small>
                {access.allowed
                  ? `Offre ${access.planName ?? 'Pro'} · lecture seule`
                  : `Offre ${access.planName ?? '—'} · assistant verrouillé`}
              </small>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => setOpen(false)}
              aria-label="Fermer l’assistant"
              data-testid="button-assistant-close"
            >
              <X size={17} />
            </button>
          </div>

          {access.allowed ? (
            <AssistantChat isManager={isManager} compact testId="fab" />
          ) : (
            <div className="assistant-float-locked">
              <Lock size={20} />
              <strong>L’assistant IA est réservé aux offres Pro et Premium</strong>
              <p>
                Il répond en français avec les chiffres exacts de votre agence : biens sans
                photo, prospects à relancer, prochaines visites, résumé du jour.
              </p>
              <Link href="/assistant-ia" className="primary-action" onClick={() => setOpen(false)} data-testid="link-float-unlock">
                <Sparkles size={15} /> Voir l’aperçu et passer au Pro
              </Link>
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        ref={buttonRef}
        className={`assistant-fab${open ? ' is-open' : ''}${access.allowed ? '' : ' is-locked'}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Fermer l’assistant IA' : 'Ouvrir l’assistant IA'}
        title="Assistant IA"
        data-testid="button-assistant-fab"
      >
        {access.allowed ? <Sparkles size={20} /> : <Lock size={18} />}
      </button>
    </>
  );
}
