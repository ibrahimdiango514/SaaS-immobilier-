import { Link } from 'wouter';
import {
  ArrowRight, BadgeCheck, BarChart3, Bot, Building2, CalendarCheck, ImagePlus,
  LockKeyhole, MessageCircle, Search, ShieldCheck, Sparkles, UsersRound,
} from 'lucide-react';

const features = [
  {
    icon: Building2,
    title: 'Portefeuille de biens',
    text: 'Annonces, photos HD, statuts et visibilité immobilière : tout votre catalogue tient dans une fiche claire, accessible à toute votre équipe.',
  },
  {
    icon: UsersRound,
    title: 'Contacts & pipeline',
    text: 'Prospects, visites, relances et opportunités suivis au jour le jour, avec un historique complet pour ne plus jamais perdre un client.',
  },
  {
    icon: Bot,
    title: 'Agent WhatsApp & IA',
    text: 'Un agent disponible sur WhatsApp répond à vos clients avec vos biens réels, 24h/24 — et se met en pause pour les agences suspendues.',
  },
];

export default function WelcomePage() {
  return (
    <div className="welcome-page" data-testid="page-welcome">
      <div className="welcome-orbs" aria-hidden="true">
        <span className="welcome-orb orb-a" />
        <span className="welcome-orb orb-b" />
        <span className="welcome-orb orb-c" />
      </div>

      <header className="welcome-header">
        <Link href="/" className="brand-lockup welcome-brand" data-testid="link-welcome-brand">
          <span className="brand-mark welcome-brand-mark"><Building2 size={18} /></span>
          <div>
            <div className="brand-name">sofia immobilier</div>
            <div className="brand-caption">Bamako · Mali</div>
          </div>
        </Link>
        <nav className="welcome-header-actions" aria-label="Accès compte">
          <Link href="/login" className="button-link welcome-ghost-btn" data-testid="link-welcome-login">
            Se connecter
          </Link>
          <Link href="/inscription" className="button-link welcome-cta-btn" data-testid="link-welcome-signup">
            Créer mon agence <ArrowRight size={15} />
          </Link>
        </nav>
      </header>

      <section className="welcome-hero">
        <div className="welcome-hero-media" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}accueil-hero.jpg`} alt="" loading="eager" />
          <div className="welcome-hero-shade" />
        </div>
        <div className="welcome-hero-copy welcome-enter enter-1">
          <span className="eyebrow welcome-eyebrow"><Sparkles size={13} /> Logiciel immobilier nouvelle génération</span>
          <h1>
            L’espace de travail des <em>agences immobilières</em> qui veulent aller vite.
          </h1>
          <p>
            Biens, contacts, visites, chiffre d’affaires et agent WhatsApp : Sofia Immobilier réunit
            toute votre activité dans un espace élégant, sécurisé et pensé pour Bamako.
          </p>
          <div className="welcome-hero-ctas">
            <Link href="/inscription" className="button-link welcome-cta-btn welcome-cta-lg" data-testid="link-welcome-hero-signup">
              Commencer gratuitement <ArrowRight size={16} />
            </Link>
            <Link href="/login" className="button-link welcome-ghost-btn welcome-cta-lg" data-testid="link-welcome-hero-login">
              J’ai déjà un compte
            </Link>
          </div>
          <div className="welcome-trust">
            <span><LockKeyhole size={13} /> Données chiffrées & cloisonnées par agence</span>
            <span><BadgeCheck size={13} /> Espaces admin & agence distincts</span>
          </div>
        </div>

        <aside className="welcome-float welcome-enter enter-3" aria-hidden="true">
          <div className="float-card float-card-a">
            <span className="float-icon float-icon-money"><BarChart3 size={16} /></span>
            <div>
              <strong>Chiffre d’affaires</strong>
              <small>Suivi mensuel, trimestriel & annuel</small>
            </div>
          </div>
          <div className="float-card float-card-b">
            <span className="float-icon float-icon-visit"><CalendarCheck size={16} /></span>
            <div>
              <strong>Visite confirmée</strong>
              <small>Acacia Ville · demain 10 h 30</small>
            </div>
          </div>
          <div className="float-card float-card-c">
            <span className="float-icon float-icon-chat"><MessageCircle size={16} /></span>
            <div>
              <strong>Agent WhatsApp actif</strong>
              <small>3 conversations ouvertes</small>
            </div>
          </div>
        </aside>
      </section>

      <section className="welcome-features welcome-enter enter-4">
        {features.map(({ icon: Icon, title, text }) => (
          <article className="welcome-feature-card" key={title}>
            <span className="welcome-feature-icon"><Icon size={19} /></span>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </section>

      <section className="welcome-strip welcome-enter enter-5">
        <div className="welcome-strip-item"><Search size={16} /><span><strong>Recherche globale</strong> — biens, contacts, agences en un geste</span></div>
        <div className="welcome-strip-item"><ImagePlus size={16} /><span><strong>Photos illimitées</strong> — compression auto & couverture au choix</span></div>
        <div className="welcome-strip-item"><ShieldCheck size={16} /><span><strong>Rôles stricts</strong> — agent suspendu = accès coupé, partout</span></div>
        <div className="welcome-strip-item"><Sparkles size={16} /><span><strong>Design premium</strong> — clair ou sombre, mobile & bureau</span></div>
      </section>

      <section className="welcome-final-cta welcome-enter enter-5">
        <div className="welcome-final-card">
          <h2>Prêt à professionnaliser votre agence&nbsp;?</h2>
          <p>Créez votre espace en deux minutes, invitez votre équipe et commencez à enregistrer vos biens aujourd’hui.</p>
          <div className="welcome-hero-ctas">
            <Link href="/inscription" className="button-link welcome-cta-btn welcome-cta-lg" data-testid="link-welcome-final-signup">
              Créer mon agence <ArrowRight size={16} />
            </Link>
            <Link href="/login" className="button-link welcome-ghost-btn welcome-cta-lg" data-testid="link-welcome-final-login">
              Se connecter
            </Link>
          </div>
        </div>
      </section>

      <footer className="welcome-footer">
        <span>© {new Date().getFullYear()} Sofia Immobilier · Bamako</span>
        <span>Espace professionnel des agences immobilières</span>
      </footer>
    </div>
  );
}
