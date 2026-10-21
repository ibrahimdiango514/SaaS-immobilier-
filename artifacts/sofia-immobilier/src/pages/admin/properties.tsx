import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ArrowRight, Download, Eye, Home, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAllProperties, useAllAgencies, useAllMediaRefs, usePlatformSummary } from '@/lib/data-hooks';
import type { PropertyRow } from '@/lib/database.types';
import { getSupabaseClient, getSupabaseErrorMessage } from '@/lib/supabase';
import { AdminHeading } from './admin-shell';
import { LoadingRows, cash, dateLabel, downloadCsv, propertyStatus } from '@/lib/workspace-ui';

export default function AdminPropertiesPage() {
  const propertiesQ = useAllProperties();
  const agenciesQ = useAllAgencies();
  const mediaQ = useAllMediaRefs();
  const summaryQ = usePlatformSummary();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [detail, setDetail] = useState<PropertyRow | null>(null);
  const [pageError, setPageError] = useState('');
  const [busy, setBusy] = useState(false);

  const mediaCountByProperty = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of mediaQ.data ?? []) counts.set(row.property_id, (counts.get(row.property_id) ?? 0) + 1);
    return counts;
  }, [mediaQ.data]);

  const coverByProperty = useMemo(() => {
    const covers = new Map<string, string>();
    for (const row of mediaQ.data ?? []) {
      if (covers.has(row.property_id)) continue;
      covers.set(
        row.property_id,
        getSupabaseClient().storage.from('property-images').getPublicUrl(row.storage_path).data.publicUrl,
      );
    }
    return covers;
  }, [mediaQ.data]);

  const agencyName = (agencyId: string) =>
    agenciesQ.data?.agencies.find((agency) => agency.id === agencyId)?.name ?? 'Agence inconnue';

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    return (propertiesQ.data ?? []).filter((property) => {
      const haystack = `${property.reference} ${property.title} ${property.city ?? ''} ${property.neighborhood ?? ''} ${property.property_type}`.toLocaleLowerCase('fr');
      return (
        (!needle || haystack.includes(needle)) &&
        (statusFilter === 'all' || property.status === statusFilter) &&
        (agencyFilter === 'all' || property.agency_id === agencyFilter)
      );
    });
  }, [propertiesQ.data, search, statusFilter, agencyFilter]);

  const moderateStatus = async (property: PropertyRow, nextStatus: string) => {
    setBusy(true);
    setPageError('');
    try {
      const { error } = await getSupabaseClient()
        .schema('saas_immobilier')
        .from('properties')
        .update({ status: nextStatus })
        .eq('id', property.id);
      if (error) throw error;
      setDetail(null);
      await Promise.all([propertiesQ.refetch(), summaryQ.refetch()]);
    } catch (error) {
      setPageError(getSupabaseErrorMessage(error, 'modérer le bien'));
    } finally {
      setBusy(false);
    }
  };

  const removeProperty = async (property: PropertyRow) => {
    if (!window.confirm(`Supprimer définitivement le bien ${property.reference} ? Cette action est irréversible.`)) return;
    setBusy(true);
    setPageError('');
    try {
      // 1. Suppression des fichiers photos dans Storage (autorisation plateforme vérifiée en RLS).
      const { data: mediaRows, error: mediaError } = await getSupabaseClient()
        .schema('saas_immobilier')
        .from('property_media')
        .select('storage_path')
        .eq('property_id', property.id);
      if (mediaError) throw mediaError;
      const storagePaths = (mediaRows ?? []).map((row) => row.storage_path).filter(Boolean);
      if (storagePaths.length) {
        const { error: storageError } = await getSupabaseClient()
          .storage.from('property-images')
          .remove(storagePaths);
        if (storageError) throw storageError;
      }
      // 2. Suppression de la fiche (les lignes property_media suivent en cascade).
      const { error } = await getSupabaseClient()
        .schema('saas_immobilier')
        .from('properties')
        .delete()
        .eq('id', property.id);
      if (error) throw error;
      setDetail(null);
      await Promise.all([propertiesQ.refetch(), summaryQ.refetch(), mediaQ.refetch()]);
    } catch (error) {
      setPageError(getSupabaseErrorMessage(error, 'supprimer le bien'));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    downloadCsv(
      `sofia-biens-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Référence', 'Titre', 'Agence', 'Type', 'Transaction', 'Statut', 'Prix', 'Devise', 'Ville', 'Quartier', 'Photos', 'Créé le'],
      rows.map((property) => [
        property.reference,
        property.title,
        agencyName(property.agency_id),
        property.property_type,
        property.transaction_type,
        propertyStatus[property.status] ?? property.status,
        property.price,
        property.currency,
        property.city ?? '',
        property.neighborhood ?? '',
        mediaCountByProperty.get(property.id) ?? 0,
        dateLabel(property.created_at),
      ]),
    );
  };

  if (propertiesQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Modération" title="Biens & contenus" description="Chargement de tous les biens de la plateforme…" />
        <LoadingRows />
      </>
    );
  }

  if (propertiesQ.error) {
    return (
      <>
        <AdminHeading eyebrow="Modération" title="Biens & contenus" description="Impossible de charger les biens." />
        <div className="state-card error-state" role="alert">
          <h2>Accès refusé</h2>
          <p>RLS a bloqué la lecture globale des biens. Vérifiez votre rôle administrateur.</p>
          <Button variant="outline" onClick={() => void propertiesQ.refetch()}>Réessayer</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeading
        eyebrow="Modération"
        title="Biens & contenus"
        description="Consultez, modérez et gérez toutes les annonces de toutes les agences."
        action={
          <button className="button-link" onClick={exportCsv} data-testid="button-export-properties">
            <Download size={15} /> Exporter (CSV)
          </button>
        }
      />

      <section className="kpi-grid kpi-grid-compact">
        <article className="kpi-card accent-teal"><div className="kpi-top"><span>Biens totaux</span></div><div className="kpi-value">{propertiesQ.data?.length ?? 0}</div><div className="kpi-foot">Toutes agences confondues</div></article>
        <article className="kpi-card accent-blue"><div className="kpi-top"><span>Sans photo</span></div><div className="kpi-value">{(propertiesQ.data ?? []).filter((p) => !mediaCountByProperty.has(p.id)).length}</div><div className="kpi-foot">Annonces à compléter</div></article>
        <article className="kpi-card accent-amber"><div className="kpi-top"><span>Sans description</span></div><div className="kpi-value">{(propertiesQ.data ?? []).filter((p) => !p.description || p.description.trim().length < 10).length}</div><div className="kpi-foot">Texte à rédiger</div></article>
        <article className="kpi-card accent-rose"><div className="kpi-top"><span>Brouillons/archives</span></div>
          <div className="kpi-value">{(propertiesQ.data ?? []).filter((p) => ['draft', 'archived'].includes(p.status)).length}</div>
          <div className="kpi-foot">Non publiés</div>
        </article>
      </section>

      {pageError && <p className="form-error module-error" role="alert">{pageError}</p>}

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Référence, titre, ville…" aria-label="Rechercher un bien" data-testid="input-search-admin-properties" />
        </label>
        <select className="form-select compact-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filtrer par statut" data-testid="filter-admin-property-status">
          <option value="all">Tous les statuts</option>
          {Object.entries(propertyStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select className="form-select compact-select" value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} aria-label="Filtrer par agence" data-testid="filter-admin-property-agency">
          <option value="all">Toutes les agences</option>
          {(agenciesQ.data?.agencies ?? []).map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
        </select>
        <span className="result-count">{rows.length} bien(s)</span>
      </section>

      {rows.length ? (
        <div className="panel list-panel">
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Bien</th>
                  <th>Agence</th>
                  <th>Prix</th>
                  <th>Photos</th>
                  <th>Statut</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((property) => (
                  <tr key={property.id} data-testid={`row-admin-property-${property.id}`}>
                    <td><strong>{property.reference}</strong></td>
                    <td className="table-thumb-link">
                      {coverByProperty.get(property.id)
                        ? <span className="table-thumb"><img src={coverByProperty.get(property.id)} alt="" loading="lazy" /></span>
                        : <span className="table-thumb table-thumb-empty"><Home size={13} /></span>}
                      <span>{property.title}<small>{property.property_type} · {property.city ?? '—'}</small></span>
                    </td>
                    <td>{agencyName(property.agency_id)}</td>
                    <td>{cash(property.price, property.currency)}</td>
                    <td>
                      <span className={`photo-count${mediaCountByProperty.get(property.id) ? '' : ' is-empty'}`}>
                        {mediaCountByProperty.get(property.id) ?? 0} photo(s)
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill status-${property.status}`}>{propertyStatus[property.status] ?? property.status}</span>
                      {/* BLOC 6 : archivage côté agence (colonne is_archived), distinct
                          de la modération plateforme (status='archived'). */}
                      {property.is_archived && (
                        <span className="agency-archived-pill" title="Masqué des listes de l'agence mais conservé dans son CA" data-testid={`badge-agency-archived-${property.id}`}>
                          Archivé par l’agence
                        </span>
                      )}
                    </td>
                    <td className="row-actions-cell">
                      <button className="row-action" onClick={() => setDetail(property)} data-testid={`button-detail-property-${property.id}`}>
                        <Eye size={14} /> <span>Détails</span>
                      </button>
                      {property.status !== 'archived' ? (
                        <button className="row-action danger" disabled={busy} onClick={() => void moderateStatus(property, 'archived')} data-testid={`button-archive-property-${property.id}`}>
                          Archiver
                        </button>
                      ) : (
                        <button className="row-action" disabled={busy} onClick={() => void moderateStatus(property, 'available')} data-testid={`button-republish-property-${property.id}`}>
                          Republier
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-admin-properties">
          <div className="state-icon"><Search size={19} /></div>
          <h2>Aucun bien pour ces filtres</h2>
          <p>Élargissez la recherche ou changez les filtres.</p>
          <Button variant="outline" onClick={() => { setSearch(''); setStatusFilter('all'); setAgencyFilter('all'); }}>Effacer les filtres</Button>
        </div>
      )}

      <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="form-dialog">
          {detail && (
            <>
              <DialogHeader>
                <span className="form-kicker">{detail.reference}</span>
                <DialogTitle>{detail.title}</DialogTitle>
                <DialogDescription>{agencyName(detail.agency_id)} · {detail.property_type}</DialogDescription>
              </DialogHeader>
              <div className="agency-detail-body">
                <div className="detail-pricebar">
                  <div><span className="form-kicker">Prix</span><strong>{cash(detail.price, detail.currency)}</strong></div>
                  <span className={`status-pill status-${detail.status}`}>{propertyStatus[detail.status] ?? detail.status}</span>
                  {detail.is_archived && (
                    <span className="agency-archived-pill" data-testid="badge-agency-archived-detail">Archivé par l’agence</span>
                  )}
                </div>
                <div className="detail-facts">
                  <div><span>Transaction</span><strong>{detail.transaction_type === 'sale' ? 'Vente' : detail.transaction_type === 'rent' ? 'Location' : 'Bail'}</strong></div>
                  <div><span>Chambres</span><strong>{detail.bedrooms ?? '—'}</strong></div>
                  <div><span>Salles d’eau</span><strong>{detail.bathrooms ?? '—'}</strong></div>
                  <div><span>Surface</span><strong>{detail.area_m2 ? `${detail.area_m2} m²` : '—'}</strong></div>
                  <div><span>Ville</span><strong>{detail.city ?? '—'}</strong></div>
                  <div><span>Photos</span><strong>{mediaCountByProperty.get(detail.id) ?? 0}</strong></div>
                  <div><span>Créé le</span><strong>{dateLabel(detail.created_at)}</strong></div>
                  <div><span>Mis à jour</span><strong>{dateLabel(detail.updated_at)}</strong></div>
                </div>
                <div className="detail-section">
                  <h2>Adresse</h2>
                  <p>{[detail.address, detail.neighborhood, detail.city].filter(Boolean).join(', ') || 'Non renseignée'}</p>
                </div>
                <div className="detail-section">
                  <h2>Description</h2>
                  <p>{detail.description || 'Aucune description — annonce incomplète.'}</p>
                </div>
                <div className="agency-detail-actions">
                  <Link href="/admin/agences" className="button-link">Voir l’agence <ArrowRight size={13} /></Link>
                  <span className="button-link"><Home size={14} /> {mediaCountByProperty.get(detail.id) ?? 0} photo(s) enregistrée(s)</span>
                </div>
                <div className="form-actions">
                  {detail.status !== 'archived' ? (
                    <Button variant="destructive" disabled={busy} onClick={() => void moderateStatus(detail, 'archived')} data-testid="button-archive-detail">
                      Archiver l’annonce
                    </Button>
                  ) : (
                    <Button disabled={busy} onClick={() => void moderateStatus(detail, 'available')} data-testid="button-republish-detail">
                      Republier l’annonce
                    </Button>
                  )}
                  <Button variant="outline" disabled={busy} onClick={() => void removeProperty(detail)} data-testid="button-delete-detail">
                    <Trash2 size={14} /> Supprimer
                  </Button>
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
