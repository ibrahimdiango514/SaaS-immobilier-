// =============================================================================
// SESSION 2 — BLOC 2 : ADMIN — FILE DES AGENCES EN ATTENTE DE VALIDATION
// =============================================================================
// Une nouvelle agence est créée avec `status = 'pending'` et SANS abonnement.
// Cette page liste les dossiers en attente avec l'offre choisie, le montant dû
// (installation + premier mois) et le paiement déclaré.
//   • Valider  → `admin_activate_pending_agency` : crée l'abonnement actif,
//                calcule l'échéance (1 mois), passe l'agence en `active`. Le
//                tableau de bord de l'agence s'ouvre avec les modules de l'offre.
//   • Refuser  → `admin_reject_pending_agency` avec motif obligatoire : l'agence
//                reste en attente et voit le motif à sa prochaine connexion.
// Aucune décision d'autorisation ici : les deux fonctions vérifient
// `is_platform_admin()` côté base.
// =============================================================================
import { useState } from 'react';
import {
  AlertTriangle, BadgeCheck, Building2, Clock3, CreditCard, Search, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AdminHeading } from './admin-shell';
import { ErrorState, LoadingRows, cash, dateLabel, useSafeRetry } from '@/lib/workspace-ui';
import {
  usePendingAgencies, useActivatePendingAgency, useRejectPendingAgency,
  usePendingOnlinePayments, useActivatePendingAgencyPaid,
  pendingDeclarationLabel, pendingErrorLabel,
  type PendingAgencyRow, type PendingOnlinePayment,
} from '@/lib/pending-api';

export default function AdminPendingPage() {
  const queue = usePendingAgencies();
  const activate = useActivatePendingAgency();
  const activatePaid = useActivatePendingAgencyPaid();
  const reject = useRejectPendingAgency();
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  // Motif de refus saisi, par agence.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<string | null>(null);

  const rows = (queue.data?.agencies ?? []).filter((row) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [row.agency_name, row.slug ?? '', row.city ?? '', row.owner_email ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  // SASPAY : intentions de paiement en ligne « installation » des dossiers
  // affichés (RLS : administrateur plateforme).
  const pendingIds = (queue.data?.agencies ?? []).map((row) => row.agency_id);
  const onlinePayments = usePendingOnlinePayments(pendingIds, !queue.isLoading && !queue.error);
  const onlineByAgency = new Map<string, PendingOnlinePayment>();
  for (const payment of onlinePayments.data ?? []) {
    if (!onlineByAgency.has(payment.agency_id)) onlineByAgency.set(payment.agency_id, payment);
  }

  const onActivate = async (row: PendingAgencyRow) => {
    setNotice('');
    setNoticeError(false);
    try {
      const result = await activate.mutateAsync(row.agency_id);
      setNotice(
        `« ${row.agency_name} » validée : offre ${result.plan_name} active jusqu’au ${dateLabel(result.ends_at)}. Le tableau de bord de l’agence est ouvert.`,
      );
    } catch (error) {
      setNoticeError(true);
      setNotice(pendingErrorLabel(error, 'valider cette agence'));
    }
  };

  // SASPAY : le paiement d'installation a été confirmé EN LIGNE → cette
  // validation encaisse l'intention et ouvre le dashboard (barrière unique :
  // un double clic ne double jamais l'encaissement).
  const onActivatePaid = async (row: PendingAgencyRow) => {
    setNotice('');
    setNoticeError(false);
    try {
      const result = await activatePaid.mutateAsync(row.agency_id);
      setNotice(
        `« ${row.agency_name} » validée avec paiement en ligne encaissé${
          result.ends_at ? ` : offre active jusqu’au ${dateLabel(result.ends_at)}` : ''
        }. Le tableau de bord de l’agence est ouvert.`,
      );
    } catch (error) {
      setNoticeError(true);
      setNotice(pendingErrorLabel(error, 'valider avec le paiement en ligne'));
    }
  };

  const onReject = async (row: PendingAgencyRow) => {
    const reason = (reasons[row.agency_id] ?? '').trim();
    if (!reason) {
      setNoticeError(true);
      setNotice('Le motif de refus est obligatoire : il est affiché à l’agence.');
      return;
    }
    setNotice('');
    setNoticeError(false);
    try {
      await reject.mutateAsync({ agencyId: row.agency_id, reason });
      setReasons((prev) => ({ ...prev, [row.agency_id]: '' }));
      setRejecting(null);
      setNotice(`Refus enregistré pour « ${row.agency_name} ». L’agence verra le motif à sa prochaine connexion.`);
    } catch (error) {
      setNoticeError(true);
      setNotice(pendingErrorLabel(error, 'refuser cette agence'));
    }
  };

  return (
    <>
      <AdminHeading
        eyebrow="Mise en service"
        title="Agences en attente de validation"
        description="Offre choisie, montant dû et paiement déclaré. La validation crée l’abonnement actif et ouvre le tableau de bord de l’agence."
      />

      {notice && (
        <div className={`notice-box${noticeError ? ' is-error' : ''}`} role={noticeError ? 'alert' : 'status'} data-testid="status-pending-admin-notice">
          {noticeError ? <AlertTriangle size={15} /> : <BadgeCheck size={15} />}
          <span>{notice}</span>
        </div>
      )}

      <div className="list-toolbar">
        <div className="list-search">
          <Search size={14} />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Rechercher une agence, une ville, un e-mail…"
            data-testid="input-pending-search"
          />
        </div>
        <span className="status-tag" data-testid="count-pending">
          {queue.data?.total ?? 0} dossier(s) en attente
        </span>
      </div>

      {queue.isLoading ? (
        <LoadingRows label="Chargement des agences en attente" />
      ) : queue.error ? (
        <ErrorState error={queue.error} retry={useSafeRetry(queue)} testId="status-pending-error" />
      ) : rows.length === 0 ? (
        <div className="state-card" data-testid="status-pending-empty">
          <div className="state-icon"><Building2 size={19} /></div>
          <h2>Aucune agence en attente</h2>
          <p>
            {search.trim()
              ? 'Aucun dossier ne correspond à votre recherche.'
              : 'Toutes les agences créées ont déjà été traitées. Les nouvelles inscriptions apparaîtront ici avec leur offre choisie et leur paiement déclaré.'}
          </p>
        </div>
      ) : (
        <div className="pending-admin-list">
          {rows.map((row) => {
            const declaration = row.latest_declaration;
            const busy = activate.isPending || activatePaid.isPending || reject.isPending;
            // SASPAY : intention d'installation en ligne rattachée à ce dossier.
            const online = onlineByAgency.get(row.agency_id) ?? null;
            const onlineReady = online?.status === 'paid' && !online.reconciled_at;
            return (
              <article className="panel pending-admin-card" key={row.agency_id} data-testid={`card-pending-${row.slug ?? row.agency_id}`}>
                <header className="pending-admin-head">
                  <div>
                    <h3>{row.agency_name}</h3>
                    <p>
                      {row.city ? `${row.city} · ` : ''}créée le {dateLabel(row.created_at)}
                      {row.owner_email ? ` · ${row.owner_email}` : ''}
                    </p>
                  </div>
                  <span className="status-tag" data-testid="badge-pending-admin">
                    <Clock3 size={12} /> En attente
                  </span>
                </header>

                <div className="pending-admin-grid">
                  <div className="pending-admin-cell" data-testid="display-pending-plan">
                    <span>Offre choisie</span>
                    <strong>{row.plan_display_name ?? row.plan_name ?? 'Aucune offre choisie'}</strong>
                    <small>
                      {row.price_monthly != null
                        ? `${cash(Number(row.price_monthly), row.currency ?? 'XOF')} / mois · installation ${cash(Number(row.setup_fee ?? 0), row.currency ?? 'XOF')}`
                        : '—'}
                    </small>
                  </div>
                  <div className="pending-admin-cell" data-testid="display-pending-amount">
                    <span>Montant attendu</span>
                    <strong>{cash(Number(row.amount_due ?? 0), row.currency ?? 'XOF')}</strong>
                    <small>Installation + premier mois</small>
                  </div>
                  <div className="pending-admin-cell" data-testid="display-pending-payment">
                    <span>Paiement déclaré</span>
                    <strong>
                      {declaration
                        ? `${cash(Number(declaration.amount), 'XOF')} · ${declaration.method === 'wave' ? 'Wave' : 'Orange Money'}`
                        : 'Aucun paiement déclaré'}
                    </strong>
                    <small>
                      {declaration
                        ? `${pendingDeclarationLabel(declaration.status)} · réf. ${declaration.transaction_reference}${declaration.paid_on ? ` · payé le ${dateLabel(declaration.paid_on)}` : ''}`
                        : 'L’agence n’a pas encore soumis de déclaration'}
                    </small>
                    {online && (
                      <small data-testid="display-pending-online-payment">
                        {onlineReady
                          ? `Paiement en ligne reçu : ${cash(Number(online.amount), online.currency)} — prêt à valider${online.transaction_reference ? ` · réf. ${online.transaction_reference}` : ''}`
                          : online.status === 'pending'
                            ? `Paiement en ligne en cours : ${cash(Number(online.amount), online.currency)} (page de paiement ouverte)`
                            : online.status === 'paid'
                              ? `Paiement en ligne déjà encaissé${online.reconciled_at ? ` le ${dateLabel(online.reconciled_at)}` : ''}`
                              : `Paiement en ligne : ${online.status}`}
                      </small>
                    )}
                  </div>
                </div>

                {row.pending_note && (
                  <p className="pending-admin-note" data-testid="display-pending-note">
                    <AlertTriangle size={13} /> Dernier motif communiqué : {row.pending_note}
                  </p>
                )}

                {declaration?.status === 'pending' && (
                  <p className="pending-admin-note is-info">
                    <CreditCard size={13} /> Une déclaration est en attente dans la file
                    « Paiements à valider ». Valider l’agence ici crée l’abonnement ;
                    approuver aussi la déclaration prolongera l’échéance.
                  </p>
                )}

                {online?.status === 'pending' && (
                  <p className="pending-admin-note is-info" data-testid="status-pending-online-waiting">
                    <CreditCard size={13} /> Un paiement en ligne est en cours pour ce
                    dossier : dès qu’il est confirmé, le bouton « Paiement reçu —
                    valider et ouvrir » apparaît ici.
                  </p>
                )}

                <div className="pending-admin-actions">
                  {onlineReady ? (
                    <Button
                      type="button"
                      onClick={() => void onActivatePaid(row)}
                      disabled={busy}
                      data-testid={`button-activate-paid-${row.slug ?? row.agency_id}`}
                    >
                      <CreditCard size={15} />
                      {activatePaid.isPending ? 'Validation…' : 'Paiement reçu — valider et ouvrir'}
                    </Button>
                  ) : null}

                  <Button
                    type="button"
                    variant={onlineReady ? 'outline' : undefined}
                    onClick={() => void onActivate(row)}
                    disabled={busy || activate.isPending}
                    data-testid={`button-activate-${row.slug ?? row.agency_id}`}
                  >
                    <BadgeCheck size={15} />
                    {activate.isPending
                      ? 'Validation…'
                      : onlineReady
                        ? 'Valider sans paiement en ligne'
                        : 'Valider et ouvrir le dashboard'}
                  </Button>

                  {rejecting === row.agency_id ? (
                    <div className="pending-admin-reject">
                      <Input
                        value={reasons[row.agency_id] ?? ''}
                        onChange={(event) => setReasons((prev) => ({ ...prev, [row.agency_id]: event.target.value }))}
                        placeholder="Motif du refus (affiché à l’agence) — obligatoire"
                        data-testid={`input-reject-reason-${row.slug ?? row.agency_id}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void onReject(row)}
                        disabled={busy}
                        data-testid={`button-reject-confirm-${row.slug ?? row.agency_id}`}
                      >
                        <XCircle size={15} /> {reject.isPending ? 'Refus…' : 'Confirmer le refus'}
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setRejecting(null)} disabled={busy}>
                        Annuler
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setRejecting(row.agency_id)}
                      disabled={busy}
                      data-testid={`button-reject-${row.slug ?? row.agency_id}`}
                    >
                      <XCircle size={15} /> Refuser avec motif
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
