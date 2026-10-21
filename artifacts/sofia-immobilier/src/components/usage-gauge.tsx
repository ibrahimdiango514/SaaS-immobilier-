// =============================================================================
// BLOC 7 — Jauge de consommation réutilisable (agence + plateforme).
// =============================================================================
// Trois états d'alerte imposés par le cahier des charges : seuil à 80 % puis
// 100 %. Les seuils sont calculés côté SQL (`public.agency_ai_usage` /
// `public.platform_agency_usage`) : ce composant ne fait qu'afficher.
// =============================================================================
import { AlertTriangle, CheckCircle2, Infinity as InfinityIcon } from 'lucide-react';
import {
  ALERT_LABELS, compactNumber, isUnlimitedLimit, type UsageAlert,
} from '@/lib/usage-api';

export function UsageGauge({
  label,
  used,
  limit,
  ratio,
  alert,
  unit = '',
  testId,
  dense = false,
}: {
  label: string;
  used: number;
  limit: number | null | undefined;
  ratio?: number;
  alert: UsageAlert;
  unit?: string;
  testId: string;
  dense?: boolean;
}) {
  const unlimited = alert === 'unlimited' || isUnlimitedLimit(limit);
  const pct = unlimited
    ? 100
    : Math.max(0, Math.min(100, ratio ?? (limit && limit > 0 ? (used / limit) * 100 : 0)));

  const tone = unlimited ? 'is-unlimited' : alert === 'reached' ? 'is-reached' : alert === 'warning' ? 'is-warning' : 'is-ok';

  return (
    <div className={`usage-gauge ${tone}${dense ? ' is-dense' : ''}`} data-testid={`gauge-${testId}`}>
      <div className="usage-gauge-head">
        <span>{label}</span>
        <strong data-testid={`text-${testId}`}>
          {compactNumber(used)}
          {unit ? ` ${unit}` : ''}
          {unlimited
            ? <em className="unlimited-chip" title="Non plafonné par l’offre"><InfinityIcon size={11} /> illimité</em>
            : <> / {compactNumber(limit)}</>}
        </strong>
      </div>
      <div className="usage-gauge-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${label} : ${Math.round(pct)} %`}>
        <span style={{ width: `${unlimited ? 4 : pct}%` }} />
      </div>
      {!unlimited && alert !== 'ok' && (
        <p className="usage-gauge-alert" role="status" data-testid={`alert-${testId}`}>
          {alert === 'reached' ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
          {ALERT_LABELS[alert]} · {Math.round(pct)} %
        </p>
      )}
    </div>
  );
}

/** Pastille d'état du canal WhatsApp, avec badge « non officiel » pour Evolution API. */
export function WhatsAppBadge({
  providerLabel,
  official,
  status,
  phoneNumber,
  connections = 0,
  testId,
}: {
  providerLabel: string | null;
  official: boolean;
  status: string | null;
  phoneNumber?: string | null;
  connections?: number;
  testId: string;
}) {
  if (!providerLabel) {
    return (
      <span className="wa-cell is-none" data-testid={`wa-${testId}`}>
        <em>Aucun canal</em>
      </span>
    );
  }
  return (
    <span className={`wa-cell wa-status-${status ?? 'none'}`} data-testid={`wa-${testId}`}>
      <span className="wa-provider">
        {providerLabel}
        {!official && (
          <em className="wa-unofficial" title="Fournisseur non officiel : aucun accord Meta, risque de suspension du numéro">
            non officiel
          </em>
        )}
        {connections > 1 && <em className="wa-extra">+{connections - 1}</em>}
      </span>
      <small>
        {phoneNumber ?? 'numéro non renseigné'} · {status ?? 'état inconnu'}
      </small>
    </span>
  );
}
