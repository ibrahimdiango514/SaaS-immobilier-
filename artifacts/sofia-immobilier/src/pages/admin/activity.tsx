import { useMemo, useState } from 'react';
import { Activity, Download, Filter, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useActivityLog, useAllAgencies } from '@/lib/data-hooks';
import { AdminHeading } from './admin-shell';
import { LoadingRows, dateTimeLabel, downloadCsv, entityLabels } from '@/lib/workspace-ui';

export default function AdminActivityPage() {
  const activityQ = useActivityLog(300);
  const agenciesQ = useAllAgencies();
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState('all');
  const [agencyFilter, setAgencyFilter] = useState('all');

  const agencies = agenciesQ.data?.agencies ?? [];
  const entityTypes = useMemo(
    () => [...new Set((activityQ.data ?? []).map((entry) => entry.entity_type))].sort(),
    [activityQ.data],
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('fr');
    return (activityQ.data ?? []).filter((entry) => {
      const agency = agencies.find((a) => a.id === entry.agency_id);
      const haystack = `${entry.summary} ${entry.entity_type} ${entry.action} ${agency?.name ?? ''}`.toLocaleLowerCase('fr');
      return (
        (!needle || haystack.includes(needle)) &&
        (entityFilter === 'all' || entry.entity_type === entityFilter) &&
        (agencyFilter === 'all' || entry.agency_id === agencyFilter)
      );
    });
  }, [activityQ.data, agencies, search, entityFilter, agencyFilter]);

  const exportCsv = () => {
    downloadCsv(
      `sofia-activite-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Action', 'Entité', 'Agence', 'Résumé'],
      rows.map((entry) => [
        dateTimeLabel(entry.created_at),
        entry.action,
        entityLabels[entry.entity_type] ?? entry.entity_type,
        agencies.find((a) => a.id === entry.agency_id)?.name ?? 'Plateforme',
        entry.summary,
      ]),
    );
  };

  if (activityQ.isLoading) {
    return (
      <>
        <AdminHeading eyebrow="Traçabilité" title="Journal d’activité" description="Chargement du journal…" />
        <LoadingRows />
      </>
    );
  }

  if (activityQ.error) {
    return (
      <>
        <AdminHeading eyebrow="Traçabilité" title="Journal d’activité" description="Impossible de charger le journal." />
        <div className="state-card error-state" role="alert">
          <h2>Accès refusé</h2>
          <p>Seuls les administrateurs peuvent consulter le journal global.</p>
          <Button variant="outline" onClick={() => void activityQ.refetch()}>Réessayer</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminHeading
        eyebrow="Traçabilité"
        title="Journal d’activité"
        description="Chaque création, modification et suppression sur la plateforme est horodatée automatiquement (triggers SQL)."
        action={
          <button className="button-link" onClick={exportCsv} data-testid="button-export-activity">
            <Download size={15} /> Exporter (CSV)
          </button>
        }
      />

      <section className="list-toolbar">
        <label className="list-search">
          <Search size={15} />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Résumé, agence, type…" aria-label="Rechercher dans le journal" data-testid="input-search-activity" />
        </label>
        <select className="form-select compact-select" value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)} aria-label="Filtrer par type d’entité" data-testid="filter-activity-entity">
          <option value="all">Tous les modules</option>
          {entityTypes.map((type) => <option key={type} value={type}>{entityLabels[type] ?? type}</option>)}
        </select>
        <select className="form-select compact-select" value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} aria-label="Filtrer par agence" data-testid="filter-activity-agency">
          <option value="all">Toutes les agences</option>
          {agencies.map((agency) => <option key={agency.id} value={agency.id}>{agency.name}</option>)}
        </select>
        <span className="result-count">{rows.length} entrée(s)</span>
      </section>

      {rows.length ? (
        <div className="panel list-panel">
          <div className="table-wrap">
            <table className="data-table full-table">
              <thead>
                <tr><th>Date</th><th>Module</th><th>Action</th><th>Agence</th><th>Détail</th></tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id} data-testid={`row-activity-${entry.id}`}>
                    <td>{dateTimeLabel(entry.created_at)}</td>
                    <td><span className="entity-tag">{entityLabels[entry.entity_type] ?? entry.entity_type}</span></td>
                    <td>
                      <span className={`activity-dot is-${entry.action}`} style={{ display: 'inline-block', marginRight: 6 }} />
                      {entry.action === 'created' ? 'Création' : entry.action === 'updated' ? 'Modification' : entry.action === 'deleted' ? 'Suppression' : entry.action}
                    </td>
                    <td>{agencies.find((a) => a.id === entry.agency_id)?.name ?? <em>Plateforme</em>}</td>
                    <td>{entry.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="state-card compact-empty" data-testid="empty-activity">
          <div className="state-icon"><Activity size={19} /></div>
          <h2>Aucune entrée pour ces filtres</h2>
          <p>Le journal se remplit automatiquement à mesure que les agences travaillent.</p>
          <Button variant="outline" onClick={() => { setSearch(''); setEntityFilter('all'); setAgencyFilter('all'); }}>
            <Filter size={14} /> Réinitialiser les filtres
          </Button>
        </div>
      )}
    </>
  );
}
