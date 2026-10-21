import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  Bell, CheckCheck, UserPlus, Wallet, Upload, Star, ChevronLeft, ChevronRight,
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
  useDashboardSummary, useProperties, useContacts, usePipeline, useAgencyRoster, useCurrentProfile,
  useCreateProperty, useUpdateProperty, useCreateContact, useUpdateContact,
  useCreatePipelineItem, useUpdatePipelineItem, useUpdateAgency, useUpdateCurrentProfile,
  usePropertyMedia, useUploadPropertyMedia, useDeletePropertyMedia,
  useUploadPropertyMediaBatch, useDeletePropertyMediaMany, useReorderPropertyMedia,
  useAgencyMediaRefs, useAccountState, getAccountState, isBlockedAccount, useArchivedProperties,
  useRevenueOperations,
  usePlatformRole, useNotifications, useMarkNotificationRead, useMarkAllNotificationsRead,
  getCurrentProfileQueryKey,
  useTrackPropertyView, getPlatformRole,
  type PropertyCreateInput, type ContactCreateInput, type PipelineCreateInput,
  type AgencySettingsInput, type ProfileUpdateInput,
} from '@/lib/data-hooks';
import { compressImages } from '@/lib/image-tools';
// BLOC 3 : compteur de photos et decoupe des envois multiples selon l'offre.
import { formatQuota, splitByPhotoQuota, usePhotoQuota } from '@/lib/plan-limits';
import { PhotoQuotaBar } from '@/components/photo-quota';
import { AgencyLogo } from '@/lib/workspace-ui';
import { AgencyLogoCard } from '@/components/agency-logo-card';
// BLOC 6 : archivage et suppression d'un bien (autorisations tranchees cote serveur).
import { ArchivedPropertiesPanel, PropertyLifecyclePanel } from '@/components/property-lifecycle';
// BLOC 8 : assistant IA (bouton flottant), resume du jour et alertes intelligentes.
import { AssistantFab } from '@/components/assistant-fab';
// BLOC 9 : bouton retour partage (agence, admin, pages publiques) + suivi de route.
import { BackButton } from '@/components/back-button';
import { trackRoute } from '@/lib/back-navigation';
import { DailySummaryCard, SmartAlertsCard } from '@/components/smart-alerts';
// BLOC 4 : tracé précis des modifications des informations de l'agence.
import { diffAgencyFields, traceAgencySettingsChange } from '@/lib/agency-activity';
import { ThemeToggle } from '@/lib/theme';
import type { AgencyMemberRow, PropertyRow, ContactRow, SalesPipelineRow } from '@/lib/database.types';
import { getSupabaseClient, getSupabaseErrorMessage } from '@/lib/supabase';
import NotFound from '@/pages/not-found';
import VisitsPage from '@/pages/visits';
import WhatsAppPage from '@/pages/whatsapp';
import AssistantPage from '@/pages/assistant';
import AutomationsPage from '@/pages/automations';
import SignupPage from '@/pages/signup';
import OnboardingPage from '@/pages/onboarding';
import AdminShell from '@/pages/admin/admin-shell';
import AdminOverviewPage from '@/pages/admin/overview';
import AdminAgenciesPage from '@/pages/admin/agencies';
import AdminPropertiesPage from '@/pages/admin/properties';
import AdminActivityPage from '@/pages/admin/activity';
import AdminSubscriptionsPage from '@/pages/admin/subscriptions';
import AdminBillingPage from '@/pages/admin/billing';
import AdminSettingsPage from '@/pages/admin/settings';
// BLOC 7 : consommation IA et canal WhatsApp (espace plateforme).
import AdminUsagePage from '@/pages/admin/usage';
import AdminRevenuePage from '@/pages/admin/revenue';
import WelcomePage from '@/pages/welcome';
import TeamPage from '@/pages/team';
import JoinAgencyPage from '@/pages/rejoindre';
import ForcePasswordPage from '@/pages/force-password';
import MyOfferPage from '@/pages/my-offer';
import { Area, AreaChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { bucketize, computeStats, periodRange } from '@/lib/revenue-utils';

const queryClient = new QueryClient();

const nav = [
  { href: '/dashboard', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { href: '/biens', label: 'Biens immobiliers', icon: Home },
  { href: '/contacts', label: 'Prospects et contacts', icon: ContactRound },
  { href: '/pipeline', label: 'Pipeline commercial', icon: SlidersHorizontal },
  { href: '/visites', label: 'Visites', icon: CalendarDays },
  { href: '/whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { href: '/assistant-ia', label: 'Assistant IA', icon: CircleHelp },
  { href: '/automatisations', label: 'Automatisations', icon: RefreshCw },
  { href: '/agence', label: 'Agence et membres', icon: UsersRound },
  { href: '/mon-offre', label: 'Mon offre', icon: Wallet },
  { href: '/equipe', label: 'Équipe', icon: UserCog },
  { href: '/profil', label: 'Mon profil', icon: UserRound },
  { href: '/parametres', label: 'Paramètres', icon: Settings2 },
];
const roleNames: Record<string, string> = { owner: 'Propriétaire', admin: 'Administrateur', manager: 'Responsable', agent: 'Agent', viewer: 'Lecture seule' };
const propertyStatus: Record<string, string> = { available: 'Disponible', reserved: 'Réservé', sold: 'Vendu', rented: 'Loué', unavailable: 'Indisponible', draft: 'Brouillon', archived: 'Archivé' };
const contactStatus: Record<string, string> = { lead: 'Nouveau contact', prospect: 'Prospect', client: 'Client', inactive: 'Inactif' };
const cash = (price: number, currency: string) => `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(price)} ${currency === 'XOF' ? 'FCFA' : currency}`;
const dateLabel = (value?: string | null) => value ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Non renseignée';

function BrandMark() { return <div className="brand-mark" aria-hidden="true"><Building2 size={18} /></div>; }

function AppShell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [signOutError, setSignOutError] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { agencies, activeAgency, activeAgencyId, setActiveAgencyId, activeMembership } = useAgency();
  const { data: profile } = useCurrentProfile(user?.id);
  const notificationsQ = useNotifications(activeAgencyId);
  const markRead = useMarkNotificationRead(activeAgencyId);
  const markAllRead = useMarkAllNotificationsRead(activeAgencyId);
  const unreadCount = (notificationsQ.data ?? []).filter((item) => !item.read_at).length;
  const name = profile?.full_name || user?.email || 'Mon compte';
  // LOT A (point 4) : un agent n'a pas acces a la gestion de l'equipe.
  const isAgentOnly = activeMembership?.role === 'agent';
  // BLOC 10 (roles) : un agent n'a acces ni a l'Equipe, ni a Mon offre
  // (paiements, offre, consommation). Le filtrage de la navigation seul ne
  // suffit pas : les routes sont aussi gardees (voir RequireManager ci-dessous).
  const agentHiddenRoutes = ['/equipe', '/mon-offre'];
  const visibleNav = isAgentOnly ? nav.filter((item) => !agentHiddenRoutes.includes(item.href)) : nav;
  // BLOC 9 : journal des routes internes -> le bouton retour ne sort jamais de l'app.
  useEffect(() => { trackRoute(path); }, [path]);
  const currentLabel = nav.find((item) => item.href === path)?.label ?? (path.startsWith('/biens/') ? 'Fiche bien' : path.startsWith('/contacts/') ? 'Fiche contact' : 'Espace de travail');
  const handleSignOut = async () => {
    setSignOutError('');
    try {
      await signOut();
    } catch (error) {
      setSignOutError(getSupabaseErrorMessage(error, 'fermer la session'));
      setNotice('error');
    }
  };
  return <div className="app-shell">
    <div className={`mobile-overlay${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen(false)} data-testid="mobile-navigation-overlay" />
    <aside className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Navigation principale">
      <Link href="/dashboard" className="brand-lockup" data-testid="link-brand-home" onClick={() => setMenuOpen(false)}><BrandMark /><div><div className="brand-name">sofia immobilier</div><div className="brand-caption">L’espace de votre agence</div></div></Link>
      <div className="nav-label">Espace de travail</div>
      <nav className="nav-list" aria-label="Navigation principale">{visibleNav.map(({ href, label, icon: Icon }) => <Link href={href} key={href} className={`nav-link${path === href ? ' is-active' : ''}`} aria-current={path === href ? 'page' : undefined} data-testid={`link-nav-${href === '/dashboard' ? 'overview' : href.slice(1)}`} onClick={() => setMenuOpen(false)}><Icon size={16} /><span>{label}</span></Link>)}</nav>
      <div className="sidebar-spacer" />
      <div className="connection-card" data-testid="status-data-access"><div className="connection-heading"><i /> Espace sécurisé</div><p>Vos données sont limitées aux agences auxquelles vous avez accès.</p></div>
      <label className="agency-select-label" htmlFor="agency-switcher">Agence active</label>
      <div className="agency-switcher" data-testid="display-agency-workspace">
        {/* BLOC 4 : logo de l'agence dans la barre laterale. */}
        <AgencyLogo logoUrl={activeAgency?.logo_url} name={activeAgency?.name} size={34} className="agency-avatar" testId="display-sidebar-agency-logo" />
        {agencies.length > 1 ? <select id="agency-switcher" value={activeAgencyId ?? ''} onChange={(e) => setActiveAgencyId(e.target.value)} data-testid="select-active-agency" aria-label="Choisir une agence">{agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}</select> : <div className="agency-label"><strong>{activeAgency?.name ?? 'Aucune agence active'}</strong><span>{activeMembership ? roleNames[activeMembership.role] : 'Accès agence requis'}</span></div>}
        {agencies.length > 1 && <ChevronDown size={14} color="#9aafaa" />}
      </div>
      <button className="sidebar-signout" onClick={() => void handleSignOut()} data-testid="button-sign-out"><LogOut size={14} /> Se déconnecter</button>
    </aside>
    <div className="main-column">
      <header className="topbar"><div className="breadcrumb"><AgencyLogo logoUrl={activeAgency?.logo_url} name={activeAgency?.name} size={24} testId="display-topbar-agency-logo" /><span>{activeAgency?.name ?? 'Espace agence'}</span><ArrowRight size={12} /><strong>{currentLabel}</strong></div><div className="topbar-tools">{path !== '/dashboard' && <BackButton space="agency" variant="desktop" testId="button-back-overview" />}<button type="button" className="icon-button topbar-signout" onClick={() => void handleSignOut()} aria-label="Se déconnecter" title="Se déconnecter" data-testid="button-topbar-sign-out"><LogOut size={15} /></button><ThemeToggle testId="button-theme-toggle-app" /><Link href="/profil" className="profile-chip" data-testid="display-user-access-status"><div className="profile-circle">{name.slice(0, 1).toUpperCase()}</div><span>{name}</span></Link>
        <div className="notif-wrap">
          <button type="button" className="icon-button notif-button" onClick={() => setNotifOpen((v) => !v)} aria-label="Notifications" title="Notifications" aria-expanded={notifOpen} data-testid="button-notifications">
            <Bell size={15} />
            {unreadCount > 0 && <span className="notif-badge" data-testid="count-unread-notifications">{unreadCount > 9 ? '9+' : unreadCount}</span>}
          </button>
          {notifOpen && <div className="notif-panel" role="dialog" aria-label="Notifications" data-testid="panel-notifications">
            <div className="notif-panel-head">
              <strong>Notifications</strong>
              {unreadCount > 0 && <button type="button" className="text-action" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending} data-testid="button-mark-all-read"><CheckCheck size={13} /> Tout lire</button>}
            </div>
            {notificationsQ.isLoading ? <div className="notif-empty">Chargement…</div> : notificationsQ.error ? <div className="notif-empty">Impossible de charger les notifications.</div> : (notificationsQ.data ?? []).length ? (
              <div className="notif-list">
                {notificationsQ.data!.map((item) => (
                  <button type="button" key={item.id} className={`notif-item${item.read_at ? '' : ' is-unread'}`} onClick={() => { if (!item.read_at) markRead.mutate(item.id); }} data-testid={`row-notification-${item.id}`}>
                    <strong>{item.title}</strong>
                    <span>{item.message}</span>
                    <small>{dateLabel(item.created_at)}</small>
                  </button>
                ))}
              </div>
            ) : <div className="notif-empty">Aucune notification pour l’instant.</div>}
            <button type="button" className="notif-close" onClick={() => setNotifOpen(false)}>Fermer</button>
          </div>}
        </div>
      </div></header>
      <header className="mobile-header">
        {/* BLOC 9 : retour visible sur mobile ET dans les previews. Repli
            determine sur la page parente quand il n'y a pas d'historique interne. */}
        <BackButton space="agency" variant="mobile" testId="button-mobile-back" />
        <div className="mobile-brand"><AgencyLogo logoUrl={activeAgency?.logo_url} name={activeAgency?.name} size={26} testId="display-mobile-agency-logo" /><strong>{activeAgency?.name ?? 'sofia immobilier'}</strong></div><button type="button" className="icon-button mobile-signout" onClick={() => void handleSignOut()} aria-label="Se déconnecter" data-testid="button-mobile-sign-out"><LogOut size={17} /></button><button type="button" className="icon-button mobile-menu-button" aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} data-testid="button-mobile-menu">{menuOpen ? <X size={18} /> : <Menu size={18} />}</button></header>
      <main className="content-wrap">{children}</main>
      {/* BLOC 8 : assistant IA accessible depuis tout l'espace agence. */}
      <AssistantFab />
    </div>
    {notice && <div className="notice-toast" role={signOutError ? 'alert' : 'status'} data-testid="status-notifications">{signOutError || 'Action effectuée.'}<button onClick={() => setNotice('')} aria-label="Fermer le message" data-testid="button-dismiss-notice"><X size={13} /></button></div>}
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
  return <div className="state-card" data-testid="empty-membership"><div className="state-icon"><LockKeyhole size={19} /></div><span className="state-kicker">Accès requis</span><h2>Aucune agence active associée</h2><p>Créez votre propre agence en quelques étapes, ou demandez à un administrateur de vous donner accès à une agence existante.</p><div className="heading-actions" style={{ justifyContent: 'center' }}><Link href="/onboarding" className="button-link" data-testid="link-create-agency"><UserPlus size={15} /> Créer mon agence</Link><button className="button-link" onClick={retry}><RefreshCw size={14} /> Réessayer</button></div></div>;
}
function useSafeRetry(query: { refetch: () => unknown }) { return () => { void query.refetch(); }; }
function Redirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  const redirected = useRef(false);
  useEffect(() => {
    if (redirected.current) return;
    redirected.current = true;
    navigate(to, { replace: true });
  }, [to, navigate]);
  return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Redirection…" /></div>;
}
const SESSION_BLOCK_KEY = 'sofia-compte-desactive';

/**
 * Surveille l'état du compte : une agence suspendue est déconnectée
 * immédiatement (chargement, changement de route, rechargement de fenêtre).
 * Un compte administrateur n'est jamais bloqué (isBlockedAccount).
 */
function useAccountBlockGuard() {
  const { user, signOut } = useAuth();
  const [, navigate] = useLocation();
  const accountQ = useAccountState(Boolean(user));
  const [kicking, setKicking] = useState(false);
  useEffect(() => {
    if (!user || kicking) return;
    if (isBlockedAccount(accountQ.data)) {
      setKicking(true);
      sessionStorage.setItem(SESSION_BLOCK_KEY, '1');
      void Promise.resolve(signOut())
        .catch(() => undefined)
        .finally(() => navigate('/login', { replace: true }));
    }
  }, [accountQ.data, user, signOut, navigate, kicking]);
  return { accountQ, kicking };
}

function WorkspaceGate({ children }: { children: ReactNode }) {
  const { user, loading, configurationError, initializationError } = useAuth();
  const agency = useAgency();
  const client = useQueryClient();
  const roleQ = usePlatformRole(user?.id);
  const block = useAccountBlockGuard();
  // LOT A (point 4) : un compte cree par le propriétaire reçoit un mot de passe
  // temporaire. Tant qu'il n'est pas remplace, l'espace de travail reste ferme.
  const profileQ = useCurrentProfile(user?.id);
  if (loading || (user && roleQ.isLoading)) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Chargement de la session" /></div>;
  if (configurationError || initializationError) return <div className="auth-loading"><div className="state-card error-state"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Connexion indisponible</h2><p>{configurationError || initializationError}</p></div></div>;
  if (!user) return <Login />;
  // Vérification du statut de l'agence avant tout affichage protégé.
  if (block.kicking) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Compte agence désactivé — déconnexion" /></div>;
  if (block.accountQ.isLoading && !block.accountQ.data) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Vérification du statut du compte" /></div>;
  // Un administrateur plateforme sans adhésion agence est renvoyé vers la console d'administration.
  // Ecran obligatoire : ni navigation, ni donnees metier ne sont atteignables.
  if (profileQ.data?.must_change_password === true) {
    return <ForcePasswordPage onDone={() => { void client.invalidateQueries({ queryKey: getCurrentProfileQueryKey(user.id) }); }} />;
  }
  if (roleQ.data?.isAdmin && !agency.loading && !agency.error && agency.memberships.length === 0) return <Redirect to="/admin" />;
  if (agency.loading || agency.error || !agency.activeAgencyId) return <AppShell><NoAgency isLoading={agency.loading || (agency.memberships.length > 0 && !agency.activeAgencyId)} error={agency.error} retry={() => { void client.invalidateQueries({ queryKey: ['sofia', 'memberships'] }); void client.invalidateQueries({ queryKey: ['sofia', 'agencies'] }); }} /></AppShell>;
  return <AppShell>{children}</AppShell>;
}

function Overview() {
  const { activeAgencyId, activeMembership } = useAgency();
  // BLOC 10 (roles) : le chiffre d'affaires est reserve au proprietaire et aux
  // administrateurs de l'agence. Un agent (ou un role non gestionnaire) ne voit
  // ni le panneau CA, ni ses indicateurs.
  const canSeeRevenue = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';
  const summary = useDashboardSummary(activeAgencyId);
  const revenueQ = useRevenueOperations(activeAgencyId);
  const [caPeriod, setCaPeriod] = useState<'month' | 'm6' | 'm12' | 'year'>('m6');
  const properties = useProperties(activeAgencyId);
  const pipeline = usePipeline(activeAgencyId);
  if (summary.isLoading || properties.isLoading || pipeline.isLoading) return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence, à jour et accessibles." /><LoadingRows /></>;
  if (summary.error) return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence." /><ErrorState error={summary.error} retry={useSafeRetry(summary)} /></>;
  const stats = [
    { label: 'Biens totaux', count: summary.data?.properties ?? 0, foot: 'Tout le portefeuille', icon: Home },
    { label: 'Disponibles', count: summary.data?.availableProperties ?? 0, foot: 'À commercialiser', icon: Home },
    { label: 'Loués', count: summary.data?.rentedProperties ?? 0, foot: 'Statut enregistré', icon: KeyRound },
    { label: 'Vendus', count: summary.data?.soldProperties ?? 0, foot: 'Statut enregistré', icon: ShieldCheck },
    { label: 'Contacts actifs', count: summary.data?.activeContacts ?? 0, foot: 'Hors contacts inactifs', icon: ContactRound },
    { label: 'Prospects', count: summary.data?.prospects ?? 0, foot: 'Nouveaux et prospects', icon: ArrowDownRight },
    { label: 'Opportunités', count: summary.data?.opportunities ?? 0, foot: 'Dossiers du pipeline', icon: SlidersHorizontal },
    { label: 'Membres actifs', count: summary.data?.activeMembers ?? 0, foot: 'Accès en cours', icon: UsersRound },
  ];
  const caOps = revenueQ.data ?? [];
  const caRange = periodRange(caPeriod);
  const caStats = computeStats(caOps, caRange);
  const caMonthStats = computeStats(caOps, periodRange('month'));
  const caYearStats = computeStats(caOps, periodRange('year'));
  const caBuckets = bucketize(caOps, caRange, 'month');
  const compact = (value: number) => new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const caTrendClass = caStats.variation !== null && caStats.variation >= 0 ? 'is-up' : 'is-down';
  const caTrendLabel = caStats.variation === null ? 'Aucune période précédente' : `${caStats.variation >= 0 ? '▲' : '▼'} ${Math.abs(caStats.variation).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % vs période précédente`;
  const latest = (properties.data ?? []).slice(0, 5);
  const stageCounts = Object.entries((pipeline.data ?? []).reduce<Record<string, number>>((acc, row) => { acc[row.etape] = (acc[row.etape] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]);
  const recentPipeline = (pipeline.data ?? []).slice(0, 4);
  const monthlyAdds = Array.from({length: 6}, (_, index) => {
    const date = new Date(); date.setDate(1); date.setMonth(date.getMonth() - (5 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const count = (pipeline.data ?? []).filter((row) => row.created_at.slice(0, 7) === key).length;
    return { label: new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(date), count };
  });
  const relatedClosed = new Set((pipeline.data ?? []).filter((o) => ['sold', 'rented'].includes((properties.data ?? []).find((p) => p.id === o.property_id)?.status ?? '')).map((o) => o.id)).size;
  const conversion = (pipeline.data ?? []).length ? `${((relatedClosed / (pipeline.data ?? []).length) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : 'Données insuffisantes';
  return <><Heading eyebrow="Votre activité" title="Vue d’ensemble" description="Les repères essentiels de votre agence, à jour et accessibles." /><section className="status-banner" data-testid="status-dashboard-access"><div className="status-banner-icon"><ShieldCheck size={15} /></div><div><strong>Votre espace de travail est synchronisé</strong><p>Les indicateurs ci-dessous reflètent les données actuellement accessibles pour votre agence.</p></div><span className="status-tag">Accès actif</span></section>
    {/* BLOC 8 : resume du jour (assistant IA, a la demande) et alertes calculees. */}
    <div className="insight-grid"><DailySummaryCard /><SmartAlertsCard /></div>
    <section className="stat-grid stat-grid-eight" aria-label="Indicateurs de l’agence">{stats.map(({ label, count, foot, icon: Icon }, i) => <article className="stat-card" key={label} data-testid={`card-stat-${i + 1}`}><div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={14} /></span></div><div className="stat-value" data-testid={`value-stat-${i + 1}`}>{count}</div><div className="stat-foot">{foot}</div></article>)}</section>

    {canSeeRevenue && (
    <section className="panel revenue-overview-panel" data-testid="panel-ca-dashboard">
      <div className="panel-head">
        <div><h2><Wallet size={17} /> Chiffre d’affaires</h2><p>Commissions calculées automatiquement à chaque vente ou location · volume des transactions affiché en secondaire</p></div>
        <div className="revenue-toolbar revenue-period-select" role="group" aria-label="Période du chiffre d’affaires">
          {([['month', 'Mois courant'], ['m6', '6 mois'], ['m12', '12 mois'], ['year', 'Année']] as const).map(([key, label]) => (
            <button key={key} type="button" className={`button-link period-pill${caPeriod === key ? ' is-active' : ''}`} aria-pressed={caPeriod === key} onClick={() => setCaPeriod(key)} data-testid={`button-ca-periode-${key}`}>{label}</button>
          ))}
        </div>
      </div>
      <div className="revenue-kpis revenue-kpis-dashboard">
        <article className="kpi-card" data-testid="kpi-ca-mois"><span className="kpi-label">CA du mois</span><strong className="kpi-value">{cash(caMonthStats.ca, 'XOF')}</strong><span className="kpi-foot">Commission · volume {cash(caMonthStats.volume, 'XOF')} · {caMonthStats.count} opération(s)</span></article>
        <article className="kpi-card" data-testid="kpi-ca-annee"><span className="kpi-label">CA de l’année</span><strong className="kpi-value">{cash(caYearStats.ca, 'XOF')}</strong><span className="kpi-foot">Commission · volume {cash(caYearStats.volume, 'XOF')}</span></article>
        <article className="kpi-card" data-testid="kpi-ca-variation"><span className="kpi-label">Variation de la période</span><strong className="kpi-value"><span className={`trend-chip ${caTrendClass}`}>{caStats.variation === null ? '—' : `${caStats.variation >= 0 ? '+' : '−'}${Math.abs(caStats.variation).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`}</span></strong><span className="kpi-foot">{caTrendLabel}</span></article>
        <article className="kpi-card" data-testid="kpi-ca-volume"><span className="kpi-label">Volume des transactions</span><strong className="kpi-value">{cash(caStats.volume, 'XOF')}</strong><span className="kpi-foot">{caStats.count} opération(s) sur la période · panier moyen {cash(caStats.count ? caStats.ca / caStats.count : 0, 'XOF')}</span></article>
      </div>
      {revenueQ.isLoading ? <LoadingRows label="Chargement du chiffre d’affaires" /> : revenueQ.error ? <ErrorState error={revenueQ.error} retry={useSafeRetry(revenueQ)} testId="status-ca-dashboard-error" /> : caBuckets.length ? (
        <div className="chart-box" data-testid="chart-ca-dashboard">
          <ResponsiveContainer width="100%" height={264}>
            <AreaChart data={caBuckets} margin={{ top: 18, right: 10, left: -6, bottom: 0 }}>
              <defs>
                <linearGradient id="caDashGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#0f766e" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#0f766e" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.12} vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={10} tickFormatter={(v: number) => compact(Number(v))} width={52} />
              <Tooltip formatter={(value: number) => [cash(Number(value), 'XOF'), 'Commission']} />
              <Area type="monotone" dataKey="ca" stroke="var(--si-chart-1)" strokeWidth={2.4} fill="url(#caDashGrad)" name="Commission">
                <LabelList dataKey="ca" position="top" formatter={(value: number) => compact(Number(value))} style={{ fontSize: 10, fontWeight: 700, fill: 'currentColor' }} />
              </Area>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="empty-table" data-testid="empty-ca-dashboard"><div className="empty-table-mark"><Wallet size={17} /></div><strong>Aucune opération sur cette période</strong><p>Le chiffre d’affaires se remplit automatiquement dès qu’un bien passe en vendu ou loué.</p></div>
      )}
    </section>
    )}
    <section className="overview-grid"><article className="panel"><div className="panel-head"><div><h2>Biens récemment ajoutés</h2><p>Les derniers dossiers du portefeuille</p></div><Link href="/biens" className="text-action" data-testid="link-view-properties">Tous les biens <ArrowRight size={13} /></Link></div>
       {properties.error ? <ErrorState error={properties.error} retry={useSafeRetry(properties)} testId="status-recent-properties-error" /> : latest.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Référence</th><th>Bien</th><th>Localisation</th><th>Statut</th></tr></thead><tbody>{latest.map((p) => <tr key={p.id} data-testid={`row-recent-property-${p.id}`}><td><strong>{p.reference}</strong></td><td>{p.title}</td><td>{p.neighborhood || p.city || '—'}</td><td><span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span></td></tr>)}</tbody></table></div> : <div className="empty-table" data-testid="empty-recent-properties"><div className="empty-table-mark"><Home size={17} /></div><strong>Aucun bien enregistré</strong><p>Les biens ajoutés par votre équipe apparaîtront ici.</p><Link href="/biens" className="text-action" data-testid="link-add-first-property">Ajouter un bien <ArrowRight size={13} /></Link></div>}</article>
       <article className="panel readiness-panel"><div className="readiness-title"><h2>Repères d’agence</h2><span>Vue du jour</span></div><p className="readiness-intro">Conversion observée : {conversion}. Définition : opportunités reliées à un bien vendu ou loué / opportunités chargées.</p><div className="readiness-list"><Link href="/biens" className="readiness-row" data-testid="link-overview-properties"><div className="readiness-icon"><Home size={14} /></div><div className="readiness-copy"><strong>Biens disponibles</strong><span>{summary.data?.availableProperties ?? 0} actuellement en commercialisation</span></div><ArrowRight size={14} /></Link><Link href="/contacts" className="readiness-row" data-testid="link-overview-contacts"><div className="readiness-icon"><ContactRound size={14} /></div><div className="readiness-copy"><strong>Contacts actifs</strong><span>{summary.data?.activeContacts ?? 0} fiches non inactives</span></div><ArrowRight size={14} /></Link><Link href="/pipeline" className="readiness-row" data-testid="link-overview-pipeline"><div className="readiness-icon"><SlidersHorizontal size={14} /></div><div className="readiness-copy"><strong>Pipeline commercial</strong><span>{summary.data?.opportunities ?? 0} opportunités à suivre</span></div><ArrowRight size={14} /></Link></div><div className="notice-box"><CircleHelp size={14} /> Les membres sont visibles par rôle uniquement afin de préserver la confidentialité de leurs profils.</div></article></section>
    <section className="overview-grid dashboard-lower"><article className="panel"><div className="panel-head"><div><h2>Répartition des opportunités</h2><p>Étapes réellement présentes dans le pipeline</p></div><Link href="/pipeline" className="text-action">Ouvrir le pipeline <ArrowRight size={13} /></Link></div>{pipeline.error ? <ErrorState error={pipeline.error} retry={useSafeRetry(pipeline)} /> : stageCounts.length ? <div className="stage-summary">{stageCounts.map(([stage, count]) => <div className="stage-summary-row" key={stage}><span>{stage}</span><div className="stage-track"><i style={{ width: `${Math.max(8, count / Math.max(...stageCounts.map((s) => s[1])) * 100)}%` }} /></div><strong>{count}</strong></div>)}</div> : <div className="empty-table"><strong>Pas encore d’étape enregistrée</strong><p>Les étapes apparaîtront à partir des opportunités chargées.</p></div>}</article>
      <article className="panel"><div className="panel-head"><div><h2>Derniers dossiers créés</h2><p>À partir de created_at · dates françaises</p></div></div>{recentPipeline.length ? <div className="recent-opportunities">{recentPipeline.map((item) => <div className="recent-opportunity" key={item.id}><span className="recent-stage">{item.etape}</span><strong>{dateLabel(item.created_at)}</strong><small>{item.probabilite}% de probabilité</small></div>)}</div> : <div className="empty-table"><strong>Aucune opportunité chargée</strong><p>Les créations apparaîtront ici.</p></div>}<div className="trend-block"><strong>Ajouts d’opportunités · 6 derniers mois</strong><div className="trend-bars">{monthlyAdds.map((month, i)=><div key={`${month.label}-${i}`} title={`${month.count} ajout(s)`}><span style={{height:`${Math.max(5, month.count / Math.max(1, ...monthlyAdds.map((m)=>m.count)) * 100)}%`}}/><small>{month.label}</small><b>{month.count}</b></div>)}</div></div></article></section></>;
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
  commission_rate: z.string().optional().refine((value) => !value || (Number(value) >= 0 && Number(value) <= 100), 'Taux de commission (vente) entre 0 et 100 %'),
  rental_commission_rate: z.string().optional().refine((value) => !value || (Number(value) >= 0 && Number(value) <= 500), 'Commission de location entre 0 et 500 %'),
});
type PropertyFormValues = z.infer<typeof propertySchema>;
function PropertyDialog({ open, onOpenChange, item, currency }: { open: boolean; onOpenChange: (open: boolean) => void; item: PropertyRow | null; currency: string }) {
  const { activeAgencyId, canManageAgency } = useAgency();
  const create = useCreateProperty(activeAgencyId); const update = useUpdateProperty(activeAgencyId);
  const form = useForm<PropertyFormValues>({ resolver: zodResolver(propertySchema), defaultValues: { reference: '', title: '', transaction_type: 'sale', property_type: '', price: 0, currency, status: 'draft', neighborhood: '', city: 'Bamako', address: '', description: '', bedrooms: '', bathrooms: '', area_m2: '', commission_rate: '', rental_commission_rate: '' } });
  const [formError, setFormError] = useState('');
  const [createdProperty, setCreatedProperty] = useState<PropertyRow | null>(null);
  const targetId = item?.id ?? createdProperty?.id;
  useEffect(() => {
    if (!item) return;
    form.reset({
      reference: item.reference,
      title: item.title,
      transaction_type: item.transaction_type,
      property_type: item.property_type,
      price: item.price,
      currency: item.currency,
      status: item.status,
      neighborhood: item.neighborhood ?? '',
      city: item.city ?? '',
      address: item.address ?? '',
      description: item.description ?? '',
      bedrooms: item.bedrooms != null ? String(item.bedrooms) : '',
      bathrooms: item.bathrooms != null ? String(item.bathrooms) : '',
      area_m2: item.area_m2 != null ? String(item.area_m2) : '',
      commission_rate: item.commission_rate != null ? String(item.commission_rate) : '',
      rental_commission_rate: item.rental_commission_rate != null ? String(item.rental_commission_rate) : '',
    });
  }, [item, form]);
  const mediaQ = usePropertyMedia(activeAgencyId, targetId);
  const uploadBatch = useUploadPropertyMediaBatch(activeAgencyId);
  const removeMany = useDeletePropertyMediaMany(activeAgencyId, targetId, true);
  const reorder = useReorderPropertyMedia(activeAgencyId, targetId);
  const [staged, setStaged] = useState<Array<{ key: string; file: File; preview: string }>>([]);
  const [photoProgress, setPhotoProgress] = useState<{ done: number; total: number } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [photoNotice, setPhotoNotice] = useState('');
  const existingPhotos = targetId ? (mediaQ.data ?? []) : [];
  // BLOC 3 : « 7/10 » — photos déjà enregistrées + photos préparées.
  const photoQuota = usePhotoQuota(activeAgencyId, existingPhotos.length, staged.length);

  const addFiles = async (source: FileList | File[] | null) => {
    if (!source) return;
    const files = Array.from(source);
    if (!files.length) return;
    setFormError('');
    setPhotoNotice('');
    // BLOC 3 : un envoi multiple qui dépasse la limite n'envoie que ce qui
    // rentre ; les fichiers refusés sont nommés explicitement.
    const { accepted, refused } = splitByPhotoQuota(files, photoQuota.remaining);
    if (refused.length) {
      const names = refused.slice(0, 3).map((file) => file.name).join(', ');
      setPhotoNotice(
        `${refused.length} photo(s) non retenue(s) : ${names}${refused.length > 3 ? '…' : ''}. ` +
        (photoQuota.reached || accepted.length === 0
          ? `Limite de ${photoQuota.limit} photos par bien atteinte avec l’offre ${photoQuota.planName}.`
          : `Seules les ${accepted.length} première(s) rentrent dans la limite de ${photoQuota.limit} photos de l’offre ${photoQuota.planName}.`),
      );
    }
    if (!accepted.length) return;
    try {
      const compressed = await compressImages(accepted);
      setStaged((previous) => [
        ...previous,
        ...compressed.map((file) => ({ key: crypto.randomUUID(), file, preview: URL.createObjectURL(file) })),
      ]);
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, 'préparer les photos'));
    }
  };
  const dropStaged = (key: string) => {
    setStaged((previous) => {
      const target = previous.find((entry) => entry.key === key);
      if (target) URL.revokeObjectURL(target.preview);
      return previous.filter((entry) => entry.key !== key);
    });
  };
  const moveStaged = (index: number, direction: -1 | 1) => {
    setStaged((previous) => {
      const next = [...previous];
      const swapWith = index + direction;
      if (swapWith < 0 || swapWith >= next.length) return previous;
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      return next;
    });
  };
  const clearStaged = () => {
    staged.forEach((entry) => URL.revokeObjectURL(entry.preview));
    setStaged([]);
  };
  const makeCover = async (photoId: string) => {
    const list = [...existingPhotos];
    const rest = list.filter((photo) => photo.id !== photoId);
    const order = [
      { id: photoId, sort_order: 0 },
      ...rest.map((photo, index) => ({ id: photo.id, sort_order: index + 1 })),
    ];
    setPhotoNotice('');
    try {
      await reorder.mutateAsync(order);
      setPhotoNotice('Couverture mise à jour.');
    } catch (error) {
      setPhotoNotice(getSupabaseErrorMessage(error, 'définir la couverture'));
    }
  };
  const moveExisting = async (photoId: string, direction: -1 | 1) => {
    const list = [...existingPhotos];
    const index = list.findIndex((photo) => photo.id === photoId);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= list.length) return;
    setPhotoNotice('');
    try {
      await reorder.mutateAsync([
        { id: list[index].id, sort_order: list[swapWith].sort_order },
        { id: list[swapWith].id, sort_order: list[index].sort_order },
      ]);
    } catch (error) {
      setPhotoNotice(getSupabaseErrorMessage(error, 'réordonner les photos'));
    }
  };
  const dropExisting = async (photo: (typeof existingPhotos)[number]) => {
    if (!window.confirm(`Supprimer définitivement la photo « ${photo.file_name} » du stockage et de la fiche ?`)) return;
    setPhotoNotice('');
    try {
      await removeMany.mutateAsync([{ id: photo.id, storage_path: photo.storage_path }]);
      setPhotoNotice('Photo supprimée.');
    } catch (error) {
      setPhotoNotice(getSupabaseErrorMessage(error, 'supprimer la photo'));
    }
  };

  const isBusy = create.isPending || update.isPending || photoBusy;
  const submit = async (values: PropertyFormValues) => {
    setFormError('');
    setPhotoNotice('');
    const input: PropertyCreateInput = { reference: values.reference, title: values.title, transaction_type: values.transaction_type, property_type: values.property_type, price: values.price, currency: values.currency, status: values.status, neighborhood: values.neighborhood || null, city: values.city || null, address: values.address || null, description: values.description || null, bedrooms: values.bedrooms ? Number(values.bedrooms) : null, bathrooms: values.bathrooms ? Number(values.bathrooms) : null, area_m2: values.area_m2 ? Number(values.area_m2) : null, commission_rate: values.commission_rate ? Number(values.commission_rate) : null, rental_commission_rate: values.rental_commission_rate ? Number(values.rental_commission_rate) : null };
    let targetProperty: PropertyRow | null = item;
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, input });
      } else if (createdProperty) {
        // Une première tentative a déjà créé le bien (échec photo) : on met à jour.
        await update.mutateAsync({ id: createdProperty.id, input });
        targetProperty = { ...createdProperty, ...input } as PropertyRow;
        setCreatedProperty(targetProperty);
      } else {
        const created = await create.mutateAsync(input);
        setCreatedProperty(created);
        targetProperty = created;
      }
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item || createdProperty ? 'modifier le bien' : 'créer le bien'));
      return;
    }
    // Envoi des photos (compression déjà effectuée à la sélection).
    if (staged.length && targetProperty) {
      setPhotoBusy(true);
      setPhotoProgress({ done: 0, total: staged.length });
      try {
        const result = await uploadBatch.mutateAsync({
          files: staged.map((entry) => entry.file),
          propertyId: targetProperty.id,
          propertyReference: targetProperty.reference,
          startSortOrder: existingPhotos.length,
          onProgress: (done, total) => setPhotoProgress({ done, total }),
        });
        // BLOC 3 : un échec partiel n'annule pas les photos qui sont passées.
        clearStaged();
        if (result.failed.length) {
          const names = result.failed.slice(0, 3).map((entry) => entry.file.name).join(', ');
          setFormError(
            `Le bien est enregistré et ${result.uploaded.length} photo(s) ont été envoyée(s). ` +
            `${result.failed.length} photo(s) refusée(s) : ${names}${result.failed.length > 3 ? '…' : ''}. ` +
            `Motif : ${result.failed[0].reason}`,
          );
        } else {
          onOpenChange(false);
        }
      } catch (error) {
        setFormError(
          `Le bien est enregistré, mais ${staged.length} photo(s) n’ont pas pu être envoyées : ${getSupabaseErrorMessage(error, 'envoyer les photos')} Vous pouvez réessayer — le formulaire reste ouvert.`,
        );
      } finally {
        setPhotoBusy(false);
        setPhotoProgress(null);
      }
      return;
    }
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={(v) => { if (!v) { setFormError(''); setPhotoNotice(''); clearStaged(); setCreatedProperty(null); } onOpenChange(v); }}><DialogContent className="form-dialog"><DialogHeader><span className="form-kicker">Portefeuille immobilier</span><DialogTitle>{item ? 'Modifier le bien' : 'Ajouter un bien'}</DialogTitle><DialogDescription>Renseignez les informations du bien et joignez autant de photos que nécessaire (compression automatique).</DialogDescription></DialogHeader>
    <Form {...form}><form onSubmit={form.handleSubmit(submit)} className="entity-form">
      <div className="form-grid"><FormField control={form.control} name="reference" render={({ field }) => <FormItem><FormLabel>Référence</FormLabel><FormControl><Input {...field} data-testid="input-property-reference" placeholder="Ex. BI-024" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="title" render={({ field }) => <FormItem><FormLabel>Intitulé</FormLabel><FormControl><Input {...field} data-testid="input-property-title" placeholder="Villa, appartement…" /></FormControl><FormMessage /></FormItem>} /></div>
      <div className="form-grid"><FormField control={form.control} name="transaction_type" render={({ field }) => <FormItem><FormLabel>Transaction</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-property-transaction"><option value="sale">Vente</option><option value="rent">Location</option><option value="lease">Bail</option></select></FormControl></FormItem>} /><FormField control={form.control} name="property_type" render={({ field }) => <FormItem><FormLabel>Type de bien</FormLabel><FormControl><Input {...field} data-testid="input-property-type" placeholder="Villa, terrain…" /></FormControl><FormMessage /></FormItem>} /></div>
       <div className="form-grid three-col"><FormField control={form.control} name="price" render={({ field }) => <FormItem><FormLabel>Prix</FormLabel><FormControl><Input type="number" min="0" {...field} data-testid="input-property-price" /></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="currency" render={({ field }) => <FormItem><FormLabel>Devise</FormLabel><FormControl><select {...field} className="form-select" data-testid="input-property-currency"><option value="XOF">FCFA (XOF)</option><option value="EUR">Euro (EUR)</option><option value="USD">Dollar (USD)</option>{field.value && !['XOF','EUR','USD'].includes(field.value) && <option value={field.value}>{field.value}</option>}</select></FormControl><FormMessage /></FormItem>} /><FormField control={form.control} name="status" render={({ field }) => <FormItem><FormLabel>Statut</FormLabel><FormControl><select {...field} className="form-select" data-testid="select-property-status">{Object.entries(propertyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></FormControl></FormItem>} /></div>
      <div className="form-grid"><FormField control={form.control} name="neighborhood" render={({ field }) => <FormItem><FormLabel>Quartier</FormLabel><FormControl><Input {...field} data-testid="input-property-neighborhood" /></FormControl></FormItem>} /><FormField control={form.control} name="city" render={({ field }) => <FormItem><FormLabel>Ville</FormLabel><FormControl><Input {...field} data-testid="input-property-city" /></FormControl></FormItem>} /></div>
       <div className="form-grid three-col">{(['bedrooms', 'bathrooms', 'area_m2'] as const).map((key) => <FormField key={key} control={form.control} name={key} render={({ field }) => <FormItem><FormLabel>{key === 'bedrooms' ? 'Chambres' : key === 'bathrooms' ? 'Salles d’eau' : 'Surface m²'}</FormLabel><FormControl><Input type="number" min={key === 'area_m2' ? '0.01' : '0'} step={key === 'area_m2' ? '0.01' : '1'} {...field} data-testid={`input-property-${key}`} /></FormControl><FormMessage /></FormItem>} />)}</div>
      <div className="form-grid three-col">
        <FormField control={form.control} name="commission_rate" render={({ field }) => <FormItem><FormLabel>Commission vente (%)</FormLabel><FormControl><Input type="number" min="0" max="100" step="0.5" placeholder="Défaut : taux de l’agence" {...field} data-testid="input-property-commission-rate" /></FormControl><FormMessage /></FormItem>} />
        <FormField control={form.control} name="rental_commission_rate" render={({ field }) => <FormItem><FormLabel>Commission location (% du loyer)</FormLabel><FormControl><Input type="number" min="0" max="500" step="5" placeholder="100 = 1 mois de loyer" {...field} data-testid="input-property-rental-commission-rate" /></FormControl><FormMessage /></FormItem>} />
        <div className="form-field"><span>Par agence par défaut</span><small className="commission-hint">Modifiable dans Paramètres de l’agence.</small></div>
      </div>
      <FormField control={form.control} name="address" render={({ field }) => <FormItem><FormLabel>Adresse</FormLabel><FormControl><Input {...field} data-testid="input-property-address" /></FormControl></FormItem>} /><FormField control={form.control} name="description" render={({ field }) => <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea {...field} data-testid="input-property-description" /></FormControl></FormItem>} />
      <section className="photo-manager" data-testid="photo-manager"
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); void addFiles(event.dataTransfer.files); }}>
        <div className="photo-manager-head">
          <strong>Photos du bien</strong>
          <span data-testid="photo-count">{formatQuota(photoQuota)} photo(s) · 1re photo = couverture</span>
        </div>
        {(existingPhotos.length > 0 || staged.length > 0) && (
          <div className="photo-manager-grid">
            {existingPhotos.map((photo, index) => (
              <figure className={`photo-chip${index === 0 ? ' is-cover' : ''}`} key={photo.id} data-testid={`photo-existing-${photo.id}`}>
                <div className="photo-chip-preview">
                  {photo.signedUrl ? <img src={photo.signedUrl} alt={photo.file_name} loading="lazy" /> : <ImagePlus size={16} />}
                  {index === 0 && <span className="photo-chip-cover"><Star size={10} /> Couverture</span>}
                </div>
                <figcaption>
                  <button type="button" className="icon-button" onClick={() => void makeCover(photo.id)} disabled={reorder.isPending || index === 0} aria-label={`Définir ${photo.file_name} en couverture`} data-testid={`button-cover-${photo.id}`}><Star size={12} /></button>
                  <button type="button" className="icon-button" onClick={() => void moveExisting(photo.id, -1)} disabled={reorder.isPending || index === 0} aria-label="Déplacer à gauche"><ChevronLeft size={12} /></button>
                  <button type="button" className="icon-button" onClick={() => void moveExisting(photo.id, 1)} disabled={reorder.isPending || index === existingPhotos.length - 1} aria-label="Déplacer à droite"><ChevronRight size={12} /></button>
                  <button type="button" className="icon-button photo-chip-delete" onClick={() => void dropExisting(photo)} disabled={removeMany.isPending} aria-label={`Supprimer ${photo.file_name}`}><Trash2 size={12} /></button>
                </figcaption>
              </figure>
            ))}
            {staged.map((entry, index) => (
              <figure className="photo-chip is-staged" key={entry.key} data-testid={`photo-staged-${index}`}>
                <div className="photo-chip-preview">
                  <img src={entry.preview} alt={entry.file.name} />
                  {index === 0 && <span className="photo-chip-cover"><Star size={10} /> Couverture</span>}
                </div>
                <figcaption>
                  <button type="button" className="icon-button" onClick={() => moveStaged(index, -1)} disabled={index === 0} aria-label="Déplacer à gauche"><ChevronLeft size={12} /></button>
                  <button type="button" className="icon-button" onClick={() => moveStaged(index, 1)} disabled={index === staged.length - 1} aria-label="Déplacer à droite"><ChevronRight size={12} /></button>
                  <button type="button" className="icon-button photo-chip-delete" onClick={() => dropStaged(entry.key)} aria-label={`Retirer ${entry.file.name}`}><X size={12} /></button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        <div className={`photo-dropzone${dragOver ? ' is-over' : ''}`}>
          <Upload size={17} />
          <span>Déposez vos images ici</span>
          <div className="photo-manager-actions">
            <label className={`upload-control${photoBusy ? ' is-busy' : ''}`}>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={photoBusy} onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ''; }} data-testid="input-property-photos" />
              <ImagePlus size={15} /> Choisir des photos
            </label>
            <label className={`upload-control${photoBusy ? ' is-busy' : ''}`}>
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" disabled={photoBusy} onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ''; }} data-testid="input-property-camera" />
              <Camera size={15} /> Prendre une photo
            </label>
          </div>
        </div>
        {photoProgress && (
          <div className="photo-progress" role="status" data-testid="progress-photos">
            <div className="photo-progress-track"><span style={{ width: `${photoProgress.total ? Math.round((photoProgress.done / photoProgress.total) * 100) : 0}%` }} /></div>
            <small>Envoi {photoProgress.done}/{photoProgress.total}…</small>
          </div>
        )}
        <PhotoQuotaBar quota={photoQuota} agencyId={activeAgencyId} canManageAgency={canManageAgency} testId="dialog-photos" compact />
        <p className="photo-manager-hint">JPG · PNG · WebP — redimensionnement et compression automatiques · {photoQuota.unlimited ? 'nombre illimité' : `${photoQuota.limit} photos maximum par bien avec l’offre ${photoQuota.planName}`}.</p>
        {photoNotice && <p className="form-feedback is-warning" role="status" data-testid="status-photo-notice">{photoNotice}</p>}
      </section>
      {formError && <p className="form-error" role="alert" data-testid="status-property-form-error">{formError}</p>}<div className="form-actions"><Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-property">Annuler</Button><Button type="submit" disabled={isBusy} data-testid="button-submit-property">{isBusy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Créer le bien'}</Button></div>
    </form></Form>
  </DialogContent></Dialog>;
}

function PropertiesPage() {
  const { activeAgencyId, activeAgency, canManageAgency } = useAgency(); const query = useProperties(activeAgencyId);
  // BLOC 6 : message du panneau « Biens archivés ».
  const [archivedNotice, setArchivedNotice] = useState('');
  const mediaRefsQ = useAgencyMediaRefs(activeAgencyId);
  const coverByProperty = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of mediaRefsQ.data ?? []) {
      if (map.has(row.property_id)) continue;
      map.set(row.property_id, getSupabaseClient().storage.from('property-images').getPublicUrl(row.storage_path).data.publicUrl);
    }
    return map;
  }, [mediaRefsQ.data]);
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('all'); const [kind, setKind] = useState('all'); const [neighborhood, setNeighborhood] = useState('all'); const [minPrice, setMinPrice] = useState(''); const [maxPrice, setMaxPrice] = useState(''); const [mode, setMode] = useState<'table' | 'cards'>('table');
  const [editing, setEditing] = useState<PropertyRow | null>(null); const [open, setOpen] = useState(false);
  const neighborhoods = [...new Set((query.data ?? []).map((p) => p.neighborhood).filter((v): v is string => Boolean(v)))].sort((a,b)=>a.localeCompare(b,'fr'));
  const propertyTypes = [...new Set((query.data ?? []).map((p) => p.property_type).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));
  const rows = useMemo(() => (query.data ?? []).filter((p) => {
    const matches = `${p.reference} ${p.title} ${p.property_type} ${p.neighborhood ?? ''} ${p.city ?? ''}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr'));
    const typeMatch = kind === 'all' || p.transaction_type === kind || p.property_type === kind;
    return matches && (status === 'all' || p.status === status) && typeMatch && (neighborhood === 'all' || p.neighborhood === neighborhood) && (!minPrice || p.price >= Number(minPrice)) && (!maxPrice || p.price <= Number(maxPrice));
  }), [query.data, search, status, kind, neighborhood, minPrice, maxPrice]);
  return <><Heading eyebrow="Portefeuille" title="Biens immobiliers" description="Consultez et tenez à jour les biens de votre agence." action={<ButtonPrimary testId="button-add-property" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} /> Ajouter un bien</ButtonPrimary>} />
    <section className="list-toolbar property-toolbar"><label className="list-search"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Référence, type ou localisation" aria-label="Rechercher un bien" data-testid="input-search-properties" /></label><span className="result-count" data-testid="text-properties-count">{query.data ? `${rows.length} ${rows.length === 1 ? 'bien' : 'biens'}` : '—'}</span><div className="view-switch" aria-label="Mode d’affichage"><button type="button" className={mode==='table'?'selected':''} onClick={()=>setMode('table')} aria-label="Vue tableau"><List size={15}/></button><button type="button" className={mode==='cards'?'selected':''} onClick={()=>setMode('cards')} aria-label="Vue cartes"><LayoutGrid size={15}/></button></div></section>
    <section className="filter-strip" aria-label="Filtres des biens"><select className="form-select" value={status} onChange={(e)=>setStatus(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-property-status"><option value="all">Tous les statuts</option>{Object.entries(propertyStatus).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><select className="form-select" value={kind} onChange={(e)=>setKind(e.target.value)} aria-label="Filtrer par type ou transaction" data-testid="filter-property-type"><option value="all">Tous les types</option><option value="sale">Vente</option><option value="rent">Location</option><option value="lease">Bail</option>{propertyTypes.map((v)=><option key={v} value={v}>{v}</option>)}</select><select className="form-select" value={neighborhood} onChange={(e)=>setNeighborhood(e.target.value)} aria-label="Filtrer par quartier" data-testid="filter-property-neighborhood"><option value="all">Tous les quartiers</option>{neighborhoods.map((n)=><option key={n} value={n}>{n}</option>)}</select><Input type="number" min="0" value={minPrice} onChange={(e)=>setMinPrice(e.target.value)} placeholder="Prix min. FCFA" aria-label="Prix minimum" data-testid="filter-property-min-price"/><Input type="number" min="0" value={maxPrice} onChange={(e)=>setMaxPrice(e.target.value)} placeholder="Prix max. FCFA" aria-label="Prix maximum" data-testid="filter-property-max-price"/></section>
    {query.isLoading || query.error || !query.data?.length ? <PageDataState loading={query.isLoading} error={query.error} retry={useSafeRetry(query)} count={query.data?.length ?? 0} emptyTitle="Votre portefeuille est encore vide" emptyText="Ajoutez un bien pour commencer à structurer votre portefeuille immobilier." testId="empty-properties" /> : rows.length ? mode === 'table' ? <div className="panel list-panel"><div className="table-wrap"><table className="data-table full-table"><thead><tr><th>Référence</th><th>Bien</th><th>Localisation</th><th>Transaction</th><th>Prix</th><th>Statut</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.map((p) => <tr key={p.id} data-testid={`row-property-${p.id}`}><td><Link href={`/biens/${p.id}`} className="table-primary-link"><strong>{p.reference}</strong></Link></td><td><Link href={`/biens/${p.id}`} className="table-primary-link table-thumb-link">{coverByProperty.get(p.id) ? <span className="table-thumb"><img src={coverByProperty.get(p.id)} alt="" loading="lazy" /></span> : <span className="table-thumb table-thumb-empty"><Home size={13} /></span>}<span><strong>{p.title}</strong><small>{p.property_type}</small></span></Link></td><td>{p.neighborhood || '—'}<small>{p.city || '—'}</small></td><td>{p.transaction_type === 'sale' ? 'Vente' : p.transaction_type === 'rent' ? 'Location' : 'Bail'}</td><td>{cash(p.price, p.currency)}</td><td><span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span></td><td><button className="row-action" onClick={() => { setEditing(p); setOpen(true); }} aria-label={`Modifier ${p.title}`} data-testid={`button-edit-property-${p.id}`}><Pencil size={14} /><span>Modifier</span></button></td></tr>)}</tbody></table></div></div> : <div className="property-card-grid">{rows.map((p) => <article className="property-card" key={p.id}><div className="property-card-media">{coverByProperty.get(p.id) ? <img src={coverByProperty.get(p.id)} alt="" loading="lazy" /> : <div className="property-card-media-empty"><Home size={20} /></div>}<span className={`status-pill status-${p.status}`}>{propertyStatus[p.status] ?? p.status}</span></div><div className="property-card-top"><span>{p.reference}</span></div><Link href={`/biens/${p.id}`} className="property-card-title"><h2>{p.title}</h2></Link><p>{p.property_type} · {p.neighborhood || p.city || 'Localisation non renseignée'}</p><strong className="property-card-price">{cash(p.price,p.currency)}</strong><div className="property-card-foot"><span>{p.transaction_type==='sale'?'Vente':p.transaction_type==='rent'?'Location':'Bail'}</span><button className="row-action" onClick={() => { setEditing(p); setOpen(true); }} aria-label={`Modifier ${p.title}`}><Pencil size={14}/> Modifier</button></div></article>)}</div> : <div className="state-card compact-empty" data-testid="empty-filtered-properties"><div className="state-icon"><Search size={19} /></div><h2>Aucun résultat pour ces filtres</h2><p>Essayez une autre référence, un autre quartier ou élargissez la fourchette de prix.</p><Button variant="outline" onClick={() => { setSearch(''); setStatus('all'); setKind('all'); setNeighborhood('all'); setMinPrice(''); setMaxPrice(''); }} data-testid="button-clear-property-search">Effacer les filtres</Button></div>}
    {/* BLOC 6 : biens archives — masques des listes ci-dessus, CA et historique conserves. */}
    <ArchivedPropertiesPanel agencyId={activeAgencyId} canManage={canManageAgency} onRestore={(text, error) => setArchivedNotice(error ? `⚠ ${text}` : text)} />
    {archivedNotice && <p className={archivedNotice.startsWith('⚠') ? 'form-error' : 'form-feedback'} role="status" data-testid="status-archived-notice">{archivedNotice}</p>}
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
  const { activeAgencyId } = useAgency(); const query = useContacts(activeAgencyId); const [search, setSearch] = useState(''); const [status, setStatus] = useState('all'); const [editing, setEditing] = useState<ContactRow | null>(null); const [open, setOpen] = useState(false);
  const rows = useMemo(() => (query.data ?? []).filter((c) => `${c.first_name} ${c.last_name ?? ''} ${c.phone ?? ''} ${c.email ?? ''} ${c.status} ${c.source ?? ''}`.toLocaleLowerCase('fr').includes(search.toLocaleLowerCase('fr')) && (status === 'all' || c.status === status)), [query.data, search, status]);
  return <><Heading eyebrow="Relation client" title="Prospects et contacts" description="Retrouvez les personnes et reprenez le fil de chaque échange." action={<ButtonPrimary testId="button-add-contact" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={15} /> Nouveau contact</ButtonPrimary>} /><section className="list-toolbar"><label className="list-search"><Search size={15} /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom, téléphone ou e-mail" aria-label="Rechercher un contact" data-testid="input-search-contacts" /></label><select className="form-select compact-select" value={status} onChange={(e)=>setStatus(e.target.value)} aria-label="Filtrer les contacts par statut" data-testid="filter-contact-status"><option value="all">Tous les statuts</option>{Object.entries(contactStatus).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select><span className="result-count" data-testid="text-contacts-count">{query.data ? `${rows.length} ${rows.length === 1 ? 'contact' : 'contacts'}` : '—'}</span></section>
    {query.isLoading || query.error || !query.data?.length ? <PageDataState loading={query.isLoading} error={query.error} retry={useSafeRetry(query)} count={query.data?.length ?? 0} emptyTitle="Aucun contact dans votre espace" emptyText="Ajoutez un contact après votre premier échange. Les fiches resteront privées à votre agence." testId="empty-contacts" /> : rows.length ? <div className="panel list-panel"><div className="table-wrap"><table className="data-table full-table"><thead><tr><th>Contact</th><th>Coordonnées</th><th>Origine</th><th>Statut</th><th>Ajouté le</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.map((c) => <tr key={c.id} data-testid={`row-contact-${c.id}`}><td><Link href={`/contacts/${c.id}`} className="contact-cell table-contact-link"><span className="contact-avatar">{`${c.first_name[0] ?? ''}${c.last_name?.[0] ?? ''}`.toUpperCase()}</span><div><strong>{c.first_name} {c.last_name}</strong><small>Ouvrir la fiche</small></div></Link></td><td>{c.phone || c.email || '—'}{c.email && c.phone && <small>{c.email}</small>}</td><td>{c.source || '—'}</td><td><span className={`status-pill status-${c.status}`}>{contactStatus[c.status] ?? c.status}</span></td><td>{dateLabel(c.created_at)}</td><td><button className="row-action" onClick={() => { setEditing(c); setOpen(true); }} aria-label={`Modifier ${c.first_name}`} data-testid={`button-edit-contact-${c.id}`}><Pencil size={14} /><span>Modifier</span></button></td></tr>)}</tbody></table></div></div> : <div className="state-card compact-empty" data-testid="empty-filtered-contacts"><div className="state-icon"><Search size={19} /></div><h2>Aucun contact correspondant</h2><p>Modifiez les mots recherchés pour retrouver une fiche.</p><Button variant="outline" onClick={() => {setSearch('');setStatus('all');}} data-testid="button-clear-contact-search">Effacer les filtres</Button></div>}
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
    <div className="agency-layout"><section className="panel agency-profile-card"><AgencyLogo logoUrl={activeAgency?.logo_url} name={activeAgency?.name} size={54} className="agency-profile-mark" testId="display-agency-profile-logo" /><span className="form-kicker">Agence active</span><h2 data-testid="text-active-agency-name">{activeAgency?.name}</h2><p>{activeAgency?.legal_name || 'Raison sociale non renseignée'}</p><div className="agency-facts"><div><MapPin size={15} /><span>{[activeAgency?.address, activeAgency?.city, activeAgency?.country].filter(Boolean).join(', ') || 'Adresse non renseignée'}</span></div><div><Phone size={15} /><span>{activeAgency?.phone || 'Téléphone non renseigné'}</span></div><div><Mail size={15} /><span>{activeAgency?.email || 'E-mail non renseigné'}</span></div></div><div className="agency-meta"><span>Devise <strong>{activeAgency?.currency}</strong></span><span>Fuseau horaire <strong>{activeAgency?.timezone}</strong></span><span>État <strong>{activeAgency?.status}</strong></span></div></section>
      <section className="panel roster-panel"><div className="panel-head"><div><h2>Accès des membres</h2><p>{roster.data?.length ?? 0} accès répertorié(s)</p></div><span className="roster-lock"><LockKeyhole size={14} /> Lecture seule</span></div><div className="privacy-note"><ShieldCheck size={15} /><p>Pour protéger les profils, cette vue n’affiche aucun nom ni e-mail des autres membres. Les identifiants sont partiellement masqués.</p></div>{roster.data?.length ? <div className="roster-list">{roster.data.map((member: AgencyMemberRow) => <div className="roster-row" key={member.id} data-testid={`row-roster-${member.id}`}><span className="roster-avatar"><UserRound size={15} /></span><div className="roster-copy"><strong>{roleNames[member.role] ?? member.role}</strong><span>{member.user_id.slice(0, 5)}••••••{member.user_id.slice(-4)}</span></div><span className={`membership-status membership-${member.status}`}>{member.status === 'active' ? 'Actif' : member.status}</span></div>)}</div> : <div className="empty-table" data-testid="empty-agency-roster"><strong>Aucun accès à afficher</strong><p>Aucun membre n’est retourné pour cette agence.</p></div>}</section></div>
    {!canManageAgency && <div className="permission-note" role="status" data-testid="status-agency-permission"><LockKeyhole size={15} /><span>La modification des informations de l’agence est réservée aux propriétaires et administrateurs. Les règles d’accès de l’agence restent prioritaires.</span></div>}
  </>;
}

function PropertyDetailPage() {
  const params = useParams<{ id: string }>(); const id = params.id;
  const { activeAgencyId, activeMembership, canManageAgency } = useAgency(); const propertiesQ = useProperties(activeAgencyId);
  // BLOC 6 : la fiche d'un bien archive doit rester consultable.
  const [, navigate] = useLocation();
  const archivedQ = useArchivedProperties(activeAgencyId);
  const item = propertiesQ.data?.find((property) => property.id === id)
    ?? archivedQ.data?.find((property) => property.id === id)
    ?? null;
  const media = usePropertyMedia(activeAgencyId, id);
  // BLOC 3 : compteur « 7/10 » de la galerie.
  const photoQuota = usePhotoQuota(activeAgencyId, media.data?.length ?? 0);
  const uploadBatch = useUploadPropertyMediaBatch(activeAgencyId);
  const reorder = useReorderPropertyMedia(activeAgencyId, id);
  const canDelete = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';
  const removeMedia = useDeletePropertyMedia(activeAgencyId, id, canDelete);
  const trackView = useTrackPropertyView(activeAgencyId, id);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const trackedPropertyId = useRef<string | null>(null);
  useEffect(() => {
    if (item && trackedPropertyId.current !== item.id) {
      trackedPropertyId.current = item.id;
      trackView.mutate();
    }
  }, [item, trackView]);
  if (propertiesQ.isLoading || archivedQ.isLoading) return <><Heading eyebrow="Portefeuille" title="Fiche du bien" description="Chargement du dossier immobilier."/><LoadingRows/></>;
  if (propertiesQ.error) return <><Heading eyebrow="Portefeuille" title="Fiche du bien" description="Les informations du dossier ne sont pas disponibles."/><ErrorState error={propertiesQ.error} retry={useSafeRetry(propertiesQ)}/></>;
  if (!item) return <><Heading eyebrow="Portefeuille" title="Bien introuvable" description="Ce dossier n’est pas présent dans le portefeuille de l’agence active."/><Link href="/biens" className="text-action">Retour aux biens <ArrowRight size={13}/></Link></>;
  const doUploadFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setNotice('');
    const selected = Array.from(files);
    // BLOC 3 : envoi multiple au-delà de la limite -> on n'envoie que ce qui
    // rentre et on nomme les photos refusées.
    const { accepted, refused } = splitByPhotoQuota(selected, photoQuota.remaining);
    if (!accepted.length) {
      setNotice(
        `Limite atteinte : ${photoQuota.used}/${photoQuota.limit} photos pour l’offre ${photoQuota.planName}. ` +
        `Supprimez une photo ou passez à une offre supérieure.`,
      );
      return;
    }
    try {
      const compressed = await compressImages(accepted);
      const result = await uploadBatch.mutateAsync({ files: compressed, propertyId: id, propertyReference: item.reference, startSortOrder: media.data?.length ?? 0 });
      const refusedByQuota = refused.map((file) => file.name);
      const refusedByServer = result.failed.map((entry) => entry.file.name);
      const allRefused = [...refusedByQuota, ...refusedByServer];
      if (allRefused.length) {
        const reason = result.failed[0]?.reason
          ?? `Limite de ${photoQuota.limit} photos par bien atteinte avec l’offre ${photoQuota.planName}`;
        setNotice(
          `${result.uploaded.length} photo(s) ajoutée(s). ${allRefused.length} refusée(s) : ` +
          `${allRefused.slice(0, 3).join(', ')}${allRefused.length > 3 ? '…' : ''}. Motif : ${reason}.`,
        );
      } else {
        setNotice(`${result.uploaded.length} photo(s) ajoutée(s).`);
      }
    } catch (error) { setNotice(getSupabaseErrorMessage(error, 'ajouter les photos')); }
  };
  const makeCover = async (photoId: string) => {
    const list = media.data ?? [];
    const rest = list.filter((photo) => photo.id !== photoId);
    setNotice('');
    try {
      await reorder.mutateAsync([{ id: photoId, sort_order: 0 }, ...rest.map((photo, index) => ({ id: photo.id, sort_order: index + 1 }))]);
      setNotice('Couverture mise à jour.');
    } catch (error) { setNotice(getSupabaseErrorMessage(error, 'définir la couverture')); }
  };
  const doDelete = async (photo: NonNullable<typeof media.data>[number]) => {
    if (!canDelete) return;
    if (!window.confirm(`Supprimer définitivement la photo « ${photo.file_name} » du stockage et de la fiche ?`)) return;
    setNotice(''); try { await removeMedia.mutateAsync({ id: photo.id, storage_path: photo.storage_path }); setNotice('Photo supprimée.'); } catch (error) { setNotice(getSupabaseErrorMessage(error, 'supprimer la photo')); }
  };
  return <><Heading eyebrow={`Portefeuille · ${item.reference}`} title={item.title} description={`${item.property_type} · ${item.neighborhood || item.city || 'Localisation non renseignée'}`} action={<div className="heading-actions"><Link href="/biens" className="button-link">Retour aux biens</Link><ButtonPrimary testId="button-edit-property-detail" onClick={()=>setEditing(true)}><Pencil size={14}/> Modifier</ButtonPrimary></div>}/>
    <div className="detail-layout"><section className="panel detail-main"><div className="detail-pricebar"><div><span className="form-kicker">Prix affiché</span><strong>{cash(item.price,item.currency)}</strong></div><span className={`status-pill status-${item.status}`}>{propertyStatus[item.status] ?? item.status}</span></div>
      <div className="detail-facts"><div><span>Référence</span><strong>{item.reference}</strong></div><div><span>Transaction</span><strong>{item.transaction_type==='sale'?'Vente':item.transaction_type==='rent'?'Location':'Bail'}</strong></div><div><span>Chambres</span><strong>{item.bedrooms ?? '—'}</strong></div><div><span>Salles d’eau</span><strong>{item.bathrooms ?? '—'}</strong></div><div><span>Surface</span><strong>{item.area_m2 ? `${item.area_m2} m²` : '—'}</strong></div><div><span>Mis à jour</span><strong>{dateLabel(item.updated_at)}</strong></div></div>
      <div className="detail-section"><h2>Localisation</h2><p>{[item.address,item.neighborhood,item.city].filter(Boolean).join(', ') || 'Adresse non renseignée'}</p></div><div className="detail-section"><h2>Description</h2><p>{item.description || 'Aucune description renseignée pour ce bien.'}</p></div></section>
      <section className="panel gallery-panel"><div className="panel-head"><div><h2>Galerie du bien</h2><p><span className="photo-counter" data-testid="text-gallery-photo-count">{formatQuota(photoQuota)}</span> photo(s) enregistrée(s)</p></div><Camera size={17}/></div>
        <div className="gallery-quota"><PhotoQuotaBar quota={photoQuota} agencyId={activeAgencyId} canManageAgency={canManageAgency} testId="galerie" /></div>
        <div className="gallery-content">{media.isLoading ? <LoadingRows label="Chargement de la galerie"/> : media.error ? <ErrorState error={media.error} retry={useSafeRetry(media)}/> : media.data?.length ? <div className="photo-grid">{media.data.map((photo)=><figure className="photo-item" key={photo.id}>{photo.signedUrl ? <button type="button" className="photo-preview" onClick={()=>setActiveImage(photo.signedUrl)} aria-label={`Agrandir ${photo.file_name}`}><img src={photo.signedUrl} alt={photo.file_name}/></button> : <div className="photo-unavailable">{photo.signedUrlError || 'Aperçu indisponible'}</div>}<figcaption><span>{photo.file_name}</span>{canDelete && <button type="button" className={`icon-button${media.data?.[0]?.id === photo.id ? ' is-cover' : ''}`} onClick={()=>void makeCover(photo.id)} disabled={reorder.isPending || media.data?.[0]?.id === photo.id} aria-label={`Définir ${photo.file_name} en couverture`} title="Mettre en couverture"><Star size={13}/></button>}{canDelete && <button type="button" className="icon-button" onClick={()=>void doDelete(photo)} disabled={removeMedia.isPending} aria-label={`Supprimer ${photo.file_name}`}><Trash2 size={14}/></button>}</figcaption></figure>)}</div> : <div className="gallery-empty"><ImagePlus size={21}/><strong>Aucune photo pour l’instant</strong><span>Les images ajoutées à ce dossier apparaîtront ici.</span></div>}</div>
        <div className="photo-upload"><label className={`upload-control${uploadBatch.isPending?' is-busy':''}`}><input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploadBatch.isPending} onChange={(e)=>{void doUploadFiles(e.target.files); e.currentTarget.value='';}}/><ImagePlus size={15}/>{uploadBatch.isPending?'Envoi en cours…':'Ajouter des photos'}</label><p>JPG, PNG ou WebP · compression automatique · {photoQuota.unlimited ? 'nombre illimité' : `${photoQuota.limit} maximum par bien (offre ${photoQuota.planName})`} · la 1re photo devient la couverture.</p><div className="public-bucket-warning"><ShieldCheck size={15}/><span>Le bucket actuel étant public, une photo enregistrée peut être récupérée par toute personne connaissant son URL ; l’application ne rend pas ce stockage privé.</span></div>{notice && <p className={notice.includes('Impossible')?'form-error':'form-feedback'} role="status">{notice}</p>}</div>
      </section></div>
    <div className="related-record"><h2>Fiche du bien</h2><span>Créé le {dateLabel(item.created_at)}</span></div>
    {/* BLOC 6 : archivage (CA conserve) et suppression (photos purgees, impact chiffre). */}
    <PropertyLifecyclePanel property={item} agencyId={activeAgencyId} canManage={canDelete} onDeleted={() => navigate('/biens')} />
    {editing && <PropertyDialog key={item.id} open={editing} onOpenChange={setEditing} item={item} currency={item.currency}/>}
    {activeImage && <div className="lightbox" role="dialog" aria-modal="true" aria-label="Aperçu de la photo" onClick={()=>setActiveImage(null)}><button type="button" className="icon-button lightbox-close" onClick={()=>setActiveImage(null)} aria-label="Fermer l’aperçu"><X size={18}/></button><img src={activeImage} alt={item.title} onClick={(e)=>e.stopPropagation()}/></div>}
  </>;
}

function ContactDetailPage() {
  const params = useParams<{ id: string }>(); const { activeAgencyId } = useAgency(); const contactsQ = useContacts(activeAgencyId); const pipelineQ = usePipeline(activeAgencyId); const propertiesQ = useProperties(activeAgencyId);
  const contact = contactsQ.data?.find((row)=>row.id===params.id) ?? null;
  if (contactsQ.isLoading || pipelineQ.isLoading || propertiesQ.isLoading) return <><Heading eyebrow="Relation client" title="Fiche contact" description="Chargement des informations et de l’historique disponible."/><LoadingRows/></>;
  const error = contactsQ.error || pipelineQ.error || propertiesQ.error;
  if (error) return <><Heading eyebrow="Relation client" title="Fiche contact" description="Les informations ne sont pas disponibles."/><ErrorState error={error} retry={()=>{void contactsQ.refetch();void pipelineQ.refetch();void propertiesQ.refetch();}}/></>;
  if (!contact) return <><Heading eyebrow="Relation client" title="Contact introuvable" description="Cette fiche n’est pas disponible dans l’agence active."/><Link href="/contacts" className="text-action">Retour aux contacts <ArrowRight size={13}/></Link></>;
  const history = (pipelineQ.data ?? []).filter((row)=>row.client_id===contact.id);
  return <><Heading eyebrow="Relation client" title={`${contact.first_name} ${contact.last_name ?? ''}`} description="Coordonnées et historique issu des opportunités réellement reliées." action={<Link href="/contacts" className="button-link">Retour aux contacts</Link>}/>
    <div className="detail-layout contact-detail-layout"><section className="panel detail-main"><div className="contact-profile-head"><span className="contact-avatar large-avatar">{`${contact.first_name[0] ?? ''}${contact.last_name?.[0] ?? ''}`.toUpperCase()}</span><div><span className={`status-pill status-${contact.status}`}>{contactStatus[contact.status] ?? contact.status}</span><h2>{contact.first_name} {contact.last_name}</h2><small>Contact créé le {dateLabel(contact.created_at)}</small></div></div><div className="detail-facts"><div><span>Téléphone</span><strong>{contact.phone || '—'}</strong></div><div><span>WhatsApp</span><strong>{contact.whatsapp_number || '—'}</strong></div><div><span>E-mail</span><strong>{contact.email || '—'}</strong></div><div><span>Origine</span><strong>{contact.source || '—'}</strong></div></div><div className="detail-section"><h2>Notes</h2><p>{contact.notes || 'Aucune note enregistrée.'}</p></div></section>
      <section className="panel history-panel"><div className="panel-head"><div><h2>Historique des opportunités</h2><p>{history.length} dossier(s) réellement relié(s)</p></div></div>{history.length ? <div className="history-list">{history.map((row)=><article className="history-item" key={row.id}><span className="history-dot"/><div><div className="history-title"><strong>{row.etape}</strong><time>{dateLabel(row.created_at)}</time></div><Link href={`/biens/${row.property_id}`} className="history-property">{propertiesQ.data?.find((p)=>p.id===row.property_id)?.title ?? 'Bien associé indisponible'} <ArrowRight size={13}/></Link><p>{row.notes || 'Aucune note sur cette opportunité.'}</p>{row.date_visite && <small>Visite renseignée : {dateLabel(row.date_visite)}</small>}</div></article>)}</div> : <div className="empty-table"><div className="empty-table-mark"><Clock3 size={17}/></div><strong>Aucun historique disponible</strong><p>Les opportunités associées à ce contact apparaîtront ici.</p></div>}</section></div>
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

const settingsSchema = z.object({ name: z.string().trim().min(1, 'Le nom est obligatoire'), legal_name: z.string().optional(), phone: z.string().optional(), email: z.string().email('Adresse e-mail invalide').or(z.literal('')).optional(), address: z.string().optional(), city: z.string().optional(), description: z.string().optional(), country: z.string().trim().min(1, 'Le pays est obligatoire'), timezone: z.string().trim().min(1, 'Le fuseau horaire est obligatoire'), currency: z.string().trim().min(1, 'La devise est obligatoire'), commission_rate: z.string().optional().refine((value) => value === undefined || value === '' || (Number(value) >= 0 && Number(value) <= 100), 'Taux de vente entre 0 et 100 %'), rental_commission_rate: z.string().optional().refine((value) => value === undefined || value === '' || (Number(value) >= 0 && Number(value) <= 500), 'Taux de location entre 0 et 500 %') });
const profileSchema = z.object({ full_name: z.string().trim().min(1, 'Le nom est obligatoire'), phone: z.string().optional() });
function SettingsPage() {
  const { user } = useAuth(); const { activeAgency, activeAgencyId, canManageAgency } = useAgency(); const profileQ = useCurrentProfile(user?.id); const updateAgency = useUpdateAgency(activeAgencyId); const updateProfile = useUpdateCurrentProfile(user?.id);
  const profileForm = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema), defaultValues: { full_name: '', phone: '' } });
  const agencyForm = useForm<z.infer<typeof settingsSchema>>({ resolver: zodResolver(settingsSchema), defaultValues: { name: '', legal_name: '', phone: '', email: '', address: '', city: '', description: '', country: 'Mali', timezone: 'Africa/Bamako', currency: 'XOF', commission_rate: '', rental_commission_rate: '' } });
  const [profileMessage, setProfileMessage] = useState(''); const [agencyMessage, setAgencyMessage] = useState('');
  useEffect(() => { if (profileQ.data) profileForm.reset({ full_name: profileQ.data.full_name ?? '', phone: profileQ.data.phone ?? '' }); }, [profileQ.data, profileForm]);
  useEffect(() => { if (activeAgency) agencyForm.reset({ name: activeAgency.name, legal_name: activeAgency.legal_name ?? '', phone: activeAgency.phone ?? '', email: activeAgency.email ?? '', address: activeAgency.address ?? '', city: activeAgency.city ?? '', description: activeAgency.description ?? '', country: activeAgency.country, timezone: activeAgency.timezone, currency: activeAgency.currency, commission_rate: activeAgency.commission_rate != null ? String(activeAgency.commission_rate) : '', rental_commission_rate: activeAgency.rental_commission_rate != null ? String(activeAgency.rental_commission_rate) : '' }); }, [activeAgency, agencyForm]);
  if (profileQ.isLoading) return <><Heading eyebrow="Préférences" title="Paramètres" description="Gérez votre profil et les informations de l’agence." /><LoadingRows /></>;
  if (profileQ.error) return <><Heading eyebrow="Préférences" title="Paramètres" description="Gérez votre profil et les informations de l’agence." /><ErrorState error={profileQ.error} retry={useSafeRetry(profileQ)} /></>;
  const saveProfile = async (v: z.infer<typeof profileSchema>) => { setProfileMessage(''); try { const input: ProfileUpdateInput = { full_name: v.full_name, phone: v.phone || null }; await updateProfile.mutateAsync(input); setProfileMessage('Profil enregistré.'); } catch (e) { setProfileMessage(getSupabaseErrorMessage(e, 'enregistrer le profil')); } };
  const saveAgency = async (v: z.infer<typeof settingsSchema>) => { setAgencyMessage(''); try { const input: AgencySettingsInput = { name: v.name, legal_name: v.legal_name || null, phone: v.phone || null, email: v.email || null, address: v.address || null, city: v.city || null, description: v.description || null, country: v.country, timezone: v.timezone, currency: v.currency, commission_rate: v.commission_rate === '' || v.commission_rate === undefined ? undefined : Number(v.commission_rate), rental_commission_rate: v.rental_commission_rate === '' || v.rental_commission_rate === undefined ? undefined : Number(v.rental_commission_rate) }; await updateAgency.mutateAsync(input);
    // BLOC 4 : le trigger `activity_log_agencies` journalise déjà la modification ;
    // on ajoute la liste précise des champs changés pour un journal exploitable.
    const changed = diffAgencyFields((activeAgency ?? null) as unknown as Record<string, unknown>, input as Record<string, unknown>);
    await traceAgencySettingsChange(activeAgencyId, changed);
    setAgencyMessage(changed.length ? `Informations d’agence enregistrées : ${changed.join(', ')}.` : 'Aucune modification à enregistrer.'); } catch (e) { setAgencyMessage(getSupabaseErrorMessage(e, 'enregistrer les informations de l’agence')); } };
  return <><Heading eyebrow="Préférences" title="Paramètres" description="Votre profil personnel et les coordonnées de l’agence active." />
    <div className="settings-stack"><section className="panel settings-panel"><div className="settings-heading"><div className="settings-icon"><UserRound size={17} /></div><div><h2>Mon profil</h2><p>Ces informations concernent uniquement votre compte.</p></div></div><Form {...profileForm}><form className="settings-form" onSubmit={profileForm.handleSubmit(saveProfile)}><div className="settings-readonly"><Mail size={15} /><div><span>Adresse e-mail de connexion</span><strong data-testid="text-profile-email">{user?.email}</strong></div><small>Non modifiable</small></div><div className="form-grid"><FormField control={profileForm.control} name="full_name" render={({ field }) => <FormItem><FormLabel>Nom affiché</FormLabel><FormControl><Input {...field} data-testid="input-profile-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={profileForm.control} name="phone" render={({ field }) => <FormItem><FormLabel>Téléphone</FormLabel><FormControl><Input {...field} data-testid="input-profile-phone" /></FormControl><FormMessage /></FormItem>} /></div><div className="form-actions">{profileMessage && <span className={`form-feedback${profileMessage.includes('Impossible') || profileMessage.includes('refusé') ? ' is-error' : ''}`} role="status" data-testid="status-profile-save">{profileMessage}</span>}<Button type="submit" disabled={updateProfile.isPending} data-testid="button-save-profile">{updateProfile.isPending ? 'Enregistrement…' : 'Enregistrer mon profil'}</Button></div></form></Form></section>
      <section className="panel settings-panel"><div className="settings-heading"><div className="settings-icon"><Building2 size={17} /></div><div><h2>Informations de l’agence</h2><p>Coordonnées partagées de {activeAgency?.name ?? 'l’agence active'}.</p></div><span className={`permission-badge${canManageAgency ? ' allowed' : ''}`}><KeyRound size={13} /> {canManageAgency ? 'Modification autorisée' : 'Lecture seule'}</span></div>
        {!canManageAgency && <div className="permission-note"><LockKeyhole size={15} /><span>Seuls les propriétaires et administrateurs peuvent modifier ces champs.</span></div>}
        <Form {...agencyForm}><form className="settings-form" onSubmit={agencyForm.handleSubmit(saveAgency)}><div className="form-grid"><FormField control={agencyForm.control} name="name" render={({ field }) => <FormItem><FormLabel>Nom commercial</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-name" /></FormControl><FormMessage /></FormItem>} /><FormField control={agencyForm.control} name="legal_name" render={({ field }) => <FormItem><FormLabel>Raison sociale</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-legal-name" /></FormControl></FormItem>} /></div><div className="form-grid"><FormField control={agencyForm.control} name="phone" render={({ field }) => <FormItem><FormLabel>Téléphone agence</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-phone" /></FormControl></FormItem>} /><FormField control={agencyForm.control} name="email" render={({ field }) => <FormItem><FormLabel>E-mail agence</FormLabel><FormControl><Input type="email" {...field} disabled={!canManageAgency} data-testid="input-agency-email" /></FormControl><FormMessage /></FormItem>} /></div><FormField control={agencyForm.control} name="address" render={({ field }) => <FormItem><FormLabel>Adresse</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-address" /></FormControl></FormItem>} /><FormField control={agencyForm.control} name="description" render={({ field }) => <FormItem><FormLabel>Description de l’agence</FormLabel><FormControl><Textarea {...field} disabled={!canManageAgency} placeholder="Présentez votre agence…" data-testid="input-agency-description" /></FormControl><FormMessage /></FormItem>} /><div className="form-grid three-col"><FormField control={agencyForm.control} name="city" render={({ field }) => <FormItem><FormLabel>Ville</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-city" /></FormControl></FormItem>} /><FormField control={agencyForm.control} name="country" render={({ field }) => <FormItem><FormLabel>Pays</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-country" /></FormControl><FormMessage /></FormItem>} /><FormField control={agencyForm.control} name="currency" render={({ field }) => <FormItem><FormLabel>Devise</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-currency" /></FormControl><FormMessage /></FormItem>} /></div><FormField control={agencyForm.control} name="timezone" render={({ field }) => <FormItem><FormLabel>Fuseau horaire</FormLabel><FormControl><Input {...field} disabled={!canManageAgency} data-testid="input-agency-timezone" /></FormControl><FormMessage /></FormItem>} /><div className="form-grid three-col">
        <FormField control={agencyForm.control} name="commission_rate" render={({ field }) => <FormItem><FormLabel>Commission vente (%)</FormLabel><FormControl><Input type="number" min="0" max="100" step="0.5" placeholder="5" {...field} disabled={!canManageAgency} data-testid="input-agency-commission-rate" /></FormControl><FormMessage /></FormItem>} />
        <FormField control={agencyForm.control} name="rental_commission_rate" render={({ field }) => <FormItem><FormLabel>Commission location (%)</FormLabel><FormControl><Input type="number" min="0" max="500" step="5" placeholder="100 = 1 mois de loyer" {...field} disabled={!canManageAgency} data-testid="input-agency-rental-commission-rate" /></FormControl><FormMessage /></FormItem>} />
        <div className="form-field"><span>Calcul automatique</span><small className="commission-hint">Appliqué aux biens sans taux propre.</small></div>
      </div><div className="form-actions">{agencyMessage && <span className={`form-feedback${agencyMessage.includes('Impossible') || agencyMessage.includes('refusé') ? ' is-error' : ''}`} role="status" data-testid="status-agency-save">{agencyMessage}</span>}{canManageAgency && <Button type="submit" disabled={updateAgency.isPending} data-testid="button-save-agency">{updateAgency.isPending ? 'Enregistrement…' : 'Enregistrer les informations'}</Button>}</div></form></Form>
      </section>
        {/* BLOC 4 : logo de l'agence — aperçu, remplacement, suppression. */}
        <AgencyLogoCard
          agencyId={activeAgencyId}
          agencyName={activeAgency?.name}
          logoUrl={activeAgency?.logo_url}
          canManage={canManageAgency}
        />
      </div>
  </>;
}

const loginSchema = z.object({
  email: z.string().trim().email('Adresse e-mail invalide'),
  password: z.string().min(1, 'Le mot de passe est obligatoire'),
});
type LoginFormValues = z.infer<typeof loginSchema>;

function Login() {
  const { user, signIn, signOut, configurationError, initializationError } = useAuth();
  const [, navigate] = useLocation();
  const roleQ = usePlatformRole(user?.id);
  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const [error, setError] = useState('');
  const [blockedNotice, setBlockedNotice] = useState(() => {
    const flagged = sessionStorage.getItem(SESSION_BLOCK_KEY) === '1';
    if (flagged) sessionStorage.removeItem(SESSION_BLOCK_KEY);
    return flagged;
  });
  const [busy, setBusy] = useState(false);
  const submit = async (values: LoginFormValues) => {
    setError('');
    setBlockedNotice(false);
    setBusy(true);
    try {
      const signedInUser = await signIn(values.email, values.password);
      if (signedInUser) {
        // Statut de l'agence vérifié AVANT tout accès au dashboard.
        try {
          const account = await getAccountState();
          if (isBlockedAccount(account)) {
            sessionStorage.setItem(SESSION_BLOCK_KEY, '1');
            await Promise.resolve(signOut()).catch(() => undefined);
            sessionStorage.removeItem(SESSION_BLOCK_KEY);
            setBlockedNotice(true);
            return;
          }
        } catch {
          // Statut momentanément illisible : les gardes de routes revérifient.
        }
        // Redirection selon le rôle lu dans Supabase : admin → /admin, agence → /dashboard.
        try {
          const role = await getPlatformRole(signedInUser.id);
          navigate(role.isAdmin ? '/admin' : '/dashboard', { replace: true });
        } catch {
          navigate('/dashboard', { replace: true });
        }
      }
    } catch (e) {
      setError(getSupabaseErrorMessage(e, 'ouvrir une session'));
    } finally {
      setBusy(false);
    }
  };
  if (user) {
    const destination = roleQ.data?.isAdmin ? '/admin' : '/dashboard';
    const destinationLabel = roleQ.data?.isAdmin ? 'Continuer vers la console d’administration' : 'Continuer vers l’espace agence';
    return <div className="auth-loading"><div className="state-card"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Session déjà ouverte</h2><p>Votre compte est déjà connecté à Sofia Immobilier.</p><Link href={destination} className="text-action" data-testid="link-continue-workspace">{destinationLabel} <ArrowRight size={14} /></Link></div></div>;
  }
  // BLOC 9 : page publique -> retour vers l'accueil, cible 44 px, visible sur mobile.
  return <div className="login-page"><div className="public-back-row"><BackButton to="/" label="Retour à l’accueil" testId="button-back-login" /></div><div className="login-aside"><Link href="/" className="brand-lockup" data-testid="link-login-brand"><BrandMark /><div><div className="brand-name">sofia immobilier</div><div className="brand-caption">L’espace de votre agence</div></div></Link><div className="login-aside-copy"><span className="eyebrow">Bamako · Espace professionnel</span><h1>Le suivi de votre agence, <em>en un seul endroit.</em></h1><p>Retrouvez vos biens, vos contacts et les prochaines étapes commerciales dans un espace fiable, réservé à votre équipe.</p><div className="login-aside-rule"><ShieldCheck size={16} /><span>Connexion sécurisée · accès selon votre rôle</span></div></div><span className="login-aside-foot">SOFIA IMMOBILIER <span>—</span> GESTION D’AGENCE</span></div><main className="login-main"><div className="login-card"><span className="form-kicker">Bon retour</span><h2>Se connecter</h2><p>Connectez-vous avec les identifiants de votre compte existant.</p><Form {...form}><form onSubmit={form.handleSubmit(submit)} className="login-form">
    <FormField control={form.control} name="email" render={({ field }) => <FormItem><FormLabel>Adresse e-mail</FormLabel><div className="login-input-wrap"><Mail size={15} aria-hidden="true" /><FormControl><Input {...field} type="email" autoComplete="email" placeholder="vous@agence.ml" data-testid="input-login-email" /></FormControl></div><FormMessage /></FormItem>} />
    <FormField control={form.control} name="password" render={({ field }) => <FormItem><FormLabel>Mot de passe</FormLabel><div className="login-input-wrap"><LockKeyhole size={15} aria-hidden="true" /><FormControl><Input {...field} type="password" autoComplete="current-password" placeholder="Votre mot de passe" data-testid="input-login-password" /></FormControl></div><FormMessage /></FormItem>} />
    {(blockedNotice) && <p className="form-error login-blocked-notice" role="alert" data-testid="status-account-disabled">Votre compte agence est désactivé. Contactez l’administrateur.</p>}
    {(error || configurationError || initializationError) && <p className="form-error" role="alert" data-testid="status-login-error">{error || configurationError || initializationError}</p>}<Button type="submit" className="login-submit" disabled={busy || !!configurationError || !!initializationError} data-testid="button-login-submit">{busy ? 'Connexion…' : 'Se connecter'} <ArrowRight size={15} /></Button>
  </form></Form><div className="login-footnote"><ShieldCheck size={14} /> Nouvelle agence ? <Link href="/inscription" className="text-action" data-testid="link-signup-from-login">Créer un compte</Link></div></div><span className="login-copyright">© {new Date().getFullYear()} Sofia Immobilier · Bamako</span></main></div>;
}

function AdminGate({ children }: { children: ReactNode }) {
  const { user, loading, configurationError, initializationError } = useAuth();
  const roleQ = usePlatformRole(user?.id);
  const block = useAccountBlockGuard();
  if (loading || (user && roleQ.isLoading)) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Vérification du rôle administrateur" /></div>;
  if (configurationError || initializationError) return <div className="auth-loading"><div className="state-card error-state"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Connexion indisponible</h2><p>{configurationError || initializationError}</p></div></div>;
  if (!user) return <Redirect to="/login" />;
  if (block.kicking) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Compte désactivé — déconnexion" /></div>;
  if (block.accountQ.isLoading && !block.accountQ.data) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Vérification du statut du compte" /></div>;
  if (roleQ.error) return <div className="auth-loading"><div className="state-card error-state"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Impossible de vérifier votre rôle</h2><p>{getSupabaseErrorMessage(roleQ.error, 'vérifier votre rôle')}</p><Button variant="outline" onClick={() => void roleQ.refetch()}>Réessayer</Button></div></div>;
  if (!roleQ.data?.isAdmin) return <Redirect to="/dashboard" />;
  return <AdminShell><ErrorBoundary resetKey={user.id}>{children}</ErrorBoundary></AdminShell>;
}

function HomeRedirect() {
  const { user, loading, configurationError, initializationError } = useAuth();
  const roleQ = usePlatformRole(user?.id);
  const block = useAccountBlockGuard();
  if (loading || (user && roleQ.isLoading)) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Ouverture de votre espace" /></div>;
  if (configurationError || initializationError) return <div className="auth-loading"><div className="state-card error-state"><div className="state-icon"><ShieldCheck size={19} /></div><h2>Connexion indisponible</h2><p>{configurationError || initializationError}</p></div></div>;
  if (!user) return <WelcomePage />;
  if (block.kicking || (block.accountQ.isLoading && !block.accountQ.data)) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Vérification du statut du compte" /></div>;
  return <Redirect to={roleQ.data?.isAdmin ? '/admin' : '/dashboard'} />;
}

function ProfileRoute() {
  const { user, loading } = useAuth();
  const roleQ = usePlatformRole(user?.id);
  const block = useAccountBlockGuard();
  if (loading || (user && roleQ.isLoading)) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Chargement du profil" /></div>;
  if (!user) return <Redirect to="/login" />;
  if (block.kicking || (block.accountQ.isLoading && !block.accountQ.data)) return <div className="auth-loading"><div className="brand-lockup"><BrandMark /><div className="brand-name">sofia immobilier</div></div><LoadingRows label="Vérification du statut du compte" /></div>;
  if (roleQ.data?.isAdmin) return <AdminShell><ErrorBoundary resetKey={user.id}><ProfilePage /></ErrorBoundary></AdminShell>;
  return <WorkspaceGate><ProfilePage /></WorkspaceGate>;
}

function RoutedContent() {
  const [path] = useLocation();
  if (path === '/login') return <Login />;
  if (path === '/inscription') return <SignupPage />;
  if (path === '/onboarding') return <OnboardingPage />;
  // Page publique : aucun compte requis, le jeton d'invitation fait foi.
  if (path === '/rejoindre') return <JoinAgencyPage />;
  if (path === '/profil') return <ProfileRoute />;
  if (path === '/') return <HomeRedirect />;
  if (path === '/admin' || path.startsWith('/admin/')) {
    return <AdminGate>
      <Switch>
        <Route path="/admin" component={AdminOverviewPage} />
        <Route path="/admin/agences" component={AdminAgenciesPage} />
        <Route path="/admin/biens" component={AdminPropertiesPage} />
        <Route path="/admin/abonnements" component={AdminSubscriptionsPage} />
        <Route path="/admin/paiements" component={AdminBillingPage} />
        <Route path="/admin/reglages" component={AdminSettingsPage} />
        <Route path="/admin/consommation" component={AdminUsagePage} />
        <Route path="/admin/ca" component={AdminRevenuePage} />
        <Route path="/admin/activite" component={AdminActivityPage} />
        <Route component={NotFound} />
      </Switch>
    </AdminGate>;
  }
  return <WorkspaceGate><ErrorBoundary resetKey={path}><Switch>
    <Route path="/dashboard" component={Overview} />
    <Route path="/" component={Overview} />
    <Route path="/biens" component={PropertiesPage} />
    <Route path="/biens/:id" component={PropertyDetailPage} />
    <Route path="/contacts" component={ContactsPage} />
    <Route path="/contacts/:id" component={ContactDetailPage} />
    <Route path="/pipeline" component={PipelinePage} />
    <Route path="/visites" component={VisitsPage} />
    <Route path="/whatsapp" component={WhatsAppPage} />
    <Route path="/assistant-ia" component={AssistantPage} />
    <Route path="/automatisations" component={AutomationsPage} />
    <Route path="/agence" component={AgencyPage} />
    <Route path="/mon-offre" component={MyOfferPage} />
    <Route path="/equipe" component={TeamPage} />
    <Route path="/parametres" component={SettingsPage} />
    <Route component={NotFound} />
  </Switch></ErrorBoundary></WorkspaceGate>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><AuthProvider><AgencyProvider><RoutedContent /></AgencyProvider></AuthProvider></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}
export default App;
