import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  MapPin,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
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
  useVisits,
  useContacts,
  useProperties,
  useCreateVisit,
  useUpdateVisit,
  useDeleteVisit,
  type VisitCreateInput,
} from '@/lib/data-hooks';
import type { PropertyVisitRow } from '@/lib/database.types';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { useAgency as useAgencyContext } from '@/lib/agency-context';
import { useAuth as useAuthContext } from '@/lib/auth-context';
import {
  ButtonPrimary,
  ErrorState,
  Heading,
  LoadingRows,
  PageDataState,
  dateTimeLabel,
  dateLabel,
  useSafeRetry,
  visitStatus,
} from '@/lib/workspace-ui';

const visitSchema = z.object({
  contact_id: z.string().min(1, 'Choisissez un contact'),
  property_id: z.string().min(1, 'Choisissez un bien'),
  visit_date: z.string().min(1, 'La date de visite est obligatoire'),
  status: z.enum(['scheduled', 'done', 'cancelled', 'no_show']),
  visit_type: z.string().trim().min(1, 'Le type est obligatoire'),
  notes: z.string().optional(),
  feedback: z.string().optional(),
});
type VisitFormValues = z.infer<typeof visitSchema>;

function toLocalInput(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function VisitDialog({
  open,
  onOpenChange,
  item,
  contacts,
  properties,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: PropertyVisitRow | null;
  contacts: Array<{ id: string; first_name: string; last_name: string | null }>;
  properties: Array<{ id: string; reference: string; title: string }>;
}) {
  const { activeAgencyId, user } = useAgencyUser();
  const create = useCreateVisit(activeAgencyId);
  const update = useUpdateVisit(activeAgencyId);
  const [formError, setFormError] = useState('');
  const form = useForm<VisitFormValues>({
    resolver: zodResolver(visitSchema),
    defaultValues: {
      contact_id: item?.contact_id ?? '',
      property_id: item?.property_id ?? '',
      visit_date: toLocalInput(item?.visited_at) ?? '',
      status: (item?.status as VisitFormValues['status']) ?? 'scheduled',
      visit_type: item?.visit_type ?? 'visit',
      notes: item?.notes ?? '',
      feedback: item?.feedback ?? '',
    },
  });
  const busy = create.isPending || update.isPending;
  const submit = async (values: VisitFormValues) => {
    setFormError('');
    const input: VisitCreateInput = {
      contact_id: values.contact_id,
      property_id: values.property_id,
      visited_at: new Date(values.visit_date).toISOString(),
      status: values.status,
      visit_type: values.visit_type,
      notes: values.notes || null,
      feedback: values.feedback || null,
      agent_user_id: user?.id ?? null,
    };
    try {
      if (item) await update.mutateAsync({ id: item.id, input });
      else await create.mutateAsync(input);
      onOpenChange(false);
    } catch (error) {
      setFormError(getSupabaseErrorMessage(error, item ? 'modifier la visite' : 'planifier la visite'));
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setFormError(''); onOpenChange(v); }}>
      <DialogContent className="form-dialog">
        <DialogHeader>
          <span className="form-kicker">Visites immobilières</span>
          <DialogTitle>{item ? 'Modifier la visite' : 'Planifier une visite'}</DialogTitle>
          <DialogDescription>
            Associez un contact à un bien et fixez la date du rendez-vous.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} className="entity-form">
            <FormField control={form.control} name="contact_id" render={({ field }) => (
              <FormItem><FormLabel>Contact</FormLabel><FormControl>
                <select {...field} className="form-select" data-testid="select-visit-contact">
                  <option value="">Choisir un contact</option>
                  {contacts.map((c) => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
                </select>
              </FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="property_id" render={({ field }) => (
              <FormItem><FormLabel>Bien concerné</FormLabel><FormControl>
                <select {...field} className="form-select" data-testid="select-visit-property">
                  <option value="">Choisir un bien</option>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.reference} · {p.title}</option>)}
                </select>
              </FormControl><FormMessage /></FormItem>
            )} />
            <div className="form-grid">
              <FormField control={form.control} name="visit_date" render={({ field }) => (
                <FormItem><FormLabel>Date et heure</FormLabel><FormControl>
                  <Input type="datetime-local" {...field} data-testid="input-visit-date" />
                </FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Statut</FormLabel><FormControl>
                  <select {...field} className="form-select" data-testid="select-visit-status">
                    {Object.entries(visitStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </FormControl></FormItem>
              )} />
            </div>
            <FormField control={form.control} name="visit_type" render={({ field }) => (
              <FormItem><FormLabel>Type de rendez-vous</FormLabel><FormControl>
                <select {...field} className="form-select" data-testid="select-visit-type">
                  <option value="visit">Visite du bien</option>
                  <option value="inspection">Inspection</option>
                  <option value="keys">Remise des clés</option>
                  <option value="estimate">Estimation sur place</option>
                </select>
              </FormControl></FormItem>
            )} />
            <FormField control={form.control} name="notes" render={({ field }) => (
              <FormItem><FormLabel>Notes</FormLabel><FormControl>
                <Textarea {...field} placeholder="Consignes, point de rendez-vous…" data-testid="input-visit-notes" />
              </FormControl></FormItem>
            )} />
            <FormField control={form.control} name="feedback" render={({ field }) => (
              <FormItem><FormLabel>Retour du client</FormLabel><FormControl>
                <Textarea {...field} placeholder="Réactions après la visite…" data-testid="input-visit-feedback" />
              </FormControl></FormItem>
            )} />
            {formError && <p className="form-error" role="alert" data-testid="status-visit-form-error">{formError}</p>}
            <div className="form-actions">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Annuler</Button>
              <Button type="submit" disabled={busy} data-testid="button-submit-visit">
                {busy ? 'Enregistrement…' : item ? 'Enregistrer les modifications' : 'Planifier la visite'}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function useAgencyUser() {
  // Small adapter: the visits page only needs the active agency + current user.
  const { activeAgencyId } = useAgencyContext();
  const { user } = useAuthContext();
  return { activeAgencyId, user };
}

export default function VisitsPage() {
  const { activeAgencyId, activeAgency } = useAgencyContext();
  const visitsQ = useVisits(activeAgencyId);
  const contactsQ = useContacts(activeAgencyId);
  const propertiesQ = useProperties(activeAgencyId);
  const remove = useDeleteVisit(activeAgencyId);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PropertyVisitRow | null>(null);

  const contacts = contactsQ.data ?? [];
  const properties = propertiesQ.data ?? [];

  const rows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('fr');
    return (visitsQ.data ?? []).filter((visit) => {
      const contact = contacts.find((c) => c.id === visit.contact_id);
      const property = properties.find((p) => p.id === visit.property_id);
      const matches =
        !term ||
        `${contact?.first_name ?? ''} ${contact?.last_name ?? ''} ${property?.title ?? ''} ${property?.reference ?? ''} ${visit.notes ?? ''}`
          .toLocaleLowerCase('fr')
          .includes(term);
      return matches && (status === 'all' || visit.status === status);
    });
  }, [visitsQ.data, contacts, properties, search, status]);

  const loading = visitsQ.isLoading || contactsQ.isLoading || propertiesQ.isLoading;
  const error = visitsQ.error || contactsQ.error || propertiesQ.error;
  const retry = () => {
    void visitsQ.refetch();
    void contactsQ.refetch();
    void propertiesQ.refetch();
  };

  const upcoming = rows.filter((v) => !v.visited_at || new Date(v.visited_at).getTime() >= Date.now());
  const past = rows.filter((v) => v.visited_at && new Date(v.visited_at).getTime() < Date.now());

  const doDelete = async (visit: PropertyVisitRow) => {
    if (!window.confirm('Supprimer définitivement cette visite ?')) return;
    try {
      await remove.mutateAsync(visit.id);
    } catch (error) {
      window.alert(getSupabaseErrorMessage(error, 'supprimer la visite'));
    }
  };

  const renderRow = (visit: PropertyVisitRow) => {
    const contact = contacts.find((c) => c.id === visit.contact_id);
    const property = properties.find((p) => p.id === visit.property_id);
    return (
      <tr key={visit.id} data-testid={`row-visit-${visit.id}`}>
        <td>
          <Link href={`/contacts/${visit.contact_id}`} className="table-primary-link">
            <strong>{contact ? `${contact.first_name} ${contact.last_name ?? ''}` : 'Contact inaccessible'}</strong>
          </Link>
        </td>
        <td>
          <Link href={`/biens/${visit.property_id}`} className="table-primary-link">
            <strong>{property?.title ?? 'Bien inaccessible'}</strong>
          </Link>
          <small>{property?.reference ?? '—'}</small>
        </td>
        <td>{dateTimeLabel(visit.visited_at)}</td>
        <td>
          <span className={`status-pill status-${visit.status === 'done' ? 'available' : visit.status === 'cancelled' ? 'archived' : visit.status === 'no_show' ? 'unavailable' : 'reserved'}`}>
            {visitStatus[visit.status] ?? visit.status}
          </span>
        </td>
        <td>{visit.visit_type === 'visit' ? 'Visite' : visit.visit_type === 'inspection' ? 'Inspection' : visit.visit_type === 'keys' ? 'Remise des clés' : 'Estimation'}</td>
        <td className="row-actions-cell">
          <button className="row-action" onClick={() => { setEditing(visit); setOpen(true); }} aria-label="Modifier la visite" data-testid={`button-edit-visit-${visit.id}`}>
            <Pencil size={14} /> <span>Modifier</span>
          </button>
          <button className="row-action danger" onClick={() => void doDelete(visit)} disabled={remove.isPending} aria-label="Supprimer la visite" data-testid={`button-delete-visit-${visit.id}`}>
            <Trash2 size={14} /> <span>Supprimer</span>
          </button>
        </td>
      </tr>
    );
  };

  return (
    <>
      <Heading
        eyebrow="Agenda de l’agence"
        title="Visites"
        description="Planifiez, réalisez et suivez les visites de vos biens avec vos contacts."
        action={
          <ButtonPrimary
            testId="button-add-visit"
            disabled={!contacts.length || !properties.length}
            onClick={() => { setEditing(null); setOpen(true); }}
          >
            <Plus size={15} /> Planifier une visite
          </ButtonPrimary>
        }
      />
      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Contact, bien ou note"
            aria-label="Rechercher une visite"
            data-testid="input-search-visits"
          />
        </label>
        <select className="form-select compact-select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-visit-status">
          <option value="all">Tous les statuts</option>
          {Object.entries(visitStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="result-count" data-testid="text-visits-count">
          {visitsQ.data ? `${rows.length} visite${rows.length === 1 ? '' : 's'}` : '—'}
        </span>
      </section>

      {loading || error || !visitsQ.data?.length ? (
        <PageDataState
          loading={loading}
          error={error}
          retry={retry}
          count={visitsQ.data?.length ?? 0}
          emptyTitle="Aucune visite planifiée"
          emptyText={
            contacts.length && properties.length
              ? 'Planifiez votre première visite pour lancer votre agenda immobilier.'
              : 'Pour planifier une visite, ajoutez d’abord au moins un contact et un bien.'
          }
          testId="empty-visits"
          emptyIcon={<CalendarDays size={19} />}
        />
      ) : rows.length ? (
        <div className="panel list-panel">
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>Bien</th>
                  <th>Date</th>
                  <th>Statut</th>
                  <th>Type</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map(renderRow)}
                {past.map(renderRow)}
              </tbody>
            </table>
          </div>
          {remove.isPending && <p className="table-loading-note">Suppression en cours…</p>}
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-filtered-visits">
          <div className="state-icon"><Search size={19} /></div>
          <h2>Aucune visite pour ces filtres</h2>
          <p>Modifiez la recherche ou le statut sélectionné.</p>
          <Button variant="outline" onClick={() => { setSearch(''); setStatus('all'); }}>Effacer les filtres</Button>
        </div>
      )}

      {!loading && !error && visitsQ.data && visitsQ.data.length > 0 && (
        <section className="module-summary-grid">
          <article className="stat-card">
            <div className="stat-top"><span>À venir</span><span className="stat-icon"><CalendarDays size={14} /></span></div>
            <div className="stat-value">{upcoming.length}</div>
            <div className="stat-foot">Visites planifiées ou en attente</div>
          </article>
          <article className="stat-card">
            <div className="stat-top"><span>Réalisées</span><span className="stat-icon"><CheckCircle2 size={14} /></span></div>
            <div className="stat-value">{(visitsQ.data ?? []).filter((v) => v.status === 'done').length}</div>
            <div className="stat-foot">Visites passées au statut « Réalisée »</div>
          </article>
          <article className="stat-card">
            <div className="stat-top"><span>Agence active</span><span className="stat-icon"><MapPin size={14} /></span></div>
            <div className="stat-value stat-value-text">{activeAgency?.city ?? activeAgency?.name ?? '—'}</div>
            <div className="stat-foot">Les visites restent privées à cette agence</div>
          </article>
        </section>
      )}

      {visitsQ.error && !loading && <ErrorState error={visitsQ.error} retry={useSafeRetry(visitsQ)} testId="status-visits-error" />}
      {loading && <LoadingRows label="Chargement des visites" />}

      <VisitDialog
        key={editing?.id ?? 'new-visit'}
        open={open}
        onOpenChange={setOpen}
        item={editing}
        contacts={contacts}
        properties={properties}
      />
    </>
  );
}
