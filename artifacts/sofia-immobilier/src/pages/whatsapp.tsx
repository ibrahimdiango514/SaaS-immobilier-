import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCheck,
  MessageCircle,
  Phone,
  Plus,
  Search,
  Send,
  Trash2,
  Link2,
  Pencil,
  X,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAgency } from '@/lib/agency-context';
import { useAuth } from '@/lib/auth-context';
import {
  useConversations,
  useContacts,
  useCreateConversation,
  useUpdateConversation,
  useDeleteConversation,
  useConversationMessages,
  useSendMessage,
  useWhatsAppConnections,
  useCreateWhatsAppConnection,
  useUpdateWhatsAppConnection,
  useDeleteWhatsAppConnection,
} from '@/lib/data-hooks';
import type { ConversationRow, WhatsAppConnectionRow } from '@/lib/database.types';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import {
  ButtonPrimary,
  Heading,
  LoadingRows,
  dateTimeLabel,
} from '@/lib/workspace-ui';

const newConversationSchema = z.object({ contact_id: z.string().min(1, 'Choisissez un contact') });
type NewConversationValues = z.infer<typeof newConversationSchema>;

const connectionSchema = z.object({
  connection_name: z.string().trim().min(1, 'Le nom est obligatoire'),
  provider: z.string().trim().min(1, 'Le fournisseur est obligatoire'),
  phone_number: z.string().optional(),
});
type ConnectionFormValues = z.infer<typeof connectionSchema>;

const connectionStatus: Record<string, string> = {
  connected: 'Connectée',
  disconnected: 'Déconnectée',
  error: 'En erreur',
};

function ConnectionDialog({
  open,
  onOpenChange,
  item,
  agencyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: WhatsAppConnectionRow | null;
  agencyId?: string;
}) {
  const create = useCreateWhatsAppConnection(agencyId);
  const update = useUpdateWhatsAppConnection(agencyId);
  const [formError, setFormError] = useState('');
  const form = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionSchema),
    defaultValues: {
      connection_name: item?.connection_name ?? '',
      provider: item?.provider ?? 'whatsapp-business',
      phone_number: item?.phone_number ?? '',
    },
  });
  const busy = create.isPending || update.isPending;
  const submit = async (values: ConnectionFormValues) => {
    setFormError('');
    try {
      if (item) {
        await update.mutateAsync({ id: item.id, input: { ...values, phone_number: values.phone_number || null } });
      } else {
        await create.mutateAsync({ ...values, phone_number: values.phone_number || null, status: 'disconnected' });
      }
      onOpenChange(false);
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item ? 'modifier la connexion' : 'créer la connexion'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setFormError(''); onOpenChange(v); }}>
      <DialogContent className="form-dialog">
        <DialogHeader>
          <span className="form-kicker">Passerelle WhatsApp</span>
          <DialogTitle>{item ? 'Modifier la connexion' : 'Nouvelle connexion'}</DialogTitle>
          <DialogDescription>
            Enregistrez les informations de la ligne WhatsApp Business de l’agence.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="entity-form">
            <FormField control={form.control} name="connection_name" render={({ field }) => (
              <FormItem><FormLabel>Nom de la connexion</FormLabel><FormControl>
                <Input {...field} placeholder="Ligne agence principale" data-testid="input-connection-name" />
              </FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="provider" render={({ field }) => (
              <FormItem><FormLabel>Fournisseur</FormLabel><FormControl>
                <select {...field} className="form-select" data-testid="select-connection-provider">
                  <option value="whatsapp-business">WhatsApp Business (Meta)</option>
                  <option value="whatsapp-web">WhatsApp Web (instance)</option>
                  <option value="other">Autre passerelle</option>
                </select>
              </FormControl></FormItem>
            )} />
            <FormField control={form.control} name="phone_number" render={({ field }) => (
              <FormItem><FormLabel>Numéro de téléphone</FormLabel><FormControl>
                <Input {...field} placeholder="+223 70 00 00 00" data-testid="input-connection-phone" />
              </FormControl><FormMessage /></FormItem>
            )} />
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
              <Button type="submit" disabled={busy} data-testid="button-submit-connection">
                {busy ? 'Enregistrement…' : item ? 'Enregistrer' : 'Créer la connexion'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function WhatsAppPage() {
  const { activeAgencyId } = useAgency();
  const { user } = useAuth();
  const conversationsQ = useConversations(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const connectionsQ = useWhatsAppConnections(activeAgencyId);
  const createConversation = useCreateConversation(activeAgencyId);
  const updateConversation = useUpdateConversation(activeAgencyId);
  const deleteConversation = useDeleteConversation(activeAgencyId);
  const updateConnection = useUpdateWhatsAppConnection(activeAgencyId);
  const deleteConnection = useDeleteWhatsAppConnection(activeAgencyId);

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'threads' | 'connections'>('threads');
  const [newOpen, setNewOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<WhatsAppConnectionRow | null>(null);
  const [pageError, setPageError] = useState('');

  const conversations = conversationsQ.data ?? [];
  const contacts = contactsQ.data ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('fr');
    return conversations.filter((conversation) => {
      const contact = contacts.find((c) => c.id === conversation.contact_id);
      const haystack = `${contact?.first_name ?? ''} ${contact?.last_name ?? ''} ${contact?.phone ?? ''} ${conversation.status} ${conversation.mode}`;
      return !term || haystack.toLocaleLowerCase('fr').includes(term);
    });
  }, [conversations, contacts, search]);

  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && filtered.length) setSelectedId(filtered[0].id);
  }, [filtered, selectedId]);

  const messagesQ = useConversationMessages(activeAgencyId, selectedId ?? undefined);
  const sendMessage = useSendMessage(activeAgencyId);
  const [draft, setDraft] = useState('');
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messagesQ.data?.length, selectedId]);

  const loading = conversationsQ.isLoading || contactsQ.isLoading;
  const error = conversationsQ.error || contactsQ.error;

  const submitNew = async (values: NewConversationValues) => {
    setPageError('');
    try {
      const conversation = await createConversation.mutateAsync({
        contact_id: values.contact_id,
        status: 'open',
        mode: 'agent',
        assigned_user_id: user?.id ?? null,
      });
      setNewOpen(false);
      setSelectedId(conversation.id);
      setTab('threads');
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'créer la conversation'));
    }
  };

  const [newContactOpen, setNewContactOpen] = useState(false);

  const doSend = async () => {
    if (!draft.trim() || !selectedId) return;
    const content = draft.trim();
    setDraft('');
    setPageError('');
    try {
      await sendMessage.mutateAsync({
        conversation_id: selectedId,
        content,
        sender_type: 'agent',
        sender_user_id: user?.id ?? null,
      });
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'envoyer le message'));
    }
  };

  const toggleStatus = async (conversation: ConversationRow) => {
    setPageError('');
    try {
      await updateConversation.mutateAsync({
        id: conversation.id,
        input: { status: conversation.status === 'open' ? 'closed' : 'open' },
      });
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'changer le statut de la conversation'));
    }
  };

  const doDeleteConversation = async (conversation: ConversationRow) => {
    if (!window.confirm('Supprimer cette conversation et tous ses messages ?')) return;
    try {
      await deleteConversation.mutateAsync(conversation.id);
      if (selectedId === conversation.id) setSelectedId(null);
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'supprimer la conversation'));
    }
  };

  return (
    <>
      <Heading
        eyebrow="Messaging"
        title="WhatsApp"
        description="Retrouvez vos échanges clients, ouvrez des conversations et gérez la ligne WhatsApp de l’agence."
        action={
          <div className="heading-actions">
            <div className="view-switch" role="tablist" aria-label="Sections WhatsApp">
              <button type="button" className={tab === 'threads' ? 'selected' : ''} onClick={() => setTab('threads')} data-testid="tab-whatsapp-threads">Conversations</button>
              <button type="button" className={tab === 'connections' ? 'selected' : ''} onClick={() => setTab('connections')} data-testid="tab-whatsapp-connections">Connexions</button>
            </div>
            <ButtonPrimary testId="button-new-conversation" disabled={!contacts.length} onClick={() => setNewOpen(true)}>
              <Plus size={15} /> Nouvelle conversation
            </ButtonPrimary>
          </div>
        }
      />

      <div className="notice-box" role="note" data-testid="status-whatsapp-notice">
        <MessageCircle size={14} />
        <span>
          Les conversations et leurs messages sont enregistrés en temps réel dans Supabase et restent
          privés à votre agence. L’envoi vers WhatsApp nécessite une passerelle WhatsApp Business (Meta)
          configurée sur la ligne de l’agence.
        </span>
      </div>

      {pageError && <p className="form-error module-error" role="alert" data-testid="status-whatsapp-error">{pageError}</p>}

      {loading ? (
        <LoadingRows label="Chargement des conversations" />
      ) : error ? (
        <div className="state-card error-state" role="alert">
          <h2>Impossible de charger les conversations</h2>
          <Button variant="outline" onClick={() => { void conversationsQ.refetch(); void contactsQ.refetch(); }}>Réessayer</Button>
        </div>
      ) : tab === 'threads' ? (
        !contacts.length ? (
          <div className="state-card compact-empty">
            <div className="state-icon"><MessageCircle size={19} /></div>
            <h2>Aucun contact pour ouvrir une conversation</h2>
            <p>Ajoutez d’abord un contact dans le module « Prospects et contacts ».</p>
          </div>
        ) : (
          <div className="whatsapp-layout">
            <section className="panel whatsapp-list" aria-label="Liste des conversations">
              <div className="whatsapp-search">
                <Search size={14} />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un contact" aria-label="Rechercher une conversation" data-testid="input-search-conversations" />
              </div>
              {filtered.length ? (
                <div className="whatsapp-items">
                  {filtered.map((conversation) => {
                    const contact = contacts.find((c) => c.id === conversation.contact_id);
                    return (
                      <button
                        key={conversation.id}
                        type="button"
                        className={`whatsapp-item${selectedId === conversation.id ? ' is-active' : ''}`}
                        onClick={() => setSelectedId(conversation.id)}
                        data-testid={`row-conversation-${conversation.id}`}
                      >
                        <span className="contact-avatar">{`${contact?.first_name?.[0] ?? '?'}${contact?.last_name?.[0] ?? ''}`.toUpperCase()}</span>
                        <span className="whatsapp-item-copy">
                          <strong>{contact ? `${contact.first_name} ${contact.last_name ?? ''}` : 'Contact'}</strong>
                          <small>{contact?.phone || contact?.email || 'Coordonnées non renseignées'}</small>
                        </span>
                        <span className={`status-pill status-${conversation.status === 'open' ? 'available' : 'archived'}`}>
                          {conversation.status === 'open' ? 'Ouverte' : 'Fermée'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-table"><strong>Aucune conversation</strong><p>Ouvrez une conversation avec un contact pour démarrer.</p></div>
              )}
            </section>

            <section className="panel whatsapp-thread" aria-label="Fil de discussion">
              {selected ? (
                <>
                  <div className="whatsapp-thread-head">
                    <div>
                      <strong>{(() => { const c = contacts.find((x) => x.id === selected.contact_id); return c ? `${c.first_name} ${c.last_name ?? ''}` : 'Contact'; })()}</strong>
                      <small>{(() => { const c = contacts.find((x) => x.id === selected.contact_id); return c?.whatsapp_number || c?.phone || '—'; })()}</small>
                    </div>
                    <div className="whatsapp-thread-actions">
                      <Button variant="outline" size="sm" onClick={() => void toggleStatus(selected)} data-testid="button-toggle-conversation">
                        {selected.status === 'open' ? 'Fermer' : 'Rouvrir'}
                      </Button>
                      <button type="button" className="icon-button" onClick={() => void doDeleteConversation(selected)} aria-label="Supprimer la conversation" data-testid="button-delete-conversation">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="whatsapp-messages" data-testid="display-conversation-messages">
                    {messagesQ.isLoading ? (
                      <LoadingRows label="Chargement des messages" />
                    ) : messagesQ.error ? (
                      <p className="form-error">{getSupabaseErrorMessage(messagesQ.error, 'charger les messages')}</p>
                    ) : messagesQ.data?.length ? (
                      messagesQ.data.map((message) => (
                        <div key={message.id} className={`whatsapp-message is-${message.sender_type === 'agent' ? 'out' : 'in'}`} data-testid={`row-message-${message.id}`}>
                          <p>{message.content}</p>
                          <span>
                            {message.sender_type === 'agent' ? 'Agence' : message.sender_type === 'sofia' ? 'Sofia' : 'Client'} · {dateTimeLabel(message.created_at)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="gallery-empty">
                        <MessageCircle size={21} />
                        <strong>Aucun message</strong>
                        <span>Démarrez l’échange ci-dessous.</span>
                      </div>
                    )}
                    <div ref={threadEndRef} />
                  </div>
                  <div className="whatsapp-composer">
                    <Input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void doSend(); }}
                      placeholder="Écrire un message…"
                      aria-label="Contenu du message"
                      data-testid="input-message-draft"
                      disabled={selected.status !== 'open' || sendMessage.isPending}
                    />
                    <Button onClick={() => void doSend()} disabled={!draft.trim() || sendMessage.isPending || selected.status !== 'open'} data-testid="button-send-message">
                      {sendMessage.isPending ? <CheckCheck size={15} /> : <Send size={15} />} Envoyer
                    </Button>
                  </div>
                </>
              ) : (
                <div className="gallery-empty">
                  <MessageCircle size={21} />
                  <strong>Sélectionnez une conversation</strong>
                  <span>Le fil de discussion s’affichera ici.</span>
                </div>
              )}
            </section>
          </div>
        )
      ) : (
        <section className="panel list-panel" aria-label="Connexions WhatsApp">
          <div className="panel-head">
            <div>
              <h2>Lignes WhatsApp de l’agence</h2>
              <p>{connectionsQ.data?.length ?? 0} connexion(s) enregistrée(s)</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => { setEditingConnection(null); setConnectionDialogOpen(true); }} data-testid="button-add-connection">
              <Plus size={14} /> Ajouter une ligne
            </Button>
          </div>
          {connectionsQ.isLoading ? (
            <LoadingRows label="Chargement des connexions" />
          ) : connectionsQ.error ? (
            <p className="form-error">{getSupabaseErrorMessage(connectionsQ.error, 'charger les connexions')}</p>
          ) : connectionsQ.data?.length ? (
            <div className="table-wrap">
              <table className="data-table full-table">
                <thead>
                  <tr><th>Nom</th><th>Fournisseur</th><th>Numéro</th><th>Statut</th><th>Dernière connexion</th><th><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody>
                  {connectionsQ.data.map((connection) => (
                    <tr key={connection.id} data-testid={`row-connection-${connection.id}`}>
                      <td><strong>{connection.connection_name}</strong></td>
                      <td>{connection.provider}</td>
                      <td>{connection.phone_number || '—'}</td>
                      <td>
                        <span className={`status-pill status-${connection.status === 'connected' ? 'available' : connection.status === 'error' ? 'unavailable' : 'archived'}`}>
                          {connectionStatus[connection.status] ?? connection.status}
                        </span>
                      </td>
                      <td>{dateTimeLabel(connection.last_connected_at)}</td>
                      <td className="row-actions-cell">
                        <button className="row-action" onClick={() => {
                          updateConnection.mutate(
                            { id: connection.id, input: { status: connection.status === 'connected' ? 'disconnected' : 'connected' } },
                            { onError: (err) => setPageError(getSupabaseErrorMessage(err, 'changer le statut de la connexion')) },
                          );
                        }} disabled={updateConnection.isPending} data-testid={`button-toggle-connection-${connection.id}`}>
                          <Link2 size={14} /> <span>{connection.status === 'connected' ? 'Déconnecter' : 'Connecter'}</span>
                        </button>
                        <button className="row-action" onClick={() => { setEditingConnection(connection); setConnectionDialogOpen(true); }} aria-label="Modifier">
                          <Pencil size={14} /> <span>Modifier</span>
                        </button>
                        <button className="row-action danger" onClick={() => {
                          if (!window.confirm('Supprimer cette connexion ?')) return;
                          deleteConnection.mutate(connection.id, {
                            onError: (err) => setPageError(getSupabaseErrorMessage(err, 'supprimer la connexion')),
                          });
                        }} disabled={deleteConnection.isPending} aria-label="Supprimer" data-testid={`button-delete-connection-${connection.id}`}>
                          <Trash2 size={14} /> <span>Supprimer</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-table" data-testid="empty-connections">
              <div className="empty-table-mark"><Phone size={17} /></div>
              <strong>Aucune ligne WhatsApp</strong>
              <p>Ajoutez la ligne professionnelle de votre agence pour centraliser les échanges.</p>
            </div>
          )}
        </section>
      )}

      {newOpen && (
        <Dialog open={newOpen} onOpenChange={setNewOpen}>
          <DialogContent className="form-dialog">
            <DialogHeader>
              <span className="form-kicker">Conversations</span>
              <DialogTitle>Nouvelle conversation</DialogTitle>
              <DialogDescription>Choisissez le contact avec qui ouvrir un fil de discussion.</DialogDescription>
            </DialogHeader>
            <NewConversationForm contacts={contacts} pending={createConversation.isPending} onSubmit={submitNew} onCancel={() => setNewOpen(false)} error={pageError} />
          </DialogContent>
        </Dialog>
      )}

      <ConnectionDialog
        key={editingConnection?.id ?? 'new-connection'}
        open={connectionDialogOpen}
        onOpenChange={setConnectionDialogOpen}
        item={editingConnection}
        agencyId={activeAgencyId}
      />
    </>
  );
}

function NewConversationForm({
  contacts,
  pending,
  onSubmit,
  onCancel,
  error,
}: {
  contacts: Array<{ id: string; first_name: string; last_name: string | null }>;
  pending: boolean;
  onSubmit: (values: NewConversationValues) => Promise<void>;
  onCancel: () => void;
  error: string;
}) {
  const form = useForm<NewConversationValues>({ resolver: zodResolver(newConversationSchema), defaultValues: { contact_id: '' } });
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="entity-form">
        <FormField control={form.control} name="contact_id" render={({ field }) => (
          <FormItem><FormLabel>Contact</FormLabel><FormControl>
            <select {...field} className="form-select" data-testid="select-conversation-contact">
              <option value="">Choisir un contact</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
            </select>
          </FormControl><FormMessage /></FormItem>
        )} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <Button type="button" variant="outline" onClick={onCancel}>Annuler</Button>
          <Button type="submit" disabled={pending} data-testid="button-submit-conversation">{pending ? 'Création…' : 'Ouvrir la conversation'}</Button>
        </div>
      </form>
    </Form>
  );
}
