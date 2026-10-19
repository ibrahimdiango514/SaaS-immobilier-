import { useMemo, useState } from 'react';
import { BellRing, CheckCircle2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useAgency } from '@/lib/agency-context';
import {
  useFollowUps,
  useContacts,
  useCreateFollowUp,
  useUpdateFollowUp,
  useDeleteFollowUp,
  type FollowUpCreateInput,
} from '@/lib/data-hooks';
import type { FollowUpRow } from '@/lib/database.types';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import {
  ButtonPrimary,
  Heading,
  PageDataState,
  dateTimeLabel,
  followUpStatus,
} from '@/lib/workspace-ui';

const followUpSchema = z.object({
  contact_id: z.string().min(1, 'Choisissez un contact'),
  type: z.enum(['message', 'call', 'email', 'visit']),
  scheduled_at: z.string().min(1, 'La date de relance est obligatoire'),
  notes: z.string().optional(),
});
type FollowUpFormValues = z.infer<typeof followUpSchema>;

const typeLabels: Record<string, string> = {
  message: 'Message',
  call: 'Appel',
  email: 'E-mail',
  visit: 'Visite',
};

function toLocalInput(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function FollowUpDialog({
  open,
  onOpenChange,
  item,
  contacts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: FollowUpRow | null;
  contacts: Array<{ id: string; first_name: string; last_name: string | null }>;
}) {
  const { activeAgencyId } = useAgency();
  const create = useCreateFollowUp(activeAgencyId);
  const update = useUpdateFollowUp(activeAgencyId);
  const [formError, setFormError] = useState('');
  const form = useForm<FollowUpFormValues>({
    resolver: zodResolver(followUpSchema),
    defaultValues: {
      contact_id: item?.contact_id ?? '',
      type: (item?.type as FollowUpFormValues['type']) ?? 'message',
      scheduled_at: toLocalInput(item?.scheduled_at),
      notes: item?.notes ?? '',
    },
  });
  const busy = create.isPending || update.isPending;
  const submit = async (values: FollowUpFormValues) => {
    setFormError('');
    const input: FollowUpCreateInput = {
      contact_id: values.contact_id,
      type: values.type,
      scheduled_at: new Date(values.scheduled_at).toISOString(),
      notes: values.notes || null,
      status: 'pending',
    };
    try {
      if (item) await update.mutateAsync({ id: item.id, input: { ...input, status: item.status } });
      else await create.mutateAsync(input);
      onOpenChange(false);
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item ? 'modifier la relance' : 'créer la relance'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setFormError(''); onOpenChange(v); }}>
      <DialogContent className="form-dialog">
        <DialogHeader>
          <span className="form-kicker">Automatisations</span>
          <DialogTitle>{item ? 'Modifier la relance' : 'Nouvelle relance programmée'}</DialogTitle>
          <DialogDescription>
            Définissez une action de suivi à effectuer automatiquement à la date choisie.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="entity-form">
            <FormField control={form.control} name="contact_id" render={({ field }) => (
              <FormItem><FormLabel>Contact à relancer</FormLabel><FormControl>
                <select {...field} className="form-select" data-testid="select-followup-contact">
                  <option value="">Choisir un contact</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
                </select>
              </FormControl><FormMessage /></FormItem>
            )} />
            <div className="form-grid">
              <FormField control={form.control} name="type" render={({ field }) => (
                <FormItem><FormLabel>Type d’action</FormLabel><FormControl>
                  <select {...field} className="form-select" data-testid="select-followup-type">
                    {Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </FormControl></FormItem>
              )} />
              <FormField control={form.control} name="scheduled_at" render={({ field }) => (
                <FormItem><FormLabel>Date et heure</FormLabel><FormControl>
                  <Input type="datetime-local" {...field} data-testid="input-followup-date" />
                </FormControl><FormMessage /></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem><FormLabel>Consigne</FormLabel><FormControl>
                <Textarea {...field} placeholder="Relancer au sujet de la visite du 12…" data-testid="input-followup-notes" />
              </FormControl></FormItem>
            )} />
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
              <Button type="submit" disabled={busy} data-testid="button-submit-followup">
                {busy ? 'Enregistrement…' : item ? 'Enregistrer' : 'Programmer la relance'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function AutomationsPage() {
  const { activeAgencyId } = useAgency();
  const followUpsQ = useFollowUps(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const create = useCreateFollowUp(activeAgencyId);
  const update = useUpdateFollowUp(activeAgencyId);
  const remove = useDeleteFollowUp(activeAgencyId);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<FollowUpRow | null>(null);
  const [pageError, setPageError] = useState('');

  const contacts = contactsQ.data ?? [];
  const rows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('fr');
    return (followUpsQ.data ?? []).filter((item) => {
      const contact = contacts.find((c) => c.id === item.contact_id);
      const haystack = `${contact?.first_name ?? ''} ${contact?.last_name ?? ''} ${item.notes ?? ''} ${item.type}`;
      return (!term || haystack.toLocaleLowerCase('fr').includes(term)) && (status === 'all' || item.status === status);
    });
  }, [followUpsQ.data, contacts, search, status]);

  const loading = followUpsQ.isLoading || contactsQ.isLoading;
  const error = followUpsQ.error || contactsQ.error;
  const pendingCount = (followUpsQ.data ?? []).filter((f) => f.status === 'pending').length;
  const overdueCount = (followUpsQ.data ?? []).filter(
    (f) => f.status === 'pending' && new Date(f.scheduled_at).getTime() < Date.now(),
  ).length;

  const complete = async (item: FollowUpRow) => {
    setPageError('');
    try {
      await update.mutateAsync({ id: item.id, input: { status: 'completed', completed_at: new Date().toISOString() } });
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'marquer la relance comme terminée'));
    }
  };

  const doDelete = async (item: FollowUpRow) => {
    if (!window.confirm('Supprimer cette relance ?')) return;
    try {
      await remove.mutateAsync(item.id);
    } catch (err) {
      setPageError(getSupabaseErrorMessage(err, 'supprimer la relance'));
    }
  };

  return (
    <>
      <Heading
        eyebrow="Suivi automatique"
        title="Automatisations"
        description="Programmez des relances (message, appel, e-mail, visite) et suivez leur exécution."
        action={
          <ButtonPrimary testId="button-add-followup" disabled={!contacts.length} onClick={() => { setEditing(null); setOpen(true); }}>
            <Plus size={15} /> Nouvelle relance
          </ButtonPrimary>
        }
      />

      <section className="status-banner" data-testid="status-automation-summary">
        <div className="status-banner-icon"><RefreshCw size={15} /></div>
        <div>
          <strong>{pendingCount} relance(s) en attente · {overdueCount} en retard</strong>
          <p>Chaque relance est enregistrée dans Supabase et visible par toute l’équipe de l’agence.</p>
        </div>
        <span className="status-tag">{followUpStatus.pending}</span>
      </section>

      {pageError && <p className="form-error module-error" role="alert">{pageError}</p>}

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Contact ou consigne" aria-label="Rechercher une relance" data-testid="input-search-followups" />
        </label>
        <select className="form-select compact-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-followup-status">
          <option value="all">Tous les statuts</option>
          {Object.entries(followUpStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="result-count">{rows.length} relance(s)</span>
      </section>

      {loading || error || !followUpsQ.data?.length ? (
        <PageDataState
          loading={loading}
          error={error}
          retry={() => { void followUpsQ.refetch(); void contactsQ.refetch(); }}
          count={followUpsQ.data?.length ?? 0}
          emptyTitle="Aucune automatisation configurée"
          emptyText={contacts.length ? 'Créez votre première relance pour ne plus rien oublier.' : 'Ajoutez d’abord un contact pour programmer une relance.'}
          testId="empty-followups"
          emptyIcon={<BellRing size={19} />}
        />
      ) : rows.length ? (
        <div className="followup-list">
          {rows.map((item) => {
            const contact = contacts.find((c) => c.id === item.contact_id);
            const isOverdue = item.status === 'pending' && new Date(item.scheduled_at).getTime() < Date.now();
            return (
              <article className={`followup-card${item.status === 'completed' ? ' is-done' : ''}`} key={item.id} data-testid={`card-followup-${item.id}`}>
                <div className="followup-icon"><BellRing size={16} /></div>
                <div className="followup-body">
                  <div className="followup-title">
                    <strong>{contact ? `${contact.first_name} ${contact.last_name ?? ''}` : 'Contact inaccessible'}</strong>
                    <span className={`status-pill status-${item.status === 'completed' ? 'available' : isOverdue ? 'unavailable' : 'reserved'}`}>
                      {followUpStatus[item.status] ?? item.status}
                    </span>
                  </div>
                  <p>{typeLabels[item.type] ?? item.type} · prévue le {dateTimeLabel(item.scheduled_at)}</p>
                  {item.notes && <small>{item.notes}</small>}
                </div>
                <div className="followup-actions">
                  {item.status === 'pending' && (
                    <button className="row-action" onClick={() => void complete(item)} disabled={update.isPending} data-testid={`button-complete-followup-${item.id}`}>
                      <CheckCircle2 size={14} /> <span>Terminer</span>
                    </button>
                  )}
                  <button className="row-action" onClick={() => { setEditing(item); setOpen(true); }} data-testid={`button-edit-followup-${item.id}`}>
                    <Pencil size={14} /> <span>Modifier</span>
                  </button>
                  <button className="row-action danger" onClick={() => void doDelete(item)} disabled={remove.isPending} data-testid={`button-delete-followup-${item.id}`}>
                    <Trash2 size={14} /> <span>Supprimer</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-filtered-followups">
          <div className="state-icon"><Search size={19} /></div>
          <h2>Aucune relance correspondante</h2>
          <p>Modifiez les filtres pour retrouver un élément.</p>
          <Button variant="outline" onClick={() => { setSearch(''); setStatus('all'); }}>Effacer les filtres</Button>
        </div>
      )}

      <FollowUpDialog key={editing?.id ?? 'new-followup'} open={open} onOpenChange={setOpen} item={editing} contacts={contacts} />
    </>
  );
}
