// =============================================================================
// BLOC 6 — CYCLE DE VIE D'UN BIEN : ARCHIVAGE ET SUPPRESSION
// =============================================================================
// Autorisations tranchées CÔTÉ SERVEUR :
//   - lecture de l'impact  : `public.property_delete_impact`  (membre de l'agence)
//   - archivage            : `public.archive_property`        (owner/admin)
//   - suppression          : `public.delete_property_with_media` (owner/admin)
// Le front n'accorde rien : il affiche, avertit et transmet.
//
// L'archivage n'utilise PAS `status='archived'` : le trigger existant
// `trg_sync_property_revenue` annulerait l'opération de CA automatique dès que le
// statut quitte sold/rented. La colonne dédiée `is_archived` conserve donc
// intact le CA et l'historique.
// =============================================================================
import { useState } from 'react';
import {
  Archive, ArchiveRestore, AlertTriangle, ChevronLeft, LockKeyhole, Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabaseErrorMessage } from '@/lib/supabase';
import {
  useArchiveProperty, useArchivedProperties, useDeletePropertyWithMedia,
  usePropertyDeleteImpact,
} from '@/lib/data-hooks';
import type { PropertyRow } from '@/lib/database.types';

const STATUS_LABELS: Record<string, string> = {
  available: 'Disponible',
  reserved: 'Réservé',
  sold: 'Vendu',
  rented: 'Loué',
  unavailable: 'Indisponible',
  draft: 'Brouillon',
  archived: 'Archivé',
};

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status;
}

function money(value: number | null | undefined, currency = 'XOF') {
  const amount = Number(value ?? 0);
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(amount)} ${currency}`;
}

/* ---------------------------------------------------------------------------
 * Panneau « Zone sensible » de la fiche bien
 * ------------------------------------------------------------------------ */
export function PropertyLifecyclePanel({
  property,
  agencyId,
  canManage,
  onDeleted,
}: {
  property: PropertyRow;
  agencyId?: string;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const impactQ = usePropertyDeleteImpact(property.id);
  const archive = useArchiveProperty(agencyId);
  const remove = useDeletePropertyWithMedia(agencyId);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [isError, setIsError] = useState(false);

  const impact = impactQ.data;
  const busy = archive.isPending || remove.isPending;
  const isArchived = property.is_archived;
  const canArchiveNow = !isArchived && ['sold', 'rented'].includes(property.status);

  const flash = (text: string, error = false) => {
    setIsError(error);
    setNotice(text);
  };

  const toggleArchive = async () => {
    setNotice('');
    try {
      const result = await archive.mutateAsync({ propertyId: property.id, archived: !isArchived });
      flash(
        result.is_archived
          ? `« ${result.title} » est archivé : il disparaît des listes mais reste dans l’historique et le CA, et ne compte plus dans la limite de biens de votre offre.`
          : `« ${result.title} » est de nouveau actif dans vos listes.`,
      );
    } catch (error) {
      flash(getSupabaseErrorMessage(error, isArchived ? 'restaurer le bien' : 'archiver le bien'), true);
    }
  };

  const confirmDelete = async () => {
    setNotice('');
    try {
      const result = await remove.mutateAsync(property.id);
      const purged = result.media?.length ?? 0;
      const kept = result.impact?.revenue_operations ?? 0;
      const lost = (result.impact?.opportunities ?? 0) + (result.impact?.visits ?? 0);
      flash(
        `Bien supprimé. ${purged} photo(s) purgée(s) du stockage.` +
        (kept ? ` ${kept} opération(s) de CA conservée(s) (détachée(s) du bien).` : '') +
        (lost ? ` ${lost} élément(s) lié(s) (opportunités, visites) supprimé(s).` : '') +
        (result.storage_errors.length ? ` ⚠ ${result.storage_errors.length} fichier(s) non purgé(s) : ${result.storage_errors[0]}` : ''),
      );
      setConfirmOpen(false);
      onDeleted();
    } catch (error) {
      flash(getSupabaseErrorMessage(error, 'supprimer le bien'), true);
      setConfirmOpen(false);
    }
  };

  if (!canManage) {
    return (
      <section className="panel lifecycle-panel" data-testid="panel-property-lifecycle">
        <div className="panel-head">
          <div><h2>Archivage et suppression</h2><p>Réservé au propriétaire et aux administrateurs.</p></div>
          <LockKeyhole size={17} />
        </div>
        <div className="permission-note" role="status" data-testid="status-lifecycle-readonly">
          <LockKeyhole size={15} />
          <span>Un agent ne peut ni archiver ni supprimer un bien.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel lifecycle-panel" data-testid="panel-property-lifecycle">
      <div className="panel-head">
        <div>
          <h2>Archivage et suppression</h2>
          <p>{isArchived ? 'Ce bien est archivé : il est masqué des listes courantes.' : 'Archivez un bien vendu ou loué, ou supprimez-le définitivement.'}</p>
        </div>
        <Archive size={17} />
      </div>

      {isArchived && (
        <div className="notice-box" role="status" data-testid="status-property-archived">
          <Archive size={15} />
          <span>
            Bien archivé{property.archived_at ? ` le ${new Date(property.archived_at).toLocaleDateString('fr-FR')}` : ''}.
            Il reste compté dans l’historique et le chiffre d’affaires, et ne compte plus dans la limite de biens de votre offre.
          </span>
        </div>
      )}

      {impactQ.isPending && <p className="form-hint">Analyse de l’impact en cours…</p>}
      {impactQ.error && (
        <p className="form-error" role="alert" data-testid="status-impact-error">
          {getSupabaseErrorMessage(impactQ.error, 'analyser l’impact')}
        </p>
      )}

      <div className="lifecycle-actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => void toggleArchive()}
          disabled={busy || impactQ.isPending}
          data-testid={isArchived ? 'button-restore-property' : 'button-archive-property'}
        >
          {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          {archive.isPending ? 'En cours…' : isArchived ? 'Restaurer le bien' : canArchiveNow ? 'Archiver ce bien vendu/loué' : 'Archiver ce bien'}
        </Button>

        <Button
          type="button"
          variant="outline"
          className="danger-action"
          onClick={() => { setNotice(''); setConfirmOpen(true); }}
          disabled={busy || impactQ.isPending || !impact?.can_delete}
          data-testid="button-delete-property"
        >
          <Trash2 size={15} /> Supprimer définitivement
        </Button>
      </div>

      {!canArchiveNow && !isArchived && (
        <p className="form-hint">
          L’archivage est surtout utile pour un bien <strong>vendu</strong> ou <strong>loué</strong> :
          il disparaît des listes tout en restant dans le CA.
        </p>
      )}

      {notice && (
        <p
          className={isError ? 'form-error' : 'form-feedback'}
          role={isError ? 'alert' : 'status'}
          data-testid="status-lifecycle-message"
        >
          {notice}
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Confirmation de suppression : avertissements chiffrés             */}
      {/* ---------------------------------------------------------------- */}
      <div className={`confirm-sheet${confirmOpen ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-label="Confirmer la suppression du bien" data-testid="dialog-delete-property">
        <div className="confirm-sheet-head">
          <AlertTriangle size={17} />
          <strong>Supprimer « {property.title} » ?</strong>
          <button type="button" className="icon-button" onClick={() => setConfirmOpen(false)} aria-label="Fermer" data-testid="button-close-delete-dialog">
            <ChevronLeft size={16} />
          </button>
        </div>

        {impact && (
          <ul className="impact-list" data-testid="list-delete-impact">
            <li className={impact.media_count ? 'is-warn' : ''}>
              <strong>{impact.media_count}</strong> photo(s) — fichiers supprimés du stockage, non récupérables
            </li>
            <li className={impact.revenue_operations ? 'is-warn' : ''}>
              <strong>{impact.revenue_operations}</strong> opération(s) de CA ({money(impact.revenue_amount, property.currency)}) —
              {impact.revenue_operations ? ' conservée(s) dans votre chiffre d’affaires mais détachée(s) de ce bien' : ' aucune'}
            </li>
            <li className={impact.opportunities ? 'is-danger' : ''}>
              <strong>{impact.opportunities}</strong> opportunité(s) du pipeline — {impact.opportunities ? 'supprimée(s) définitivement' : 'aucune'}
            </li>
            <li className={impact.visits ? 'is-danger' : ''}>
              <strong>{impact.visits}</strong> visite(s) — {impact.visits ? 'supprimée(s) définitivement' : 'aucune'}
            </li>
          </ul>
        )}

        {(impact?.revenue_operations ?? 0) > 0 && (
          <div className="notice-box is-warning" role="status">
            <AlertTriangle size={15} />
            <span>
              Ce bien a des opérations de revenu. Pensez à <strong>l’archiver</strong> plutôt qu’à le
              supprimer : l’archivage garde le bien et son CA dans l’historique.
            </span>
          </div>
        )}

        <div className="confirm-sheet-actions">
          <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy} data-testid="button-cancel-delete">
            Annuler
          </Button>
          <Button type="button" className="danger-action" onClick={() => void confirmDelete()} disabled={busy} data-testid="button-confirm-delete">
            <Trash2 size={15} /> {remove.isPending ? 'Suppression…' : 'Je confirme la suppression'}
          </Button>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------
 * Liste des biens archivés (page Biens)
 * ------------------------------------------------------------------------ */
export function ArchivedPropertiesPanel({
  agencyId,
  canManage,
  onRestore,
}: {
  agencyId?: string;
  canManage: boolean;
  onRestore?: (message: string, isError?: boolean) => void;
}) {
  const archivedQ = useArchivedProperties(agencyId);
  const archive = useArchiveProperty(agencyId);
  const remove = useDeletePropertyWithMedia(agencyId);
  const [open, setOpen] = useState(false);

  const rows = archivedQ.data ?? [];
  const busy = archive.isPending || remove.isPending;

  const restore = async (row: PropertyRow) => {
    try {
      await archive.mutateAsync({ propertyId: row.id, archived: false });
      onRestore?.(`« ${row.title} » est de nouveau actif dans vos listes.`);
    } catch (error) {
      onRestore?.(getSupabaseErrorMessage(error, 'restaurer le bien'), true);
    }
  };

  const destroy = async (row: PropertyRow) => {
    if (!window.confirm(`Supprimer définitivement « ${row.title} » et toutes ses photos ?`)) return;
    try {
      const result = await remove.mutateAsync(row.id);
      onRestore?.(`Bien supprimé. ${result.media?.length ?? 0} photo(s) purgée(s) du stockage.`);
    } catch (error) {
      onRestore?.(getSupabaseErrorMessage(error, 'supprimer le bien'), true);
    }
  };

  return (
    <section className="panel archived-panel" data-testid="panel-archived-properties">
      <button type="button" className="archived-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="button-toggle-archived">
        <Archive size={16} />
        <span>
          Biens archivés
          <strong data-testid="text-archived-count">{archivedQ.data ? rows.length : '…'}</strong>
        </span>
        <small>Non comptés dans la limite de biens de votre offre · CA et historique conservés</small>
        <em className={`archived-chevron${open ? ' is-open' : ''}`} aria-hidden="true"><ChevronLeft size={15} /></em>
      </button>

      {open && (
        archivedQ.isLoading ? (
          <p className="form-hint">Chargement des biens archivés…</p>
        ) : archivedQ.error ? (
          <p className="form-error" role="alert">{getSupabaseErrorMessage(archivedQ.error, 'charger les biens archivés')}</p>
        ) : rows.length ? (
          <div className="archived-list" data-testid="list-archived-properties">
            {rows.map((row) => (
              <div className="archived-row" key={row.id} data-testid={`row-archived-${row.id}`}>
                <div className="archived-copy">
                  <strong>{row.title}</strong>
                  <span>
                    {row.reference} · {statusLabel(row.status)} · archivé
                    {row.archived_at ? ` le ${new Date(row.archived_at).toLocaleDateString('fr-FR')}` : ''}
                  </span>
                </div>
                {canManage && (
                  <div className="archived-actions">
                    <button type="button" className="row-action" onClick={() => void restore(row)} disabled={busy} data-testid={`button-restore-${row.id}`}>
                      <ArchiveRestore size={14} /><span>Restaurer</span>
                    </button>
                    <button type="button" className="row-action danger-action" onClick={() => void destroy(row)} disabled={busy} data-testid={`button-delete-archived-${row.id}`}>
                      <Trash2 size={14} /><span>Supprimer</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="form-hint" data-testid="empty-archived-properties">Aucun bien archivé pour le moment.</p>
        )
      )}
    </section>
  );
}
