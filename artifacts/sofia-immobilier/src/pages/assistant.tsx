// =============================================================================
// BLOC 8 — PAGE « ASSISTANT IA »
// =============================================================================
// Réservée aux offres Pro / Premium. Le contrôle décisif est côté serveur
// (Edge Function `dashboard-assistant`) ; cette page affiche un APERÇU VERROUILLÉ
// avec « Passer au Pro » pour les offres qui n'y ont pas droit, au lieu d'un chat
// qui échouerait à chaque message.
// =============================================================================
import { useState } from 'react';
import { Bot, Lock, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { useAgency } from '@/lib/agency-context';
import { Heading, LoadingRows } from '@/lib/workspace-ui';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AssistantChat } from '@/components/assistant-chat';
import { useAssistantAccess } from '@/lib/assistant-api';
import { useRequestUpgrade, useUpgradeTargets } from '@/lib/plan-limits';

export default function AssistantPage() {
  const { activeAgencyId, activeMembership, activeAgency } = useAgency();
  const access = useAssistantAccess(activeAgencyId);
  const targetsQ = useUpgradeTargets();
  const requestUpgrade = useRequestUpgrade(activeAgencyId);
  const [notice, setNotice] = useState('');

  const isManager = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';

  if (access.isLoading) {
    return (
      <>
        <Heading eyebrow="Assistant" title="Assistant IA" description="Vérification de votre offre." />
        <LoadingRows label="Chargement de l’assistant" />
      </>
    );
  }

  if (access.error) {
    return (
      <>
        <Heading eyebrow="Assistant" title="Assistant IA" description="Votre offre n’a pas pu être vérifiée." />
        <div className="state-card error-state" role="alert" data-testid="status-assistant-error">
          <div className="state-icon"><Lock size={19} /></div>
          <h2>Vérification impossible</h2>
          <p>{getSupabaseErrorMessage(access.error, 'vérifier votre offre')}</p>
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Aperçu verrouillé — offre Essentiel (ou aucune offre active)
  // ---------------------------------------------------------------------------
  if (!access.allowed) {
    const targets = (targetsQ.data ?? []).filter((plan) => ['pro', 'enterprise'].includes(String(plan.name).toLowerCase()));
    const target = targets[0];

    const askUpgrade = async () => {
      if (!target) return;
      setNotice('');
      try {
        await requestUpgrade.mutateAsync({
          planId: target.id,
          note:
            `Demande depuis la page Assistant IA : passage de ${access.planName ?? 'l’offre actuelle'} à ` +
            `${target.display_name ?? target.name} pour débloquer l’assistant IA.`,
        });
        setNotice(`Demande de passage à ${target.display_name ?? target.name} envoyée à l’administrateur.`);
      } catch (error) {
        setNotice(getSupabaseErrorMessage(error, 'envoyer la demande'));
      }
    };

    return (
      <>
        <Heading
          eyebrow="Assistant"
          title="Assistant IA"
          description="Vos questions, vos chiffres réels, en français."
        />

        <section className="panel assistant-locked" data-testid="panel-assistant-locked">
          <span className="assistant-locked-mark"><Lock size={22} /></span>
          <h2>L’assistant IA est réservé aux offres Pro et Premium</h2>
          <p>
            Votre agence utilise l’offre <strong>{access.planName ?? '—'}</strong>.
            L’assistant répond à partir de vos données réelles (biens, contacts,
            pipeline, visites, alertes) et vous fait gagner du temps chaque jour.
          </p>

          {/* Aperçu : questions possibles, réponses masquées. */}
          <div className="assistant-preview" aria-hidden="false" data-testid="box-assistant-preview">
            <div className="assistant-preview-item">
              <span className="assistant-avatar"><Bot size={14} /></span>
              <div>
                <p className="assistant-preview-q">« Quels biens n’ont pas encore de photo ? »</p>
                <p className="assistant-preview-a blurred">3 biens sur 12 n’ont aucune photo…</p>
              </div>
            </div>
            <div className="assistant-preview-item">
              <span className="assistant-avatar"><Bot size={14} /></span>
              <div>
                <p className="assistant-preview-q">« Quels prospects relancer aujourd’hui ? »</p>
                <p className="assistant-preview-a blurred">5 prospects sans suivi depuis plus de 7 jours…</p>
              </div>
            </div>
            <div className="assistant-preview-item">
              <span className="assistant-avatar"><Bot size={14} /></span>
              <div>
                <p className="assistant-preview-q">« Que dois-je faire en priorité ? »</p>
                <p className="assistant-preview-a blurred">Commencez par compléter les photos…</p>
              </div>
            </div>
          </div>

          <ul className="assistant-benefits">
            <li><Sparkles size={14} /> Réponses en français avec les chiffres exacts de votre agence</li>
            <li><Sparkles size={14} /> Résumé du jour et alertes intelligentes sur la vue d’ensemble</li>
            <li><Sparkles size={14} /> Lecture seule : l’assistant ne modifie jamais vos données</li>
            {isManager && <li><Sparkles size={14} /> Chiffre d’affaires et abonnement inclus pour le propriétaire et les administrateurs</li>}
          </ul>

          <div className="assistant-locked-actions">
            {target && isManager && (
              <button
                type="button"
                className="primary-action"
                onClick={() => void askUpgrade()}
                disabled={requestUpgrade.isPending}
                data-testid="button-assistant-upgrade"
              >
                <Sparkles size={15} />
                {requestUpgrade.isPending ? 'Demande en cours…' : `Passer au ${target.display_name ?? target.name}`}
              </button>
            )}
            <Link href="/mon-offre" className="button-link" data-testid="link-assistant-offer">
              Voir mon offre
            </Link>
            {!isManager && (
              <p className="permission-note">
                <Lock size={14} />
                Seul le propriétaire ou un administrateur de {activeAgency?.name ?? 'l’agence'} peut demander
                un changement d’offre.
              </p>
            )}
          </div>

          {notice && <p className="form-feedback" role="status" data-testid="status-assistant-upgrade">{notice}</p>}
        </section>
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Assistant actif — Pro / Premium
  // ---------------------------------------------------------------------------
  return (
    <>
      <Heading
        eyebrow="Assistant"
        title="Assistant IA"
        description={`Offre ${access.planName ?? 'Pro'} · réponses en français à partir de vos données réelles, en lecture seule.`}
      />
      <section className="panel assistant-panel" data-testid="panel-assistant">
        <div className="panel-head">
          <div>
            <h2>Discuter avec Sofia</h2>
            <p>Biens, contacts, pipeline, visites, alertes{isManager ? ', chiffre d’affaires et abonnement' : ''}.</p>
          </div>
          <Bot size={18} />
        </div>
        <AssistantChat isManager={isManager} testId="page" />
      </section>
    </>
  );
}
