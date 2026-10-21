import { useState, type ReactNode } from 'react';
import { ArrowRight, RefreshCw, FileText, LockKeyhole, ShieldCheck, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabaseErrorMessage } from '@/lib/supabase';

export const roleNames: Record<string, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  manager: 'Responsable',
  agent: 'Agent',
  viewer: 'Lecture seule',
};

export const propertyStatus: Record<string, string> = {
  available: 'Disponible',
  reserved: 'Réservé',
  sold: 'Vendu',
  rented: 'Loué',
  unavailable: 'Indisponible',
  draft: 'Brouillon',
  archived: 'Archivé',
};

export const contactStatus: Record<string, string> = {
  lead: 'Nouveau contact',
  prospect: 'Prospect',
  client: 'Client',
  inactive: 'Inactif',
};

export const visitStatus: Record<string, string> = {
  scheduled: 'Planifiée',
  done: 'Réalisée',
  cancelled: 'Annulée',
  no_show: 'Non honorée',
};

export const followUpStatus: Record<string, string> = {
  pending: 'En attente',
  completed: 'Terminée',
  cancelled: 'Annulée',
};

export const entityLabels: Record<string, string> = {
  agencies: 'Agences',
  properties: 'Biens',
  property_media: 'Photos',
  contacts: 'Contacts',
  property_visits: 'Visites',
  sales_pipeline: 'Pipeline',
  conversations: 'Conversations',
  property_messages: 'Messages',
  follow_ups: 'Relances',
  notifications: 'Notifications',
  agency_members: 'Membres',
  agency_subscriptions: 'Abonnements',
  revenue_operations: 'Chiffre d’affaires',
  plans: 'Formules',
  usage_events: 'Usages',
  platform_admins: 'Administration',
  auth_users: 'Comptes',
  user_profiles: 'Profils',
};

export const cash = (price: number, currency: string) =>
  `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(price)} ${currency === 'XOF' ? 'FCFA' : currency}`;

/**
 * Analyse une date sans JAMAIS lever d'exception.
 *
 * Pourquoi : `new Intl.DateTimeFormat(...).format(new Date(chaine))` lève
 * `RangeError: Invalid time value` dès que la chaîne n'est pas une date
 * valide. C'est exactement ce qui cassait la vue d'ensemble admin : le RPC
 * `platform_subscription_revenue` renvoie `month_start` en **timestamptz**
 * (`"2026-10-01T00:00:00+00:00"`), et le code concaténait `T12:00:00` dessus,
 * ce qui donnait `"2026-10-01T00:00:00+00:00T12:00:00"` → `Invalid Date`.
 *
 * Formats acceptés : `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, ISO complet (avec ou sans
 * fuseau), et toute chaîne déjà comprise par `Date`. Les dates « nues » sont
 * interprétées à MIDI LOCAL pour éviter le décalage d'un mois/jour dû au fuseau.
 */
export function parseDate(value?: string | null): Date | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // `YYYY-MM` seul : Date l'interprète mal, on complète explicitement.
  const yearMonth = /^(\d{4})-(\d{2})$/.exec(raw);
  if (yearMonth) {
    const date = new Date(Number(yearMonth[1]), Number(yearMonth[2]) - 1, 1, 12, 0, 0);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // `YYYY-MM-DD` sans heure : midi LOCAL (et non minuit UTC) pour rester sur le
  // bon jour quel que soit le fuseau de l'utilisateur.
  const bareDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (bareDate) {
    const date = new Date(
      Number(bareDate[1]), Number(bareDate[2]) - 1, Number(bareDate[3]), 12, 0, 0,
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // ISO complet (déjà horodaté / avec fuseau) : ne RIEN concaténer.
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Vrai si la valeur donne une date exploitable. */
export const isValidDateValue = (value?: string | null) => parseDate(value) !== null;

const MISSING_DATE_LABEL = 'Non renseignée';

/** Formate une date ; renvoie un libellé de repli au lieu de lever. */
export function formatDate(value: string | Date | null | undefined, fallback = MISSING_DATE_LABEL): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return fallback;
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
  } catch {
    return fallback;
  }
}

/** Formate une date + heure ; renvoie un libellé de repli au lieu de lever. */
export function formatDateTime(value: string | Date | null | undefined, fallback = MISSING_DATE_LABEL): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return fallback;
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(date);
  } catch {
    return fallback;
  }
}

/**
 * Libellé court d'un mois (« oct. ») à partir de n'importe quel format de date.
 * C'est le correctif direct du bug de la vue d'ensemble admin.
 */
export function monthShortLabel(value: string | Date | null | undefined, fallback = '—'): string {
  const date = value instanceof Date ? value : parseDate(value);
  if (!date) return fallback;
  try {
    return new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(date).replace('.', '');
  } catch {
    return fallback;
  }
}

/**
 * Formateur générique qui ne lève JAMAIS.
 * Remplace les `new Date(chaine).toLocaleString(...)` dispersés dans l'app,
 * qui lèvent `RangeError: Invalid time value` sur une chaîne non vide mais
 * invalide. Renvoie `fallback` dans ce cas.
 */
export function safeFormat(
  value: string | number | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  fallback = MISSING_DATE_LABEL,
  locale = 'fr-FR',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : (typeof value === 'number' ? new Date(value) : parseDate(value));
  if (!date) return fallback;
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return fallback;
  }
}

/** Date courte « 21/10/2026 ». */
export const formatDateShort = (value?: string | null, fallback = MISSING_DATE_LABEL) =>
  safeFormat(value, { day: '2-digit', month: '2-digit', year: 'numeric' }, fallback);

/** Date + heure courtes « 21/10/2026 14:30 ». */
export const formatDateTimeShort = (value?: string | null, fallback = MISSING_DATE_LABEL) =>
  safeFormat(value, { dateStyle: 'short', timeStyle: 'short' }, fallback);

/** Heure seule « 14:30 ». */
export const formatTime = (value?: string | number | null, fallback = '--:--') =>
  safeFormat(value, { hour: '2-digit', minute: '2-digit' }, fallback);

export const dateLabel = (value?: string | null) => formatDate(value);

export const dateTimeLabel = (value?: string | null) => formatDateTime(value);

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <Building2 size={18} />
    </div>
  );
}

/**
 * BLOC 4 : logo de l'agence, affiché dans la barre latérale et l'en-tête.
 * Retombe sur l'initiale du nom (ou l'icône par défaut) quand aucun logo n'est
 * enregistré, et sur l'initiale si le fichier ne se charge pas.
 */
export function AgencyLogo({
  logoUrl,
  name,
  size = 34,
  className = '',
  testId = 'agency-logo',
}: {
  logoUrl?: string | null;
  name?: string | null;
  size?: number;
  className?: string;
  testId?: string;
}) {
  const [broken, setBroken] = useState(false);
  const initial = (name ?? 'S').trim().charAt(0).toUpperCase() || 'S';
  const showImage = Boolean(logoUrl) && !broken;
  return (
    <span
      className={`agency-logo${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      data-testid={testId}
    >
      {showImage ? (
        <img
          src={logoUrl as string}
          alt={name ? `Logo de ${name}` : 'Logo de l’agence'}
          width={size}
          height={size}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="agency-logo-fallback" aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}

export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

export function ButtonPrimary({
  children,
  onClick,
  testId,
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <Button className="primary-action" onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </Button>
  );
}

export function ErrorState({
  error,
  retry,
  testId = 'status-query-error',
}: {
  error: unknown;
  retry: () => void;
  testId?: string;
}) {
  return (
    <div className="state-card error-state" role="alert" data-testid={testId}>
      <div className="state-icon">
        <ShieldCheck size={19} />
      </div>
      <h2>Accès aux données refusé</h2>
      <p>{getSupabaseErrorMessage(error, 'charger les données')}</p>
      <Button variant="outline" onClick={retry} data-testid="button-retry-query">
        <RefreshCw size={14} /> Réessayer
      </Button>
    </div>
  );
}

export function LoadingRows({ label = 'Chargement des données' }: { label?: string }) {
  return (
    <div className="loading-state" aria-label={label} data-testid="status-loading">
      <div className="skeleton-line wide" />
      <div className="skeleton-line" />
      <div className="skeleton-line medium" />
      <div className="skeleton-line wide" />
    </div>
  );
}

export function PageDataState({
  loading,
  error,
  retry,
  count,
  emptyTitle,
  emptyText,
  testId,
  emptyIcon,
}: {
  loading: boolean;
  error: unknown;
  retry: () => void;
  count: number;
  emptyTitle: string;
  emptyText: string;
  testId: string;
  emptyIcon?: ReactNode;
}) {
  if (loading) return <LoadingRows />;
  if (error) return <ErrorState error={error} retry={retry} />;
  if (!count)
    return (
      <div className="state-card compact-empty" data-testid={testId}>
        <div className="state-icon">{emptyIcon ?? <FileText size={19} />}</div>
        <span className="state-kicker">Votre espace</span>
        <h2>{emptyTitle}</h2>
        <p>{emptyText}</p>
      </div>
    );
  return null;
}

export function EmptyLockState({ title, text }: { title: string; text: string }) {
  return (
    <div className="state-card" data-testid="empty-membership">
      <div className="state-icon">
        <LockKeyhole size={19} />
      </div>
      <span className="state-kicker">Accès requis</span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

export function useSafeRetry(query: { refetch: () => unknown }) {
  return () => {
    void query.refetch();
  };
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number>>,
) {
  const escape = (value: string | number) => {
    const str = String(value ?? '');
    return /[",;\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csv = [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join(
    '\n',
  );
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
