import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  ArrowDownRight, ArrowRight, Building2, ChevronDown, CircleHelp, Clock3,
  ContactRound, FileText, Home, LayoutDashboard, LogOut, Menu, Plus, Search,
  Settings2, ShieldCheck, SlidersHorizontal, UsersRound, X, Pencil, RefreshCw,
  LockKeyhole, Mail, Phone, MapPin, UserRound, KeyRound,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
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
  useDashboardSummary, useProperties, useContacts, usePipeline, useAgencyRoster, useCurrentProfile,
  useCreateProperty, useUpdateProperty, useCreateContact, useUpdateContact,
  useCreatePipelineItem, useUpdatePipelineItem, useUpdateAgency, useUpdateCurrentProfile,
  type PropertyCreateInput, type ContactCreateInput, type PipelineCreateInput,
  type AgencySettingsInput, type ProfileUpdateInput,
} from '@/lib/data-hooks';
import type { AgencyMemberRow, PropertyRow, ContactRow, SalesPipelineRow } from '@/lib/database.types';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

const nav = [
  { href: '/', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { href: '/biens', label: 'Biens immobiliers', icon: Home },
  { href: '/contacts', label: 'Prospects et contacts', icon: ContactRound },
  { href: '/pipeline', label: 'Pipeline commercial', icon: SlidersHorizontal },
  { href: '/agence', label: 'Agence et membres', icon: UsersRound },
  { href: '/parametres', label: 'Paramètres', icon: Settings2 },
];
const roleNames: Record<string, string> = { owner: 'Propriétaire', admin: 'Administrateur', manager: 'Responsable', agent: 'Agent', viewer: 'Lecture seule' };
const propertyStatus: Record<string, string> = { available: 'Disponible', reserved: 'Réservé', sold: 'Vendu', rented: 'Loué', unavailable: 'Indisponible', draft: 'Brouillon', archived: 'Archivé' };
const contactStatus: Record<string, string> = { lead: 'Nouveau contact', prospect: 'Prospect', client: 'Client', inactive: 'Inactif' };
const cash = (price: number, currency: string) => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(price)} ${currency}`;
const dateLabel = (value?: string | null) => value ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Non renseignée';

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
  const currentLabel = nav.find((item) => item.href === path)?.label ?? 'Espace de travail';
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
      <nav className="nav-list" aria-label="Navigation principale">{nav.map(({ href, label, icon: Icon }) => <Link href={href} key={href} className="nav-link" aria-current={path === href ? 'page' : undefined} data-testid={`link-nav-${href === '/' ? 'overview' : href.slice(1)}`} onClick={() => setMenuOpen(false)}><Icon size={16} /><span>{label}</span></Link>)}</nav>
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
      <header className="topbar"><div className="breadcrumb"><span>{activeAgency?.name ?? 'Espace agence'}</span><ArrowRight size={12} /><strong>{currentLabel}</strong></div><div className="topbar-tools"><div className="profile-chip" data-testid="display-user-access-status"><div className="profile-circle">{name.slice(0, 1).toUpperCase()}</div><span>{name}</span></div><button type="button" className="icon-button" onClick={() => setNotice(true)} aria-label="Afficher l’état de connexion" data-testid="button-notifications"><CircleHelp size={15} /></button></div></header>
      <header className="mobile-header"><div className="mobile-brand"><BrandMark /><strong>sofia immobilier</strong></div><button type="button" className="icon-button mobile-menu-button" aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} data-testid="button-mobile-menu">{menuOpen ? <X size={18} /> : <Menu size={18} />}</button></header>
      <main className="content-wrap">{children}</main>
    </div>
    {notice && <div className="notice-toast" role={signOutError ? 'alert' : 'status'} data-testid="status-notifications">{signOutError || 'Session active · accès contrôlé par votre agence.'}<button onClick={() => setNotice(false)} aria-label="Fermer le message" data-testid="button-dismiss-notice"><X size={13} /></button></div>}
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
  const { activeAgencyId } = useAgency();
  const summary = useDashboardSummary(activeAgencyId);
  const properties = useProperties(activeAgencyId);
  if (summary.isLoading || properties.isLoading) return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence, à jour et accessibles." /><LoadingRows /></>;
  if (summary.error) return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence." /><ErrorState error={summary.error} retry={useSafeRetry(summary)} /></>;
  const stats = [
    { label: 'Biens au portefeuille', count: summary.data?.properties ?? 0, foot: `${summary.data?.availableProperties ?? 0} disponibles`, icon: Home },
    { label: 'Contacts suivis', count: summary.data?.contacts ?? 0, foot: 'Dans votre agence', icon: ContactRound },
    { label: 'Opportunités', count: summary.data?.opportunities ?? 0, foot: 'En suivi commercial', icon: ArrowDownRight },
    { label: 'Membres actifs', count: summary.data?.activeMembers ?? 0, foot: 'Accès en cours', icon: UsersRound },
  ];
  const latest = (properties.data ?? []).slice(0, 5);
  return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence, à jour et accessibles." /><section className="status-banner" data-testid="status-dashboard-access"><div className="status-banner-icon"><ShieldCheck size={15} /></div><div><strong>Votre espace de travail est synchronisé</strong><p>Les indicateurs ci-dessous reflètent les données actuellement accessibles pour votre agence.</p></div><span className="status-tag">Accès actif</span></section>
    <section className="stat-grid" aria-label="Indicateurs de l’agence">{stats.map(({ label, count, foot, icon: Icon }, i) => <article className="stat-card" key={label} data-testid={`card-stat-${i + 1}`}><div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={14} /></span></div><div className="stat-value" data-testid={`value-stat-${i + 1}`}>{count}</div><div className="stat-foot">{foot}</div></article>)}</section>
    <section className="overview-grid"><article className="panel"><div className="panel-head"><div><h2>Biens récemment ajoutés</h2><p>Les derniers dossiers du portefeuille</p></div><Link href="/biens" className="text-action" data-testid="link-view-properties">Tous les biens <ArrowRight size={13} /></Link></div>
       {properties.error ? <ErrorState error={properties.error} retry={useSafeRetry(properties)} testId="status-recent-properties-error" /> : latest.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Référence</th><th>Bien</th><th>Localisation</th><th>Statut</th></tr></thead><tbody>{latest.map((p) => <tr key={p.id} data-testid={`row-recent-property-${p.id}`}><td><strong>{p.reference}</strong></td><td>{p.title}</td><td>{p.neighborhood || p.city || '—'}</td><td><span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-table" data-testid="empty-recent-properties"><div className="empty-table-mark"><Home size={17} /></div><strong>Aucun bien enregistré</strong><p>Les biens ajoutés par votre équipe apparaîtront ici.</p><Link href="/biens" className="text-action" data-testid="link-add-first-property">Ajouter un bien <ArrowRight size={13} /></Link></div>}</article>
      <article className="panel readiness-panel"><div className="readiness-title"><h2>Repères d’agence</h2><span>Vue du jour</span></div><p className="readiness-intro">Gardez une lecture claire de votre portefeuille et des échanges à poursuivre.</p><div className="readiness-list"><Link href="/biens" className="readiness-row" data-testid="link-overview-properties"><div className="readiness-icon"><Home size={14} /></div><div className="readiness-copy"><strong>Biens disponibles</strong><span>{summary.data?.availableProperties ?? 0} actuellement en commercialisation</span></div><ArrowRight size={14} /></Link><Link href="/contacts" className="readiness-row" data-testid="link-overview-contacts"><div className="readiness-icon"><ContactRound size={14} /></div><div className="readiness-copy"><strong>Suivi des contacts</strong><span>{summary.data?.contacts ?? 0} fiches dans votre espace</span></div><ArrowRight size={14} /></Link><Link href="/pipeline" className="readiness-row" data-testid="link-overview-pipeline"><div className="readiness-icon"><SlidersHorizontal size={14} /></div><div className="readiness-copy"><strong>Pipeline commercial</strong><span>{summary.data?.opportunities ?? 0} opportunités à suivre</span></div><ArrowRight size={14} /></Link></div><div className="notice-box"><CircleHelp size={14} /> Les membres sont visibles par rôle uniquement afin de préserver la confidentialité de leurs profils.</div></article></section></>;
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
  price: z.coerce.number().min(0, 'Le montant ne peut pas être négatif'),
  currency: z.string().trim().min(1, 'La devise est obligatoire'),
  status: z.enum(['available', 'reserved', 'sold', 'rented', 'unavailable', 'draft', 'archived']),
  neighborhood: z.string().optional(), city: z.string().optional(), address: z.string().optional(),
  description: z.string().optional(),
  bedrooms: z.string().optional().refine((value) => !value || (Number.isInteger(Number(value)) && Number(value) >= 0), 'Le nombre de chambres doit être un entier positif ou nul'),
  bathrooms: z.string().optional().refine((value) => !value || (Number.isInteger(Number(value)) && Number(value) >= 0), 'Le nombre de salles d’eau doit être un entier positif ou nul'),
  area_m2: z.string().optional().refine((value) => !value || Number(value) > 0, 'La surface doit être supérieure à zéro'),
});
type PropertyFormValues = z.infer<typeof propertySchema>;
function PropertyDialog({ open, onOpenChange, item, currency }: { open: boolean; onOpenChange: (open: boolean) => void; item: PropertyRow | null; currency: string }) {
  const { activeAgencyId } = useAgency();
  const create = useCreateProperty(activeAgencyId); const update = useUpdateProperty(activeAgencyId);
  const form = useForm<PropertyFormValues>({ resolver: zodResolver(propertySchema), defaultValues: { reference: '', title: '', transaction_type: 'sale', property_type: '', price: 0, currency, status: 'draft', neighborhood: '', city: 'Bamako', address: '', description: '', bedrooms: '', bathrooms: '', area_m2: '' } });
  const [formError, setFormError] = useState('');
  const isBusy = create.isPending || update.isPending;
  const submit = async (values: PropertyFormValues) => {
    setFormError('');
    const input: PropertyCreateInput = { reference: values.reference, title: values.title, transaction_type: values.transaction_type, property_type: values.property_type, price: values.price, currency: values.currency, status: values.status, neighborhood: values.neighborhood || null, city: values.city || null, address: values.address || null, description: values.description || null, bedrooms: values.bedrooms ? Number(values.bedrooms) : null, bathrooms: values.bathrooms ? Number(values.bathrooms) : null, area_m2: values.area_m2 ? Number(values.area_m2) : null };
    try { if (item) await update.mutateAsync({ id: item.id, input }); else await create.mutateAsync(input); onOpenChange(false); }
    catch (error) { setFormError(getSupabaseErrorMessage(error, item ? 'modifier le bien' : 'créer le bien')); }
  };
  return <Dialog open={open} onOpenChange={(v) => { if (!v) setFormError(''); onOpenChange(v); }}><DialogContent className="form-dialog"><DialogHeader><span className="form-kicker">Portefeuille immobilier</span><DialogTitle>{item ? 'Modifier le bien' : 'Ajouter un bien'}</DialogTitle><DialogDescription>Renseignez les informations connues. Aucun document ni photo n’est demandé ici.</DialogDescription></DialogHeader>
    <Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form">
      <div className="form-grid"><FormField control={form.control} name="reference" render={({ field }) => <FormItem><FormLabel>Référence</FormLabel><FormControl><Input {...field} data-testid="input-property-reference" placeholder="Ex. BI-024" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="title" render={({ field }) => <FormItem><FormLabel>Intitulé</FormLabel><FormControl><Input {...field} data-testid="input-property-title" placeholder="Villa, appartement…" /></FormControl><FormMessage /></FormItem>} /></div>
      <div className="form-grid"><FormField control={form.control} name="transaction_type" render={({ field }) => <FormItem><FormLabel>Transaction</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-property-transaction"><option value="sale">Vente</option><option value="rent">Location</option><option value="lease">Bail</option></select></FormControl></FormItem>} /><FormField control={form.control} name="property_type" render={({ field }) => <FormItem><FormLabel>Type de bien</FormLabel><FormControl><Input {...field} data-testid="input-property-type" placeholder="Villa, terrain…" /></FormControl><FormMessage /></FormItem>} /></div>
       <div className="form-grid three-col"><FormField control={form.control} name="price" render={({ field }) => <FormItem><FormLabel>Prix</FormLabel><FormControl><Input type="number" min="0" {...field} data-testid="input-property-price" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="currency" render={({ field }) => <FormItem><FormLabel>Devise</FormLabel><FormControl><Input {...field} data-testid="input-property-currency" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="status" render={({ field }) => <FormItem><FormLabel>Statut</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-property-status">{Object.entries(propertyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormControl></FormItem>} /></div>
      <div className="form-grid"><FormField control={form.control} name="neighborhood" render={({ field }) => <FormItem><FormLabel>Quartier</FormLabel><FormControl><Input {...field} data-testid="input-property-neighborhood" /></FormControl></FormItem>} /><FormField control={form.control} name="city" render={({ field }) => <FormItem><FormLabel>Ville</FormLabel><FormControl><Input {...field} data-testid="input-property-city" /></FormControl></FormItem>} /></div>
       <div className="form-grid three-col">{(['bedrooms', 'bathrooms', 'area_m2'] as const).map((key) => <FormField key={key} control={form.control} name={key} render={({ field }) => <FormItem><FormLabel>{key === 'bedrooms' ? 'Chambres' : key === 'bathrooms' ? 'Salles d’eau' : 'Surface m²'}</FormLabel><FormControl><Input type="number" min={key === 'area_m2' ? '0.01' : '0'} step={key === 'area_m2' ? '0.01' : '1'} {...field} data-testid={`input-property-${key}`} /></FormControl><FormMessage /></FormItem>} />)}</div>
      <FormField control={form.control} name="address" render={({ field }) => <FormItem><FormLabel>Adresse</FormLabel><FormControl><Input {...field} data-testid="input-property-address" /></FormControl></FormItem>} /><FormField control={form.control} name="description" render={({ field }) => <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea {...field} data-testid="input-property-description" /></FormControl></FormItem>} />
      {formError && <p className="form-error" role="alert" data-testid="status-property-form-error">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-property">Annuler</Button><Button type="submit" disabled={isBusy} data-testid="button-submit-property">{isBusy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer le bien'}</Button></div>
    </form></Form>
  </DialogContent></Dialog>;
}

function PropertiesPage() {
  const { activeAgencyId, activeAgency } = useAgency(); const query = useProperties(activeAgencyId);
  const [search, setSearch] = useState(''); const [editing, setEditing] = useState<PropertyRow | null>(null); const [open, setOpen] = useState(false);
  const rows = useMemo(() => (query.data ?? []).filter((p) => `${p.reference} ${p.title} ${p.property_type} ${p.neighborhood ?? ''} ${p.city ?? ''}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr'))), [query.data, search]);
  return <><Heading eyebrow="Portefeuille" title="Biens immobiliers" description="Consultez et tenez à jour les biens de votre agence." action={<ButtonPrimary testId="button-add-property" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} /> Ajouter un bien</ButtonPrimary>} />
    <section className="list-toolbar"><label className="list-search"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Référence, type ou localisation" aria-label="Rechercher un bien" data-testid="input-search-properties" /></label><span className="result-count" data-testid="text-properties-count">{query.data ? `${rows.length} ${rows.length === 1 ? 'bien' : 'biens'}` : '—'}</span></section>
    {query.isLoading || query.error || !query.data?.length ? <PageDataState loading={query.isLoading} error={query.error} retry={useSafeRetry(query)} count={query.data?.length ?? 0} emptyTitle="Votre portefeuille est encore vide" emptyText="Ajoutez un bien pour commencer à structurer votre portefeuille immobilier." testId="empty-properties" /> : rows.length ? <div className="panel list-panel"><div className="table-wrap"><table className="data-table full-table"><thead><tr><th>Référence</th><th>Bien</th><th>Localisation</th><th>Transaction</th><th>Prix</th><th>Statut</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.map((p) => <tr key={p.id} data-testid={`row-property-${p.id}`}><td><strong>{p.reference}</strong></td><td><strong>{p.title}</strong><small>{p.property_type}</small></td><td>{p.neighborhood || '—'}<small>{p.city || '—'}</small></td><td>{p.transaction_type === 'sale' ? 'Vente' : p.transaction_type === 'rent' ? 'Location' : 'Bail'}</td><td>{cash(p.price, p.currency)}</td><td><span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span></td><td><button className="row-action" onClick={() => { setEditing(p); setOpen(true); }} aria-label={`Modifier ${p.title}`} data-testid={`button-edit-property-${p.id}`}><Pencil size={14} /><span>Modifier</span></button></td></tr>)}</tbody></table></div></div> : <div className="state-card compact-empty" data-testid="empty-filtered-properties"><div className="state-icon"><Search size={19} /></div><h2>Aucun résultat pour cette recherche</h2><p>Essayez une autre référence ou localisation.</p><Button variant="outline" onClick={() => setSearch('')} data-testid="button-clear-property-search">Effacer la recherche</Button></div>}
    <PropertyDialog key={editing?.id ?? 'new-property'} open={open} onOpenChange={setOpen} item={editing} currency={activeAgency?.currency ?? 'XOF'} />
  </>;
}

const contactSchema = z.object({ first_name: z.string().trim().min(1, 'Le prénom est obligatoire'), last_name: z.string().optional(), phone: z.string().optional(), email: z.string().email('Adresse e-mail invalide').or(z.literal('')).optional(), whatsapp_number: z.string().optional(), status: z.enum(['lead', 'prospect', 'client', 'inactive']), source: z.string().optional(), notes: z.string().optional() });
type ContactFormValues = z.infer<typeof contactSchema>;
function ContactDialog({ open, onOpenChange, item }: { open: boolean; onOpenChange: (open: boolean) => void; item: ContactRow | null }) {
  const { activeAgencyId } = useAgency(); const create = useCreateContact(activeAgencyId); const update = useUpdateContact(activeAgencyId);
  const form = useForm<ContactFormValues>({ resolver: zodResolver(contactSchema), defaultValues: { first_name: item?.first_name ?? '', last_name: item?.last_name ?? '', phone: item?.phone ?? '', email: item?.email ?? '', whatsapp_number: item?.whatsapp_number ?? '', status: item?.status ?? 'lead', source: item?.source ?? '', notes: item?.notes ?? '' } });
  const [formError, setFormError] = useState('');
  const submit = async (v: ContactFormValues) => {
    const input: ContactCreateInput = { first_name: v.first_name, last_name: v.last_name || null, phone: v.phone || null, email: v.email || null, whatsapp_number: v.whatsapp_number || null, status: v.status, source: v.source || null, notes: v.notes || null };
    try { if (item) await update.mutateAsync({ id: item.id, input }); else await create.mutateAsync(input); onOpenChange(false); } catch (e) { setFormError(getSupabaseErrorMessage(e, item ? 'modifier le contact' : 'créer le contact')); }
  };
  const busy = create.isPending || update.isPending;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="form-dialog"><DialogHeader><span className="form-kicker">Carnet de contacts</span><DialogTitle>{item ? 'Modifier le contact' : 'Nouveau contact'}</DialogTitle><DialogDescription>Enregistrez les coordonnées et l’état du suivi.</DialogDescription></DialogHeader><Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form">
    <div className="form-grid"><FormField control={form.control} name="first_name" render={({ field }) => <FormItem><FormLabel>Prénom</FormLabel><FormControl><Input {...field} data-testid="input-contact-first-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="last_name" render={({ field }) => <FormItem><FormLabel>Nom</FormLabel><FormControl><Input {...field} data-testid="input-contact-last-name" /></FormControl></FormItem>} /></div>
    <div className="form-grid"><FormField control={form.control} name="phone" render={({ field }) => <FormItem><FormLabel>Téléphone</FormLabel><FormControl><Input {...field} data-testid="input-contact-phone" /></FormControl></FormItem>} /><FormField control={form.control} name="whatsapp_number" render={({ field }) => <FormItem><FormLabel>WhatsApp</FormLabel><FormControl><Input {...field} data-testid="input-contact-whatsapp" /></FormControl></FormItem>} /></div>
    <div className="form-grid"><FormField control={form.control} name="email" render={({ field }) => <FormItem><FormLabel>E-mail</FormLabel><FormControl><Input type="email" {...field} data-testid="input-contact-email" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="status" render={({ field }) => <FormItem><FormLabel>Statut</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-contact-status">{Object.entries(contactStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormControl></FormItem>} /></div>
    <FormField control={form.control} name="source" render={({ field }) => <FormItem><FormLabel>Origine du contact</FormLabel><FormControl><Input {...field} data-testid="input-contact-source" placeholder="Recommandation, annonce…" /></FormControl></FormItem>} /><FormField control={form.control} name="notes" render={({ field }) => <FormItem><FormLabel>Notes de suivi</FormLabel><FormControl><Textarea {...field} data-testid="input-contact-notes" /></FormControl></FormItem>} />
    {formError && <p className="form-error" role="alert" data-testid="status-contact-form-error">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-contact">Annuler</Button><Button type="submit" disabled={busy} data-testid="button-submit-contact">{busy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer le contact'}</Button></div>
  </form></Form></DialogContent></Dialog>;
}
function ContactsPage() {
  const { activeAgencyId } = useAgency(); const query = useContacts(activeAgencyId); const [search, setSearch] = useState(''); const [editing, setEditing] = useState<ContactRow | null>(null); const [open, setOpen] = useState(false);
  const rows = useMemo(() => (query.data ?? []).filter((c) => `${c.first_name} ${c.last_name ?? ''} ${c.phone ?? ''} ${c.email ?? ''} ${c.status}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr'))), [query.data, search]);
  return <><Heading eyebrow="Relation client" title="Prospects et contacts" description="Retrouvez les personnes et reprenez le fil de chaque échange." action={<ButtonPrimary testId="button-add-contact" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} /> Nouveau contact</ButtonPrimary>} /><section className="list-toolbar"><label className="list-search"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom, téléphone ou e-mail" aria-label="Rechercher un contact" data-testid="input-search-contacts" /></label><span className="result-count" data-testid="text-contacts-count">{query.data ? `${rows.length} ${rows.length === 1 ? 'contact' : 'contacts'}` : '—'}</span></section>
    {query.isLoading || query.error || !query.data?.length ? <PageDataState loading={query.isLoading} error={query.error} retry={useSafeRetry(query)} count={query.data?.length ?? 0} emptyTitle="Aucun contact dans votre espace" emptyText="Ajoutez un contact après votre premier échange. Les fiches resteront privées à votre agence." testId="empty-contacts" /> : rows.length ? <div className="panel list-panel"><div className="table-wrap"><table className="data-table full-table"><thead><tr><th>Contact</th><th>Coordonnées</th><th>Origine</th><th>Statut</th><th>Ajouté le</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.map((c) => <tr key={c.id} data-testid={`row-contact-${c.id}`}><td><div className="contact-cell"><span className="contact-avatar">{`${c.first_name[0] ?? ''}${c.last_name?.[0] ?? ''}`.toUpperCase()}</span><div><strong>{c.first_name} {c.last_name}</strong><small>Contact agence</small></div></div></td><td>{c.phone || c.email || '—'}{c.email && c.phone && <small>{c.email}</small>}</td><td>{c.source || '—'}</td><td><span className={`status-pill status-${c.status}`}>{contactStatus[c.status] ?? c.status}</span></td><td>{dateLabel(c.created_at)}</td><td><button className="row-action" onClick={() => { setEditing(c); setOpen(true); }} aria-label={`Modifier ${c.first_name}`} data-testid={`button-edit-contact-${c.id}`}><Pencil size={14} /><span>Modifier</span></button></td></tr>)}</tbody></table></div></div> : <div className="state-card compact-empty" data-testid="empty-filtered-contacts"><div className="state-icon"><Search size={19} /></div><h2>Aucun contact correspondant</h2><p>Modifiez les mots recherchés pour retrouver une fiche.</p><Button variant="outline" onClick={() => setSearch('')} data-testid="button-clear-contact-search">Effacer la recherche</Button></div>}
    <ContactDialog key={editing?.id ?? 'new-contact'} open={open} onOpenChange={setOpen} item={editing} />
  </>;
}

const pipelineSchema = z.object({ client_id: z.string().min(1, 'Choisissez un contact'), property_id: z.string().min(1, 'Choisissez un bien'), etape: z.string().trim().min(1, 'L’étape est obligatoire'), probabilite: z.coerce.number().min(0).max(100), date_visite: z.string().optional(), notes: z.string().optional() });
type PipelineFormValues = z.infer<typeof pipelineSchema>;
function PipelineDialog({ open, onOpenChange, item, contacts, properties }: { open: boolean; onOpenChange: (open: boolean) => void; item: SalesPipelineRow | null; contacts: ContactRow[]; properties: PropertyRow[] }) {
  const { activeAgencyId } = useAgency(); const create = useCreatePipelineItem(activeAgencyId); const update = useUpdatePipelineItem(activeAgencyId); const [formError, setFormError] = useState('');
   const form = useForm<PipelineFormValues>({ resolver: zodResolver(pipelineSchema), defaultValues: { client_id: item?.client_id ?? '', property_id: item?.property_id ?? '', etape: item?.etape ?? 'nouveau', probabilite: item?.probabilite ?? 0, date_visite: item?.date_visite?.slice(0, 10) ?? '', notes: item?.notes ?? '' } });
  const submit = async (v: PipelineFormValues) => { const input: PipelineCreateInput = { client_id: v.client_id, property_id: v.property_id, etape: v.etape, probabilite: v.probabilite, date_visite: v.date_visite || null, notes: v.notes || null }; try { if (item) await update.mutateAsync({ id: item.id, input }); else await create.mutateAsync(input); onOpenChange(false); } catch (e) { setFormError(getSupabaseErrorMessage(e, item ? 'modifier l’opportunité' : 'créer l’opportunité')); } };
  const busy = create.isPending || update.isPending;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="form-dialog"><DialogHeader><span className="form-kicker">Suivi commercial</span><DialogTitle>{item ? 'Modifier l’opportunité' : 'Nouvelle opportunité'}</DialogTitle><DialogDescription>Associez un contact à un bien pour suivre la progression du dossier.</DialogDescription></DialogHeader><Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form">
    <FormField control={form.control} name="client_id" render={({ field }) => <FormItem><FormLabel>Contact</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-pipeline-contact"><option value="">Choisir un contact</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}</select></FormControl><FormMessage /></FormItem>} />
    <FormField control={form.control} name="property_id" render={({ field }) => <FormItem><FormLabel>Bien concerné</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-pipeline-property"><option value="">Choisir un bien</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.title}</option>)}</select></FormControl><FormMessage /></FormItem>} />
     <div className="form-grid"><FormField control={form.control} name="etape" render={({ field }) => <FormItem><FormLabel>Étape</FormLabel><FormControl><Input {...field} placeholder="nouveau" data-testid="input-pipeline-stage" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="probabilite" render={({ field }) => <FormItem><FormLabel>Probabilité (%)</FormLabel><FormControl><Input type="number" min="0" max="100" {...field} data-testid="input-pipeline-probability" /></FormControl><FormMessage /></FormItem>} /></div>
    <FormField control={form.control} name="date_visite" render={({ field }) => <FormItem><FormLabel>Date de visite</FormLabel><FormControl><Input type="date" {...field} data-testid="input-pipeline-visit-date" /></FormControl></FormItem>} /><FormField control={form.control} name="notes" render={({ field }) => <FormItem><FormLabel>Notes</FormLabel><FormControl><Textarea {...field} data-testid="input-pipeline-notes" /></FormControl></FormItem>} />
    {formError && <p className="form-error" role="alert" data-testid="status-pipeline-form-error">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-pipeline">Annuler</Button><Button type="submit" disabled={busy} data-testid="button-submit-pipeline">{busy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer l’opportunité'}</Button></div>
  </form></Form></DialogContent></Dialog>;
}
function PipelinePage() {
  const { activeAgencyId } = useAgency(); const query = usePipeline(activeAgencyId); const contactsQ = useContacts(activeAgencyId); const propertiesQ = useProperties(activeAgencyId);
  const [search, setSearch] = useState(''); const [editing, setEditing] = useState<SalesPipelineRow | null>(null); const [open, setOpen] = useState(false);
  const contacts = contactsQ.data ?? []; const properties = propertiesQ.data ?? [];
  const rows = useMemo(() => (query.data ?? []).filter((item) => { const c = contacts.find((x) => x.id === item.client_id); const p = properties.find((x) => x.id === item.property_id); return `${c?.first_name ?? ''} ${c?.last_name ?? ''} ${p?.title ?? ''} ${item.etape}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr')); }), [query.data, contacts, properties, search]);
  const loading = query.isLoading || contactsQ.isLoading || propertiesQ.isLoading;
  const error = query.error || contactsQ.error || propertiesQ.error;
  return <><Heading eyebrow="Développement commercial" title="Pipeline commercial" description="Suivez les dossiers en cours, du premier échange à la conclusion." action={<ButtonPrimary testId="button-add-pipeline" onClick={() => { setEditing(null); setOpen(true); }} disabled={!contacts.length || !properties.length}><Plus size={15} /> Nouvelle opportunité</ButtonPrimary>} /><section className="list-toolbar"><label className="list-search"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Contact, bien ou étape" aria-label="Rechercher une opportunité" data-testid="input-search-pipeline" /></label><span className="result-count" data-testid="text-pipeline-count">{query.data ? `${rows.length} ${rows.length === 1 ? 'opportunité' : 'opportunités'}` : '—'}</span></section>
    {loading || error || !query.data?.length ? <PageDataState loading={loading} error={error} retry={() => { void query.refetch(); void contactsQ.refetch(); void propertiesQ.refetch(); }} count={query.data?.length ?? 0} emptyTitle="Aucune opportunité en cours" emptyText={contacts.length && properties.length ? 'Créez un dossier pour relier un contact à un bien et suivre les prochaines étapes.' : 'Pour ouvrir une opportunité, votre agence doit disposer d’au moins un contact et un bien.'} testId="empty-pipeline" /> : rows.length ? <div className="pipeline-list">{rows.map((item) => { const c = contacts.find((x) => x.id === item.client_id); const p = properties.find((x) => x.id === item.property_id); return <article className="pipeline-card" key={item.id} data-testid={`card-pipeline-${item.id}`}><div className="pipeline-stage"><span className="stage-marker" /><span>{item.etape}</span><small>{item.probabilite}% de probabilité</small></div><div className="pipeline-main"><div><span className="pipeline-label">CONTACT</span><strong>{c ? `${c.first_name} ${c.last_name ?? ''}` : 'Contact inaccessible'}</strong><small>{c?.phone || c?.email || 'Coordonnées non renseignées'}</small></div><ArrowRight className="pipeline-arrow" size={17} /><div><span className="pipeline-label">BIEN</span><strong>{p?.title ?? 'Bien inaccessible'}</strong><small>{p ? `${p.reference} · ${p.neighborhood || p.city || 'Localisation non renseignée'}` : 'Référence indisponible'}</small></div></div><div className="pipeline-meta"><span><Clock3 size={13} /> Visite : {dateLabel(item.date_visite)}</span><button className="row-action" onClick={() => { setEditing(item); setOpen(true); }} data-testid={`button-edit-pipeline-${item.id}`}><Pencil size={14} /> Modifier</button></div></article>; })}</div> : <div className="state-card compact-empty" data-testid="empty-filtered-pipeline"><div className="state-icon"><Search size={19} /></div><h2>Aucune opportunité correspondante</h2><p>Essayez un autre nom, bien ou étape.</p><Button variant="outline" onClick={() => setSearch('')} data-testid="button-clear-pipeline-search">Effacer la recherche</Button></div>}
    <PipelineDialog key={editing?.id ?? 'new-pipeline'} open={open} onOpenChange={setOpen} item={editing} contacts={contacts} properties={properties} />
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
    <FormField control={form.control} name="email" render={({ field }) => <FormItem><FormLabel>Adresse e-mail</FormLabel><div className="login-input-wrap"><Mail size={15} aria-hidden="true" /><FormControl><Input {...field} type="email" autoComplete="email" placeholder="vous@agence.ml" data-testid="input-login-email" /></FormControl></div><FormMessage /></FormItem>} />
    <FormField control={form.control} name="password" render={({ field }) => <FormItem><FormLabel>Mot de passe</FormLabel><div className="login-input-wrap"><LockKeyhole size={15} aria-hidden="true" /><FormControl><Input {...field} type="password" autoComplete="current-password" placeholder="Votre mot de passe" data-testid="input-login-password" /></FormControl></div><FormMessage /></FormItem>} />
    {(error || configurationError || initializationError) && <p className="form-error" role="alert" data-testid="status-login-error">{error || configurationError || initializationError}</p>}<Button type="submit" className="login-submit" disabled={busy || !!configurationError || !!initializationError} data-testid="button-login-submit">{busy ? 'Connexion…' : 'Se connecter'} <ArrowRight size={15} /></Button>
  </form></Form><div className="login-footnote"><ShieldCheck size={14} /> Les nouvelles inscriptions sont gérées par l’administrateur de votre agence.</div></div><span className="login-copyright">© {new Date().getFullYear()} Sofia Immobilier · Bamako</span></main></div>;
}

function RoutedContent() {
  const [path] = useLocation();
  if (path === '/login') return <Login />;
  return <WorkspaceGate><ErrorBoundary resetKey={path}><Switch><Route path="/" component={Overview} /><Route path="/biens" component={PropertiesPage} /><Route path="/contacts" component={ContactsPage} /><Route path="/pipeline" component={PipelinePage} /><Route path="/agence" component={AgencyPage} /><Route path="/parametres" component={SettingsPage} /><Route component={NotFound} /></Switch></ErrorBoundary></WorkspaceGate>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AuthProvider><AgencyProvider><RoutedContent /></AgencyProvider></AuthProvider></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
