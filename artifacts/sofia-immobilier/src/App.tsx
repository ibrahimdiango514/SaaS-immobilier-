import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowDownRight,
  ArrowRight,
  Building2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ContactRound,
  FileText,
  Home,
  LayoutDashboard,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  UsersRound,
  X,
  Bell,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

const navigation = [
  { href: '/', label: 'Vue d’ensemble', icon: LayoutDashboard },
  { href: '/biens', label: 'Biens immobiliers', icon: Home },
  { href: '/contacts', label: 'Prospects et contacts', icon: ContactRound },
  { href: '/pipeline', label: 'Pipeline commercial', icon: SlidersHorizontal },
  { href: '/agence', label: 'Agence et membres', icon: UsersRound },
  { href: '/parametres', label: 'Paramètres', icon: Settings2 },
];

const pageDetails: Record<string, { title: string; description: string; icon: typeof Home }> = {
  '/biens': {
    title: 'Biens immobiliers',
    description: 'Retrouvez les biens suivis par votre agence, dès que votre espace sera connecté.',
    icon: Home,
  },
  '/contacts': {
    title: 'Prospects et contacts',
    description: 'Un point de repère pour les échanges et les demandes à venir.',
    icon: ContactRound,
  },
  '/pipeline': {
    title: 'Pipeline commercial',
    description: 'Les étapes commerciales apparaîtront ici après activation de l’accès aux données.',
    icon: SlidersHorizontal,
  },
  '/agence': {
    title: 'Agence et membres',
    description: 'Les informations de votre agence et de son équipe seront disponibles une fois l’accès configuré.',
    icon: UsersRound,
  },
  '/parametres': {
    title: 'Paramètres',
    description: 'Les préférences de votre espace seront présentées ici lorsque la configuration sera disponible.',
    icon: Settings2,
  },
};

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <Building2 size={18} strokeWidth={1.9} />
    </div>
  );
}

function Navigation({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <>
      <div className="nav-label">Espace de travail</div>
      <nav className="nav-list" aria-label="Navigation principale">
        {navigation.map(({ href, label, icon: Icon }) => (
          <Link
            href={href}
            key={href}
            className="nav-link"
            aria-current={current === href ? 'page' : undefined}
            data-testid={`link-nav-${href === '/' ? 'overview' : href.slice(1)}`}
            onClick={onNavigate}
          >
            <Icon size={16} strokeWidth={1.8} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}

function SearchField({ value, onChange, mobile = false }: {
  value: string;
  onChange: (value: string) => void;
  mobile?: boolean;
}) {
  return (
    <label className={`global-search${mobile ? ' mobile-search' : ''}`}>
      <Search size={14} aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Rechercher dans l’espace"
        aria-label="Rechercher dans l’espace"
        data-testid={mobile ? 'input-search-mobile' : 'input-global-search'}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          onClick={() => onChange('')}
          aria-label="Effacer la recherche"
          data-testid={mobile ? 'button-clear-search-mobile' : 'button-clear-search'}
        >
          <X size={13} />
        </button>
      )}
    </label>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [notice, setNotice] = useState(false);
  const current = navigation.find((item) => item.href === location);
  const currentLabel = current?.label ?? 'Espace de travail';

  useEffect(() => {
    setMenuOpen(false);
  }, [location]);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(false), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const showNotice = () => {
    setNoticeOpen(true);
    setNotice(true);
  };

  return (
    <div className="app-shell">
      <div
        className={`mobile-overlay${menuOpen ? ' is-open' : ''}`}
        aria-hidden="true"
        onClick={() => setMenuOpen(false)}
        data-testid="mobile-navigation-overlay"
      />
      <aside className={`sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Menu de l’agence">
        <Link href="/" className="brand-lockup" data-testid="link-brand-home" onClick={() => setMenuOpen(false)}>
          <BrandMark />
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">L’espace de votre agence</div>
          </div>
        </Link>
        <Navigation current={location} onNavigate={() => setMenuOpen(false)} />
        <div className="sidebar-spacer" />
        <div className="connection-card" data-testid="status-data-access">
          <div className="connection-heading"><i /> Accès aux données en attente</div>
          <p>Les informations de l’agence s’afficheront après configuration de l’accès.</p>
        </div>
        <div className="agency-switcher" data-testid="display-agency-workspace">
          <div className="agency-avatar">S</div>
          <div className="agency-label">
            <strong>Espace agence</strong>
            <span>Configuration initiale</span>
          </div>
          <ChevronDown size={14} color="#9aafaa" />
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Espace agence</span>
            <ArrowRight size={12} />
            <strong>{currentLabel}</strong>
          </div>
          <div className="topbar-tools">
            <SearchField value={search} onChange={setSearch} />
            <button
              type="button"
              className="icon-button"
              aria-label="Afficher les notifications"
              onClick={showNotice}
              data-testid="button-notifications"
            >
              <Bell size={15} />
            </button>
            <div className="profile-chip" data-testid="display-user-access-status">
              <div className="profile-circle">—</div>
              <span>Accès en attente</span>
            </div>
          </div>
        </header>
        <header className="mobile-header">
          <div className="mobile-brand">
            <BrandMark />
            <strong>sofia immobilier</strong>
          </div>
          <button
            type="button"
            className="icon-button mobile-menu-button"
            aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            data-testid="button-mobile-menu"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </header>
        <main className="content-wrap">
          <div className="mobile-search-row"><SearchField value={search} onChange={setSearch} mobile /></div>
          {search.trim() && (
            <div className="search-feedback" role="status" data-testid="status-search">
              <Search size={13} />
              La recherche sera disponible lorsque l’accès aux données sera configuré.
            </div>
          )}
          {children}
        </main>
      </div>
      {notice && (
        <div className="notice-toast" role="status" data-testid="status-notifications">
          {noticeOpen ? 'Aucune notification : accès aux données en attente.' : 'Aucune notification disponible.'}
          <button type="button" onClick={() => setNotice(false)} aria-label="Fermer le message" data-testid="button-dismiss-notice">
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="today-pill" data-testid="status-workspace-mode">
        <Clock3 size={13} />
        Espace en préparation
      </div>
    </div>
  );
}

const stats = [
  { label: 'Biens immobiliers', icon: Home, foot: 'Données non chargées' },
  { label: 'Contacts suivis', icon: ContactRound, foot: 'Données non chargées' },
  { label: 'Opportunités', icon: ArrowDownRight, foot: 'Données non chargées' },
  { label: 'Membres de l’agence', icon: UsersRound, foot: 'Données non chargées' },
];

function Overview() {
  return (
    <>
      <PageHeading
        eyebrow="Votre espace de travail"
        title="Vue d’ensemble"
        description="Les repères essentiels de votre activité, réunis au même endroit."
      />
      <section className="status-banner" aria-label="État de connexion des données" data-testid="status-dashboard-access">
        <div className="status-banner-icon"><ShieldCheck size={15} /></div>
        <div>
          <strong>Votre espace est prêt à être configuré</strong>
          <p>Les données de votre agence ne sont pas encore chargées. Aucun chiffre ni dossier ne sera affiché avant la configuration de l’accès.</p>
        </div>
        <span className="status-tag">Accès en attente</span>
      </section>
      <section className="stat-grid" aria-label="Indicateurs de l’agence">
        {stats.map(({ label, icon: Icon, foot }, index) => (
          <article className="stat-card" key={label} data-testid={`card-stat-${index + 1}`}>
            <div className="stat-top">
              <span>{label}</span>
              <span className="stat-icon"><Icon size={14} /></span>
            </div>
            <div className="stat-value" data-testid={`value-stat-${index + 1}`}>—</div>
            <div className="stat-foot">{foot}</div>
          </article>
        ))}
      </section>
      <section className="overview-grid">
        <article className="panel" aria-labelledby="recent-properties-title">
          <div className="panel-head">
            <div>
              <h2 id="recent-properties-title">Derniers biens ajoutés</h2>
              <p>Un aperçu des biens de votre portefeuille</p>
            </div>
            <Link href="/biens" className="text-action" data-testid="link-view-properties">
              Voir les biens <ArrowRight size={13} />
            </Link>
          </div>
          <div className="table-wrap">
            <table className="data-table" aria-label="Derniers biens immobiliers">
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Bien</th>
                  <th>Localisation</th>
                  <th>Statut</th>
                </tr>
              </thead>
            </table>
            <div className="empty-table" data-testid="empty-recent-properties">
              <div className="empty-table-mark"><Home size={17} /></div>
              <strong>Aucun bien à afficher pour le moment</strong>
              <p>Les biens apparaîtront ici après la configuration de l’accès aux données.</p>
            </div>
          </div>
        </article>
        <article className="panel readiness-panel" aria-labelledby="workspace-readiness-title">
          <div className="readiness-title">
            <h2 id="workspace-readiness-title">Votre espace</h2>
            <span>État de configuration</span>
          </div>
          <p className="readiness-intro">Sofia Immobilier est le point de départ partagé de votre équipe. Voici les éléments en attente avant l’affichage de vos données.</p>
          <div className="readiness-list">
            <div className="readiness-row" data-testid="status-setup-agency">
              <div className="readiness-icon"><Building2 size={14} /></div>
              <div className="readiness-copy"><strong>Informations de l’agence</strong><span>Accès en attente</span></div>
              <span className="pending-dot" />
            </div>
            <div className="readiness-row" data-testid="status-setup-members">
              <div className="readiness-icon"><UsersRound size={14} /></div>
              <div className="readiness-copy"><strong>Équipe et permissions</strong><span>Accès en attente</span></div>
              <span className="pending-dot" />
            </div>
            <div className="readiness-row" data-testid="status-setup-data">
              <div className="readiness-icon"><FileText size={14} /></div>
              <div className="readiness-copy"><strong>Données métier</strong><span>Non chargées</span></div>
              <span className="pending-dot" />
            </div>
          </div>
          <div className="notice-box"><CircleHelp size={14} /> Les chiffres, listes et détails resteront vides tant que les autorisations d’accès ne sont pas configurées.</div>
        </article>
      </section>
    </>
  );
}

function PlaceholderPage({ path }: { path: string }) {
  const page = pageDetails[path];
  const Icon = page?.icon ?? FileText;
  return (
    <>
      <PageHeading eyebrow="Espace de travail" title={page.title} description={page.description} />
      <div className="status-banner" data-testid={`status-access-${path.slice(1)}`}>
        <div className="status-banner-icon"><ShieldCheck size={15} /></div>
        <div>
          <strong>Accès aux données en attente</strong>
          <p>Aucune donnée n’a été chargée. Le contenu de cette page apparaîtra après configuration des accès de l’agence.</p>
        </div>
        <span className="status-tag">Non connecté</span>
      </div>
      <section className="route-placeholder" data-testid={`empty-page-${path.slice(1)}`}>
        <div className="placeholder-inner">
          <div className="placeholder-art"><Icon size={24} strokeWidth={1.6} /></div>
          <h2>Votre espace {page.title.toLocaleLowerCase('fr')} vous attend</h2>
          <p>Cette vue est prête à accueillir les informations autorisées de votre agence. Aucune donnée métier n’est affichée dans cette version initiale.</p>
          <div className="placeholder-state"><i /> Chargement des données non configuré</div>
        </div>
      </section>
    </>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return (
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/biens"><PlaceholderPage path="/biens" /></Route>
          <Route path="/contacts"><PlaceholderPage path="/contacts" /></Route>
          <Route path="/pipeline"><PlaceholderPage path="/pipeline" /></Route>
          <Route path="/agence"><PlaceholderPage path="/agence" /></Route>
          <Route path="/parametres"><PlaceholderPage path="/parametres" /></Route>
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
