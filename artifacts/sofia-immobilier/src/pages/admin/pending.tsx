// =============================================================================
// LOT 1 — ADMIN : INSTALLATIONS PHYSIQUES & ACTIVATION DES AGENCES (`pending`)
// =============================================================================
// Flux opérationnel côté administrateur :
//   1. Consulter les nouvelles agences inscrites (`status = 'pending'`), leur
//      offre choisie (Essentiel / Pro / Premium) et leurs coordonnées sur site.
//   2. Modifier l'offre si nécessaire (`admin_set_pending_agency_plan`) — seul
//      l'administrateur peut changer l'offre lorsque les frais d'installation
//      diffèrent (Décision métier 1).
//   3. Enregistrer l'encaissement physique des frais d'installation (150 000 /
//      250 000 / 400 000 FCFA, hors SasPay et hors abonnements récurrents) et
//      valider la réalisation de l'installation (`admin_record_physical_installation`).
//   4. Cliquer sur « Activer l'agence » (`admin_activate_pending_agency`) :
//      démarre automatiquement les 14 jours d'essai gratuit (J0 → J14) avec
//      100 % des quotas et fonctionnalités de l'offre choisie.
// =============================================================================
import { useState } from 'react';
import {
  AlertTriangle, BadgeCheck, Building2, CheckCircle2, Clock3, MapPin,
  MessageSquareWarning, Phone, Search, Sparkles, Wallet, Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { AdminHeading } from './admin-shell';
import { ErrorState, LoadingRows, cash, dateLabel, dateTimeLabel, useSafeRetry } from '@/lib/workspace-ui';
import {
  installationStatusLabel,
  pendingErrorLabel,
  PHYSICAL_INSTALLATION_METHODS,
  physicalInstallationMethodLabel,
  useActivatePendingAgency,
  useAdminRecordPhysicalInstallation,
  useAdminSetPendingAgencyPlan,
  usePendingAgencies,
  usePublicPlansCatalog,
  useRejectPendingAgency,
  type PendingAgencyRow,
  type PhysicalInstallationMethod,
} from '@/lib/pending-api';

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function AdminPendingPage() {
  const queue = usePendingAgencies();
  const plans = usePublicPlansCatalog();
  const recordInstall = useAdminRecordPhysicalInstallation();
  const setPendingPlan = useAdminSetPendingAgencyPlan();
  const activate = useActivatePendingAgency();
  const sendNote = useRejectPendingAgency();

  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);

  // Modale d'enregistrement de l'installation physique
  const [installTarget, setInstallTarget] = useState<PendingAgencyRow | null>(null);
  const [collectedAmount, setCollectedAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PhysicalInstallationMethod>('cash');
  const [receiptReference, setReceiptReference] = useState('');
  const [collectedOn, setCollectedOn] = useState(todayIso());
  const [installCompleted, setInstallCompleted] = useState(true);
  const [installNote, setInstallNote] = useState('');
  const [installError, setInstallError] = useState('');

  // Modale de changement d'offre par l'administrateur
  const [planTarget, setPlanTarget] = useState<PendingAgencyRow | null>(null);
  const [nextPlanId, setNextPlanId] = useState('');
  const [planReason, setPlanReason] = useState('');
  const [planError, setPlanError] = useState('');

  // Modale de confirmation d'activation (« Activer l'agence » -> 14j d'essai)
  const [activateTarget, setActivateTarget] = useState<PendingAgencyRow | null>(null);
  const [activationNote, setActivationNote] = useState('');
  const [activateError, setActivateError] = useState('');

  // Envoi d'une note d'attente au dossier agence
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notingAgencyId, setNotingAgencyId] = useState<string | null>(null);

  const allRows = queue.data?.agencies ?? [];
  const rows = allRows.filter((row) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [
      row.agency_name,
      row.legal_name ?? '',
      row.slug ?? '',
      row.city ?? '',
      row.owner_name ?? '',
      row.owner_email ?? '',
      row.agency_phone ?? '',
      row.plan_display_name ?? '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });

  const readyCount = allRows.filter((r) => r.installation_status === 'completed').length;
  const pendingInstallCount = allRows.length - readyCount;
  const expectedInstallTotal = allRows.reduce((acc, r) => acc + Number(r.setup_fee ?? r.amount_due ?? 0), 0);

  const openInstallDialog = (row: PendingAgencyRow) => {
    setInstallTarget(row);
    setCollectedAmount(
      String(Math.round(Number(row.installation_amount_collected ?? row.setup_fee ?? row.amount_due ?? 0))),
    );
    setPaymentMethod((row.installation_payment_method as PhysicalInstallationMethod) || 'cash');
    setReceiptReference(row.installation_receipt_reference ?? '');
    setCollectedOn(todayIso());
    setInstallCompleted(row.installation_status ? row.installation_status === 'completed' : true);
    setInstallNote(row.installation_note ?? '');
    setInstallError('');
  };

  const submitInstall = async () => {
    if (!installTarget) return;
    setInstallError('');
    const parsedAmount = Number(collectedAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      setInstallError('Veuillez saisir un montant encaissé valide (≥ 0 FCFA).');
      return;
    }
    try {
      const res = await recordInstall.mutateAsync({
        agencyId: installTarget.agency_id,
        collectedAmount: parsedAmount,
        paymentMethod,
        receiptReference: receiptReference.trim() || null,
        installationCompleted: installCompleted,
        collectedOn,
        note: installNote.trim() || null,
      });
      setNoticeError(false);
      setNotice(
        res.installation_status === 'completed'
          ? `Installation physique enregistrée pour « ${installTarget.agency_name} » (${cash(res.collected_amount, res.currency)} · reçu ${res.receipt_reference}). Vous pouvez maintenant activer l’agence.`
          : `Encaissement physique enregistré pour « ${installTarget.agency_name} » (${cash(res.collected_amount, res.currency)}). Cochez l’installation réalisée dès la fin du déploiement pour activer l’agence.`,
      );
      setInstallTarget(null);
    } catch (err) {
      setInstallError(pendingErrorLabel(err, 'enregistrer l’installation physique'));
    }
  };

  const openPlanDialog = (row: PendingAgencyRow) => {
    setPlanTarget(row);
    setNextPlanId(row.pending_plan_id ?? (plans.data?.[0]?.id ?? ''));
    setPlanReason('');
    setPlanError('');
  };

  const submitPlanChange = async () => {
    if (!planTarget || !nextPlanId) return;
    setPlanError('');
    try {
      const res = await setPendingPlan.mutateAsync({
        agencyId: planTarget.agency_id,
        planId: nextPlanId,
        note: planReason.trim() || null,
      });
      setNoticeError(false);
      setNotice(
        `Offre de « ${planTarget.agency_name} » mise à jour : ${res.plan_name} (installation physique : ${cash(res.setup_fee, 'XOF')} · abonnement après essai : ${cash(res.price_monthly, 'XOF')}/mois).`,
      );
      setPlanTarget(null);
    } catch (err) {
      setPlanError(pendingErrorLabel(err, 'modifier l’offre du dossier'));
    }
  };

  const openActivateDialog = (row: PendingAgencyRow) => {
    setActivateTarget(row);
    setActivationNote('');
    setActivateError('');
  };

  const confirmActivation = async () => {
    if (!activateTarget) return;
    setActivateError('');
    try {
      const result = await activate.mutateAsync({
        agencyId: activateTarget.agency_id,
        note: activationNote.trim() || null,
      });
      setNoticeError(false);
      setNotice(
        `Agence « ${activateTarget.agency_name} » activée sur l’offre ${result.plan_name} : ${result.trial_days} jours d’essai gratuit ouverts jusqu’au ${dateLabel(result.trial_ends_at)} avec accès 100 % complet.`,
      );
      setActivateTarget(null);
    } catch (error) {
      setActivateError(pendingErrorLabel(error, 'activer cette agence'));
    }
  };

  const onSendFolderNote = async (row: PendingAgencyRow) => {
    const reason = (reasons[row.agency_id] ?? '').trim();
    if (!reason) {
      setNoticeError(true);
      setNotice('Veuillez saisir le message à afficher sur l’écran d’attente de l’agence.');
      return;
    }
    setNotice('');
    setNoticeError(false);
    try {
      await sendNote.mutateAsync({ agencyId: row.agency_id, reason });
      setReasons((prev) => ({ ...prev, [row.agency_id]: '' }));
      setNotingAgencyId(null);
      setNotice(`Note transmise au dossier « ${row.agency_name} ».`);
    } catch (error) {
      setNoticeError(true);
      setNotice(pendingErrorLabel(error, 'transmettre la note au dossier'));
    }
  };

  return (
    <>
      <AdminHeading
        eyebrow="Mise en service"
        title="Installations physiques & activations d’agences"
        description="Enregistrez l’encaissement physique des frais d’installation (comptabilisé séparément des abonnements), puis cliquez sur « Activer l’agence » pour démarrer automatiquement les 14 jours d’essai gratuit."
      />

      {/* Bandeau KPI du flux d'installation */}
      <div className="kpi-grid" style={{ marginBottom: 18 }} data-testid="kpis-admin-pending">
        <div className="kpi-card">
          <span className="kpi-label">Dossiers en attente</span>
          <strong className="kpi-value" data-testid="kpi-pending-total">{allRows.length}</strong>
          <small className="kpi-sub">Statut pending · aucun accès métier ouvert</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Installations à réaliser</span>
          <strong className="kpi-value" data-testid="kpi-pending-to-install">{pendingInstallCount}</strong>
          <small className="kpi-sub">Déploiement sur site & encaissement physique</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Prêtes à activer (14j d’essai)</span>
          <strong className="kpi-value" data-testid="kpi-pending-ready">{readyCount}</strong>
          <small className="kpi-sub">Installation physique validée</small>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Frais d’installation attendus</span>
          <strong className="kpi-value" data-testid="kpi-pending-expected-fees">
            {cash(expectedInstallTotal, 'XOF')}
          </strong>
          <small className="kpi-sub">Ligne « Installations physiques » (hors SasPay)</small>
        </div>
      </div>

      {notice && (
        <div
          className={`notice-box${noticeError ? ' is-error' : ''}`}
          role={noticeError ? 'alert' : 'status'}
          data-testid="status-pending-admin-notice"
        >
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
            placeholder="Rechercher une agence, une ville, un propriétaire, une offre…"
            data-testid="input-pending-search"
          />
        </div>
        <span className="status-tag" data-testid="count-pending">
          {queue.data?.total ?? 0} dossier(s) en attente
        </span>
      </div>

      {queue.isLoading ? (
        <LoadingRows label="Chargement des dossiers d’agences en attente" />
      ) : queue.error ? (
        <ErrorState error={queue.error} retry={useSafeRetry(queue)} testId="status-pending-error" />
      ) : rows.length === 0 ? (
        <div className="state-card" data-testid="status-pending-empty">
          <div className="state-icon"><Building2 size={19} /></div>
          <h2>Aucune agence en attente d’activation</h2>
          <p>
            {search.trim()
              ? 'Aucun dossier ne correspond à votre recherche.'
              : 'Toutes les agences inscrites ont été installées et activées. Les nouvelles demandes apparaîtront ici avec leur offre retenue et leurs coordonnées sur site.'}
          </p>
        </div>
      ) : (
        <div className="pending-admin-list">
          {rows.map((row) => {
            const isInstalled = row.installation_status === 'completed';
            const isPaidPending = row.installation_status === 'paid_pending_setup';
            const busy =
              activate.isPending ||
              recordInstall.isPending ||
              setPendingPlan.isPending ||
              sendNote.isPending;

            return (
              <article
                className="panel pending-admin-card"
                key={row.agency_id}
                data-testid={`card-pending-${row.slug ?? row.agency_id}`}
              >
                <header className="pending-admin-head">
                  <div>
                    <h3>{row.agency_name}</h3>
                    <p>
                      {row.legal_name ? `${row.legal_name} · ` : ''}
                      {[row.address, row.city, row.country].filter(Boolean).join(', ') || 'Localisation non précisée'}
                      {' · '}inscrite le {dateLabel(row.created_at)}
                    </p>
                    <p style={{ fontSize: 12.5, opacity: 0.85, marginTop: 2 }}>
                      {row.owner_name ? `${row.owner_name} · ` : ''}
                      {row.owner_email ?? row.agency_email ?? 'E-mail non renseigné'}
                      {(row.agency_phone || row.owner_phone) && (
                        <> · <Phone size={11} style={{ display: 'inline' }} /> {row.agency_phone ?? row.owner_phone}</>
                      )}
                    </p>
                  </div>
                  <span
                    className={`status-tag${isInstalled ? ' is-ok' : ''}`}
                    data-testid="badge-pending-admin"
                  >
                    {isInstalled ? <CheckCircle2 size={12} /> : <Clock3 size={12} />}{' '}
                    {installationStatusLabel(row.installation_status)}
                  </span>
                </header>

                <div className="pending-admin-grid">
                  <div className="pending-admin-cell" data-testid="display-pending-plan">
                    <span>Offre retenue</span>
                    <strong>{row.plan_display_name ?? row.plan_name ?? 'Aucune offre choisie'}</strong>
                    <small>
                      {row.price_monthly != null
                        ? `${cash(Number(row.price_monthly), row.currency ?? 'XOF')} / mois après les 14 jours d’essai`
                        : 'Sélectionnez une offre avant l’installation'}
                    </small>
                    <div style={{ marginTop: 6 }}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openPlanDialog(row)}
                        disabled={busy}
                        data-testid={`button-change-pending-plan-${row.slug ?? row.agency_id}`}
                      >
                        <Sparkles size={13} /> Modifier l’offre (Admin)
                      </Button>
                    </div>
                  </div>

                  <div className="pending-admin-cell" data-testid="display-pending-amount">
                    <span>Frais d’installation physique</span>
                    <strong>{cash(Number(row.setup_fee ?? row.amount_due ?? 0), row.currency ?? 'XOF')}</strong>
                    <small>Encaissement physique sur site · séparé des abonnements</small>
                  </div>

                  <div className="pending-admin-cell" data-testid="display-pending-installation">
                    <span>État de l’installation sur site</span>
                    <strong>
                      {isInstalled && row.installation_amount_collected != null
                        ? `${cash(Number(row.installation_amount_collected), row.currency ?? 'XOF')} encaissés`
                        : isPaidPending && row.installation_amount_collected != null
                          ? `${cash(Number(row.installation_amount_collected), row.currency ?? 'XOF')} reçus · pose en cours`
                          : 'Non enregistrée'}
                    </strong>
                    <small>
                      {row.installation_receipt_reference
                        ? `${physicalInstallationMethodLabel(row.installation_payment_method)} · reçu ${row.installation_receipt_reference}${row.installation_completed_at ? ` · le ${dateTimeLabel(row.installation_completed_at)}` : ''}`
                        : 'Enregistrez le règlement physique et la mise en service avant activation'}
                    </small>
                  </div>
                </div>

                {row.pending_note && (
                  <p className="pending-admin-note" data-testid="display-pending-note">
                    <AlertTriangle size={13} /> Note transmise au dossier : {row.pending_note}
                  </p>
                )}

                {row.installation_note && (
                  <p className="pending-admin-note is-info">
                    <MapPin size={13} /> Note d’installation : {row.installation_note}
                  </p>
                )}

                <div className="pending-admin-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <Button
                    type="button"
                    variant={isInstalled ? 'outline' : 'default'}
                    onClick={() => openInstallDialog(row)}
                    disabled={busy}
                    data-testid={`button-record-install-${row.slug ?? row.agency_id}`}
                  >
                    <Wrench size={15} />
                    {isInstalled ? 'Modifier le reçu d’installation' : '1. Enregistrer l’installation physique'}
                  </Button>

                  <Button
                    type="button"
                    onClick={() => openActivateDialog(row)}
                    disabled={busy || !isInstalled}
                    title={
                      isInstalled
                        ? 'Ouvre immédiatement les 14 jours d’essai gratuit de l’offre choisie'
                        : 'Enregistrez d’abord l’installation physique sur site avant d’activer l’agence'
                    }
                    data-testid={`button-activate-${row.slug ?? row.agency_id}`}
                  >
                    <BadgeCheck size={15} />
                    Activer l’agence (démarrer 14j d’essai)
                  </Button>

                  {notingAgencyId === row.agency_id ? (
                    <div className="pending-admin-reject">
                      <Input
                        value={reasons[row.agency_id] ?? ''}
                        onChange={(event) =>
                          setReasons((prev) => ({ ...prev, [row.agency_id]: event.target.value }))
                        }
                        placeholder="Message ou précision à afficher à l’agence…"
                        data-testid={`input-reject-reason-${row.slug ?? row.agency_id}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void onSendFolderNote(row)}
                        disabled={busy}
                        data-testid={`button-reject-confirm-${row.slug ?? row.agency_id}`}
                      >
                        {sendNote.isPending ? 'Envoi…' : 'Envoyer la note'}
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setNotingAgencyId(null)} disabled={busy}>
                        Annuler
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setNotingAgencyId(row.agency_id)}
                      disabled={busy}
                      data-testid={`button-reject-${row.slug ?? row.agency_id}`}
                    >
                      <MessageSquareWarning size={15} /> Envoyer une note au dossier
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* --- Modale : Enregistrer l'installation physique ------------------ */}
      <Dialog open={Boolean(installTarget)} onOpenChange={(open) => !open && setInstallTarget(null)}>
        <DialogContent className="form-dialog" data-testid="dialog-record-installation">
          <DialogHeader>
            <span className="form-kicker">Installation sur site · Hors SasPay</span>
            <DialogTitle>
              Enregistrer l’installation physique — {installTarget?.agency_name}
            </DialogTitle>
            <DialogDescription>
              Ce règlement est comptabilisé dans la ligne distincte{' '}
              <strong>« Installations physiques »</strong> et n’entre jamais dans le chiffre
              d’affaires des abonnements récurrents.
            </DialogDescription>
          </DialogHeader>

          {installTarget && (
            <div className="settings-form">
              <div className="notice-box" role="status">
                <Wallet size={15} />
                <span>
                  Offre retenue : <strong>{installTarget.plan_display_name ?? installTarget.plan_name}</strong> ·
                  Frais d’installation attendus :{' '}
                  <strong>{cash(Number(installTarget.setup_fee ?? installTarget.amount_due ?? 0), installTarget.currency ?? 'XOF')}</strong>
                </span>
              </div>

              <div className="form-grid">
                <div className="form-field">
                  <label className="form-label" htmlFor="install-amount">Montant physique encaissé (FCFA)</label>
                  <Input
                    id="install-amount"
                    type="number"
                    min="0"
                    step="1000"
                    value={collectedAmount}
                    onChange={(e) => setCollectedAmount(e.target.value)}
                    data-testid="input-install-amount"
                  />
                </div>
                <div className="form-field">
                  <label className="form-label" htmlFor="install-date">Date d’encaissement</label>
                  <Input
                    id="install-date"
                    type="date"
                    value={collectedOn}
                    onChange={(e) => setCollectedOn(e.target.value)}
                    data-testid="input-install-date"
                  />
                </div>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="install-method">Mode d’encaissement physique</label>
                <select
                  id="install-method"
                  className="select-input"
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PhysicalInstallationMethod)}
                  data-testid="select-install-method"
                  style={{ width: '100%', height: 40, borderRadius: 8, padding: '0 10px', border: '1px solid var(--si-border)' }}
                >
                  {PHYSICAL_INSTALLATION_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="install-receipt">
                  Référence du reçu physique (générée automatiquement si vide)
                </label>
                <Input
                  id="install-receipt"
                  value={receiptReference}
                  onChange={(e) => setReceiptReference(e.target.value)}
                  placeholder="Ex. RECU-BMK-2026-014"
                  data-testid="input-install-receipt"
                />
              </div>

              <div className="form-field">
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={installCompleted}
                    onChange={(e) => setInstallCompleted(e.target.checked)}
                    data-testid="checkbox-install-completed"
                  />
                  <span>Installation physique sur site terminée et opérationnelle (autorise l’activation)</span>
                </label>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="install-note">Observation / note d’intervention (optionnel)</label>
                <Textarea
                  id="install-note"
                  value={installNote}
                  onChange={(e) => setInstallNote(e.target.value)}
                  placeholder="Ex. Déploiement réalisé à ACI 2000, équipe formée…"
                  data-testid="input-install-note"
                />
              </div>

              {installError && (
                <p className="form-error" role="alert" data-testid="status-install-error">{installError}</p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setInstallTarget(null)} disabled={recordInstall.isPending}>
              Annuler
            </Button>
            <Button type="button" onClick={() => void submitInstall()} disabled={recordInstall.isPending} data-testid="button-confirm-install">
              <CheckCircle2 size={15} />
              {recordInstall.isPending ? 'Enregistrement…' : 'Enregistrer l’installation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Modale : Modifier l'offre avant activation (Admin uniquement) -- */}
      <Dialog open={Boolean(planTarget)} onOpenChange={(open) => !open && setPlanTarget(null)}>
        <DialogContent className="form-dialog" data-testid="dialog-admin-pending-plan">
          <DialogHeader>
            <span className="form-kicker">Administration · Décision métier 1</span>
            <DialogTitle>Modifier l’offre du dossier — {planTarget?.agency_name}</DialogTitle>
            <DialogDescription>
              Pendant la phase d’attente et les 14 jours d’essai, seul l’administrateur peut
              modifier l’offre afin d’ajuster les frais d’installation physique correspondants.
            </DialogDescription>
          </DialogHeader>

          <div className="settings-form">
            <div className="form-field">
              <label className="form-label" htmlFor="pending-admin-plan-select">Nouvelle offre</label>
              <select
                id="pending-admin-plan-select"
                value={nextPlanId}
                onChange={(e) => setNextPlanId(e.target.value)}
                data-testid="select-admin-pending-plan"
                style={{ width: '100%', height: 40, borderRadius: 8, padding: '0 10px', border: '1px solid var(--si-border)' }}
              >
                {(plans.data ?? []).map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.display_name} — Installation {cash(pl.setup_fee, pl.currency)} · {cash(pl.price_monthly, pl.currency)}/mois après essai
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="pending-admin-plan-reason">Motif / note (journalisé)</label>
              <Input
                id="pending-admin-plan-reason"
                value={planReason}
                onChange={(e) => setPlanReason(e.target.value)}
                placeholder="Ex. Ajustement convenu lors du rendez-vous d’installation"
                data-testid="input-admin-pending-plan-reason"
              />
            </div>
            {planError && <p className="form-error" role="alert">{planError}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPlanTarget(null)} disabled={setPendingPlan.isPending}>
              Annuler
            </Button>
            <Button
              type="button"
              onClick={() => void submitPlanChange()}
              disabled={setPendingPlan.isPending || !nextPlanId}
              data-testid="button-confirm-admin-pending-plan"
            >
              {setPendingPlan.isPending ? 'Mise à jour…' : 'Appliquer l’offre'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --- Modale : Confirmation « Activer l'agence » (14j d'essai) ------- */}
      <Dialog open={Boolean(activateTarget)} onOpenChange={(open) => !open && setActivateTarget(null)}>
        <DialogContent className="form-dialog" data-testid="dialog-confirm-activate">
          <DialogHeader>
            <span className="form-kicker">Activation administrative</span>
            <DialogTitle>Activer l’agence « {activateTarget?.agency_name} »</DialogTitle>
            <DialogDescription>
              Cette action ouvre immédiatement l’espace de travail de l’agence et démarre
              automatiquement sa période de <strong>14 jours d’essai gratuit</strong>.
            </DialogDescription>
          </DialogHeader>

          {activateTarget && (
            <div className="settings-form">
              <div className="review-list">
                <div>
                  <span>Offre activée</span>
                  <strong>{activateTarget.plan_display_name ?? activateTarget.plan_name}</strong>
                </div>
                <div>
                  <span>Installation physique</span>
                  <strong>
                    {cash(Number(activateTarget.installation_amount_collected ?? activateTarget.setup_fee ?? 0), activateTarget.currency ?? 'XOF')}
                    {activateTarget.installation_receipt_reference ? ` · Reçu ${activateTarget.installation_receipt_reference}` : ''}
                  </strong>
                </div>
                <div>
                  <span>Essai gratuit démarré</span>
                  <strong>14 jours complets (J0 → J14) · 100 % des quotas & modules</strong>
                </div>
                <div>
                  <span>À l’échéance des 14 jours</span>
                  <strong>
                    Abonnement récurrent à {cash(Number(activateTarget.price_monthly ?? 0), activateTarget.currency ?? 'XOF')} / mois (SasPay)
                  </strong>
                </div>
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="activate-note">Note d’activation (optionnel)</label>
                <Input
                  id="activate-note"
                  value={activationNote}
                  onChange={(e) => setActivationNote(e.target.value)}
                  placeholder="Ex. Mise en service validée avec le gérant"
                  data-testid="input-activate-note"
                />
              </div>

              {activateError && (
                <p className="form-error" role="alert" data-testid="status-activate-error">{activateError}</p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setActivateTarget(null)} disabled={activate.isPending}>
              Annuler
            </Button>
            <Button
              type="button"
              onClick={() => void confirmActivation()}
              disabled={activate.isPending}
              data-testid="button-confirm-activate"
            >
              <BadgeCheck size={15} />
              {activate.isPending ? 'Activation en cours…' : 'Activer l’agence'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
