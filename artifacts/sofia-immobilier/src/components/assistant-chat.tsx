// =============================================================================
// BLOC 8 — DISCUSSION AVEC L'ASSISTANT IA
// =============================================================================
// Composant partagé entre la page « Assistant IA » et le bouton flottant.
// L'assistant est en LECTURE SEULE : aucune action n'est déclenchée depuis ce
// composant, il n'envoie que la question et l'historique.
// =============================================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Lock, Send, Sparkles, User, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  askAssistant, assistantErrorLabel, ASSISTANT_SUGGESTIONS, type AssistantMessage,
} from '@/lib/assistant-api';

const MAX_LENGTH = 1200;

export function AssistantChat({
  isManager = false,
  compact = false,
  extraSuggestions = [],
  greeting,
  testId = 'assistant',
}: {
  /** Un agent ne reçoit ni CA ni paiements : on n'affiche pas ces suggestions. */
  isManager?: boolean;
  /** Variante réduite pour le panneau flottant. */
  compact?: boolean;
  extraSuggestions?: string[];
  greeting?: string;
  testId?: string;
}) {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const suggestions = useMemo(() => {
    const base = [...ASSISTANT_SUGGESTIONS];
    if (isManager) base.push('Quel est mon chiffre d’affaires du mois ?', 'Où en est mon abonnement ?');
    return [...base, ...extraSuggestions];
  }, [isManager, extraSuggestions]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  const send = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    if (trimmed.length > MAX_LENGTH) {
      setError(`Message trop long : ${MAX_LENGTH} caractères maximum.`);
      return;
    }
    setError('');
    const userMessage: AssistantMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      at: Date.now(),
    };
    setMessages((previous) => [...previous, userMessage]);
    setDraft('');
    setBusy(true);
    try {
      const history = messages
        .filter((item) => !item.pending && !item.error)
        .slice(-8)
        .map((item) => ({ role: item.role, content: item.content }));
      const reply = await askAssistant({ message: trimmed, history });
      setMessages((previous) => [
        ...previous,
        {
          id: reply.message_id ?? crypto.randomUUID(),
          role: 'assistant',
          content: reply.reply,
          at: Date.now(),
          tools: reply.tools,
          tokens: reply.usage?.total_tokens,
        },
      ]);
    } catch (caught) {
      const label = assistantErrorLabel(caught);
      setError(label);
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: 'assistant', content: label, at: Date.now(), error: true },
      ]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className={`assistant-chat${compact ? ' is-compact' : ''}`} data-testid={`chat-${testId}`}>
      <div className="assistant-thread" ref={listRef} data-testid={`thread-${testId}`}>
        {messages.length === 0 && (
          <div className="assistant-welcome">
            <span className="assistant-welcome-mark"><Sparkles size={20} /></span>
            <strong>Bonjour, je suis Sofia.</strong>
            <p>
              {greeting ??
                'Posez-moi une question sur vos biens, vos contacts, votre pipeline ou vos visites. Je réponds en français avec les chiffres exacts de votre agence.'}
            </p>
            <div className="assistant-suggestions">
              {suggestions.slice(0, compact ? 3 : 6).map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  className="suggestion-chip"
                  onClick={() => void send(suggestion)}
                  data-testid={`button-suggestion-${suggestion.slice(0, 12).replace(/\s+/g, '-')}`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div
            className={`assistant-bubble is-${message.role}${message.error ? ' is-error' : ''}`}
            key={message.id}
            data-testid={`bubble-${message.role}-${message.id}`}
          >
            <span className="assistant-avatar" aria-hidden="true">
              {message.role === 'assistant' ? <Bot size={14} /> : <User size={14} />}
            </span>
            <div className="assistant-bubble-body">
              <p>{message.content}</p>
              {message.tools?.length ? (
                <small className="assistant-tools" title="Outils en lecture seule qui ont produit ces chiffres">
                  <Wrench size={10} /> {message.tools.join(' · ')}
                  {typeof message.tokens === 'number' && message.tokens > 0 && ` · ${message.tokens} tokens`}
                </small>
              ) : null}
            </div>
          </div>
        ))}

        {busy && (
          <div className="assistant-bubble is-assistant is-pending" data-testid={`status-${testId}-pending`}>
            <span className="assistant-avatar" aria-hidden="true"><Bot size={14} /></span>
            <div className="assistant-bubble-body">
              <p className="typing"><span /><span /><span /></p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="form-error assistant-error" role="alert" data-testid={`status-${testId}-error`}>
          {error}
        </p>
      )}

      <form
        className="assistant-composer"
        onSubmit={(event) => { event.preventDefault(); void send(draft); }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={compact ? 1 : 2}
          maxLength={MAX_LENGTH}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
          placeholder="Écrivez votre question… (Entrée pour envoyer, Maj + Entrée pour un saut de ligne)"
          aria-label="Question pour l’assistant IA"
          data-testid={`input-${testId}-message`}
        />
        <div className="assistant-composer-foot">
          <span className="assistant-counter" data-testid={`text-${testId}-length`}>
            {draft.length}/{MAX_LENGTH}
          </span>
          <Button type="submit" disabled={busy || !draft.trim()} data-testid={`button-${testId}-send`}>
            <Send size={15} /> {busy ? 'Réflexion…' : 'Envoyer'}
          </Button>
        </div>
      </form>

      <p className="assistant-readonly" role="note" data-testid={`note-${testId}-readonly`}>
        <Lock size={12} />
        Assistant en lecture seule : il consulte vos données et répond, il ne modifie rien.
        Les textes de vos fiches sont traités comme des données, jamais comme des consignes.
      </p>
    </div>
  );
}
