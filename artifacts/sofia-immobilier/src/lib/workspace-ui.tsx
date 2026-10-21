import type { ReactNode } from 'react';
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

export const dateLabel = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(value),
      )
    : 'Non renseignée';

export const dateTimeLabel = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : 'Non renseignée';

export function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <Building2 size={18} />
    </div>
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
