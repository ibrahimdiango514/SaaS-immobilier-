import { useMemo, useRef, useState } from 'react';
import { BarChart3, Bot, CalendarDays, ClipboardCopy, ContactRound, Home, Send, Sparkles, TrendingUp } from 'lucide-react';
import { useAgency } from '@/lib/agency-context';
import { useProperties, useContacts, usePipeline, useVisits, useFollowUps } from '@/lib/data-hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Heading, LoadingRows, cash, dateLabel, dateTimeLabel } from '@/lib/workspace-ui';

type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; at: number };

const SUGGESTIONS = [
  'Combien de biens ai-je ?',
  'Quels biens sont disponibles ?',
  'Résumé de mes contacts',
  'Mes prochaines visites',
  'Relances en attente',
  'Valeur de mon portefeuille',
  'État de mon pipeline',
  'Que peux-tu faire ?',
];

function buildAnswer(
  question: string,
  ctx: {
    properties: ReturnType<typeof useProperties>['data'];
    contacts: ReturnType<typeof useContacts>['data'];
    pipeline: ReturnType<typeof usePipeline>['data'];
    visits: ReturnType<typeof useVisits>['data'];
    followUps: ReturnType<typeof useFollowUps>['data'];
  },
): string {
  const term = question.trim().toLocaleLowerCase('fr');
  const properties = ctx.properties ?? [];
  const contacts = ctx.contacts ?? [];
  const pipeline = ctx.pipeline ?? [];
  const visits = ctx.visits ?? [];
  const followUps = ctx.followUps ?? [];

  const has = (...words: string[]) => words.some((word) => term.includes(word));

  if (has('aide', 'peux-tu', 'peux tu', 'capacit', 'commande')) {
    return [
      'Je réponds à partir de vos données réelles Supabase, en direct :',
      '• « Combien de biens ai-je ? » — inventaire complet par statut',
      '• « Quels biens sont disponibles ? » — liste à commercialiser',
      '• « Résumé de mes contacts » — répartition des prospects',
      '• « Mes prochaines visites » — agenda à venir',
      '• « Relances en attente » — suivi commercial',
      '• « Valeur de mon portefeuille » — somme des biens disponibles',
      '• « État de mon pipeline » — opportunités par étape',
      'Aucune donnée fictive : tout est calculé sur votre agence active.',
    ].join('\n');
  }

  if (has('combien', 'nombre', 'inventaire') && has('bien', 'immobil', 'logement', 'propriet')) {
    const byStatus = properties.reduce<Record<string, number>>((acc, p) => {
      acc[p.status] = (acc[p.status] ?? 0) + 1;
      return acc;
    }, {});
    const lines = properties.length
      ? Object.entries(byStatus).map(([status, count]) => `• ${status} : ${count}`)
      : ['• Aucun bien enregistré pour le moment.'];
    return `Votre portefeuille compte ${properties.length} bien(s).\n${lines.join('\n')}`;
  }

  if (has('disponible', 'vendre', 'vente', 'louer', 'location', 'commercialiser')) {
    const available = properties.filter((p) => p.status === 'available');
    if (!available.length) return 'Aucun bien n’est actuellement au statut « Disponible ».';
    const top = available.slice(0, 5);
    return `${available.length} bien(s) disponible(s). À afficher en priorité :\n${top
      .map((p) => `• ${p.reference} — ${p.title} (${p.neighborhood || p.city || 'localisation à préciser'}) · ${cash(p.price, p.currency)}`)
      .join('\n')}`;
  }

  if (has('contact', 'prospect', 'client', 'lead')) {
    const byStatus = contacts.reduce<Record<string, number>>((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    }, {});
    const active = contacts.filter((c) => c.status !== 'inactive').length;
    if (!contacts.length) return 'Aucun contact enregistré dans votre carnet.';
    return `Vous avez ${contacts.length} contact(s), dont ${active} actif(s).\n${Object.entries(byStatus)
      .map(([status, count]) => `• ${status} : ${count}`)
      .join('\n')}`;
  }

  if (has('visite', 'rendez-vous', 'agenda')) {
    const upcoming = visits
      .filter((v) => !v.visited_at || new Date(v.visited_at).getTime() >= Date.now())
      .sort((a, b) => new Date(a.visited_at ?? 0).getTime() - new Date(b.visited_at ?? 0).getTime());
    if (!upcoming.length) return 'Aucune visite à venir dans votre agenda.';
    return `${upcoming.length} visite(s) à venir :\n${upcoming
      .slice(0, 5)
      .map((v) => `• ${dateTimeLabel(v.visited_at)} — ${v.status === 'scheduled' ? 'planifiée' : v.status}`)
      .join('\n')}`;
  }

  if (has('relance', 'suivi', 'rappel', 'automatisation', 'tâche', 'tache')) {
    const pending = followUps.filter((f) => f.status === 'pending');
    const overdue = pending.filter((f) => new Date(f.scheduled_at).getTime() < Date.now());
    if (!pending.length) return 'Aucune relance en attente : tout est à jour.';
    return `${pending.length} relance(s) en attente dont ${overdue.length} en retard.\nLes plus urgentes :\n${pending
      .slice(0, 5)
      .map((f) => `• ${dateTimeLabel(f.scheduled_at)} — ${f.type}${f.notes ? ` (${f.notes})` : ''}`)
      .join('\n')}`;
  }

  if (has('valeur', 'portefeuille', 'chiffre', 'montant', 'prix', 'estimation')) {
    const available = properties.filter((p) => p.status === 'available');
    const totals = available.reduce<Record<string, number>>((acc, p) => {
      acc[p.currency] = (acc[p.currency] ?? 0) + p.price;
      return acc;
    }, {});
    if (!available.length) return 'Aucun bien disponible dont additionner la valeur.';
    return `Valeur des biens disponibles :\n${Object.entries(totals)
      .map(([currency, total]) => `• ${cash(total, currency)}`)
      .join('\n')}`;
  }

  if (has('pipeline', 'opportunit', 'étape', 'etape', 'commercial')) {
    if (!pipeline.length) return 'Aucune opportunité enregistrée dans le pipeline.';
    const byStage = pipeline.reduce<Record<string, number>>((acc, item) => {
      acc[item.etape] = (acc[item.etape] ?? 0) + 1;
      return acc;
    }, {});
    return `${pipeline.length} opportunité(s) :\n${Object.entries(byStage)
      .map(([stage, count]) => `• ${stage} : ${count}`)
      .join('\n')}`;
  }

  if (has('vendu', 'vendus', 'loué', 'loues', 'signé', 'signe')) {
    const closed = properties.filter((p) => ['sold', 'rented'].includes(p.status));
    return closed.length
      ? `${closed.length} bien(s) conclu(s) :\n${closed.map((p) => `• ${p.reference} — ${p.title}`).join('\n')}`
      : 'Aucun bien vendu ou loué enregistré pour l’instant.';
  }

  return [
    'Je n’ai pas reconnu cette question, mais voici les informations que je maîtrise :',
    `• ${properties.length} bien(s) · ${contacts.length} contact(s) · ${pipeline.length} opportunité(s) · ${visits.length} visite(s) · ${followUps.length} relance(s)`,
    'Posez une question sur vos biens, contacts, visites, relances, pipeline ou la valeur de votre portefeuille.',
  ].join('\n');
}

export default function AssistantPage() {
  const { activeAgencyId, activeAgency } = useAgency();
  const propertiesQ = useProperties(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const pipelineQ = usePipeline(activeAgencyId);
  const visitsQ = useVisits(activeAgencyId);
  const followUpsQ = useFollowUps(activeAgencyId);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const loading = propertiesQ.isLoading || contactsQ.isLoading || pipelineQ.isLoading || visitsQ.isLoading || followUpsQ.isLoading;
  const error = propertiesQ.error || contactsQ.error || pipelineQ.error || visitsQ.error || followUpsQ.error;

  const insights = useMemo(() => {
    const properties = propertiesQ.data ?? [];
    const contacts = contactsQ.data ?? [];
    const pipeline = pipelineQ.data ?? [];
    const visits = visitsQ.data ?? [];
    const followUps = followUpsQ.data ?? [];
    const available = properties.filter((p) => p.status === 'available');
    const overdue = followUps.filter((f) => f.status === 'pending' && new Date(f.scheduled_at).getTime() < Date.now());
    const upcomingVisits = visits.filter((v) => !v.visited_at || new Date(v.visited_at).getTime() >= Date.now());
    const leads = contacts.filter((c) => c.status === 'lead');
    const staleContacts = contacts.filter((c) => c.status === 'lead' && Date.now() - new Date(c.created_at).getTime() > 7 * 24 * 3600 * 1000);
    return { available, overdue, upcomingVisits, leads, staleContacts, pipeline, properties };
  }, [propertiesQ.data, contactsQ.data, pipelineQ.data, visitsQ.data, followUpsQ.data]);

  const ask = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    const answer = buildAnswer(trimmed, {
      properties: propertiesQ.data,
      contacts: contactsQ.data,
      pipeline: pipelineQ.data,
      visits: visitsQ.data,
      followUps: followUpsQ.data,
    });
    const now = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: `u-${now}`, role: 'user', content: trimmed, at: now },
      { id: `a-${now}`, role: 'assistant', content: answer, at: now + 1 },
    ]);
    setDraft('');
    requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }));
  };

  return (
    <>
      <Heading
        eyebrow="Intelligence de vos données"
        title="Assistant IA"
        description="Interrogez un assistant qui calcule vos indicateurs en direct depuis Supabase — sans donnée simulée."
      />

      <div className="notice-box" role="note">
        <Sparkles size={14} />
        <span>
          Les réponses sont calculées à partir des données réelles de l’agence « {activeAgency?.name ?? '—'} ».
          Plus votre équipe alimente l’espace, plus les analyses sont précises.
        </span>
      </div>

      <section className="assistant-layout">
        <div className="panel assistant-chat" ref={listRef} data-testid="display-assistant-thread">
          {loading ? (
            <LoadingRows label="Chargement de vos données" />
          ) : error ? (
            <p className="form-error">Impossible de charger vos données pour l’analyse.</p>
          ) : messages.length ? (
            messages.map((message) => (
              <div key={message.id} className={`assistant-message is-${message.role}`} data-testid={`row-assistant-${message.role}`}>
                <div className="assistant-message-head">
                  {message.role === 'assistant' ? <Bot size={14} /> : <ContactRound size={14} />}
                  <span>{message.role === 'assistant' ? 'Sofia Assistant' : 'Vous'}</span>
                </div>
                <p style={{ whiteSpace: 'pre-line' }}>{message.content}</p>
              </div>
            ))
          ) : (
            <div className="gallery-empty">
              <Bot size={21} />
              <strong>Posez votre première question</strong>
              <span>Ex. « Combien de biens sont disponibles ? » — les réponses s’appuient uniquement sur vos données.</span>
            </div>
          )}
        </div>

        <aside className="assistant-side">
          <div className="panel assistant-suggestions">
            <h3>Questions suggérées</h3>
            <div className="chip-list">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" className="chip" onClick={() => ask(suggestion)} data-testid={`button-suggestion-${suggestion.slice(0, 12)}`}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
          <div className="panel assistant-insights">
            <h3>Signaux du moment</h3>
            <ul className="insight-list">
              <li><Home size={14} /><span><strong>{insights.available.length}</strong> bien(s) à commercialiser</span></li>
              <li><ContactRound size={14} /><span><strong>{insights.leads.length}</strong> nouveau(x) contact(s) à qualifier</span></li>
              <li><CalendarDays size={14} /><span><strong>{insights.upcomingVisits.length}</strong> visite(s) à venir</span></li>
              <li><BarChart3 size={14} /><span><strong>{insights.pipeline.length}</strong> opportunité(s) au pipeline</span></li>
              <li><TrendingUp size={14} /><span><strong>{insights.overdue.length}</strong> relance(s) en retard</span></li>
              {insights.staleContacts.length > 0 && (
                <li className="insight-warning"><Sparkles size={14} /><span><strong>{insights.staleContacts.length}</strong> contact(s) sans réponse depuis plus de 7 jours</span></li>
              )}
            </ul>
          </div>
        </aside>
      </section>

      <form
        className="assistant-composer"
        onSubmit={(e) => { e.preventDefault(); ask(draft); }}
        data-testid="form-assistant"
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Posez une question sur votre activité…"
          aria-label="Question à l’assistant"
          data-testid="input-assistant-question"
        />
        <Button type="submit" disabled={!draft.trim()} data-testid="button-assistant-send">
          <Send size={15} /> Envoyer
        </Button>
      </form>
      <p className="assistant-disclaimer">
        Dernière donnée chargée : {propertiesQ.data ? `${propertiesQ.data.length} bien(s) · mis à jour le ${dateLabel(propertiesQ.data[0]?.updated_at)}` : '—'}
      </p>
    </>
  );
}
