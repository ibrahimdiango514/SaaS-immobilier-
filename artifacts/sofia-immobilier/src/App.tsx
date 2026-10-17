import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowDownRight, ArrowRight, Building2, ChevronDown, CircleHelp, Clock3,
  ContactRound, FileText, Home, LayoutDashboard, LogOut, Menu, Plus, Search,
  Settings2, ShieldCheck, SlidersHorizontal, UsersRound, X, Pencil, RefreshCw,
  LockKeyhole, Mail, Phone, MapPin, UserRound, KeyRound, LayoutGrid, List,
  Camera, ImagePlus, Trash2, CalendarDays, BarChart3, UserCog, MessageCircle,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { AgencyProvider, useAgency } from '@/lib/agency-context';
import {
  useProperties, useContacts, usePipeline, useAgencyRoster, useCurrentProfile,
  useCreateProperty, useUpdateProperty, useCreateContact, useUpdateContact,
  useCreatePipelineItem, useUpdatePipelineItem, useUpdateAgency, useUpdateCurrentProfile,
  usePropertyMedia, useUploadPropertyMedia, useDeletePropertyMedia,
  type PropertyCreateInput, type ContactCreateInput, type PipelineCreateInput,
  type AgencySettingsInput, type ProfileUpdateInput,
} from '@/lib/data-hooks';
import type { AgencyMemberRow, PropertyRow, ContactRow, ContactStatus, SalesPipelineRow } from '@/lib/database.types';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { contactFormSchema, type ContactFormValues } from '@/lib/contact-schema.js';
import { pipelineFormSchema, type PipelineFormValues } from '@/lib/pipeline-schema.js';
import {
  canAssignContactToMember,
  contactFormDefaults,
  filterContacts,
  formatContactName,
  getAssignableContactMembers,
  linkedOpportunitiesForContact,
} from '@/lib/contact-utils.js';
import {
  filterProperties,
  formatPropertyPrice,
  linkedOpportunitiesForProperty,
  isOptionalNonNegativeInteger,
  isOptionalPositiveFiniteNumber,
  isPositiveFinitePrice,
  propertyFormDefaults,
  propertyPriceRangeError,
} from '@/lib/property-utils.js';
import { formatVisitDate, localDateKey, visitDateKey } from '@/lib/visit-utils.js';
import {
  filterPipelineItems,
  getPipelineStageCounts,
  getPipelineStages,
  groupPipelineByStage,
  nextPipelineVisits,
  partitionPipelineVisits,
  pipelineDateRangeError,
  pipelineStageLabel,
} from '@/lib/pipeline-utils.js';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

const nav = [
  { href: '/', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { href: '/biens', label: 'Biens immobiliers', icon: Home },
  { href: '/contacts', label: 'Prospects et contacts', icon: ContactRound },
  { href: '/pipeline', label: 'Pipeline commercial', icon: SlidersHorizontal },
  { href: '/visites', label: 'Visites', icon: CalendarDays },
  { href: '/whatsapp', label: 'WhatsApp', icon: MessageCircle, soon: true },
  { href: '/assistant-ia', label: 'Assistant IA', icon: CircleHelp, soon: true },
  { href: '/automatisations', label: 'Automatisations', icon: RefreshCw, soon: true },
  { href: '/agence', label: 'Agence et membres', icon: UsersRound },
  { href: '/profil', label: 'Mon profil', icon: UserRound },
  { href: '/parametres', label: 'Paramètres', icon: Settings2 },
];
const roleNames: Record<string, string> = { owner: 'Propriétaire', admin: 'Administrateur', manager: 'Responsable', agent: 'Agent', viewer: 'Lecture seule' };
const propertyStatus: Record<string, string> = { available: 'Disponible', reserved: 'Réservé', sold: 'Vendu', rented: 'Loué', unavailable: 'Indisponible', draft: 'Brouillon', archived: 'Archivé' };
const contactStatus: Record<string, string> = { lead: 'Nouveau contact', prospect: 'Prospect', client: 'Client', inactive: 'Inactif' };
const dateLabel = (value?: string | null) => value ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Non renseignée';
const agencyMemberLabel = (member?: AgencyMemberRow | null) => {
  if (!member) return 'Membre indisponible';
  const role = roleNames[member.role] ?? member.role;
  const status = member.status === 'active' ? '' : ' · adhésion inactive';
  return `${role} · …${member.user_id.slice(-4)}${status}`;
};

function BrandMark() { return <div className="brand-mark" aria-hidden="true"><Building2 size={18} /></div>; }

function AppShell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const { user, signOut } = useAuth();
  const { agencies, activeAgency, activeAgencyId, setActiveAgencyId, activeMembership } = useAgency();
  const { data: profile } = useCurrentProfile(user?.id);
  const name = profile?.full_name || user?.email || 'Mon compte';
  const currentLabel = nav.find((item) => item.href === path)?.label ?? (path.startsWith('/biens/') ? 'Fiche bien' : path.startsWith('/contacts/') ? 'Fiche contact' : 'Espace de travail');
  const handleSignOut = async () => {
    setSignOutError('');
    try {
      await signOut();
    } catch (error) {
      setSignOutError(getSupabaseErrorMessage(error, 'fermer la session'));
      setNotice(true);
    }
  };
  return <div className="app-shell">
    <div className={`mobile-overlay${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen(false)} data-testid="mobile-navigation-overlay" />
    <aside className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Navigation principale">
      <Link href="/" className="brand-lockup" data-testid="link-brand-home" onClick={() => setMenuOpen(false)}><BrandMark /><div><div className="brand-name">sofia immobilier</div><div className="brand-caption">L’espace de votre agence</div></div></Link>
      <div className="nav-label">Espace de travail</div>
      <nav className="nav-list" aria-label="Navigation principale">{nav.map(({ href, label, icon: Icon, soon }) => <Link href={href} key={href} className={`nav-link${soon ? ' nav-link-soon' : ''}`} aria-current={path === href ? 'page' : undefined} data-testid={`link-nav-${href === '/' ? 'overview' : href.slice(1)}`} onClick={() => setMenuOpen(false)}><Icon size={16} /><span>{label}</span>{soon && <small>Bientôt</small>}</Link>)}</nav>
      <div className="sidebar-spacer" />
      <div className="connection-card" data-testid="status-data-access"><div className="connection-heading"><i /> Espace sécurisé</div><p>Vos données sont limitées aux agences auxquelles vous avez accès.</p></div>
      <label className="agency-select-label" htmlFor="agency-switcher">Agence active</label>
      <div className="agency-switcher" data-testid="display-agency-workspace">
        <div className="agency-avatar">{activeAgency?.name?.slice(0, 1) ?? 'S'}</div>
        {agencies.length > 1 ? <select id="agency-switcher" value={activeAgencyId ?? ''} onChange={(e) => setActiveAgencyId(e.target.value)} data-testid="select-active-agency" aria-label="Choisir une agence">{agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}</select> : <div className="agency-label"><strong>{activeAgency?.name ?? 'Aucune agence active'}</strong><span>{activeMembership ? roleNames[activeMembership.role] : 'Accès agence requis'}</span></div>}
        {agencies.length > 1 && <ChevronDown size={14} color="#9aafaa" />}
      </div>
      <button className="sidebar-signout" onClick={() => void handleSignOut()} data-testid="button-sign-out"><LogOut size={14} /> Se déconnecter</button>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="breadcrumb"><span>{activeAgency?.name ?? 'Espace agence'}</span><ArrowRight size={12} /><strong>{currentLabel}</strong></div><div className="topbar-tools"><Link href="/profil" className="profile-chip" data-testid="display-user-access-status"><div className="profile-circle">{name.slice(0, 1).toUpperCase()}</div><span>{name}</span></Link><button type="button" className="icon-button" onClick={() => setNotice(true)} aria-label="Notifications bientôt disponibles" title="Notifications · Bientôt disponible" data-testid="button-notifications"><CircleHelp size={15} /></button></div></header>
      <header className="mobile-header"><div className="mobile-brand"><BrandMark /><strong>sofia immobilier</strong></div><button type="button" className="icon-button mobile-menu-button" aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} data-testid="button-mobile-menu">{menuOpen ? <X size={18} /> : <Menu size={18} />}</button></header>
      <main className="content-wrap">{children}</main>
    </div>
    {notice && <div className="notice-toast" role={signOutError ? 'alert' : 'status'} data-testid="status-notifications">{signOutError || 'Notifications : bientôt disponible. Aucun compteur ni alerte fictive.'}<button onClick={() => setNotice(false)} aria-label="Fermer le message" data-testid="button-dismiss-notice"><X size={13} /></button></div>}
  </div>;
}

function Heading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
function ButtonPrimary({ children, onClick, testId, disabled = false }: { children: ReactNode; onClick: () => void; testId: string; disabled?: boolean }) {
  return <Button className="primary-action" onClick={onClick} disabled={disabled} data-testid={testId}>{children}</Button>;
}
function ErrorState({ error, retry, testId = 'status-query-error' }: { error: unknown; retry: () => void; testId?: string }) {
  return <div className="state-card error-state" role="alert" data-testid={testId}><div className="state-icon"><ShieldCheck size={19} /></div><h2>Accès aux données refusé</h2><p>{getSupabaseErrorMessage(error, 'charger les données')}</p><Button variant="outline" onClick={retry} data-testid="button-retry-query"><RefreshCw size={14} /> Réessayer</Button></div>;
}
function LoadingRows({ label = 'Chargement des données' }: { label?: string }) {
  return <div className="loading-state" aria-label={label} data-testid="status-loading"><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-line medium" /><div className="skeleton-line wide" /></div>;
}
function NoAgency({ isLoading, error, retry }: { isLoading: boolean; error: Error | null; retry: () => void }) {
  if (isLoading) return <LoadingRows label="Vérification des accès agence" />;
  if (error) return <ErrorState error={error} retry={retry} testId="status-membership-error" />;
  return <div className="state-card" data-testid="empty-membership"><div className="state-icon"><LockKeyhole size={19} /></div><span className="state-kicker">Accès requis</span><h2>Aucune agence active associée</h2><p>Ce compte ne possède pas encore d’adhésion active à une agence. Demandez à un administrateur de vérifier vos accès.</p></div>;
}
function useSafeRetry(query: { refetch: () => unknown }) { return () => { void query.refetch(); }; }
function WorkspaceGate({ children }: { children: ReactNode }) {
  const { user, loading, configurationError, initializationError } = useAuth();
  const agency = useAgency();
  const client = useQueryClient();
  if (loading) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Chargement de la session" /></div>;
  if (configurationError || initializationError) return <div className="auth-loading"><div className="state-card error-state"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Connexion indisponible</h2><p>{configurationError || initializationError}</p></div></div>;
  if (!user) return <Login />;
  if (agency.loading || agency.error || !agency.activeAgencyId) return <AppShell><NoAgency isLoading={agency.loading || (agency.memberships.length > 0 && !agency.activeAgencyId)} error={agency.error} retry={() => { void client.invalidateQueries({ queryKey: ['sofia', 'memberships'] }); void client.invalidateQueries({ queryKey: ['sofia', 'agencies'] }); }} /></AppShell>;
  return <AppShell>{children}</AppShell>;
}

function Overview() {
  const { activeAgency, activeAgencyId } = useAgency();
  const propertiesQ = useProperties(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const pipelineQ = usePipeline(activeAgencyId);
  const properties = propertiesQ.data ?? [];
  const contacts = contactsQ.data ?? [];
  const opportunities = pipelineQ.data ?? [];
  const todayKey = localDateKey() ?? '';
  const visitPartition = useMemo(
    () => partitionPipelineVisits(opportunities, todayKey),
    [opportunities, todayKey],
  );
  const upcomingVisits = useMemo(
    () => nextPipelineVisits(visitPartition.scheduledVisits, 5),
    [visitPartition.scheduledVisits],
  );
  const propertyCounts = useMemo(() => Object.entries(propertyStatus)
    .map(([status, label]) => ({
      status,
      label,
      count: properties.filter((property) => property.status === status).length,
    }))
    .filter((entry) => entry.count > 0), [properties]);
  const stageCounts = useMemo(() => getPipelineStageCounts(opportunities), [opportunities]);
  const contactsById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const propertiesById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties]);
  const recentRecords = useMemo(() => {
    const records = [
      ...properties.map((property) => ({
        id: `property-${property.id}`,
        type: 'Bien',
        title: property.title || property.reference,
        detail: `${property.reference} · ${propertyStatus[property.status] ?? property.status}`,
        created_at: property.created_at,
        href: `/biens/${property.id}`,
      })),
      ...contacts.map((contact) => ({
        id: `contact-${contact.id}`,
        type: 'Contact',
        title: formatContactName(contact),
        detail: contactStatus[contact.status] ?? contact.status,
        created_at: contact.created_at,
        href: `/contacts/${contact.id}`,
      })),
      ...opportunities.map((item) => {
        const contact = contactsById.get(item.client_id);
        const property = propertiesById.get(item.property_id);
        return {
          id: `opportunity-${item.id}`,
          type: 'Opportunité',
          title: contact ? formatContactName(contact) : 'Contact indisponible',
          detail: `${pipelineStageLabel(item.etape)} · ${property ? `${property.reference} · ${property.title}` : 'Bien indisponible'}`,
          created_at: item.created_at,
          href: '/pipeline',
        };
      }),
    ];
    return records
      .sort((left, right) => {
        const leftTime = Date.parse(left.created_at);
        const rightTime = Date.parse(right.created_at);
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
      })
      .slice(0, 6);
  }, [properties, contacts, opportunities, contactsById, propertiesById]);
  const loading = propertiesQ.isLoading || contactsQ.isLoading || pipelineQ.isLoading;
  const error = propertiesQ.error || contactsQ.error || pipelineQ.error;
  const retry = () => {
    void propertiesQ.refetch();
    void contactsQ.refetch();
    void pipelineQ.refetch();
  };

  if (loading) return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence, à jour et accessibles." /><LoadingRows /></>;
  if (error) return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence." /><ErrorState error={error} retry={retry} testId="status-dashboard-error" /></>;

  const maxPropertyCount = Math.max(1, ...propertyCounts.map((entry) => entry.count));
  const maxStageCount = Math.max(1, ...stageCounts.map((entry) => entry.count));
  const stats = [
    { label: 'Biens disponibles', count: properties.filter((property) => property.status === 'available').length, foot: `sur ${properties.length} biens visibles`, icon: Home },
    { label: 'Contacts', count: contacts.length, foot: 'Fiches visibles dans l’agence', icon: ContactRound },
    { label: 'Opportunités', count: opportunities.length, foot: 'Dossiers du pipeline', icon: SlidersHorizontal },
    { label: 'Visites aujourd’hui', count: visitPartition.todayCount, foot: 'Date enregistrée dans le pipeline', icon: CalendarDays },
    { label: 'Visites à venir', count: visitPartition.upcomingCount, foot: 'À partir des dates de visite', icon: Clock3 },
    { label: 'Sans date de visite', count: visitPartition.unscheduledItems.length, foot: 'Opportunités à planifier', icon: CalendarDays },
  ];

  return <>
    <Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence, à jour et accessibles." />
    <section className="status-banner" data-testid="status-dashboard-access">
      <div className="status-banner-icon"><ShieldCheck size={15} /></div>
      <div><strong>Données de {activeAgency?.name ?? 'l’agence active'}</strong><p>Indicateurs calculés à partir des biens, contacts et opportunités effectivement visibles.</p></div>
      <span className="status-tag">Accès actif</span>
    </section>
    <section className="stat-grid dashboard-stat-grid" aria-label="Indicateurs de l’agence">
      {stats.map(({ label, count, foot, icon: Icon }, index) => <article className="stat-card" key={label} data-testid={`card-stat-${index + 1}`}>
        <div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={14} /></span></div>
        <div className="stat-value" data-testid={`value-stat-${index + 1}`}>{count}</div>
        <div className="stat-foot">{foot}</div>
      </article>)}
    </section>
    {visitPartition.invalidDateCount > 0 && <p className="visit-data-warning" role="status" data-testid="status-dashboard-invalid-visit-dates">{visitPartition.invalidDateCount} date(s) de visite enregistrée(s) ne sont pas valides et ne sont pas comptées parmi les visites planifiées.</p>}

    <section className="overview-grid dashboard-distribution-grid">
      <article className="panel">
        <div className="panel-head"><div><h2>Biens par statut</h2><p>{properties.length} bien(s) visibles · données de l’agence active</p></div><Link href="/biens" className="text-action" data-testid="link-dashboard-properties">Voir les biens <ArrowRight size={13} /></Link></div>
        {propertyCounts.length ? <div className="stage-summary" data-testid="dashboard-property-distribution">{propertyCounts.map(({ status, label, count }) => <div className="stage-summary-row" key={status}>
          <span>{label}</span><div className="stage-track"><i style={{ width: `${Math.max(8, count / maxPropertyCount * 100)}%` }} /></div><strong>{count}</strong>
        </div>)}</div> : <div className="empty-table"><strong>Aucun bien enregistré</strong><p>La répartition apparaîtra à partir des biens visibles.</p><Link href="/biens" className="text-action">Ouvrir les biens <ArrowRight size={13} /></Link></div>}
      </article>
      <article className="panel">
        <div className="panel-head"><div><h2>Opportunités par étape</h2><p>{opportunities.length} opportunité(s) · étapes observées dans le pipeline</p></div><Link href="/pipeline" className="text-action" data-testid="link-dashboard-pipeline">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>
        {stageCounts.length ? <div className="stage-summary" data-testid="dashboard-pipeline-distribution">{stageCounts.map(({ stage, count }) => <div className="stage-summary-row" key={stage}>
          <span>{stage}</span><div className="stage-track"><i style={{ width: `${Math.max(8, count / maxStageCount * 100)}%` }} /></div><strong>{count}</strong>
        </div>)}</div> : <div className="empty-table"><strong>Aucune opportunité enregistrée</strong><p>Les étapes apparaîtront à partir des dossiers du pipeline.</p><Link href="/pipeline" className="text-action">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>}
        <div className="notice-box dashboard-conversion-note"><CircleHelp size={14} /> Aucun taux de conversion n’est affiché : le modèle ne fournit pas d’issue gagnée/perdue fiable par opportunité.</div>
      </article>
    </section>

    <section className="overview-grid dashboard-lower">
      <article className="panel">
        <div className="panel-head"><div><h2>Prochaines visites</h2><p>Visites d’aujourd’hui et futures · la date seule est disponible</p></div><Link href="/visites" className="text-action" data-testid="link-dashboard-visits">Voir l’agenda <ArrowRight size={13} /></Link></div>
        {upcomingVisits.length ? <div className="dashboard-visit-list" data-testid="dashboard-upcoming-visits">{upcomingVisits.map(({ item, dateKey, bucket }) => {
          const contact = contactsById.get(item.client_id);
          const property = propertiesById.get(item.property_id);
          return <article className="dashboard-visit-row" key={item.id} data-testid={`dashboard-visit-${item.id}`}>
            <div className="dashboard-visit-date"><strong>{formatVisitDate(dateKey)}</strong><span className={`visit-date-badge visit-date-${bucket}`}>{bucket === 'today' ? 'Aujourd’hui' : 'À venir'}</span></div>
            <div className="dashboard-visit-copy">
              {contact ? <Link href={`/contacts/${contact.id}`}>{formatContactName(contact)}</Link> : <strong>Contact indisponible</strong>}
              {property ? <Link href={`/biens/${property.id}`} className="dashboard-visit-property">{property.reference} · {property.title}</Link> : <small>Bien indisponible</small>}
              <small>{pipelineStageLabel(item.etape)} · aucun horaire enregistré</small>
            </div>
          </article>;
        })}</div> : <div className="empty-table"><strong>Aucune visite à venir</strong><p>Les visites apparaîtront ici lorsqu’une date future ou celle d’aujourd’hui sera enregistrée.</p></div>}
        <Link href="/visites" className="dashboard-unscheduled-link" data-testid="link-dashboard-unplanned">{visitPartition.unscheduledItems.length} opportunité(s) sans date de visite <ArrowRight size={13} /></Link>
      </article>
      <article className="panel">
        <div className="panel-head"><div><h2>Derniers enregistrements</h2><p>Biens, contacts et opportunités triés par created_at</p></div></div>
        {recentRecords.length ? <div className="dashboard-record-list" data-testid="dashboard-recent-records">{recentRecords.map((record) => <Link href={record.href} className="dashboard-record-row" key={record.id} data-testid={`dashboard-record-${record.id}`}>
          <span className="dashboard-record-kind">{record.type}</span><span className="dashboard-record-copy"><strong>{record.title}</strong><small>{record.detail}</small></span><span className="dashboard-record-date">{dateLabel(record.created_at)}</span>
        </Link>)}</div> : <div className="empty-table"><strong>Aucun enregistrement</strong><p>Les dossiers créés dans cette agence apparaîtront ici.</p></div>}
      </article>
    </section>
  </>;
}

function PageDataState({ loading, error, retry, count, emptyTitle, emptyText, testId }: { loading: boolean; error: unknown; retry: () => void; count: number; emptyTitle: string; emptyText: string; testId: string }) {
  if (loading) return <LoadingRows />;
  if (error) return <ErrorState error={error} retry={retry} />;
  if (!count) return <div className="state-card compact-empty" data-testid={testId}><div className="state-icon"><FileText size={19} /></div><span className="state-kicker">Votre espace</span><h2>{emptyTitle}</h2><p>{emptyText}</p></div>;
  return null;
}

const propertySchema = z.object({
  reference: z.string().trim().min(1, 'La référence est obligatoire'),
  title: z.string().trim().min(1, 'Le titre est obligatoire'),
  transaction_type: z.enum(['sale', 'rent', 'lease']),
  property_type: z.string().trim().min(1, 'Le type de bien est obligatoire'),
  price: z.coerce.number().refine(isPositiveFinitePrice, 'Le prix doit être un montant supérieur à zéro.'),
  currency: z.string().trim().min(1, 'La devise est obligatoire'),
  status: z.enum(['available', 'reserved', 'sold', 'rented', 'unavailable', 'draft', 'archived']),
  neighborhood: z.string().optional(), city: z.string().optional(), address: z.string().optional(),
  description: z.string().optional(),
  bedrooms: z.string().trim().optional().refine(isOptionalNonNegativeInteger, 'Le nombre de chambres doit être un entier positif ou nul'),
  bathrooms: z.string().trim().optional().refine(isOptionalNonNegativeInteger, 'Le nombre de salles d’eau doit être un entier positif ou nul'),
  area_m2: z.string().trim().optional().refine(isOptionalPositiveFiniteNumber, 'La surface doit être un nombre supérieur à zéro'),
});
type PropertyFormValues = z.infer<typeof propertySchema>;
function PropertyDialog({ open, onOpenChange, item, currency, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; item: PropertyRow | null; currency: string; onSaved?: (message: string) => void }) {
  const { activeAgencyId } = useAgency();
  const create = useCreateProperty(activeAgencyId); const update = useUpdateProperty(activeAgencyId);
  const form = useForm<PropertyFormValues>({ resolver: zodResolver(propertySchema), defaultValues: propertyFormDefaults(item, currency) });
  const [formError, setFormError] = useState('');
  useEffect(() => {
    if (!open) return;
    form.reset(propertyFormDefaults(item, currency));
    setFormError('');
  }, [open, item?.id, currency, form.reset]);
  const isBusy = create.isPending || update.isPending;
  const submit = async (values: PropertyFormValues) => {
    setFormError('');
    const input: PropertyCreateInput = { reference: values.reference, title: values.title, transaction_type: values.transaction_type, property_type: values.property_type, price: values.price, currency: values.currency, status: values.status, neighborhood: values.neighborhood || null, city: values.city || null, address: values.address || null, description: values.description || null, bedrooms: values.bedrooms ? Number(values.bedrooms) : null, bathrooms: values.bathrooms ? Number(values.bathrooms) : null, area_m2: values.area_m2 ? Number(values.area_m2) : null };
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, input });
        onOpenChange(false);
        onSaved?.(`Le bien « ${values.reference} » a été modifié.`);
      } else {
        await create.mutateAsync(input);
        onOpenChange(false);
        onSaved?.(`Le bien « ${values.reference} » a été créé.`);
      }
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item ? 'modifier le bien' : 'créer le bien'));
    }
  };
  return <Dialog open={open} onOpenChange={(v) => { if (!v) setFormError(''); onOpenChange(v); }}><DialogContent className="form-dialog"><DialogHeader><span className="form-kicker">Portefeuille immobilier</span><DialogTitle>{item ? 'Modifier le bien' : 'Ajouter un bien'}</DialogTitle><DialogDescription>Renseignez les informations connues. Aucun document ni photo n’est demandé ici.</DialogDescription></DialogHeader>
    <Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form">
      <div className="form-grid"><FormField control={form.control} name="reference" render={({ field }) => <FormItem><FormLabel>Référence</FormLabel><FormControl><Input {...field} required aria-required="true" data-testid="input-property-reference" placeholder="Ex. BI-024" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="title" render={({ field }) => <FormItem><FormLabel>Intitulé</FormLabel><FormControl><Input {...field} required aria-required="true" data-testid="input-property-title" placeholder="Villa, appartement…" /></FormControl><FormMessage /></FormItem>} /></div>
      <div className="form-grid"><FormField control={form.control} name="transaction_type" render={({ field }) => <FormItem><FormLabel>Transaction</FormLabel><FormControl><select {...field} required className="form-select" data-testid="select-property-transaction"><option value="sale">Vente</option><option value="rent">Location</option><option value="lease">Bail</option></select></FormControl></FormItem>} /><FormField control={form.control} name="property_type" render={({ field }) => <FormItem><FormLabel>Type de bien</FormLabel><FormControl><Input {...field} required aria-required="true" data-testid="input-property-type" placeholder="Villa, terrain…" /></FormControl><FormMessage /></FormItem>} /></div>
       <div className="form-grid three-col"><FormField control={form.control} name="price" render={({ field }) => <FormItem><FormLabel>Prix</FormLabel><FormControl><Input type="number" required aria-required="true" min="0.01" step="any" {...field} data-testid="input-property-price" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="currency" render={({ field }) => <FormItem><FormLabel>Devise</FormLabel><FormControl><select {...field} required className="form-select" data-testid="input-property-currency"><option value="XOF">FCFA (XOF)</option><option value="EUR">Euro (EUR)</option><option value="USD">Dollar (USD)</option>{field.value && !['XOF','EUR','USD'].includes(field.value) && <option value={field.value}>{field.value}</option>}</select></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="status" render={({ field }) => <FormItem><FormLabel>Statut</FormLabel><FormControl><select {...field} required className="form-select" data-testid="select-property-status">{Object.entries(propertyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormControl></FormItem>} /></div>
      <div className="form-grid"><FormField control={form.control} name="neighborhood" render={({ field }) => <FormItem><FormLabel>Quartier</FormLabel><FormControl><Input {...field} data-testid="input-property-neighborhood" /></FormControl></FormItem>} /><FormField control={form.control} name="city" render={({ field }) => <FormItem><FormLabel>Ville</FormLabel><FormControl><Input {...field} data-testid="input-property-city" /></FormControl></FormItem>} /></div>
       <div className="form-grid three-col">{(['bedrooms', 'bathrooms', 'area_m2'] as const).map((key) => <FormField key={key} control={form.control} name={key} render={({ field }) => <FormItem><FormLabel>{key === 'bedrooms' ? 'Chambres' : key === 'bathrooms' ? 'Salles d’eau' : 'Surface m²'}</FormLabel><FormControl><Input type="number" min={key === 'area_m2' ? '0.01' : '0'} step={key === 'area_m2' ? '0.01' : '1'} {...field} data-testid={`input-property-${key}`} /></FormControl><FormMessage /></FormItem>} />)}</div>
      <FormField control={form.control} name="address" render={({ field }) => <FormItem><FormLabel>Adresse</FormLabel><FormControl><Input {...field} data-testid="input-property-address" /></FormControl></FormItem>} /><FormField control={form.control} name="description" render={({ field }) => <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea {...field} data-testid="input-property-description" /></FormControl></FormItem>} />
      {formError && <p className="form-error" role="alert" data-testid="status-property-form-error">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-property">Annuler</Button><Button type="submit" disabled={isBusy} data-testid="button-submit-property">{isBusy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer le bien'}</Button></div>
    </form></Form>
  </DialogContent></Dialog>;
}

function PropertiesPage() {
  const { activeAgencyId, activeAgency } = useAgency();
  const query = useProperties(activeAgencyId);
  const [actionNotice, setActionNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const [neighborhood, setNeighborhood] = useState('all');
  const [currency, setCurrency] = useState('all');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [mode, setMode] = useState<'table' | 'cards'>('table');
  const [editing, setEditing] = useState<PropertyRow | null>(null);
  const [open, setOpen] = useState(false);
  const neighborhoods = [...new Set((query.data ?? []).map((p) => p.neighborhood).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b, 'fr'));
  const propertyTypes = [...new Set((query.data ?? []).map((p) => p.property_type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  const currencies = [...new Set((query.data ?? []).map((p) => p.currency).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  const priceFilterError = propertyPriceRangeError(minPrice, maxPrice, currency);
  const rows = useMemo(
    () => filterProperties(query.data ?? [], { search, status, kind, neighborhood, currency, minPrice, maxPrice }),
    [query.data, search, status, kind, neighborhood, currency, minPrice, maxPrice],
  );
  const openEditor = (item: PropertyRow | null) => {
    setActionNotice('');
    setEditing(item);
    setOpen(true);
  };
  const handlePropertySaved = (message: string) => setActionNotice(message);
  return <><Heading eyebrow="Portefeuille" title="Biens immobiliers" description="Consultez et tenez à jour les biens de votre agence." action={<ButtonPrimary testId="button-add-property" onClick={() => openEditor(null)}><Plus size={15} /> Ajouter un bien</ButtonPrimary>} />
    {actionNotice && <p className="form-feedback property-action-notice" role="status" data-testid="status-property-action">{actionNotice}</p>}
    <div className="permission-note property-delete-note" role="status" data-testid="status-property-delete-disabled"><ShieldCheck size={15} /><span>La suppression des biens reste désactivée tant que le mécanisme RPC requis n’a pas été confirmé.</span></div>
    <section className="list-toolbar property-toolbar"><label className="list-search"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Référence, type ou localisation" aria-label="Rechercher un bien" data-testid="input-search-properties" /></label><span className="result-count" data-testid="text-properties-count">{query.data ? `${rows.length} ${rows.length === 1 ? 'bien' : 'biens'}` : '—'}</span><div className="view-switch" aria-label="Mode d’affichage"><button type="button" className={mode==='table'?'selected':''} onClick={()=>setMode('table')} aria-label="Vue tableau"><List size={15}/></button><button type="button" className={mode==='cards'?'selected':''} onClick={()=>setMode('cards')} aria-label="Vue cartes"><LayoutGrid size={15}/></button></div></section>
    <section className="filter-strip" aria-label="Filtres des biens"><select className="form-select" value={status} onChange={(e)=>setStatus(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-property-status"><option value="all">Tous les statuts</option>{Object.entries(propertyStatus).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><select className="form-select" value={kind} onChange={(e)=>setKind(e.target.value)} aria-label="Filtrer par type ou transaction" data-testid="filter-property-type"><option value="all">Tous les types</option><option value="sale">Vente</option><option value="rent">Location</option><option value="lease">Bail</option>{propertyTypes.map((v)=><option key={v} value={v}>{v}</option>)}</select><select className="form-select" value={neighborhood} onChange={(e)=>setNeighborhood(e.target.value)} aria-label="Filtrer par quartier" data-testid="filter-property-neighborhood"><option value="all">Tous les quartiers</option>{neighborhoods.map((n)=><option key={n} value={n}>{n}</option>)}</select><select className="form-select" value={currency} onChange={(e)=>setCurrency(e.target.value)} aria-label="Filtrer par devise" data-testid="filter-property-currency"><option value="all">Toutes les devises</option>{currencies.map((value)=><option key={value} value={value}>{value === 'XOF' ? 'FCFA (XOF)' : value}</option>)}</select><Input type="number" min="0" step="any" value={minPrice} onChange={(e)=>setMinPrice(e.target.value)} placeholder="Prix minimum" aria-label="Prix minimum" data-testid="filter-property-min-price"/><Input type="number" min="0" step="any" value={maxPrice} onChange={(e)=>setMaxPrice(e.target.value)} placeholder="Prix maximum" aria-label="Prix maximum" data-testid="filter-property-max-price"/></section>
    {priceFilterError && <p className="form-error property-filter-error" role="alert" data-testid="status-property-price-filter-error">{priceFilterError}</p>}
    {query.isLoading || query.error || !query.data?.length ? <PageDataState loading={query.isLoading} error={query.error} retry={useSafeRetry(query)} count={query.data?.length ?? 0} emptyTitle="Votre portefeuille est encore vide" emptyText="Ajoutez un bien pour commencer à structurer votre portefeuille immobilier." testId="empty-properties" /> : rows.length ? mode === 'table' ? <div className="panel list-panel"><div className="table-wrap"><table className="data-table full-table"><thead><tr><th>Référence</th><th>Bien</th><th>Localisation</th><th>Transaction</th><th>Prix</th><th>Statut</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.map((p) => <tr key={p.id} data-testid={`row-property-${p.id}`}><td><Link href={`/biens/${p.id}`} className="table-primary-link"><strong>{p.reference}</strong></Link></td><td><Link href={`/biens/${p.id}`} className="table-primary-link"><strong>{p.title}</strong></Link><small>{p.property_type}</small></td><td>{p.neighborhood || '—'}<small>{p.city || '—'}</small></td><td>{p.transaction_type === 'sale' ? 'Vente' : p.transaction_type === 'rent' ? 'Location' : 'Bail'}</td><td>{formatPropertyPrice(p.price, p.currency)}</td><td><span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span></td><td><button type="button" className="row-action" onClick={() => openEditor(p)} aria-label={`Modifier ${p.title}`} data-testid={`button-edit-property-${p.id}`}><Pencil size={14} /><span>Modifier</span></button></td></tr>)}</tbody></table></div></div> : <div className="property-card-grid">{rows.map((p) => <article className="property-card" key={p.id}><div className="property-card-top"><span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span><span>{p.reference}</span></div><Link href={`/biens/${p.id}`} className="property-card-title"><h2>{p.title}</h2></Link><p>{p.property_type} · {p.neighborhood || p.city || 'Localisation non renseignée'}</p><strong className="property-card-price">{formatPropertyPrice(p.price, p.currency)}</strong><div className="property-card-foot"><span>{p.transaction_type==='sale'?'Vente':p.transaction_type==='rent'?'Location':'Bail'}</span><button type="button" className="row-action" onClick={() => openEditor(p)} aria-label={`Modifier ${p.title}`} data-testid={`button-edit-property-card-${p.id}`}><Pencil size={14}/> Modifier</button></div></article>)}</div> : <div className="state-card compact-empty" data-testid="empty-filtered-properties"><div className="state-icon"><Search size={19} /></div><h2>Aucun résultat pour ces filtres</h2><p>Essayez une autre référence, un autre quartier ou élargissez la fourchette de prix.</p><Button variant="outline" onClick={() => { setSearch(''); setStatus('all'); setKind('all'); setNeighborhood('all'); setCurrency('all'); setMinPrice(''); setMaxPrice(''); }} data-testid="button-clear-property-search">Effacer les filtres</Button></div>}
    <PropertyDialog key={editing?.id ?? 'new-property'} open={open} onOpenChange={setOpen} item={editing} currency={activeAgency?.currency ?? 'XOF'} onSaved={handlePropertySaved} />
  </>;
}

function ContactDialog({ open, onOpenChange, item, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; item: ContactRow | null; onSaved?: (message: string) => void }) {
  const { activeAgencyId } = useAgency();
  const create = useCreateContact(activeAgencyId);
  const update = useUpdateContact(activeAgencyId);
  const roster = useAgencyRoster(activeAgencyId);
  const assignableMembers = getAssignableContactMembers(roster.data ?? []);
  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: contactFormDefaults(item),
  });
  const [formError, setFormError] = useState('');
  useEffect(() => {
    if (!open) return;
    form.reset(contactFormDefaults(item));
    setFormError('');
  }, [open, item?.id, form.reset]);
  const busy = create.isPending || update.isPending;
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setFormError('');
    onOpenChange(nextOpen);
  };
  const submit = async (values: ContactFormValues) => {
    setFormError('');
    if (!canAssignContactToMember(values.assigned_user_id, roster.data ?? [], item?.assigned_user_id)) {
      setFormError('Choisissez un membre actif avec un rôle opérationnel pour une nouvelle affectation.');
      return;
    }
    const input: ContactCreateInput = {
      first_name: values.first_name,
      last_name: values.last_name || null,
      phone: values.phone || null,
      email: values.email || null,
      whatsapp_number: values.whatsapp_number || null,
      status: values.status,
      assigned_user_id: values.assigned_user_id || null,
      source: values.source || null,
      notes: values.notes || null,
    };
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, input });
        handleOpenChange(false);
        onSaved?.(`Le contact « ${formatContactName({ first_name: values.first_name, last_name: values.last_name ?? null })} » a été modifié.`);
      } else {
        await create.mutateAsync(input);
        handleOpenChange(false);
        onSaved?.(`Le contact « ${formatContactName({ first_name: values.first_name, last_name: values.last_name ?? null })} » a été créé.`);
      }
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item ? 'modifier le contact' : 'créer le contact'));
    }
  };
  return <Dialog open={open} onOpenChange={handleOpenChange}><DialogContent className="form-dialog"><DialogHeader><span className="form-kicker">Carnet de contacts</span><DialogTitle>{item ? 'Modifier le contact' : 'Nouveau contact'}</DialogTitle><DialogDescription>Enregistrez les coordonnées et le statut du suivi. Les conversations ne sont pas gérées dans ce module.</DialogDescription></DialogHeader><Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form" noValidate>
    <div className="form-grid"><FormField control={form.control} name="first_name" render={({ field }) => <FormItem><FormLabel>Prénom</FormLabel><FormControl><Input {...field} required aria-required="true" data-testid="input-contact-first-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="last_name" render={({ field }) => <FormItem><FormLabel>Nom</FormLabel><FormControl><Input {...field} data-testid="input-contact-last-name" /></FormControl></FormItem>} /></div>
    <div className="form-grid"><FormField control={form.control} name="phone" render={({ field }) => <FormItem><FormLabel>Téléphone</FormLabel><FormControl><Input {...field} type="tel" autoComplete="tel" data-testid="input-contact-phone" /></FormControl></FormItem>} /><FormField control={form.control} name="whatsapp_number" render={({ field }) => <FormItem><FormLabel>Numéro WhatsApp</FormLabel><FormControl><Input {...field} type="tel" data-testid="input-contact-whatsapp" /></FormControl></FormItem>} /></div>
    <div className="form-grid"><FormField control={form.control} name="email" render={({ field }) => <FormItem><FormLabel>E-mail</FormLabel><FormControl><Input type="email" autoComplete="email" {...field} data-testid="input-contact-email" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="status" render={({ field }) => <FormItem><FormLabel>Statut</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-contact-status">{Object.entries(contactStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormControl></FormItem>} /></div>
    <FormField control={form.control} name="assigned_user_id" render={({ field }) => <FormItem><FormLabel>Responsable de suivi</FormLabel><FormControl><select {...field} value={field.value ?? ''} className="form-select" disabled={roster.isLoading} data-testid="select-contact-assignee"><option value="">Non affecté</option>{item?.assigned_user_id && !assignableMembers.some((member) => member.user_id === item.assigned_user_id) && <option value={item.assigned_user_id}>Affectation actuelle · …{item.assigned_user_id.slice(-4)}</option>}{assignableMembers.map((member) => <option key={member.user_id} value={member.user_id}>{agencyMemberLabel(member)}</option>)}</select></FormControl><FormMessage />{roster.error ? <p className="form-help contact-roster-error" role="status">Impossible de vérifier les membres actifs. <button type="button" onClick={() => void roster.refetch()} data-testid="button-retry-contact-roster">Réessayer</button></p> : <p className="form-help">Seuls les membres actifs avec un rôle opérationnel sont proposés. Les noms et profils personnels restent masqués.{item?.assigned_user_id && !assignableMembers.some((member) => member.user_id === item.assigned_user_id) ? ' L’affectation existante est conservée, mais ne peut pas être choisie pour une nouvelle attribution.' : ''}</p>}</FormItem>} />
    <FormField control={form.control} name="source" render={({ field }) => <FormItem><FormLabel>Origine du contact</FormLabel><FormControl><Input {...field} data-testid="input-contact-source" placeholder="Recommandation, annonce…" /></FormControl></FormItem>} /><FormField control={form.control} name="notes" render={({ field }) => <FormItem><FormLabel>Notes de suivi</FormLabel><FormControl><Textarea {...field} data-testid="input-contact-notes" /></FormControl></FormItem>} />
    {formError && <p className="form-error" role="alert" data-testid="status-contact-form-error">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => handleOpenChange(false)} data-testid="button-cancel-contact">Annuler</Button><Button type="submit" disabled={busy} data-testid="button-submit-contact">{busy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer le contact'}</Button></div>
  </form></Form></DialogContent></Dialog>;
}
function ContactsPage() {
  const { activeAgencyId } = useAgency();
  const query = useContacts(activeAgencyId);
  const roster = useAgencyRoster(activeAgencyId);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ContactStatus | 'all'>('all');
  const [assignedUserId, setAssignedUserId] = useState('all');
  const [editing, setEditing] = useState<ContactRow | null>(null);
  const [open, setOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const rows = useMemo(
    () => filterContacts(query.data ?? [], { search, status, assignedUserId }),
    [query.data, search, status, assignedUserId],
  );
  const assignedUserIds = useMemo(
    () => new Set((query.data ?? []).map((contact) => contact.assigned_user_id).filter((id): id is string => Boolean(id))),
    [query.data],
  );
  const assignedMembers = (roster.data ?? []).filter((member) => assignedUserIds.has(member.user_id));
  const knownMemberIds = new Set((roster.data ?? []).map((member) => member.user_id));
  const unknownAssigneeIds = [...assignedUserIds].filter((id) => !knownMemberIds.has(id));
  const openEditor = (item: ContactRow | null) => {
    setActionNotice('');
    setEditing(item);
    setOpen(true);
  };
  const clearFilters = () => {
    setSearch('');
    setStatus('all');
    setAssignedUserId('all');
  };
  return <><Heading eyebrow="Relation client" title="Prospects et contacts" description="Recherchez les coordonnées, le statut et les opportunités associées aux contacts de votre agence." action={<ButtonPrimary testId="button-add-contact" onClick={() => openEditor(null)}><Plus size={15} /> Nouveau contact</ButtonPrimary>} />
    {actionNotice && <p className="form-feedback contact-action-notice" role="status" data-testid="status-contact-action">{actionNotice}</p>}
    {roster.error && <p className="contact-roster-warning" role="status" data-testid="status-contact-roster-error">Les responsables ne peuvent pas être vérifiés pour le moment. <button type="button" onClick={() => void roster.refetch()} data-testid="button-retry-contact-roster-list">Réessayer</button></p>}
    <section className="list-toolbar contacts-toolbar" aria-label="Recherche et filtres des contacts">
      <label className="list-search"><Search size={15} /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nom, téléphone, e-mail, WhatsApp ou origine" aria-label="Rechercher un contact" data-testid="input-search-contacts" /></label>
      <div className="contact-filter-controls">
        <select className="form-select" value={status} onChange={(event) => setStatus(event.target.value as ContactStatus | 'all')} aria-label="Filtrer par statut" data-testid="filter-contact-status"><option value="all">Tous les statuts</option>{Object.entries(contactStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select className="form-select" value={assignedUserId} onChange={(event) => setAssignedUserId(event.target.value)} aria-label="Filtrer par responsable" data-testid="filter-contact-assignee" disabled={roster.isLoading}><option value="all">Tous les responsables</option><option value="unassigned">Non affectés</option>{assignedMembers.map((member) => <option key={member.user_id} value={member.user_id}>{agencyMemberLabel(member)}</option>)}{unknownAssigneeIds.map((userId) => <option key={userId} value={userId}>Membre indisponible · …{userId.slice(-4)}</option>)}</select>
      </div>
      <span className="result-count" data-testid="text-contacts-count">{query.data ? `${rows.length} / ${query.data.length} contacts` : '—'}</span>
    </section>
    {query.isLoading || query.error || !query.data?.length ? <PageDataState loading={query.isLoading} error={query.error} retry={useSafeRetry(query)} count={query.data?.length ?? 0} emptyTitle="Aucun contact dans votre espace" emptyText="Ajoutez un contact après votre premier échange. Les fiches resteront privées à votre agence." testId="empty-contacts" /> : rows.length ? <div className="panel list-panel"><div className="table-wrap"><table className="data-table full-table"><thead><tr><th>Contact</th><th>Coordonnées</th><th>Origine</th><th>Responsable</th><th>Statut</th><th>Ajouté le</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.map((contact) => <tr key={contact.id} data-testid={`row-contact-${contact.id}`}><td><Link href={`/contacts/${contact.id}`} className="contact-cell table-contact-link"><span className="contact-avatar">{`${contact.first_name[0] ?? ''}${contact.last_name?.[0] ?? ''}`.toUpperCase()}</span><div><strong>{formatContactName(contact)}</strong><small>Ouvrir la fiche</small></div></Link></td><td><div className="contact-channels">{contact.phone && <span>{contact.phone}</span>}{contact.email && <span>{contact.email}</span>}{contact.whatsapp_number && <small>WhatsApp · {contact.whatsapp_number}</small>}{!contact.phone && !contact.email && !contact.whatsapp_number && <span className="contact-channel-empty">Coordonnées non renseignées</span>}</div></td><td>{contact.source || '—'}</td><td>{contact.assigned_user_id ? roster.isLoading ? 'Chargement…' : agencyMemberLabel(roster.data?.find((member) => member.user_id === contact.assigned_user_id)) : 'Non affecté'}</td><td><span className={`status-pill status-${contact.status}`}>{contactStatus[contact.status] ?? contact.status}</span></td><td>{dateLabel(contact.created_at)}</td><td><button type="button" className="row-action" onClick={() => openEditor(contact)} aria-label={`Modifier ${formatContactName(contact)}`} data-testid={`button-edit-contact-${contact.id}`}><Pencil size={14} /><span>Modifier</span></button></td></tr>)}</tbody></table></div></div> : <div className="state-card compact-empty" data-testid="empty-filtered-contacts"><div className="state-icon"><Search size={19} /></div><h2>Aucun contact correspondant</h2><p>Modifiez la recherche, le statut ou le responsable sélectionné.</p><Button variant="outline" onClick={clearFilters} data-testid="button-clear-contact-search">Effacer les filtres</Button></div>}
    <ContactDialog key={editing?.id ?? 'new-contact'} open={open} onOpenChange={setOpen} item={editing} onSaved={setActionNotice} />
  </>;
}

type PipelineDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: SalesPipelineRow | null;
  contacts: ContactRow[];
  properties: PropertyRow[];
  stageSuggestions: string[];
  onSaved?: (message: string) => void;
};

function PipelineDialog({ open, onOpenChange, item, contacts, properties, stageSuggestions, onSaved }: PipelineDialogProps) {
  const { activeAgencyId } = useAgency();
  const create = useCreatePipelineItem(activeAgencyId);
  const update = useUpdatePipelineItem(activeAgencyId);
  const [formError, setFormError] = useState('');
  const form = useForm<PipelineFormValues>({
    resolver: zodResolver(pipelineFormSchema),
    defaultValues: {
      client_id: item?.client_id ?? '',
      property_id: item?.property_id ?? '',
      etape: item?.etape ?? '',
      probabilite: item?.probabilite ?? 0,
      date_visite: visitDateKey(item?.date_visite) ?? '',
      notes: item?.notes ?? '',
    },
  });
  useEffect(() => {
    if (!open) return;
    form.reset({
      client_id: item?.client_id ?? '',
      property_id: item?.property_id ?? '',
      etape: item?.etape ?? '',
      probabilite: item?.probabilite ?? 0,
      date_visite: visitDateKey(item?.date_visite) ?? '',
      notes: item?.notes ?? '',
    });
    setFormError('');
  }, [open, item?.id, form.reset]);

  const busy = create.isPending || update.isPending;
  const submit = async (values: PipelineFormValues) => {
    setFormError('');
    if (!contacts.some((contact) => contact.id === values.client_id) && item?.client_id !== values.client_id) {
      setFormError('Le contact choisi n’est pas visible dans l’agence active. Le dossier n’a pas été enregistré.');
      return;
    }
    if (!properties.some((property) => property.id === values.property_id) && item?.property_id !== values.property_id) {
      setFormError('Le bien choisi n’est pas visible dans l’agence active. Le dossier n’a pas été enregistré.');
      return;
    }
    const input: PipelineCreateInput = {
      client_id: values.client_id,
      property_id: values.property_id,
      etape: values.etape,
      probabilite: values.probabilite,
      date_visite: values.date_visite || null,
      notes: values.notes || null,
    };
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, input });
        onOpenChange(false);
        onSaved?.('L’opportunité a été modifiée. Les indicateurs du pipeline et du tableau de bord seront actualisés.');
      } else {
        await create.mutateAsync(input);
        onOpenChange(false);
        onSaved?.('L’opportunité a été créée. Les indicateurs du pipeline et du tableau de bord seront actualisés.');
      }
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item ? 'modifier l’opportunité' : 'créer l’opportunité'));
    }
  };
  const missingContact = Boolean(item?.client_id && !contacts.some((contact) => contact.id === item.client_id));
  const missingProperty = Boolean(item?.property_id && !properties.some((property) => property.id === item.property_id));
  const invalidStoredDate = Boolean(item?.date_visite?.trim() && !visitDateKey(item.date_visite));

  return <Dialog open={open} onOpenChange={(value) => { if (!value) setFormError(''); onOpenChange(value); }}>
    <DialogContent className="form-dialog">
      <DialogHeader><span className="form-kicker">Suivi commercial</span><DialogTitle>{item ? 'Modifier l’opportunité' : 'Nouvelle opportunité'}</DialogTitle><DialogDescription>Associez un contact et un bien réellement visibles dans l’agence active. Les étapes restent libres, comme dans le modèle existant.</DialogDescription></DialogHeader>
      <Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form" noValidate>
        <FormField control={form.control} name="client_id" render={({ field }) => <FormItem><FormLabel>Contact</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-pipeline-contact"><option value="">Choisir un contact</option>{missingContact && <option value={item?.client_id}>Contact indisponible · relation existante</option>}{contacts.map((contact) => <option key={contact.id} value={contact.id}>{formatContactName(contact)}</option>)}</select></FormControl><FormMessage /></FormItem>} />
        <FormField control={form.control} name="property_id" render={({ field }) => <FormItem><FormLabel>Bien concerné</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-pipeline-property"><option value="">Choisir un bien</option>{missingProperty && <option value={item?.property_id}>Bien indisponible · relation existante</option>}{properties.map((property) => <option key={property.id} value={property.id}>{property.reference} · {property.title}</option>)}</select></FormControl><FormMessage /></FormItem>} />
        <div className="form-grid">
          <FormField control={form.control} name="etape" render={({ field }) => <FormItem><FormLabel>Étape</FormLabel><FormControl><Input {...field} list="pipeline-stage-suggestions" placeholder="Saisissez l’étape utilisée" data-testid="input-pipeline-stage" /></FormControl><datalist id="pipeline-stage-suggestions">{stageSuggestions.map((stage) => <option key={stage} value={stage} />)}</datalist><FormMessage /></FormItem>} />
          <FormField control={form.control} name="probabilite" render={({ field }) => <FormItem><FormLabel>Probabilité (%)</FormLabel><FormControl><Input type="number" min="0" max="100" step="any" {...field} data-testid="input-pipeline-probability" /></FormControl><FormMessage /></FormItem>} />
        </div>
        <FormField control={form.control} name="date_visite" render={({ field }) => <FormItem><FormLabel>Date de visite</FormLabel><FormControl><Input type="date" {...field} data-testid="input-pipeline-visit-date" /></FormControl><p className="form-hint">Date du calendrier uniquement; aucun horaire n’est enregistré.</p><FormMessage /></FormItem>} />
        {invalidStoredDate && <p className="visit-data-warning" role="status" data-testid="status-pipeline-invalid-stored-date">La date déjà enregistrée est invalide. Choisissez une date valide ou laissez le champ vide pour l’effacer.</p>}
        <FormField control={form.control} name="notes" render={({ field }) => <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea {...field} data-testid="input-pipeline-notes" /></FormControl><FormMessage /></FormItem>} />
        {formError && <p className="form-error" role="alert" data-testid="status-pipeline-form-error">{formError}</p>}
        <div className="form-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-pipeline">Annuler</Button><Button type="submit" disabled={busy} data-testid="button-submit-pipeline">{busy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer l’opportunité'}</Button></div>
      </form></Form>
    </DialogContent>
  </Dialog>;
}

function PipelineOpportunityCard({ item, contact, property, compact = false, onEdit }: {
  item: SalesPipelineRow;
  contact?: ContactRow;
  property?: PropertyRow;
  compact?: boolean;
  onEdit: () => void;
}) {
  const dateKey = visitDateKey(item.date_visite);
  const visitLabel = dateKey ? formatVisitDate(dateKey) : item.date_visite?.trim() ? 'Date à vérifier' : 'Sans date de visite';
  return <article className={`pipeline-card${compact ? ' pipeline-card-compact' : ''}`} data-testid={`card-pipeline-${item.id}`}>
    <div className="pipeline-stage"><span className="stage-marker" /><span>{pipelineStageLabel(item.etape)}</span><small>{item.probabilite}% de probabilité</small></div>
    <div className="pipeline-main">
      <div className="pipeline-related-block"><span className="pipeline-label">CONTACT</span>{contact ? <Link href={`/contacts/${contact.id}`} className="pipeline-related-link">{formatContactName(contact)}</Link> : <strong>Contact inaccessible</strong>}<small>{contact?.phone || contact?.email || 'Coordonnées non renseignées'}</small></div>
      <ArrowRight className="pipeline-arrow" size={17} />
      <div className="pipeline-related-block"><span className="pipeline-label">BIEN</span>{property ? <Link href={`/biens/${property.id}`} className="pipeline-related-link">{property.title}</Link> : <strong>Bien inaccessible</strong>}<small>{property ? `${property.reference} · ${property.neighborhood || property.city || 'Localisation non renseignée'}` : 'Bien non visible dans l’agence active'}</small></div>
    </div>
    {item.notes?.trim() && <p className="pipeline-card-notes">{item.notes}</p>}
    <div className="pipeline-meta">
      <div className="pipeline-meta-summary"><span><SlidersHorizontal size={13} /> {item.probabilite}%</span><span><CalendarDays size={13} /> Visite : {visitLabel}</span></div>
      <button type="button" className="row-action" onClick={onEdit} aria-label={`Modifier l’opportunité liée à ${contact ? formatContactName(contact) : 'ce dossier'}`} data-testid={`button-edit-pipeline-${item.id}`}><Pencil size={14} /> Modifier</button>
    </div>
  </article>;
}

function PipelinePage() {
  const { activeAgencyId } = useAgency();
  const query = usePipeline(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const propertiesQ = useProperties(activeAgencyId);
  const rosterQ = useAgencyRoster(activeAgencyId);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('all');
  const [assignedUserId, setAssignedUserId] = useState('all');
  const [datePresence, setDatePresence] = useState<'all' | 'scheduled' | 'unscheduled'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [editing, setEditing] = useState<SalesPipelineRow | null>(null);
  const [open, setOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const contacts = contactsQ.data ?? [];
  const properties = propertiesQ.data ?? [];
  const opportunities = query.data ?? [];
  const contactsById = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact])), [contacts]);
  const propertiesById = useMemo(() => new Map(properties.map((property) => [property.id, property])), [properties]);
  const stages = useMemo(() => getPipelineStages(opportunities), [opportunities]);
  const stageSuggestions = stages.filter((value) => value !== 'Étape non renseignée');
  const dateError = pipelineDateRangeError(dateFrom, dateTo);
  const rows = useMemo(() => filterPipelineItems(opportunities, contacts, properties, {
    search, stage, assignedUserId, datePresence, dateFrom, dateTo,
  }), [opportunities, contacts, properties, search, stage, assignedUserId, datePresence, dateFrom, dateTo]);
  const stageGroups = useMemo(() => groupPipelineByStage(rows), [rows]);
  const usedAssigneeIds = useMemo(() => [...new Set(contacts.map((contact) => contact.assigned_user_id).filter((value): value is string => Boolean(value)))].sort(), [contacts]);
  const usedAssigneeSet = new Set(usedAssigneeIds);
  const assignedMembers = (rosterQ.data ?? [])
    .filter((member) => usedAssigneeSet.has(member.user_id))
    .sort((left, right) => agencyMemberLabel(left).localeCompare(agencyMemberLabel(right), 'fr'));
  const knownMemberIds = new Set(assignedMembers.map((member) => member.user_id));
  const unknownAssigneeIds = usedAssigneeIds.filter((userId) => !knownMemberIds.has(userId));
  const loading = query.isLoading || contactsQ.isLoading || propertiesQ.isLoading;
  const error = query.error || contactsQ.error || propertiesQ.error;
  const retry = () => {
    void query.refetch();
    void contactsQ.refetch();
    void propertiesQ.refetch();
    void rosterQ.refetch();
  };
  const clearFilters = () => {
    setSearch('');
    setStage('all');
    setAssignedUserId('all');
    setDatePresence('all');
    setDateFrom('');
    setDateTo('');
  };
  const hasFilters = Boolean(search || stage !== 'all' || assignedUserId !== 'all' || datePresence !== 'all' || dateFrom || dateTo);
  const openEditor = (item: SalesPipelineRow | null) => {
    setActionNotice('');
    setEditing(item);
    setOpen(true);
  };

  return <>
    <Heading eyebrow="Développement commercial" title="Pipeline commercial" description="Suivez les opportunités par étapes observées, avec leurs contacts, biens et dates de visite liés." action={<ButtonPrimary testId="button-add-pipeline" onClick={() => openEditor(null)} disabled={!contacts.length || !properties.length}><Plus size={15} /> Nouvelle opportunité</ButtonPrimary>} />
    {actionNotice && <p className="form-feedback pipeline-action-notice" role="status" data-testid="status-pipeline-action">{actionNotice}</p>}
    {rosterQ.error && <p className="contact-roster-warning" role="status" data-testid="status-pipeline-roster-error">Le responsable du contact ne peut pas être vérifié pour le moment; les autres filtres restent disponibles. <button type="button" onClick={() => void rosterQ.refetch()} data-testid="button-retry-pipeline-roster">Réessayer</button></p>}
    <section className="pipeline-toolbar" aria-label="Recherche et filtres des opportunités">
      <label className="list-search pipeline-search"><Search size={15} /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Contact, coordonnées, bien, étape ou note" aria-label="Rechercher une opportunité" data-testid="input-search-pipeline" /></label>
      <select className="form-select pipeline-stage-filter" value={stage} onChange={(event) => setStage(event.target.value)} aria-label="Filtrer par étape" data-testid="filter-pipeline-stage"><option value="all">Toutes les étapes</option>{stages.map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <select className="form-select pipeline-assignee-filter" value={assignedUserId} onChange={(event) => setAssignedUserId(event.target.value)} aria-label="Filtrer par responsable du contact" data-testid="filter-pipeline-assignee" disabled={rosterQ.isLoading || Boolean(rosterQ.error)}><option value="all">Tous les responsables</option><option value="unassigned">Contact non affecté</option>{assignedMembers.map((member) => <option key={member.user_id} value={member.user_id}>{agencyMemberLabel(member)}</option>)}{unknownAssigneeIds.map((userId) => <option key={userId} value={userId}>Membre indisponible · …{userId.slice(-4)}</option>)}</select>
      <select className="form-select pipeline-date-filter" value={datePresence} onChange={(event) => setDatePresence(event.target.value as 'all' | 'scheduled' | 'unscheduled')} aria-label="Filtrer par présence d’une date de visite" data-testid="filter-pipeline-date-presence"><option value="all">Toutes les dates</option><option value="scheduled">Avec date de visite</option><option value="unscheduled">Sans date de visite</option></select>
      <div className="pipeline-date-range" aria-label="Filtrer par période de visite"><label><span>Du</span><Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="Date de visite à partir du" data-testid="filter-pipeline-date-from" /></label><label><span>Au</span><Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="Date de visite jusqu’au" data-testid="filter-pipeline-date-to" /></label></div>
      <div className="pipeline-toolbar-tail"><span className="result-count" data-testid="text-pipeline-count">{query.data ? `${rows.length} / ${opportunities.length} opportunité(s)` : '—'}</span>{hasFilters && <button type="button" className="pipeline-clear-button" onClick={clearFilters} data-testid="button-clear-pipeline-filters"><X size={12} /> Effacer</button>}<div className="pipeline-view-toggle" role="group" aria-label="Mode d’affichage"><button type="button" className={view === 'board' ? 'is-active' : ''} aria-pressed={view === 'board'} onClick={() => setView('board')} data-testid="button-pipeline-board-view"><LayoutGrid size={14} /><span>Étapes</span></button><button type="button" className={view === 'list' ? 'is-active' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')} data-testid="button-pipeline-list-view"><List size={14} /><span>Liste</span></button></div></div>
    </section>
    {dateError && <p className="pipeline-filter-error" role="alert" data-testid="status-pipeline-date-filter-error">{dateError}</p>}
    <p className="pipeline-stage-note">Les colonnes reprennent les étapes déjà enregistrées; le modèle ne définit ni ordre de transition ni statut gagné/perdu.</p>
    {loading || error || !opportunities.length ? <PageDataState loading={loading} error={error} retry={retry} count={opportunities.length} emptyTitle="Aucune opportunité en cours" emptyText={contacts.length && properties.length ? 'Créez un dossier pour relier un contact à un bien et suivre les dates de visite.' : 'Pour ouvrir une opportunité, l’agence doit disposer d’au moins un contact et un bien visibles.'} testId="empty-pipeline" /> : dateError ? <div className="state-card compact-empty" data-testid="empty-pipeline-date-range"><div className="state-icon"><CalendarDays size={19} /></div><h2>Période de dates à corriger</h2><p>{dateError}</p></div> : rows.length ? view === 'board' ? <div className="pipeline-board" aria-label="Opportunités regroupées par étape" data-testid="pipeline-board">
      {stageGroups.map(({ stage: stageName, items }, index) => <section className="pipeline-column" key={stageName} aria-label={`${stageName} · ${items.length} opportunité(s)`} data-testid={`column-pipeline-stage-${index}`}>
        <div className="pipeline-column-head"><div><h2>{stageName}</h2><span>{items.length} {items.length === 1 ? 'opportunité' : 'opportunités'}</span></div><span className="stage-marker" aria-hidden="true" /></div>
        <div className="pipeline-column-cards">{items.map((item) => <PipelineOpportunityCard key={item.id} item={item} contact={contactsById.get(item.client_id)} property={propertiesById.get(item.property_id)} compact onEdit={() => openEditor(item)} />)}</div>
      </section>)}
    </div> : <div className="pipeline-list">{rows.map((item) => <PipelineOpportunityCard key={item.id} item={item} contact={contactsById.get(item.client_id)} property={propertiesById.get(item.property_id)} onEdit={() => openEditor(item)} />)}</div> : <div className="state-card compact-empty" data-testid="empty-filtered-pipeline"><div className="state-icon"><Search size={19} /></div><h2>Aucune opportunité correspondante</h2><p>Modifiez la recherche ou les filtres par étape, responsable du contact et date de visite.</p><Button variant="outline" onClick={clearFilters} data-testid="button-clear-pipeline-search">Effacer les filtres</Button></div>}
    <PipelineDialog key={editing?.id ?? 'new-pipeline'} open={open} onOpenChange={setOpen} item={editing} contacts={contacts} properties={properties} stageSuggestions={stageSuggestions} onSaved={setActionNotice} />
  </>;
}

type VisitFilter = 'all' | 'upcoming' | 'past';

function VisitsPage() {
  const { activeAgencyId } = useAgency();
  const pipelineQ = usePipeline(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const propertiesQ = useProperties(activeAgencyId);
  const [filter, setFilter] = useState<VisitFilter>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<SalesPipelineRow | null>(null);
  const [open, setOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const todayKey = localDateKey() ?? '';
  const contacts = contactsQ.data ?? [];
  const properties = propertiesQ.data ?? [];
  const contactsById = useMemo(() => {
    const map = new Map<string, ContactRow>();
    contacts.forEach((contact) => map.set(contact.id, contact));
    return map;
  }, [contacts]);
  const propertiesById = useMemo(() => {
    const map = new Map<string, PropertyRow>();
    properties.forEach((property) => map.set(property.id, property));
    return map;
  }, [properties]);
  const visitPartition = useMemo(
    () => partitionPipelineVisits(pipelineQ.data ?? [], todayKey),
    [pipelineQ.data, todayKey],
  );
  const { scheduledVisits, unscheduledItems, invalidDateCount, todayCount, upcomingCount, pastCount } = visitPartition;
  const stageSuggestions = useMemo(
    () => getPipelineStages(pipelineQ.data ?? []).filter((stage) => stage !== 'Étape non renseignée'),
    [pipelineQ.data],
  );
  const openEditor = (item: SalesPipelineRow) => {
    setActionNotice('');
    setEditing(item);
    setOpen(true);
  };
  const filteredVisits = useMemo(() => {
    const searchText = search.trim().toLocaleLowerCase('fr');
    return scheduledVisits
      .filter(({ item, bucket }) => {
        const contact = contactsById.get(item.client_id);
        const property = propertiesById.get(item.property_id);
        const searchable = [
          contact?.first_name,
          contact?.last_name,
          contact?.phone,
          contact?.email,
          property?.reference,
          property?.title,
          property?.neighborhood,
          property?.city,
          item.etape,
        ].join(' ').toLocaleLowerCase('fr');
        const matchesSearch = !searchText || searchable.includes(searchText);
        const matchesFilter = filter === 'all'
          || (filter === 'upcoming' && bucket !== 'past')
          || (filter === 'past' && bucket === 'past');
        return matchesSearch && matchesFilter;
      })
      .sort((left, right) => {
        const leftIsPast = left.bucket === 'past';
        const rightIsPast = right.bucket === 'past';
        if (leftIsPast !== rightIsPast) return leftIsPast ? 1 : -1;
        if (filter === 'past') return right.dateKey.localeCompare(left.dateKey);
        return left.dateKey.localeCompare(right.dateKey);
      });
  }, [scheduledVisits, contactsById, propertiesById, search, filter]);
  const loading = pipelineQ.isLoading || contactsQ.isLoading || propertiesQ.isLoading;
  const error = pipelineQ.error || contactsQ.error || propertiesQ.error;
  const retry = () => {
    void pipelineQ.refetch();
    void contactsQ.refetch();
    void propertiesQ.refetch();
  };

  if (loading) return <><Heading eyebrow="Agenda commerciale" title="Visites" description="Les dates de visite enregistrées dans les opportunités de votre agence." /><LoadingRows /></>;
  if (error) return <><Heading eyebrow="Agenda commerciale" title="Visites" description="Les visites ne sont pas disponibles pour le moment." /><ErrorState error={error} retry={retry} testId="status-visits-error" /></>;

  const visitFilters: { value: VisitFilter; label: string }[] = [
    { value: 'all', label: 'Toutes' },
    { value: 'upcoming', label: 'À venir' },
    { value: 'past', label: 'Passées' },
  ];

  return <>
    <Heading
      eyebrow="Agenda commerciale"
      title="Visites"
      description="Dates renseignées dans les opportunités. Le modèle actuel ne contient ni horaire ni statut de visite dédié."
      action={<Link href="/pipeline" className="button-link" data-testid="link-visits-manage-pipeline"><SlidersHorizontal size={14} /> Gérer le pipeline</Link>}
    />
    {actionNotice && <p className="form-feedback pipeline-action-notice" role="status" data-testid="status-visit-pipeline-action">{actionNotice}</p>}
    <section className="visit-summary-grid" aria-label="Résumé des visites">
      <article className="visit-summary-card"><span className="visit-summary-icon"><CalendarDays size={15} /></span><div><strong>{todayCount}</strong><span>Aujourd’hui</span></div></article>
      <article className="visit-summary-card"><span className="visit-summary-icon"><Clock3 size={15} /></span><div><strong>{upcomingCount}</strong><span>À venir</span></div></article>
      <article className="visit-summary-card"><span className="visit-summary-icon is-muted"><CalendarDays size={15} /></span><div><strong>{pastCount}</strong><span>Passées</span></div></article>
    </section>
    <section className="list-toolbar visit-toolbar">
      <label className="list-search"><Search size={15} /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Contact, bien ou étape" aria-label="Rechercher une visite" data-testid="input-search-visits" /></label>
      <div className="visit-filter-tabs" role="group" aria-label="Filtrer les visites">
        {visitFilters.map((visitFilter) => <button key={visitFilter.value} type="button" className={filter === visitFilter.value ? 'is-active' : ''} aria-pressed={filter === visitFilter.value} onClick={() => setFilter(visitFilter.value)} data-testid={`filter-visits-${visitFilter.value}`}>{visitFilter.label}</button>)}
      </div>
      <span className="result-count" data-testid="text-visits-count">{filteredVisits.length} / {scheduledVisits.length} visites</span>
    </section>
    {invalidDateCount > 0 && <p className="visit-data-warning" role="status" data-testid="status-invalid-visit-dates">{invalidDateCount} date(s) de visite ne peuvent pas être lues. Vérifiez-les dans le dossier concerné.</p>}

    <div className="visit-content-layout">
      <section className="visit-schedule" aria-label="Agenda des visites">
        {scheduledVisits.length === 0 ? <div className="state-card visit-empty-state" data-testid="empty-visits">
          <div className="state-icon"><CalendarDays size={19} /></div>
          <span className="state-kicker">Agenda des opportunités</span>
          <h2>{!pipelineQ.data?.length ? 'Aucune opportunité à planifier' : invalidDateCount ? 'Aucune date valide trouvée' : 'Aucune date de visite renseignée'}</h2>
          <p>{pipelineQ.data?.length ? invalidDateCount ? `${unscheduledItems.length} opportunité(s) sans date et ${invalidDateCount} valeur(s) à vérifier. Corrigez-les dans les dossiers du pipeline.` : `${unscheduledItems.length} opportunité(s) sans date de visite. Vous pouvez les planifier depuis le panneau voisin ou le pipeline.` : 'Créez une opportunité dans le pipeline, puis ajoutez sa date de visite.'}</p>
          <Link href="/pipeline" className="button-link" data-testid="link-empty-visits-pipeline">{pipelineQ.data?.length ? 'Ouvrir le pipeline' : 'Créer une opportunité'} <ArrowRight size={13} /></Link>
        </div> : filteredVisits.length ? <div className="visit-list">
          {filteredVisits.map(({ item, dateKey, bucket }) => {
            const contact = contactsById.get(item.client_id);
            const property = propertiesById.get(item.property_id);
            const visitLabel = bucket === 'today' ? 'Aujourd’hui' : bucket === 'upcoming' ? 'À venir' : 'Passée';
            return <article className="visit-card" key={item.id} data-testid={`card-visit-${item.id}`}>
              <div className="visit-date-block"><span className="visit-date-icon"><CalendarDays size={16} /></span><strong>{formatVisitDate(dateKey)}</strong><span className={`visit-date-badge visit-date-${bucket}`}>{visitLabel}</span></div>
              <div className="visit-details">
                <div className="visit-relations">
                  <div className="visit-related-column"><span className="pipeline-label">CONTACT</span>{contact ? <Link href={`/contacts/${contact.id}`} className="visit-related-link">{contact.first_name} {contact.last_name ?? ''}</Link> : <strong>Contact inaccessible</strong>}<small>{contact?.phone || contact?.email || 'Coordonnées non renseignées'}</small></div>
                  <ArrowRight size={15} className="visit-relation-arrow" />
                  <div className="visit-related-column"><span className="pipeline-label">BIEN</span>{property ? <Link href={`/biens/${property.id}`} className="visit-related-link">{property.title}</Link> : <strong>Bien inaccessible</strong>}<small>{property ? `${property.reference} · ${property.neighborhood || property.city || 'Localisation non renseignée'}` : 'Bien non visible dans l’agence active'}</small></div>
                </div>
                <div className="visit-stage-row"><span>Étape</span><strong>{item.etape}</strong><small>{item.probabilite}% de probabilité</small></div>
              </div>
              <div className="visit-card-actions"><span><Clock3 size={13} /> Aucun horaire enregistré</span><button type="button" className="row-action" onClick={() => openEditor(item)} aria-label={`Modifier la visite liée à ${contact ? `${contact.first_name} ${contact.last_name ?? ''}` : 'ce dossier'}`} data-testid={`button-edit-visit-${item.id}`}><Pencil size={14} /> Modifier la date</button></div>
            </article>;
          })}
        </div> : <div className="state-card compact-empty" data-testid="empty-filtered-visits"><div className="state-icon"><Search size={19} /></div><h2>Aucune visite correspondante</h2><p>Modifiez la recherche ou choisissez un autre filtre.</p><Button variant="outline" onClick={() => { setSearch(''); setFilter('all'); }} data-testid="button-clear-visit-filters">Effacer les filtres</Button></div>}
      </section>

      <aside className="panel visit-unplanned-panel">
        <div className="panel-head"><div><h2>Sans date de visite</h2><p>{unscheduledItems.length} opportunité(s) à planifier</p></div><CalendarDays size={16} /></div>
        {unscheduledItems.length ? <>
          <div className="visit-unplanned-list">{unscheduledItems.slice(0, 7).map((item) => {
            const contact = contactsById.get(item.client_id);
            const property = propertiesById.get(item.property_id);
            const contactLabel = contact ? `${contact.first_name} ${contact.last_name ?? ''}`.trim() : 'Contact inaccessible';
            return <div className="visit-unplanned-row" key={item.id} data-testid={`row-unplanned-visit-${item.id}`}><div><strong>{contactLabel}</strong><small>{property ? `${property.reference} · ${property.title}` : item.etape}</small></div><button type="button" className="row-action" onClick={() => openEditor(item)} aria-label={`Planifier une visite pour ${contactLabel}`} data-testid={`button-plan-visit-${item.id}`}><CalendarDays size={13} /> Planifier</button></div>;
          })}</div>
          {unscheduledItems.length > 7 && <Link href="/pipeline" className="visit-unplanned-link">Voir toutes les opportunités ({unscheduledItems.length}) <ArrowRight size={13} /></Link>}
        </> : invalidDateCount > 0 ? <div className="visit-unplanned-empty"><strong>Dates à vérifier</strong><p>Corrigez les valeurs non reconnues dans les opportunités correspondantes.</p></div> : pipelineQ.data?.length ? <div className="visit-unplanned-empty"><strong>Toutes les opportunités ont une date</strong><p>La liste des visites est à jour avec les dossiers chargés.</p></div> : <div className="visit-unplanned-empty"><strong>Aucun dossier commercial</strong><p>Créez une opportunité avant de planifier une visite.</p><Link href="/pipeline" className="text-action">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>}
      </aside>
    </div>
    <PipelineDialog key={editing?.id ?? 'visit-edit'} open={open} onOpenChange={setOpen} item={editing} contacts={contacts} properties={properties} stageSuggestions={stageSuggestions} onSaved={setActionNotice} />
  </>;
}

function AgencyPage() {
  const { activeAgency, activeAgencyId, canManageAgency } = useAgency(); const roster = useAgencyRoster(activeAgencyId);
  if (roster.isLoading) return <><Heading eyebrow="Votre organisation" title="Agence et membres" description="Coordonnées de votre agence et accès de l’équipe." /><LoadingRows /></>;
  if (roster.error) return <><Heading eyebrow="Votre organisation" title="Agence et membres" description="Coordonnées de votre agence et accès de l’équipe." /><ErrorState error={roster.error} retry={useSafeRetry(roster)} /></>;
  return <><Heading eyebrow="Votre organisation" title="Agence et membres" description="Coordonnées de l’agence active et état des accès de l’équipe." action={<Link href="/parametres" className="button-link" data-testid="link-edit-agency-settings"><Settings2 size={15} /> Paramètres</Link>} />
    <div className="agency-layout"><section className="panel agency-profile-card"><div className="agency-profile-mark"><Building2 size={23} /></div><span className="form-kicker">Agence active</span><h2 data-testid="text-active-agency-name">{activeAgency?.name}</h2><p>{activeAgency?.legal_name || 'Raison sociale non renseignée'}</p><div className="agency-facts"><div><MapPin size={15} /><span>{[activeAgency?.address, activeAgency?.city, activeAgency?.country].filter(Boolean).join(', ') || 'Adresse non renseignée'}</span></div><div><Phone size={15} /><span>{activeAgency?.phone || 'Téléphone non renseigné'}</span></div><div><Mail size={15} /><span>{activeAgency?.email || 'E-mail non renseigné'}</span></div></div><div className="agency-meta"><span>Devise <strong>{activeAgency?.currency}</strong></span><span>Fuseau horaire <strong>{activeAgency?.timezone}</strong></span><span>État <strong>{activeAgency?.status}</strong></span></div></section>
      <section className="panel roster-panel"><div className="panel-head"><div><h2>Accès des membres</h2><p>{roster.data?.length ?? 0} accès répertorié(s)</p></div><span className="roster-lock"><LockKeyhole size={14} /> Lecture seule</span></div><div className="privacy-note"><ShieldCheck size={15} /><p>Pour protéger les profils, cette vue n’affiche aucun nom ni e-mail des autres membres. Les identifiants sont partiellement masqués.</p></div>{roster.data?.length ? <div className="roster-list">{roster.data.map((member: AgencyMemberRow) => <div className="roster-row" key={member.id} data-testid={`row-roster-${member.id}`}><span className="roster-avatar"><UserRound size={15} /></span><div className="roster-copy"><strong>{roleNames[member.role] ?? member.role}</strong><span>{member.user_id.slice(0, 5)}••••••{member.user_id.slice(-4)}</span></div><span className={`membership-status membership-${member.status}`}>{member.status === 'active' ? 'Actif' : member.status}</span></div>)}</div> : <div className="empty-table" data-testid="empty-agency-roster"><strong>Aucun accès à afficher</strong><p>Aucun membre n’est retourné pour cette agence.</p></div>}</section></div>
    {!canManageAgency && <div className="permission-note" role="status" data-testid="status-agency-permission"><LockKeyhole size={15} /><span>La modification des informations de l’agence est réservée aux propriétaires et administrateurs. Les règles d’accès de l’agence restent prioritaires.</span></div>}
  </>;
}

function PropertyDetailPage() {
  const params = useParams<{ id: string }>(); const id = params.id;
  const { activeAgencyId, activeMembership } = useAgency();
  const propertiesQ = useProperties(activeAgencyId);
  const pipelineQ = usePipeline(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const item = propertiesQ.data?.find((property) => property.id === id) ?? null;
  const linkedOpportunities = useMemo(
    () => linkedOpportunitiesForProperty(pipelineQ.data ?? [], id),
    [pipelineQ.data, id],
  );
  const contactsById = useMemo(() => {
    const map = new Map<string, ContactRow>();
    (contactsQ.data ?? []).forEach((contact) => map.set(contact.id, contact));
    return map;
  }, [contactsQ.data]);
  const media = usePropertyMedia(activeAgencyId, id);
  const canUploadMedia = ['owner', 'admin', 'manager', 'agent'].includes(activeMembership?.role ?? '');
  const upload = useUploadPropertyMedia(activeAgencyId, id, canUploadMedia);
  const canDeleteMedia = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';
  const removeMedia = useDeletePropertyMedia(activeAgencyId, id, canDeleteMedia);
  const [notice, setNotice] = useState('');
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  if (propertiesQ.isLoading) return <><Heading eyebrow="Portefeuille" title="Fiche du bien" description="Chargement du dossier immobilier."/><LoadingRows/></>;
  if (propertiesQ.error) return <><Heading eyebrow="Portefeuille" title="Fiche du bien" description="Les informations du dossier ne sont pas disponibles."/><ErrorState error={propertiesQ.error} retry={useSafeRetry(propertiesQ)}/></>;
  if (!item) return <><Heading eyebrow="Portefeuille" title="Bien introuvable" description="Ce dossier n’est pas présent dans le portefeuille de l’agence active."/><Link href="/biens" className="text-action">Retour aux biens <ArrowRight size={13}/></Link></>;
  const doUpload = async (files: File[]) => {
    if (!files.length) return;
    setNotice('');
    setNoticeIsError(false);
    let uploadedCount = 0;
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      try {
        await upload.mutateAsync({
          file,
          sortOrder: (media.data?.length ?? 0) + index,
        });
        uploadedCount += 1;
      } catch (error) {
        failures.push(`${file.name} : ${getSupabaseErrorMessage(error, 'ajouter la photo')}`);
      }
    }
    setNotice(
      failures.length
        ? `${uploadedCount} photo(s) ajoutée(s). Échecs : ${failures.join(' · ')}`
        : `${uploadedCount} photo(s) ajoutée(s).`,
    );
    setNoticeIsError(failures.length > 0);
  };
  const doDelete = async (photo: NonNullable<typeof media.data>[number]) => {
    if (!canDeleteMedia) return;
    if (!window.confirm(`Supprimer définitivement la photo « ${photo.file_name} » du stockage et de la fiche ?`)) return;
    setNotice(''); setNoticeIsError(false);
    try {
      await removeMedia.mutateAsync({ id: photo.id, storage_path: photo.storage_path });
      setNotice('Photo supprimée.');
    } catch (error) {
      setNotice(getSupabaseErrorMessage(error, 'supprimer la photo'));
      setNoticeIsError(true);
    }
  };
  const relatedError = pipelineQ.error || contactsQ.error;
  const retryRelated = () => { void pipelineQ.refetch(); void contactsQ.refetch(); };
  const handlePropertySaved = (message: string) => { setNotice(message); setNoticeIsError(false); };
  return <><Heading eyebrow={`Portefeuille · ${item.reference}`} title={item.title} description={`${item.property_type} · ${item.neighborhood || item.city || 'Localisation non renseignée'}`} action={<div className="heading-actions"><Link href="/biens" className="button-link">Retour aux biens</Link><ButtonPrimary testId="button-edit-property-detail" onClick={()=>{setNotice('');setNoticeIsError(false);setEditing(true);}}><Pencil size={14}/> Modifier</ButtonPrimary></div>} />
    {notice && <p className={`form-feedback property-action-notice${noticeIsError ? ' is-error' : ''}`} role={noticeIsError ? 'alert' : 'status'} data-testid="status-property-detail-action">{notice}</p>}
    <div className="detail-layout"><section className="panel detail-main"><div className="detail-pricebar"><div><span className="form-kicker">Prix affiché</span><strong>{formatPropertyPrice(item.price, item.currency)}</strong></div><div className="detail-status"><span className="form-kicker">Disponibilité</span><span className={`status-pill status-${item.status}`}>{propertyStatus[item.status] ?? item.status}</span></div></div>
      <div className="detail-facts"><div><span>Référence</span><strong>{item.reference}</strong></div><div><span>Type de bien</span><strong>{item.property_type}</strong></div><div><span>Transaction</span><strong>{item.transaction_type==='sale'?'Vente':item.transaction_type==='rent'?'Location':'Bail'}</strong></div><div><span>Chambres</span><strong>{item.bedrooms ?? '—'}</strong></div><div><span>Salles d’eau</span><strong>{item.bathrooms ?? '—'}</strong></div><div><span>Surface</span><strong>{item.area_m2 !== null ? `${item.area_m2} m²` : '—'}</strong></div><div><span>Mis à jour</span><strong>{dateLabel(item.updated_at)}</strong></div></div>
      <div className="detail-section"><h2>Localisation</h2><p>{[item.address,item.neighborhood,item.city].filter(Boolean).join(', ') || 'Adresse non renseignée'}</p></div><div className="detail-section"><h2>Description</h2><p>{item.description || 'Aucune description renseignée pour ce bien.'}</p></div></section>
      <section className="panel gallery-panel"><div className="panel-head"><div><h2>Galerie du bien</h2><p>{media.data?.length ?? 0} photo(s) enregistrée(s)</p></div><Camera size={17}/></div>
        <div className="gallery-content">{media.isLoading ? <LoadingRows label="Chargement de la galerie"/> : media.error ? <ErrorState error={media.error} retry={useSafeRetry(media)}/> : media.data?.length ? <div className="photo-grid">{media.data.map((photo)=><figure className="photo-item" key={photo.id}>{photo.signedUrl ? <button type="button" className="photo-preview" onClick={()=>setActiveImage(photo.signedUrl)} aria-label={`Agrandir ${photo.file_name}`}><img src={photo.signedUrl} alt={photo.file_name}/></button> : <div className="photo-unavailable">{photo.signedUrlError || 'Aperçu indisponible'}</div>}<figcaption><span>{photo.file_name}</span>{canDeleteMedia && <button type="button" className="icon-button" onClick={()=>void doDelete(photo)} disabled={removeMedia.isPending} aria-label={`Supprimer ${photo.file_name}`}><Trash2 size={14}/></button>}</figcaption></figure>)}</div> : <div className="gallery-empty"><ImagePlus size={21}/><strong>Aucune photo pour l’instant</strong><span>Les images ajoutées à ce dossier apparaîtront ici.</span></div>}</div>
        <div className="photo-upload">{canUploadMedia ? <label className={`upload-control${upload.isPending?' is-busy':''}`}><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={upload.isPending} onChange={(e)=>{const files=Array.from(e.currentTarget.files ?? []);e.currentTarget.value='';void doUpload(files);}}/><ImagePlus size={15}/>{upload.isPending?'Envoi en cours…':'Ajouter des photos'}</label> : <p className="permission-note">Votre rôle est en lecture seule pour les photos.</p>}<p>JPG, PNG ou WebP · 10 Mo maximum par image.</p></div>
      </section></div>
    <section className="panel property-opportunities-panel" aria-labelledby="property-opportunities-heading" data-testid="panel-property-opportunities">
      <div className="panel-head"><div><h2 id="property-opportunities-heading">Opportunités associées</h2><p>{pipelineQ.isLoading ? 'Chargement des dossiers reliés…' : `${linkedOpportunities.length} dossier(s) relié(s) par identifiant de bien`}</p></div><Link href="/pipeline" className="text-action" data-testid="link-property-opportunities">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>
      {pipelineQ.isLoading || contactsQ.isLoading ? <div className="property-opportunities-loading"><LoadingRows label="Chargement des opportunités associées" /></div> : relatedError ? <ErrorState error={relatedError} retry={retryRelated} testId="status-property-opportunities-error" /> : linkedOpportunities.length ? <div className="property-opportunities-list">
        {linkedOpportunities.map((opportunity) => {
          const contact = contactsById.get(opportunity.client_id);
          const visitDate = visitDateKey(opportunity.date_visite);
          const visitLabel = visitDate ? formatVisitDate(visitDate) : opportunity.date_visite ? 'Date à vérifier' : 'Non renseignée';
          return <article className="property-opportunity-row" key={opportunity.id} data-testid={`row-property-opportunity-${opportunity.id}`}>
            <div className="property-opportunity-stage"><span className="stage-marker" /><div><strong>{opportunity.etape}</strong><small>{opportunity.probabilite}% de probabilité</small></div></div>
            <div className="property-opportunity-contact"><span>Contact</span>{contact ? <Link href={`/contacts/${contact.id}`}>{contact.first_name} {contact.last_name ?? ''}</Link> : <strong>Contact inaccessible</strong>}</div>
            <div className="property-opportunity-date"><span>Date de visite</span><strong>{visitLabel}</strong></div>
          </article>;
        })}
      </div> : <div className="empty-table property-opportunities-empty" data-testid="empty-property-opportunities"><div className="empty-table-mark"><SlidersHorizontal size={17} /></div><strong>Aucune opportunité associée</strong><p>Les dossiers rattachés à ce bien apparaîtront ici après leur création dans le pipeline.</p><Link href="/pipeline" className="text-action">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>}
    </section>
    <div className="related-record"><h2>Fiche du bien</h2><span>Créé le {dateLabel(item.created_at)}</span></div>
    {editing && <PropertyDialog key={item.id} open={editing} onOpenChange={setEditing} item={item} currency={item.currency} onSaved={handlePropertySaved} />}
    {activeImage && <div className="lightbox" role="dialog" aria-modal="true" aria-label="Aperçu de la photo" onClick={()=>setActiveImage(null)}><button type="button" className="icon-button lightbox-close" onClick={()=>setActiveImage(null)} aria-label="Fermer l’aperçu"><X size={18}/></button><img src={activeImage} alt={item.title} onClick={(e)=>e.stopPropagation()}/></div>}
  </>;
}

function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const { activeAgencyId } = useAgency();
  const contactsQ = useContacts(activeAgencyId);
  const pipelineQ = usePipeline(activeAgencyId);
  const propertiesQ = useProperties(activeAgencyId);
  const rosterQ = useAgencyRoster(activeAgencyId);
  const contact = contactsQ.data?.find((row) => row.id === params.id) ?? null;
  const history = useMemo(
    () => linkedOpportunitiesForContact(pipelineQ.data ?? [], contact?.id),
    [pipelineQ.data, contact?.id],
  );
  const propertiesById = useMemo(() => {
    const map = new Map<string, PropertyRow>();
    (propertiesQ.data ?? []).forEach((property) => map.set(property.id, property));
    return map;
  }, [propertiesQ.data]);
  const [isEditing, setIsEditing] = useState(false);
  const [actionNotice, setActionNotice] = useState('');
  const loading = contactsQ.isLoading || pipelineQ.isLoading || propertiesQ.isLoading;
  const error = contactsQ.error || pipelineQ.error || propertiesQ.error;
  if (loading) return <><Heading eyebrow="Relation client" title="Fiche contact" description="Chargement des coordonnées et des opportunités reliées." /><LoadingRows /></>;
  if (error) return <><Heading eyebrow="Relation client" title="Fiche contact" description="Les informations ne sont pas disponibles." /><ErrorState error={error} retry={() => { void contactsQ.refetch(); void pipelineQ.refetch(); void propertiesQ.refetch(); }} /></>;
  if (!contact) return <><Heading eyebrow="Relation client" title="Contact introuvable" description="Cette fiche n’est pas disponible dans l’agence active." /><Link href="/contacts" className="text-action">Retour aux contacts <ArrowRight size={13} /></Link></>;
  const assignedMember = rosterQ.data?.find((member) => member.user_id === contact.assigned_user_id);
  const handleSaved = (message: string) => setActionNotice(message);
  return <><Heading eyebrow="Relation client" title={formatContactName(contact)} description="Coordonnées et opportunités commerciales réellement reliées à ce contact." action={<div className="heading-actions"><Link href="/contacts" className="button-link">Retour aux contacts</Link><ButtonPrimary testId="button-edit-contact-detail" onClick={() => { setActionNotice(''); setIsEditing(true); }}><Pencil size={14} /> Modifier</ButtonPrimary></div>} />
    {actionNotice && <p className="form-feedback contact-action-notice" role="status" data-testid="status-contact-detail-action">{actionNotice}</p>}
    <div className="detail-layout contact-detail-layout"><section className="panel detail-main"><div className="contact-profile-head"><span className="contact-avatar large-avatar">{`${contact.first_name[0] ?? ''}${contact.last_name?.[0] ?? ''}`.toUpperCase()}</span><div><span className={`status-pill status-${contact.status}`}>{contactStatus[contact.status] ?? contact.status}</span><h2>{formatContactName(contact)}</h2><small>Contact créé le {dateLabel(contact.created_at)}</small></div></div><div className="detail-facts"><div><span>Téléphone</span><strong>{contact.phone || '—'}</strong></div><div><span>WhatsApp</span><strong>{contact.whatsapp_number || '—'}</strong></div><div><span>E-mail</span><strong>{contact.email || '—'}</strong></div><div><span>Origine</span><strong>{contact.source || '—'}</strong></div><div><span>Responsable</span><strong>{contact.assigned_user_id ? rosterQ.isLoading ? 'Chargement…' : rosterQ.error ? 'Responsable indisponible' : agencyMemberLabel(assignedMember) : 'Non affecté'}</strong></div></div>{rosterQ.error && contact.assigned_user_id && <p className="contact-roster-warning" role="status" data-testid="status-contact-detail-roster-error">Le responsable ne peut pas être vérifié pour le moment. <button type="button" onClick={() => void rosterQ.refetch()} data-testid="button-retry-contact-detail-roster">Réessayer</button></p>}<div className="contact-unavailable-note" role="status" data-testid="status-contact-whatsapp-history-unavailable">Le numéro WhatsApp est une coordonnée uniquement; aucun historique de messages WhatsApp n’est disponible ici.</div><div className="detail-section"><h2>Notes</h2><p>{contact.notes || 'Aucune note enregistrée.'}</p></div></section>
      <section className="panel history-panel"><div className="panel-head"><div><h2>Historique des opportunités</h2><p>{history.length} dossier(s) relié(s) par identifiant de contact</p></div></div>{history.length ? <div className="history-list">{history.map((row) => {
        const property = propertiesById.get(row.property_id);
        const visitDate = visitDateKey(row.date_visite);
        const visitLabel = visitDate ? formatVisitDate(visitDate) : row.date_visite ? 'Date à vérifier' : null;
        return <article className="history-item" key={row.id} data-testid={`row-contact-opportunity-${row.id}`}><span className="history-dot" /><div><div className="history-title"><strong>{row.etape}</strong><time>{dateLabel(row.created_at)}</time></div>{property ? <Link href={`/biens/${property.id}`} className="history-property" data-testid={`link-contact-opportunity-property-${row.id}`}>{property.reference} · {property.title} <ArrowRight size={13} /></Link> : <span className="history-property history-property-unavailable">Bien associé indisponible</span>}<p>{row.notes || 'Aucune note sur cette opportunité.'}</p>{visitLabel && <small>Visite renseignée : {visitLabel}</small>}</div></article>;
      })}</div> : <div className="empty-table" data-testid="empty-contact-opportunities"><div className="empty-table-mark"><Clock3 size={17} /></div><strong>Aucune opportunité reliée</strong><p>Les dossiers liés à ce contact apparaîtront ici après leur création dans le pipeline.</p><Link href="/pipeline" className="text-action">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>}</section></div>
    <ContactDialog key={contact.id} open={isEditing} onOpenChange={setIsEditing} item={contact} onSaved={handleSaved} />
  </>;
}

function ProfilePage() {
  const { user } = useAuth(); const profileQ = useCurrentProfile(user?.id); const update = useUpdateCurrentProfile(user?.id);
  const form = useForm<z.infer<typeof profileSchema>>({ resolver:zodResolver(profileSchema), defaultValues:{full_name:'',phone:''} });
  const [message,setMessage] = useState('');
  useEffect(()=>{if(profileQ.data) form.reset({full_name:profileQ.data.full_name ?? '',phone:profileQ.data.phone ?? ''});},[profileQ.data,form]);
  if(profileQ.isLoading) return <><Heading eyebrow="Compte personnel" title="Mon profil" description="Informations privées de votre compte connecté."/><LoadingRows/></>;
  if(profileQ.error) return <><Heading eyebrow="Compte personnel" title="Mon profil" description="Informations privées de votre compte connecté."/><ErrorState error={profileQ.error} retry={useSafeRetry(profileQ)}/></>;
  const save = async (v:z.infer<typeof profileSchema>)=>{setMessage('');try{await update.mutateAsync({full_name:v.full_name,phone:v.phone||null});setMessage('Profil enregistré.');}catch(e){setMessage(getSupabaseErrorMessage(e,'enregistrer le profil'));}};
  return <><Heading eyebrow="Compte personnel" title="Mon profil" description="Ces informations sont strictement celles de votre compte connecté."/><section className="panel settings-panel profile-page-panel"><div className="settings-heading"><div className="settings-icon"><UserCog size={17}/></div><div><h2>Vos informations</h2><p>Seul votre propre profil est consulté et modifiable ici.</p></div></div><Form {...form}><form className="settings-form" onSubmit={form.handleSubmit(save)}><div className="settings-readonly"><Mail size={15}/><div><span>Adresse e-mail du compte</span><strong>{user?.email || '—'}</strong></div><small>Lecture seule</small></div><FormField control={form.control} name="full_name" render={({field})=><FormItem><FormLabel>Nom affiché</FormLabel><FormControl><Input {...field} data-testid="input-profile-page-name"/></FormControl><FormMessage/></FormItem>}/><FormField control={form.control} name="phone" render={({field})=><FormItem><FormLabel>Téléphone</FormLabel><FormControl><Input {...field} data-testid="input-profile-page-phone"/></FormControl><FormMessage/></FormItem>}/><div className="form-actions">{message&&<span className={message.includes('Impossible')?'form-feedback is-error':'form-feedback'} role="status">{message}</span>}<Button type="submit" disabled={update.isPending}>{update.isPending?'Enregistrement…':'Enregistrer mon profil'}</Button></div></form></Form></section></>;
}

function ComingSoonPage() {
  const [path] = useLocation(); const entry = nav.find((item)=>item.href===path); const Icon = entry?.icon ?? CircleHelp;
  return <><Heading eyebrow="Modules Sofia" title={entry?.label ?? 'Module'} description="Ce module n’est pas encore actif dans votre espace."/><section className="route-placeholder soon-module"><div className="placeholder-inner"><div className="placeholder-art"><Icon size={23}/></div><span className="form-kicker">Disponible prochainement</span><h2>Bientôt disponible</h2><p>Cette fonctionnalité n’est pas activée. Aucun rendez-vous, message, automatisation ou résultat fictif n’est affiché.</p><span className="placeholder-state"><i/> Module désactivé</span><p><Link href="/" className="text-action">Retour à la vue d’ensemble <ArrowRight size={13}/></Link></p></div></section></>;
}

const settingsSchema = z.object({ name: z.string().trim().min(1, 'Le nom est obligatoire'), legal_name: z.string().optional(), phone: z.string().optional(), email: z.string().email('Adresse e-mail invalide').or(z.literal('')).optional(), address: z.string().optional(), city: z.string().optional(), country: z.string().trim().min(1, 'Le pays est obligatoire'), timezone: z.string().trim().min(1, 'Le fuseau horaire est obligatoire'), currency: z.string().trim().min(1, 'La devise est obligatoire') });
const profileSchema = z.object({ full_name: z.string().trim().min(1, 'Le nom est obligatoire'), phone: z.string().optional() });
function SettingsPage() {
  const { user } = useAuth(); const { activeAgency, activeAgencyId, canManageAgency } = useAgency(); const profileQ = useCurrentProfile(user?.id); const updateAgency = useUpdateAgency(activeAgencyId); const updateProfile = useUpdateCurrentProfile(user?.id);
  const profileForm = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema), defaultValues: { full_name: '', phone: '' } });
  const agencyForm = useForm<z.infer<typeof settingsSchema>>({ resolver: zodResolver(settingsSchema), defaultValues: { name: '', legal_name: '', phone: '', email: '', address: '', city: '', country: 'Mali', timezone: 'Africa/Bamako', currency: 'XOF' } });
  const [profileMessage, setProfileMessage] = useState(''); const [agencyMessage, setAgencyMessage] = useState('');
  useEffect(() => { if (profileQ.data) profileForm.reset({ full_name: profileQ.data.full_name ?? '', phone: profileQ.data.phone ?? '' }); }, [profileQ.data, profileForm]);
  useEffect(() => { if (activeAgency) agencyForm.reset({ name: activeAgency.name, legal_name: activeAgency.legal_name ?? '', phone: activeAgency.phone ?? '', email: activeAgency.email ?? '', address: activeAgency.address ?? '', city: activeAgency.city ?? '', country: activeAgency.country, timezone: activeAgency.timezone, currency: activeAgency.currency }); }, [activeAgency, agencyForm]);
  if (profileQ.isLoading) return <><Heading eyebrow="Préférences" title="Paramètres" description="Gérez votre profil et les informations de l’agence." /><LoadingRows /></>;
  if (profileQ.error) return <><Heading eyebrow="Préférences" title="Paramètres" description="Gérez votre profil et les informations de l’agence." /><ErrorState error={profileQ.error} retry={useSafeRetry(profileQ)} /></>;
  const saveProfile = async (v: z.infer<typeof profileSchema>) => { setProfileMessage(''); try { const input: ProfileUpdateInput = { full_name: v.full_name, phone: v.phone || null }; await updateProfile.mutateAsync(input); setProfileMessage('Profil enregistré.'); } catch (e) { setProfileMessage(getSupabaseErrorMessage(e, 'enregistrer le profil')); } };
  const saveAgency = async (v: z.infer<typeof settingsSchema>) => { setAgencyMessage(''); try { const input: AgencySettingsInput = { name: v.name, legal_name: v.legal_name || null, phone: v.phone || null, email: v.email || null, address: v.address || null, city: v.city || null, country: v.country, timezone: v.timezone, currency: v.currency }; await updateAgency.mutateAsync(input); setAgencyMessage('Informations d’agence enregistrées.'); } catch (e) { setAgencyMessage(getSupabaseErrorMessage(e, 'enregistrer les informations de l’agence')); } };
  return <><Heading eyebrow="Préférences" title="Paramètres" description="Votre profil personnel et les coordonnées de l’agence active." />
    <div className="settings-stack"><section className="panel settings-panel"><div className="settings-heading"><div className="settings-icon"><UserRound size={17} /></div><div><h2>Mon profil</h2><p>Ces informations concernent uniquement votre compte.</p></div></div><Form {...profileForm}><form className="settings-form" onSubmit={profileForm.handleSubmit(saveProfile)}><div className="settings-readonly"><Mail size={15} /><div><span>Adresse e-mail de connexion</span><strong data-testid="text-profile-email">{user?.email}</strong></div><small>Non modifiable</small></div><div className="form-grid"><FormField control={profileForm.control} name="full_name" render={({ field }) => <FormItem><FormLabel>Nom affiché</FormLabel><FormControl><Input {...field} data-testid="input-profile-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={profileForm.control} name="phone" render={({ field }) => <FormItem><FormLabel>Téléphone</FormLabel><FormControl><Input {...field} data-testid="input-profile-phone" /></FormControl><FormMessage /></FormItem>} /></div><div className="form-actions">{profileMessage && <span className={`form-feedback${profileMessage.includes('Impossible') || profileMessage.includes('refusé') ? ' is-error' : ''}`} role="status" data-testid="status-profile-save">{profileMessage}</span>}<Button type="submit" disabled={updateProfile.isPending} data-testid="button-save-profile">{updateProfile.isPending ? 'Enregistrement…' : 'Enregistrer mon profil'}</Button></div></form></Form></section>
      <section className="panel settings-panel"><div className="settings-heading"><div className="settings-icon"><Building2 size={17} /></div><div><h2>Informations de l’agence</h2><p>Coordonnées partagées de {activeAgency?.name ?? 'l’agence active'}.</p></div><span className={`permission-badge${canManageAgency ? ' allowed' : ''}`}><KeyRound size={13} /> {canManageAgency ? 'Modification autorisée' : 'Lecture seule'}</span></div>
        {!canManageAgency && <div className="permission-note"><LockKeyhole size={15} /><span>Seuls les propriétaires et administrateurs peuvent modifier ces champs.</span></div>}
        <Form {...agencyForm}><form className="settings-form" onSubmit={agencyForm.handleSubmit(saveAgency)}><div className="form-grid"><FormField control={agencyForm.control} name="name" render={({ field }) => <FormItem><FormLabel>Nom commercial</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={agencyForm.control} name="legal_name" render={({ field }) => <FormItem><FormLabel>Raison sociale</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-legal-name" /></FormControl></FormItem>} /></div><div className="form-grid"><FormField control={agencyForm.control} name="phone" render={({ field }) => <FormItem><FormLabel>Téléphone agence</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-phone" /></FormControl></FormItem>} /><FormField control={agencyForm.control} name="email" render={({ field }) => <FormItem><FormLabel>E-mail agence</FormLabel><FormControl><Input type="email" {...field} disabled={!canManageAgency} data-testid="input-agency-email" /></FormControl><FormMessage /></FormItem>} /></div><FormField control={agencyForm.control} name="address" render={({ field }) => <FormItem><FormLabel>Adresse</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-address" /></FormControl></FormItem>} /><div className="form-grid three-col"><FormField control={agencyForm.control} name="city" render={({ field }) => <FormItem><FormLabel>Ville</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-city" /></FormControl></FormItem>} /><FormField control={agencyForm.control} name="country" render={({ field }) => <FormItem><FormLabel>Pays</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-country" /></FormControl><FormMessage /></FormItem>} /><FormField control={agencyForm.control} name="currency" render={({ field }) => <FormItem><FormLabel>Devise</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-currency" /></FormControl><FormMessage /></FormItem>} /></div><FormField control={agencyForm.control} name="timezone" render={({ field }) => <FormItem><FormLabel>Fuseau horaire</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-timezone" /></FormControl><FormMessage /></FormItem>} /><div className="form-actions">{agencyMessage && <span className={`form-feedback${agencyMessage.includes('Impossible') || agencyMessage.includes('refusé') ? ' is-error' : ''}`} role="status" data-testid="status-agency-save">{agencyMessage}</span>}{canManageAgency && <Button type="submit" disabled={updateAgency.isPending} data-testid="button-save-agency">{updateAgency.isPending ? 'Enregistrement…' : 'Enregistrer les informations'}</Button>}</div></form></Form>
      </section></div>
  </>;
}

const loginSchema = z.object({
  email: z.string().trim().email('Adresse e-mail invalide'),
  password: z.string().min(1, 'Le mot de passe est obligatoire'),
});
type LoginFormValues = z.infer<typeof loginSchema>;

function Login() {
  const { user, signIn, configurationError, initializationError } = useAuth();
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (values: LoginFormValues) => {
    setError('');
    setBusy(true);
    try {
      await signIn(values.email, values.password);
    } catch (e) {
      setError(getSupabaseErrorMessage(e, 'ouvrir une session'));
    } finally {
      setBusy(false);
    }
  };
  if (user) return <div className="auth-loading"><div className="state-card"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Session déjà ouverte</h2><p>Votre compte est déjà connecté à Sofia Immobilier.</p><Link href="/" className="text-action" data-testid="link-continue-workspace">Continuer vers l’espace agence <ArrowRight size={14} /></Link></div></div>;
  return <div className="login-page"><div className="login-aside"><Link href="/" className="brand-lockup" data-testid="link-login-brand"><BrandMark /><div><div className="brand-name">sofia immobilier</div><div className="brand-caption">L’espace de votre agence</div></div></Link><div className="login-aside-copy"><span className="eyebrow">Bamako · Espace professionnel</span><h1>Le suivi de votre agence, <em>en un seul endroit.</em></h1><p>Retrouvez vos biens, vos contacts et les prochaines étapes commerciales dans un espace fiable, réservé à votre équipe.</p><div className="login-aside-rule"><ShieldCheck size={16} /><span>Connexion sécurisée · accès selon votre rôle</span></div></div><span className="login-aside-foot">SOFIA IMMOBILIER <span>—</span> GESTION D’AGENCE</span></div><main className="login-main"><div className="login-card"><span className="form-kicker">Bon retour</span><h2>Se connecter</h2><p>Connectez-vous avec les identifiants de votre compte existant.</p><Form {...form}><form onSubmit={form.handleSubmit(submit)} className="login-form">
    <FormField control={form.control} name="email" render={({ field }) => <FormItem><FormLabel>Adresse e-mail</FormLabel><div className="login-input-wrap"><Mail size={15} aria-hidden="true" /><FormControl><Input {...field} type="email" autoComplete="email" placeholder="agent@example.test" data-testid="input-login-email" /></FormControl></div><FormMessage /></FormItem>} />
    <FormField control={form.control} name="password" render={({ field }) => <FormItem><FormLabel>Mot de passe</FormLabel><div className="login-input-wrap"><LockKeyhole size={15} aria-hidden="true" /><FormControl><Input {...field} type="password" autoComplete="current-password" placeholder="Votre mot de passe" data-testid="input-login-password" /></FormControl></div><FormMessage /></FormItem>} />
    {(error || configurationError || initializationError) && <p className="form-error" role="alert" data-testid="status-login-error">{error || configurationError || initializationError}</p>}<Button type="submit" className="login-submit" disabled={busy || !!configurationError || !!initializationError} data-testid="button-login-submit">{busy ? 'Connexion…' : 'Se connecter'} <ArrowRight size={15} /></Button>
  </form></Form><div className="login-footnote"><ShieldCheck size={14} /> Les nouvelles inscriptions sont gérées par l’administrateur de votre agence.</div></div><span className="login-copyright">© {new Date().getFullYear()} Sofia Immobilier · Bamako</span></main></div>;
}

function RoutedContent() {
  const [path] = useLocation();
  if (path === '/login') return <Login />;
  return <WorkspaceGate><ErrorBoundary resetKey={path}><Switch><Route path="/" component={Overview} /><Route path="/biens" component={PropertiesPage} /><Route path="/biens/:id" component={PropertyDetailPage} /><Route path="/contacts" component={ContactsPage} /><Route path="/contacts/:id" component={ContactDetailPage} /><Route path="/pipeline" component={PipelinePage} /><Route path="/visites" component={VisitsPage} /><Route path="/agence" component={AgencyPage} /><Route path="/profil" component={ProfilePage} /><Route path="/parametres" component={SettingsPage} /><Route path="/whatsapp" component={ComingSoonPage} /><Route path="/assistant-ia" component={ComingSoonPage} /><Route path="/automatisations" component={ComingSoonPage} /><Route component={NotFound} /></Switch></ErrorBoundary></WorkspaceGate>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AuthProvider><AgencyProvider><RoutedContent /></AgencyProvider></AuthProvider></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
