import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Building2,
  Download,
  Mail,
  MapPin,
  Phone,
  Search,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  useAllAgencies,
  useAllProperties,
  useActivityLog,
  useAdminUpdateAgency,
} from '@/lib/data-hooks';
import type { AgencyRow } from '@/lib/database.types';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
import { LoadingRows, cash, dateLabel, dateTimeLabel, downloadCsv, roleNames } from '@/lib/workspace-ui';

const agencyStatus: Record<string, string> = {
  active: 'Active',
  suspended: 'Suspendue',
  pending: 'En validation',
  inactive: 'Inactive',
};

const subscriptionStatus: Record<string, string> = {
  active: 'Actif',
  trial: 'Essai',
  expired: 'Expiré',
  cancelled: 'Annulé',
  past_due: 'Impayé',
};

export default function AdminAgenciesPage() {
  const agenciesQ = useAllAgencies();
  const propertiesQ = useAllProperties();
  const activityQ = useActivityLog(300);
  const updateAgency = useAdminUpdateAgency();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detail, setDetail] = useState<AgencyRow | null>(null);
  const [pageError, setPageError] = useState('');

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    return (agenciesQ.data?.agencies ?? []).filter((agency) => {
      const haystack = `${agency.name} ${agency.slug} ${agency.city ?? ''} ${agency.email ?? ''} ${agency.phone ?? ''}`.toLocaleLowerCase('fr');
      return (!needle || haystack.includes(needle)) && (statusFilter === 'all' || agency.status === statusFilter);
    });
  }, [agenciesQ.data?.agencies, search, statusFilter]);

  const subscriptionFor = (agencyId: string) =>
    agenciesQ.data?.subscriptions.find((subscription) => subscription.agency_id === agencyId) ?? null;
  const planFor = (planId: string) => agenciesQ.data?.plans.find((plan) => plan.id === planId) ?? null;
  const membersFor = (agencyId: string) =>
    (agenciesQ.data?.members ?? []).filter((member) => member.agency_id === agencyId);
  const propertyCountFor = (agencyId: string) =>
    (propertiesQ.data ?? []).filter((property) => property.agency_id === agencyId).length;

  const changeStatus = (agency: AgencyRow, nextStatus: string) => {
    const verb = nextStatus === 'active' ? 'réactiver' : 'suspendre';
    if (!window.confirm(`Confirmer le fait de ${verb} l’agence « ${agency.name} » ?`)) return;
    setPageError('');
    updateAgency.mutate(
      { agencyId: agency.id, status: nextStatus },
      {
        onSuccess: () => {
          if (detail?.id === agency.id) setDetail({ ...detail, status: nextStatus });
        },
        onError: (error) => setPageError(getSupabaseErrorMessage(error, `${verb} l’agence`)),
      },
    );
  };

  const exportCsv = () => {
    downloadCsv(
      `sofia-agences-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Nom', 'Ville', 'Pays', 'Statut', 'Téléphone', 'E-mail', 'Abonnement', 'Membres', 'Biens', 'Créée le'],
      rows.map((agency) => [
        agency.name,
        agency.city ?? '',
        agency.country,
        agencyStatus[agency.status] ?? agency.status,
        agency.phone ?? '',
        agency.email ?? '',
        subscriptionStatus[subscriptionFor(agency.id)?.status ?? ''] ?? '—',
        membersFor(agency.id).length,
        propertyCountFor(agency.id),
        dateLabel(agency.created_at),
      ]),
    );
  };

  if (agenciesQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Pilotage" title="Gestion des agences" description="Chargement du répertoire…" />
        <LoadingRows />
      </>
    );
  }

  if (agenciesQ.error) {
    return (
      <>
        <AdminHeading eyebrow="Pilotage" title="Gestion des agences" description="Impossible de charger les agences." />
        <div className="state-card error-state" role="alert">
          <h2>Accès refusé</h2>
          <p>Le chargement du répertoire a été refusé par RLS. Vérifiez votre rôle administrateur.</p>
          <Button variant="outline" onClick={() => void agenciesQ.refetch()}>Réessayer</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeading
        eyebrow="Pilotage"
        title="Gestion des agences"
        description="Recherchez, inspectez, validez ou suspendez chaque agence de la plateforme."
        action={
          <button className="button-link" onClick={exportCsv} data-testid="button-export-agencies">
            <Download size={15} /> Exporter (CSV)
          </button>
        }
      />

      {pageError && <p className="form-error module-error" role="alert">{pageError}</p>}

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom, ville, e-mail…" aria-label="Rechercher une agence" data-testid="input-search-admin-agencies" />
        </label>
        <select className="form-select compact-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-admin-agency-status">
          <option value="all">Tous les statuts</option>
          {Object.entries(agencyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="result-count">{rows.length} agence(s)</span>
      </section>

      {rows.length ? (
        <div className="panel list-panel">
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr>
                  <th>Agence</th>
                  <th>Localisation</th>
                  <th>Abonnement</th>
                  <th>Membres</th>
                  <th>Biens</th>
                  <th>Statut</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((agency) => {
                  const subscription = subscriptionFor(agency.id);
                  const plan = subscription ? planFor(subscription.plan_id) : null;
                  return (
                    <tr key={agency.id} data-testid={`row-admin-agency-${agency.id}`}>
                      <td>
                        <span className="contact-cell">
                          <span className="contact-avatar"><Building2 size={14} /></span>
                          <div>
                            <strong>{agency.name}</strong>
                            <small>{agency.email ?? agency.phone ?? '—'}</small>
                          </div>
                        </span>
                      </td>
                      <td>{agency.city ?? '—'}<small>{agency.country}</small></td>
                      <td>
                        {plan ? <><strong>{plan.name}</strong><small>{subscriptionStatus[subscription?.status ?? ''] ?? subscription?.status}</small></> : '—'}
                      </td>
                      <td>{membersFor(agency.id).length}</td>
                      <td>{propertyCountFor(agency.id)}</td>
                      <td>
                        <div className="agency-status-cell">
                          <span className={`status-pill status-${agency.status === 'active' ? 'available' : agency.status === 'pending' ? 'reserved' : 'unavailable'}`}>
                            {agencyStatus[agency.status] ?? agency.status}
                          </span>
                          <span className={`status-pill mini-indicator ${agency.status === 'suspended' ? 'status-unavailable' : 'status-available'}`} data-testid={`pill-dashboard-${agency.id}`}>
                            Dashboard {agency.status === 'suspended' ? 'désactivé' : 'actif'}
                          </span>
                          <span className={`status-pill mini-indicator ${agency.status === 'suspended' ? 'status-reserved' : 'status-available'}`} data-testid={`pill-agent-${agency.id}`}>
                            Agent {agency.status === 'suspended' ? 'en pause' : 'actif'}
                          </span>
                        </div>
                      </td>
                      <td className="row-actions-cell">
                        <button className="row-action" onClick={() => setDetail(agency)} data-testid={`button-detail-agency-${agency.id}`}>
                          Détails <ArrowRight size={13} />
                        </button>
                        {agency.status === 'active' ? (
                          <button className="row-action danger" disabled={updateAgency.isPending} onClick={() => changeStatus(agency, 'suspended')} data-testid={`button-suspend-agency-${agency.id}`}>
                            Suspendre
                          </button>
                        ) : (
                          <button className="row-action" disabled={updateAgency.isPending} onClick={() => changeStatus(agency, 'active')} data-testid={`button-activate-agency-${agency.id}`}>
                            Réactiver
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-admin-agencies">
          <div className="state-icon"><Search size={19} /></div>
          <h2>Aucune agence pour ces filtres</h2>
          <p>Modifiez la recherche ou le statut sélectionné.</p>
          <Button variant="outline" onClick={() => { setSearch(''); setStatusFilter('all'); }}>Effacer les filtres</Button>
        </div>
      )}

      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="form-dialog agency-detail-dialog">
          {detail && (
            <>
              <DialogHeader>
                <span className="form-kicker">Fiche agence</span>
                <DialogTitle>{detail.name}</DialogTitle>
                <DialogDescription>{detail.legal_name || 'Raison sociale non renseignée'}</DialogDescription>
              </DialogHeader>
              <div className="agency-detail-body">
                <div className="detail-facts">
                  <div><span>Statut</span><strong>{agencyStatus[detail.status] ?? detail.status}</strong></div>
                  <div><span>Dashboard</span><strong data-testid="detail-dashboard-state">{detail.status === 'suspended' ? 'Désactivé' : 'Actif'}</strong></div>
                  <div><span>Agent WhatsApp</span><strong data-testid="detail-agent-state">{detail.status === 'suspended' ? 'En pause' : 'Actif'}</strong></div>
                  <div><span>Créée le</span><strong>{dateLabel(detail.created_at)}</strong></div>
                  <div><span>Ville</span><strong>{detail.city ?? '—'}</strong></div>
                  <div><span>Devise</span><strong>{detail.currency}</strong></div>
                  <div><span>Téléphone</span><strong>{detail.phone || '—'}</strong></div>
                  <div><span>E-mail</span><strong>{detail.email || '—'}</strong></div>
                  <div><span>Adresse</span><strong>{detail.address || '—'}</strong></div>
                  <div><span>Slug</span><strong>{detail.slug}</strong></div>
                </div>
                {detail.description && (
                  <div className="detail-section"><h2>Présentation</h2><p>{detail.description}</p></div>
                )}

                <div className="detail-section">
                  <h2>Abonnement</h2>
                  {(() => {
                    const subscription = subscriptionFor(detail.id);
                    const plan = subscription ? planFor(subscription.plan_id) : null;
                    if (!subscription || !plan) return <p>Aucun abonnement enregistré.</p>;
                    return (
                      <p>
                        <strong>{plan.name}</strong> — {cash(Number(plan.price_monthly), plan.currency)}/mois ·{' '}
                        statut {subscriptionStatus[subscription.status] ?? subscription.status}
                        {subscription.ends_at ? ` · fin le ${dateLabel(subscription.ends_at)}` : ''}
                        {subscription.trial_ends_at ? ` · essai jusqu’au ${dateLabel(subscription.trial_ends_at)}` : ''}
                      </p>
                    );
                  })()}
                </div>

                <div className="detail-section">
                  <h2>Membres ({membersFor(detail.id).length})</h2>
                  {membersFor(detail.id).length ? (
                    <div className="roster-list">
                      {membersFor(detail.id).map((member) => (
                        <div className="roster-row" key={member.id}>
                          <span className="roster-avatar"><UserRound size={15} /></span>
                          <div className="roster-copy">
                            <strong>{roleNames[member.role] ?? member.role}</strong>
                            <span>{member.user_id.slice(0, 8)}…{member.user_id.slice(-4)}</span>
                          </div>
                          <span className={`membership-status membership-${member.status}`}>{member.status === 'active' ? 'Actif' : member.status}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p>Aucun membre enregistré.</p>
                  )}
                </div>

                <div className="detail-section">
                  <h2>Dernières actions</h2>
                  {(() => {
                    const entries = (activityQ.data ?? []).filter((entry) => entry.agency_id === detail.id).slice(0, 5);
                    return entries.length ? (
                      <div className="activity-feed">
                        {entries.map((entry) => (
                          <div className="activity-row" key={entry.id}>
                            <span className={`activity-dot is-${entry.action}`} />
                            <span className="activity-copy">
                              <strong>{entry.summary}</strong>
                              <small>{dateTimeLabel(entry.created_at)}</small>
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p>Aucune action enregistrée.</p>
                    );
                  })()}
                </div>

                <div className="agency-detail-actions">
                  <a className="button-link" href={`mailto:${detail.email ?? ''}`}><Mail size={14} /> Contacter</a>
                  <span className="button-link"><MapPin size={14} /> {[detail.address, detail.city].filter(Boolean).join(', ') || 'Adresse non renseignée'}</span>
                  <span className="button-link"><Phone size={14} /> {detail.phone || '—'}</span>
                  <span className="button-link"><ShieldCheck size={14} /> {propertyCountFor(detail.id)} bien(s)</span>
                </div>

                <div className="form-actions">
                  {detail.status === 'active' ? (
                    <Button variant="destructive" disabled={updateAgency.isPending} onClick={() => changeStatus(detail, 'suspended')} data-testid="button-suspend-detail">
                      Suspendre l’agence
                    </Button>
                  ) : (
                    <Button disabled={updateAgency.isPending} onClick={() => changeStatus(detail, 'active')} data-testid="button-activate-detail">
                      Réactiver l’agence
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setDetail(null)}>Fermer</Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
