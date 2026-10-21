import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  ArrowRight,
  BarChart3,
  Bell,
  Building2,
  CreditCard,
  Gauge,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth-context';
import { usePlatformRole, useAllAgencies, useAllProperties, useAllContacts } from '@/lib/data-hooks';
import { useSubscriptionRevenue } from '@/lib/admin-billing-api';
import { getSupabaseErrorMessage } from '@/lib/supabase';
// BLOC 9 : en-tête mobile admin + retour déterministe entre espaces.
import { BackButton } from '@/components/back-button';
import { trackRoute } from '@/lib/back-navigation';
// BLOC 3 (session 3) : cloche d'alertes sur toutes les pages admin.
import { AdminAlertsBell } from '@/components/admin-alerts-bell';
import { useAgency } from '@/lib/agency-context';
import { usePendingAgencies } from '@/lib/pending-api';
import { BrandMark } from '@/lib/workspace-ui';
import { ThemeToggle } from '@/lib/theme';

type AdminNavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number | string }>;
  exact?: boolean;
  /** Clé du compteur affiché en pastille, calculé depuis la base. */
  badge?: 'pendingBilling' | 'pendingAgencies';
};

const adminNav: AdminNavItem[] = [
  { href: '/admin', label: 'Vue d’ensemble', icon: LayoutDashboard, exact: true },
  { href: '/admin/agences', label: 'Agences', icon: Building2 },
  { href: '/admin/biens', label: 'Biens & contenus', icon: Home },
  { href: '/admin/abonnements', label: 'Abonnements', icon: CreditCard },
  // BLOC 2 (session 2) : agences créées mais non validées — offre choisie et
  // paiement déclaré. La validation crée l'abonnement et ouvre leur dashboard.
  { href: '/admin/validations', label: 'Validations d’agences', icon: BadgeCheck, badge: 'pendingAgencies' },
  // BLOC 2 : file de validation des paiements et demandes de changement d'offre.
  { href: '/admin/paiements', label: 'Paiements & offres', icon: Wallet, badge: 'pendingBilling' },
  { href: '/admin/ca', label: 'Chiffre d’affaires', icon: TrendingUp },
  // BLOC 7 : consommation IA et canal WhatsApp, par agence (lecture seule).
  { href: '/admin/consommation', label: 'Consommation IA', icon: Gauge },
  { href: '/admin/activite', label: 'Activité & alertes', icon: Activity },
  { href: '/admin/reglages', label: 'Réglages', icon: Settings2 },
];

type SearchHit = { kind: 'agence' | 'bien' | 'contact'; id: string; title: string; subtitle: string; href: string };

function GlobalSearch({ onNavigate }: { onNavigate: () => void }) {
  const [term, setTerm] = useState('');
  const agenciesQ = useAllAgencies();
  const propertiesQ = useAllProperties();
  const contactsQ = useAllContacts();

  const hits = useMemo<SearchHit[]>(() => {
    const needle = term.trim().toLocaleLowerCase('fr');
    if (needle.length < 2) return [];
    const results: SearchHit[] = [];
    for (const agency of agenciesQ.data?.agencies ?? []) {
      const haystack = `${agency.name} ${agency.slug} ${agency.city ?? ''} ${agency.email ?? ''}`.toLocaleLowerCase('fr');
      if (haystack.includes(needle)) {
        results.push({ kind: 'agence', id: agency.id, title: agency.name, subtitle: agency.city ?? agency.country, href: '/admin/agences' });
      }
    }
    for (const property of propertiesQ.data ?? []) {
      const haystack = `${property.reference} ${property.title} ${property.city ?? ''} ${property.neighborhood ?? ''}`.toLocaleLowerCase('fr');
      if (haystack.includes(needle)) {
        results.push({ kind: 'bien', id: property.id, title: `${property.reference} · ${property.title}`, subtitle: property.city ?? '', href: '/admin/biens' });
      }
    }
    for (const contact of contactsQ.data ?? []) {
      const haystack = `${contact.first_name} ${contact.last_name ?? ''} ${contact.email ?? ''} ${contact.phone ?? ''}`.toLocaleLowerCase('fr');
      if (haystack.includes(needle)) {
        results.push({ kind: 'contact', id: contact.id, title: `${contact.first_name} ${contact.last_name ?? ''}`, subtitle: contact.email ?? contact.phone ?? '', href: '/admin/biens' });
      }
    }
    return results.slice(0, 8);
  }, [term, agenciesQ.data, propertiesQ.data, contactsQ.data]);

  return (
    <div className="admin-search" data-testid="admin-global-search">
      <Search size={15} aria-hidden="true" />
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Recherche globale : agence, bien, contact…"
        aria-label="Recherche globale"
        data-testid="input-admin-search"
      />
      {term.trim().length >= 2 && (
        <div className="admin-search-results" role="listbox">
          {hits.length ? (
            hits.map((hit) => (
              <Link
                key={`${hit.kind}-${hit.id}`}
                href={hit.href}
                className="admin-search-hit"
                onClick={() => { setTerm(''); onNavigate(); }}
                data-testid={`admin-search-hit-${hit.kind}`}
              >
                <span className={`admin-search-kind is-${hit.kind}`}>{hit.kind}</span>
                <span><strong>{hit.title}</strong><small>{hit.subtitle}</small></span>
                <ArrowRight size={13} />
              </Link>
            ))
          ) : (
            <p className="admin-search-empty">Aucun résultat pour « {term} »</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminShell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const { user, signOut } = useAuth();
  const roleQ = usePlatformRole(user?.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const name = roleQ.data?.profile?.full_name || user?.email || 'Administration';
  // BLOC 2 : pastille « Paiements & offres » = déclarations + demandes en attente.
  // Un seul appel (RPC déjà utilisé par la vue d'ensemble), mis en cache.
  const queuesQ = useSubscriptionRevenue(1);
  const pendingBilling =
    Number(queuesQ.data?.totals?.pending_declarations ?? 0) +
    Number(queuesQ.data?.totals?.pending_plan_changes ?? 0);
  // BLOC 11 (bug 5) : un administrateur plateforme sans adhesion agence n'a PAS
  // d'espace agence a rejoindre. `WorkspaceGate` contient deja
  // `if (isAdmin && memberships.length === 0) return <Redirect to="/admin" />` :
  // le bouton « retour vers l'espace agence » le renvoyait donc immediatement ici,
  // d'ou un bouton visible mais sans AUCUN effet. On le masque dans ce cas.
  const { memberships } = useAgency();
  const hasAgencySpace = memberships.length > 0;
  // BLOC 2 (session 2) : pastille « Validations d'agences ».
  const pendingAgenciesQ = usePendingAgencies();
  const badges: Record<string, number> = {
    pendingBilling,
    pendingAgencies: Number(pendingAgenciesQ.data?.total ?? 0),
  };
  // BLOC 9 : journal des routes internes.
  useEffect(() => { trackRoute(path); }, [path]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      setNotice(getSupabaseErrorMessage(error, 'fermer la session'));
    }
  };

  return (
    <div className="admin-shell">
      <div className={`mobile-overlay${menuOpen ? ' is-open' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`admin-sidebar${menuOpen ? ' is-open' : ''}`} aria-label="Navigation administration">
        <Link href="/admin" className="brand-lockup" onClick={() => setMenuOpen(false)}>
          <BrandMark />
          <div>
            <div className="brand-name">sofia admin</div>
            <div className="brand-caption">Console plateforme</div>
          </div>
        </Link>
        <div className="nav-label">Pilotage</div>
        <nav className="nav-list" aria-label="Navigation administration">
          {adminNav.map(({ href, label, icon: Icon, exact, badge }) => {
            const active = exact ? path === href : path.startsWith(href);
            const count = badge ? badges[badge] ?? 0 : 0;
            return (
              <Link
                key={href}
                href={href}
                className={`nav-link${active ? ' is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => setMenuOpen(false)}
                data-testid={`link-admin-nav-${href.replace('/admin', '') || 'overview'}`}
              >
                <Icon size={16} />
                <span>{label}</span>
                {count > 0 && (
                  <em className="nav-badge" data-testid={`badge-admin-nav-${href.replace('/admin', '') || 'overview'}`}>
                    {count > 9 ? '9+' : count}
                  </em>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="connection-card">
          <div className="connection-heading"><i /> Session administrateur</div>
          <p>Accès global en lecture/écriture via les politiques RLS « platform admin ».</p>
        </div>
        {hasAgencySpace && (
          <Link href="/dashboard" className="sidebar-signout" data-testid="link-admin-to-dashboard">
            <Home size={14} /> Espace agence
          </Link>
        )}
        <button className="sidebar-signout" onClick={() => void handleSignOut()} data-testid="button-admin-sign-out">
          <LogOut size={14} /> Se déconnecter
        </button>
      </aside>

      <div className="main-column">
        <header className="topbar admin-topbar">
          <button type="button" className="icon-button admin-menu-button" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          {/* BLOC 9 : sur une sous-page -> vue d'ensemble admin ; sur /admin
              -> retour à l'espace agence. Repli déterministe, cible 44 px. */}
          <BackButton
            space="admin"
            variant="desktop"
            icon={ArrowLeft}
            testId="button-admin-back"
            hidden={path === '/admin' && !hasAgencySpace}
          />
          <div className="breadcrumb">
            <Link href="/admin" className="breadcrumb-home"><ShieldCheck size={12} /> Administration</Link>
            <ArrowRight size={12} />
            <strong>{adminNav.find((item) => (item.exact ? path === item.href : path.startsWith(item.href)))?.label ?? 'Console'}</strong>
          </div>
          <GlobalSearch onNavigate={() => setMenuOpen(false)} />
          <div className="topbar-tools">
            <AdminAlertsBell />
            <ThemeToggle testId="button-theme-toggle-admin" />
            <button type="button" className="icon-button topbar-signout" onClick={() => void handleSignOut()} aria-label="Se déconnecter" title="Se déconnecter" data-testid="button-admin-topbar-sign-out">
              <LogOut size={15} />
            </button>
            <Link href="/admin/activite" className="icon-button" aria-label="Voir l’activité" data-testid="link-admin-activity">
              <Bell size={15} />
            </Link>
            <Link href="/profil" className="profile-chip">
              <div className="profile-circle">{name.slice(0, 1).toUpperCase()}</div>
              <span>{name}</span>
            </Link>
          </div>
        </header>
        {/* BLOC 9 : l'espace admin n'avait AUCUN en-tête sous 760 px (sa barre
            supérieure est masquée) : plus de flèche de retour, plus de menu, plus
            de déconnexion sur téléphone et dans les previews. */}
        <header className="mobile-header admin-mobile-header">
          <BackButton
            space="admin"
            variant="mobile"
            testId="button-admin-mobile-back"
            hidden={path === '/admin' && !hasAgencySpace}
          />
          <div className="mobile-brand">
            <strong>{adminNav.find((item) => (item.exact ? path === item.href : path.startsWith(item.href)))?.label ?? 'Administration'}</strong>
          </div>
          <button
            type="button"
            className="icon-button mobile-signout"
            onClick={() => void handleSignOut()}
            aria-label="Se déconnecter"
            title="Se déconnecter"
            data-testid="button-admin-mobile-sign-out"
          >
            <LogOut size={17} />
          </button>
          <button
            type="button"
            className="icon-button mobile-menu-button"
            aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            data-testid="button-admin-mobile-menu"
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </header>
        <main className="content-wrap admin-content">{children}</main>
      </div>

      {notice && (
        <div className="notice-toast" role="alert">
          {notice}
          <button onClick={() => setNotice('')} aria-label="Fermer"><X size={13} /></button>
        </div>
      )}
    </div>
  );
}

export function AdminHeading({
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
    <div className="page-heading admin-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
