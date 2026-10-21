// =============================================================================
// BLOC 3 — Compteur de photos « 7/10 » et sortie de limite.
// =============================================================================
// Affiche le compteur, la jauge, et — à la limite — un message clair avec le
// bouton « Passer au Pro » qui envoie une demande de changement d'offre
// (`public.request_plan_change`), exactement comme la page « Mon offre ».
// Le refus effectif reste appliqué côté base par le trigger `enforce_photo_limit`.
// =============================================================================
import { useState } from 'react';
import { ImageIcon, Lock, Sparkles } from 'lucide-react';
import { Link } from 'wouter';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import {
  formatQuota, pickUpgradeTarget, useAgencyPlan, useRequestUpgrade,
  useUpgradeTargets, type PhotoQuota,
} from '@/lib/plan-limits';

export function PhotoQuotaBar({
  quota,
  agencyId,
  canManageAgency,
  testId = 'photos',
  compact = false,
}: {
  quota: PhotoQuota;
  agencyId?: string;
  canManageAgency: boolean;
  testId?: string;
  compact?: boolean;
}) {
  const planQ = useAgencyPlan(agencyId);
  const targetsQ = useUpgradeTargets();
  const requestUpgrade = useRequestUpgrade(agencyId);
  const [notice, setNotice] = useState('');

  const target = pickUpgradeTarget(planQ.data, targetsQ.data);
  const pct = quota.unlimited
    ? 6
    : Math.min(100, quota.limit > 0 ? (quota.used / quota.limit) * 100 : 0);

  const askUpgrade = async () => {
    if (!target) return;
    setNotice('');
    try {
      await requestUpgrade.mutateAsync({
        planId: target.id,
        note:
          `Limite de photos atteinte sur un bien (${quota.used}/${quota.limit} en offre ` +
          `${quota.planName}). Demande de passage à ${target.display_name ?? target.name}.`,
      });
      setNotice(
        `Demande de passage à ${target.display_name ?? target.name} envoyée à l’administrateur.`,
      );
    } catch (error) {
      setNotice(getSupabaseErrorMessage(error, 'envoyer la demande'));
    }
  };

  return (
    <div className={`photo-quota${compact ? ' is-compact' : ''}`} data-testid={`quota-${testId}`}>
      <div className="usage-meter-head">
        <span><ImageIcon size={14} /> Photos de ce bien</span>
        <strong data-testid={`text-${testId}-count`}>{formatQuota(quota)}</strong>
      </div>
      <div className="usage-bar" aria-hidden="true">
        <span
          className={quota.reached ? 'is-full' : pct >= 80 ? 'is-warn' : ''}
          style={{ width: `${pct}%` }}
        />
      </div>

      {quota.reached && (
        <div className="photo-limit-box" role="status" data-testid={`status-${testId}-limit`}>
          <Lock size={15} />
          <div>
            <strong>
              Limite atteinte : {quota.used}/{quota.limit} photos avec l’offre {quota.planName}.
            </strong>
            <p>
              Supprimez une photo pour en ajouter une autre, ou passez à une offre
              supérieure pour augmenter la limite par bien.
            </p>
            <div className="photo-limit-actions">
              {target && canManageAgency && (
                <button
                  type="button"
                  className="button-link"
                  onClick={() => void askUpgrade()}
                  disabled={requestUpgrade.isPending}
                  data-testid={`button-${testId}-upgrade`}
                >
                  <Sparkles size={14} />
                  {requestUpgrade.isPending ? 'Demande en cours…' : `Passer au ${target.display_name ?? target.name}`}
                </button>
              )}
              <Link href="/mon-offre" className="text-action" data-testid={`link-${testId}-offer`}>
                Voir mon offre
              </Link>
            </div>
            {notice && <p className="form-feedback" role="status">{notice}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
