import { useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  Building2,
  CreditCard,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  ShieldCheck,
  TrendingUp,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth-context';
import { usePlatformRole, useAllAgencies, useAllProperties, useAllContacts } from '@/lib/data-hooks';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { BrandMark } from '@/lib/workspace-ui';
import { ThemeToggle } from '@/lib/theme';

const adminNav = [
  { href: '/admin', label: 'Vue d’ensemble', icon: LayoutDashboard, exact: true },
  { href: '/admin/agences', label: 'Agences', icon: Building2 },
  { href: '/admin/biens', label: 'Biens & contenus', icon: Home },
  { href: '/admin/abonnements', label: 'Abonnements', icon: CreditCard },
  { href: '/admin/ca', label: 'Chiffre d’affaires', icon: TrendingUp },
  { href: '/admin/activite', label: 'Activité & alertes', icon: Activity },
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
          {adminNav.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? path === href : path.startsWith(href);
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
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <div className="connection-card">
          <div className="connection-heading"><i /> Session administrateur</div>
          <p>Accès global en lecture/écriture via les politiques RLS « platform admin ».</p>
        </div>
        <Link href="/dashboard" className="sidebar-signout" data-testid="link-admin-to-dashboard">
          <Home size={14} /> Espace agence
        </Link>
        <button className="sidebar-signout" onClick={() => void handleSignOut()} data-testid="button-admin-sign-out">
          <LogOut size={14} /> Se déconnecter
        </button>
      </aside>

      <div className="main-column">
        <header className="topbar admin-topbar">
          <button type="button" className="icon-button admin-menu-button" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          {path !== '/admin' && (
            <Link href="/admin" className="icon-button topbar-back" aria-label="Retour à la vue d’ensemble" title="Retour à la vue d’ensemble" data-testid="button-admin-back">
              <ArrowLeft size={16} />
            </Link>
          )}
          <div className="breadcrumb">
            <Link href="/admin" className="breadcrumb-home"><ShieldCheck size={12} /> Administration</Link>
            <ArrowRight size={12} />
            <strong>{adminNav.find((item) => (item.exact ? path === item.href : path.startsWith(item.href)))?.label ?? 'Console'}</strong>
          </div>
          <GlobalSearch onNavigate={() => setMenuOpen(false)} />
          <div className="topbar-tools">
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
