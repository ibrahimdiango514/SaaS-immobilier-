// =============================================================================
// FACTURATION — couche d'accès unique (agence + administration)
// =============================================================================
// PRINCIPE : le navigateur ne décide de rien. Aucune écriture directe dans
// `payment_declarations` ni `agency_subscriptions` : toutes les opérations
// passent par les RPC SECURITY DEFINER, qui portent leur propre garde
// d'autorisation et valident le montant, la référence et les statuts.
//
//   public.agency_payment_access         lecture agence (offres, instructions,
//                                        demandes, abonnement, échéance)
//   public.agency_create_payment_request créer la demande + référence serveur
//   public.agency_submit_payment_proof   transmettre la preuve de paiement
//   public.agency_cancel_payment_request annuler une demande
//   public.admin_payment_queue           file admin filtrée
//   public.admin_payment_detail          détail + historique des décisions
//   public.admin_review_payment          approuver / refuser / corriger
//   public.admin_save_payment_methods    configurer Orange/Moov/Wave
//
// Aucune clé service_role, aucun secret : uniquement la session de l'utilisateur.
// =============================================================================
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type PaymentMethodCode = 'orange_money' | 'moov_money' | 'wave';

export type PaymentRequestStatus =
  | 'awaiting_payment'
  | 'pending'
  | 'correction_requested'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface PaymentMethodConfig {
  code: PaymentMethodCode;
  label: string;
  beneficiary: string;
  number: string;
  instructions: string;
  enabled: boolean;
  configured: boolean;
  reference_required: boolean;
  proof_required: boolean;
}

export interface PaymentConfig {
  methods: Record<PaymentMethodCode, PaymentMethodConfig>;
  method_order: PaymentMethodCode[];
  proof_required: boolean;
  note: string;
  configured_count: number;
  any_configured: boolean;
}

export interface PlanOption {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  price_monthly: number;
  currency: string;
  setup_fee: number;
  max_members: number;
  max_properties: number;
  max_photos_per_property: number;
  monthly_agent_messages: number;
  modules: string[] | null;
  features: Record<string, boolean> | null;
  sort_order: number;
  is_current: boolean;
}

export interface PaymentRequestRow {
  id: string;
  reference: string | null;
  plan_id: string | null;
  plan_name: string | null;
  expected_amount: number | null;
  amount: number | null;
  currency: string;
  duration_months: number;
  method: string | null;
  transaction_reference: string | null;
  paid_on: string | null;
  payer_name: string | null;
  status: PaymentRequestStatus;
  note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  payment_id: string | null;
  has_proof: boolean;
  proof_path: string | null;
}

export interface BillingState {
  has_due_date: boolean;
  grace_days: number;
  is_due_soon: boolean;
  is_overdue: boolean;
  is_past_grace?: boolean;
  days_to_due?: number;
  ends_at?: string | null;
  sub_status?: string;
  in_valid_trial?: boolean;
}

export interface AgencyBilling {
  agency_id: string;
  can_manage: boolean;
  is_owner: boolean;
  instructions: Record<string, unknown>;
  payment_config: PaymentConfig;
  grace_days: number;
  durations: number[];
  billing: BillingState;
  plans: PlanOption[];
  subscription: {
    id: string;
    status: string;
    starts_at: string;
    ends_at: string | null;
    trial_ends_at: string | null;
  } | null;
  plan: {
    id: string;
    name: string;
    display_name: string;
    price_monthly: number;
    setup_fee: number;
    currency: string;
  } | null;
  expected_amount: number;
  requests: PaymentRequestRow[];
}

export interface AdminPaymentRow {
  id: string;
  reference: string | null;
  agency_id: string;
  agency_name: string;
  agency_slug: string;
  agency_status: string;
  status: PaymentRequestStatus;
  declared_amount: number | null;
  expected_amount: number | null;
  currency: string;
  duration_months: number;
  method: string | null;
  transaction_reference: string | null;
  paid_on: string | null;
  payer_name: string | null;
  proof_path: string | null;
  proof_mime: string | null;
  proof_size: number | null;
  note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  payment_id: string | null;
  plan_id: string | null;
  plan_name: string | null;
  subscription_status: string | null;
  subscription_ends_at: string | null;
  history_count: number;
}

export interface AdminQueueCounts {
  pending: number;
  correction_requested: number;
  approved: number;
  rejected: number;
  cancelled: number;
  expired: number;
}

export interface AdminQueueFilters {
  statuses?: PaymentRequestStatus[];
  agencyId?: string;
  method?: string;
  from?: string;
  to?: string;
  search?: string;
}

/** Le détail renvoyé par `admin_payment_detail` ne contient pas les champs
 *  d'agence (ils sont dans `agency`) : c'est une forme distincte de la file. */
export interface AdminPaymentRequestDetail {
  id: string;
  reference: string | null;
  status: PaymentRequestStatus;
  amount: number | null;
  expected_amount: number | null;
  currency: string;
  duration_months: number;
  plan_id: string | null;
  plan_name: string | null;
  method: string | null;
  transaction_reference: string | null;
  paid_on: string | null;
  payer_name: string | null;
  proof_path: string | null;
  proof_mime: string | null;
  proof_size: number | null;
  note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
  submitted_at: string | null;
  expires_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  payment_id: string | null;
  amount_matches: boolean;
}

export interface AdminPaymentDetail {
  request: AdminPaymentRequestDetail;
  agency: {
    id: string;
    name: string;
    slug: string;
    status: string;
    email: string | null;
    phone: string | null;
    city: string | null;
    created_at: string;
  };
  subscription: {
    id: string;
    status: string;
    starts_at: string;
    ends_at: string | null;
    trial_ends_at: string | null;
    plan_id: string;
  } | null;
  history: Array<{
    id: string;
    action: string;
    from_status: string | null;
    to_status: string | null;
    actor_kind: string | null;
    actor_label: string | null;
    note: string | null;
    amount: number | null;
    created_at: string;
  }>;
}

export type PaymentDecision = 'approved' | 'rejected' | 'correction_requested';

export interface ReviewResult {
  decision: PaymentDecision;
  id: string;
  reference: string | null;
  status: PaymentRequestStatus;
  payment_id?: string | null;
  plan_name?: string;
  amount?: number;
  currency?: string;
  previous_ends_at?: string | null;
  starts_at?: string;
  ends_at?: string;
  duration_months?: number;
  subscription_changed: boolean;
  note?: string | null;
}

/* ------------------------------------------------------------------ */
/* Libellés                                                            */
/* ------------------------------------------------------------------ */

export const METHOD_LABELS: Record<string, string> = {
  orange_money: 'Orange Money',
  moov_money: 'Moov Money',
  wave: 'Wave',
  manual: 'Virement manuel',
};

export const REQUEST_STATUS_LABELS: Record<PaymentRequestStatus, string> = {
  awaiting_payment: 'Paiement à effectuer',
  pending: 'En attente de vérification',
  correction_requested: 'Correction demandée',
  approved: 'Validé',
  rejected: 'Refusé',
  cancelled: 'Annulée',
  expired: 'Expirée',
};

export const REQUEST_STATUS_TONE: Record<PaymentRequestStatus, string> = {
  awaiting_payment: 'is-draft',
  pending: 'is-pending',
  correction_requested: 'is-warning',
  approved: 'is-approved',
  rejected: 'is-rejected',
  cancelled: 'is-cancelled',
  expired: 'is-expired',
};

/** Libellés du journal des décisions (`payment_decision_log.action`). */
export const DECISION_LABELS: Record<string, string> = {
  created: 'Demande créée',
  submitted: 'Preuve transmise',
  approved: 'Paiement validé',
  rejected: 'Paiement refusé',
  correction_requested: 'Correction demandée',
  cancelled: 'Demande annulée',
  expired: 'Demande expirée',
  reminder_sent: 'Rappel envoyé',
};

export const decisionLabel = (action: string) => DECISION_LABELS[action] ?? action;

export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  pending: 'En attente',
  trial: 'Essai',
  active: 'Active',
  past_due: 'En retard',
  expired: 'Expirée',
  suspended: 'Suspendue',
  cancelled: 'Résiliée',
};

export const methodLabel = (method?: string | null) =>
  method ? METHOD_LABELS[method] ?? method : '—';

export const requestStatusLabel = (status: string): string =>
  REQUEST_STATUS_LABELS[status as PaymentRequestStatus] ?? status;

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export const BILLING_ROOT = 'facturation' as const;

export const getAgencyBillingQueryKey = (agencyId?: string) =>
  [BILLING_ROOT, 'agence', agencyId] as const;
export const getAdminQueueQueryKey = (filters: AdminQueueFilters) =>
  [BILLING_ROOT, 'admin', 'file', filters] as const;
export const getAdminDetailQueryKey = (id?: string | null) =>
  [BILLING_ROOT, 'admin', 'detail', id] as const;

/** Invalide tout ce qui dépend d'une décision de facturation. */
export function invalidateBilling(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: [BILLING_ROOT] }),
    queryClient.invalidateQueries({ queryKey: ['paiements'] }),
    queryClient.invalidateQueries({ queryKey: ['admin'] }),
    queryClient.invalidateQueries({ queryKey: ['offre'] }),
    queryClient.invalidateQueries({ queryKey: ['plan'] }),
    queryClient.invalidateQueries({ queryKey: ['sofia'] }),
  ]);
}

/* ------------------------------------------------------------------ */
/* Lecture — agence                                                    */
/* ------------------------------------------------------------------ */

export function useAgencyBilling(agencyId?: string) {
  return useQuery({
    queryKey: getAgencyBillingQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<AgencyBilling> => {
      const { data, error } = await rpc().rpc('agency_payment_access', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return data as AgencyBilling;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Écritures — agence                                                  */
/* ------------------------------------------------------------------ */

export interface CreatedRequest {
  id: string;
  reference: string;
  expected_amount: number;
  currency: string;
  duration_months: number;
  expires_at: string;
  status: PaymentRequestStatus;
  reused: boolean;
}

export function useCreatePaymentRequest(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { planId: string; durationMonths?: number }): Promise<CreatedRequest> => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await rpc().rpc('agency_create_payment_request', {
        p_agency_id: agencyId,
        p_plan_id: input.planId,
        p_duration_months: input.durationMonths ?? 1,
      });
      if (error) throw error;
      return data as CreatedRequest;
    },
    onSuccess: async () => {
      await invalidateBilling(queryClient);
    },
  });
}

export interface ProofInput {
  requestId: string;
  method: PaymentMethodCode;
  amount: number;
  transactionReference: string;
  paidOn: string;
  payerName?: string;
  proof?: File | null;
}

/* Bucket privé existant : 5 Mo, jpeg/png/webp/pdf (réglé côté Storage). */
export const PAYMENT_PROOFS_BUCKET = 'payment-proofs';
export const MAX_PROOF_SIZE = 5 * 1024 * 1024;
export const SUPPORTED_PROOF_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
/** Extensions refusées côté client ; le serveur applique la même règle. */
const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|com|sh|js|jsx|ts|html?|php|py|msi|scr|ps1|jar|svg)$/i;

export function validateProofFile(file: File): string | null {
  if (BLOCKED_EXTENSIONS.test(file.name) || BLOCKED_EXTENSIONS.test(file.type)) {
    return 'Ce type de fichier est refusé. Utilisez une image ou un PDF.';
  }
  if (!SUPPORTED_PROOF_TYPES.has(file.type)) {
    return 'Format non accepté. Utilisez JPG, PNG, WebP ou PDF.';
  }
  if (file.size <= 0) return 'Le fichier est vide.';
  if (file.size > MAX_PROOF_SIZE) return 'Fichier trop lourd (5 Mo maximum).';
  return null;
}

function proofFileName(name: string) {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(-60) || 'justificatif'
  );
}

/** Normalisation identique à celle du serveur (`transaction_reference_norm`). */
const normalizeTransactionReference = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Relit la demande après un échec de `agency_submit_payment_proof` : si elle
 * est déjà « pending » avec la même référence de transaction, la soumission a
 * bien eu lieu (double clic) et il n'y a rien à recréer.
 */
async function readSubmittedState(
  input: ProofInput,
  agencyId?: string,
): Promise<{
  id: string;
  reference: string;
  status: PaymentRequestStatus;
  amount: number;
  currency: string;
  has_proof: boolean;
} | null> {
  if (!agencyId) return null;
  const { data, error } = await rpc().rpc('agency_payment_access', { p_agency_id: agencyId });
  if (error || !data) return null;
  const requests = ((data as AgencyBilling).requests ?? []) as PaymentRequestRow[];
  const row = requests.find((item) => item.id === input.requestId);
  if (!row || row.status !== 'pending' || !row.transaction_reference) return null;
  if (normalizeTransactionReference(row.transaction_reference) !== normalizeTransactionReference(input.transactionReference)) {
    return null;
  }
  return {
    id: row.id,
    reference: row.reference ?? '',
    status: row.status,
    amount: Number(row.amount ?? input.amount),
    currency: row.currency,
    has_proof: Boolean(row.has_proof),
  };
}

export function useSubmitPaymentProof(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProofInput) => {
      const client = getSupabaseClient();
      let proofPath: string | null = null;
      let proofMime: string | null = null;
      let proofSize: number | null = null;

      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new Error('Le montant doit être un nombre supérieur à zéro.');
      }
      if (!input.transactionReference.trim()) {
        throw new Error('La référence de la transaction est obligatoire.');
      }

      if (input.proof) {
        const invalid = validateProofFile(input.proof);
        if (invalid) throw new Error(invalid);
        // Premier dossier = UUID de l'agence : c'est ce que lit la politique
        // Storage `payment_proofs_owner_select` (public.storage_agency_id).
        if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
        proofPath = `${agencyId}/${crypto.randomUUID()}-${proofFileName(input.proof.name)}`;
        proofMime = input.proof.type;
        proofSize = input.proof.size;
        const { error: uploadError } = await client.storage
          .from(PAYMENT_PROOFS_BUCKET)
          .upload(proofPath, input.proof, {
            cacheControl: '3600',
            contentType: input.proof.type,
            upsert: false,
          });
        if (uploadError) {
          throw new Error(getSupabaseErrorMessage(uploadError, 'envoyer le justificatif'));
        }
      }

      const { data, error } = await rpc().rpc('agency_submit_payment_proof', {
        p_request_id: input.requestId,
        p_method: input.method,
        p_amount: input.amount,
        p_transaction_reference: input.transactionReference.trim(),
        p_paid_on: input.paidOn,
        p_payer_name: input.payerName?.trim() || null,
        p_proof_path: proofPath,
        p_proof_mime: proofMime,
        p_proof_size: proofSize,
        p_confirmed: true,
      });

      if (error) {
        // DOUBLE CLIC / REJEU RÉSEAU : la demande est peut-être déjà passée
        // « pending » par l'appel précédent (le serveur refuse alors toute
        // nouvelle preuve). On relit l'état réel : si la même référence de
        // transaction est enregistrée sur cette demande, c'est un succès —
        // aucune duplication n'est créée, et l'agence voit sa confirmation au
        // lieu d'une erreur incompréhensible.
        const already = await readSubmittedState(input, agencyId);
        if (already) {
          if (proofPath) {
            // La pièce du second envoi est inutile : la preuve d'origine fait foi.
            await client.storage.from(PAYMENT_PROOFS_BUCKET).remove([proofPath]).catch(() => undefined);
          }
          return { ...already, already_submitted: true };
        }
        // Compensation : aucune pièce orpheline dans le stockage privé.
        if (proofPath) {
          await client.storage.from(PAYMENT_PROOFS_BUCKET).remove([proofPath]).catch(() => undefined);
        }
        throw error;
      }
      return data as {
        id: string;
        reference: string;
        status: PaymentRequestStatus;
        amount: number;
        currency: string;
        has_proof: boolean;
      };
    },
    onSuccess: async () => {
      await invalidateBilling(queryClient);
    },
  });
}

export function useCancelPaymentRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { requestId: string; reason?: string }) => {
      const { data, error } = await rpc().rpc('agency_cancel_payment_request', {
        p_request_id: input.requestId,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data as { id: string; reference: string; status: PaymentRequestStatus };
    },
    onSuccess: async () => {
      await invalidateBilling(queryClient);
    },
  });
}

/**
 * URL signée (15 min) d'un justificatif du bucket PRIVÉ.
 * L'autorisation est tranchée par la politique Storage : membres de l'agence
 * concernée et administrateurs uniquement.
 */
export function useProofUrl(proofPath: string | null | undefined, scope = 'shared') {
  return useQuery({
    queryKey: [BILLING_ROOT, 'justificatif', scope, proofPath],
    enabled: Boolean(proofPath),
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<{ url: string | null; error: string | null }> => {
      if (!proofPath) return { url: null, error: null };
      const { data, error } = await getSupabaseClient()
        .storage.from(PAYMENT_PROOFS_BUCKET)
        .createSignedUrl(proofPath, 15 * 60);
      if (error) return { url: null, error: error.message };
      return { url: data.signedUrl, error: null };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Lecture — administration                                            */
/* ------------------------------------------------------------------ */

export function useAdminPaymentQueue(filters: AdminQueueFilters) {
  return useQuery({
    queryKey: getAdminQueueQueryKey(filters),
    queryFn: async (): Promise<{ rows: AdminPaymentRow[]; counts: AdminQueueCounts }> => {
      const { data, error } = await rpc().rpc('admin_payment_queue', {
        p_status: filters.statuses?.length ? filters.statuses : null,
        p_agency_id: filters.agencyId ?? null,
        p_method: filters.method ?? null,
        p_from: filters.from ?? null,
        p_to: filters.to ?? null,
        p_search: filters.search?.trim() || null,
        p_limit: 300,
        p_offset: 0,
      });
      if (error) throw error;
      return data as { rows: AdminPaymentRow[]; counts: AdminQueueCounts };
    },
  });
}

export function useAdminPaymentDetail(requestId?: string | null) {
  return useQuery({
    queryKey: getAdminDetailQueryKey(requestId),
    enabled: Boolean(requestId),
    queryFn: async (): Promise<AdminPaymentDetail> => {
      const { data, error } = await rpc().rpc('admin_payment_detail', {
        p_request_id: requestId,
      });
      if (error) throw error;
      return data as AdminPaymentDetail;
    },
  });
}

/* ------------------------------------------------------------------ */
/* Écritures — administration                                          */
/* ------------------------------------------------------------------ */

export function useReviewPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { requestId: string; decision: PaymentDecision; note?: string }) => {
      const note = input.note?.trim() ?? '';
      if ((input.decision === 'rejected' || input.decision === 'correction_requested') && !note) {
        throw new Error(
          input.decision === 'rejected'
            ? 'Un motif est obligatoire pour refuser un paiement.'
            : 'Expliquez la correction attendue.',
        );
      }
      const { data, error } = await rpc().rpc('admin_review_payment', {
        p_request_id: input.requestId,
        p_decision: input.decision,
        p_note: note || null,
      });
      if (error) throw error;
      return data as ReviewResult;
    },
    onSuccess: async () => {
      await invalidateBilling(queryClient);
    },
  });
}

/**
 * Configuration normalisée des moyens de paiement, lue par
 * `saas_immobilier.payment_config()` (même source que `agency_payment_access`),
 * pour que l'écran d'administration affiche EXACTEMENT ce que voit l'agence.
 */
export function usePaymentConfig(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [BILLING_ROOT, 'configuration-moyens'],
    enabled: options?.enabled ?? true,
    queryFn: async (): Promise<PaymentConfig> => {
      const { data, error } = await getSupabaseClient()
        .schema('saas_immobilier')
        .rpc('payment_config');
      if (error) throw error;
      return data as PaymentConfig;
    },
  });
}

export interface SaveMethodsInput {
  methods: Record<string, Partial<PaymentMethodConfig>>;
  proofRequired: boolean;
  note: string;
}

export function useSavePaymentMethods() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveMethodsInput): Promise<PaymentConfig> => {
      const methods: Record<string, unknown> = {};
      for (const code of ['orange_money', 'moov_money', 'wave'] as const) {
        const row = input.methods[code] ?? {};
        methods[code] = {
          label: row.label ?? '',
          beneficiary: row.beneficiary ?? '',
          number: (row.number ?? '').trim(),
          instructions: row.instructions ?? '',
          enabled: Boolean(row.enabled),
          reference_required: row.reference_required !== false,
          proof_required: Boolean(row.proof_required),
        };
      }
      const { data, error } = await rpc().rpc('admin_save_payment_methods', {
        p_methods: methods,
        p_proof_required: input.proofRequired,
        p_note: input.note,
      });
      if (error) throw error;
      return data as PaymentConfig;
    },
    onSuccess: async () => {
      await Promise.all([
        invalidateBilling(queryClient),
        queryClient.invalidateQueries({ queryKey: ['admin', 'platform-settings'] }),
      ]);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Utilitaires d'affichage                                             */
/* ------------------------------------------------------------------ */

/** Méthodes réellement utilisables (activées ET numéro renseigné). */
export function usableMethods(config?: PaymentConfig | null): PaymentMethodConfig[] {
  if (!config?.methods) return [];
  return (config.method_order ?? Object.keys(config.methods))
    .map((code) => config.methods[code])
    .filter((m): m is PaymentMethodConfig => Boolean(m?.configured));
}

export function orderedMethods(config?: PaymentConfig | null): PaymentMethodConfig[] {
  if (!config?.methods) return [];
  return (config.method_order ?? Object.keys(config.methods))
    .map((code) => config.methods[code])
    .filter(Boolean);
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

export function monthsToHuman(months: number) {
  if (months <= 1) return '1 mois';
  return `${months} mois`;
}

export { getSupabaseErrorMessage };

/* ------------------------------------------------------------------ */
/* Historique de facturation (encaissements réels)                     */
/* ------------------------------------------------------------------ */
// Lecture directe autorisée par la politique existante
// `subscription_payments_select_member` (membres de l'agence uniquement).
export interface BillingHistoryRow {
  id: string;
  amount: number;
  currency: string;
  paid_at: string;
  period_start: string | null;
  period_end: string | null;
  method: string;
  reference: string | null;
  entry_kind: string;
  created_at: string;
}

export function useAgencyBillingHistory(agencyId?: string) {
  return useQuery({
    queryKey: [BILLING_ROOT, 'historique', agencyId],
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<BillingHistoryRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await getSupabaseClient()
        .schema('saas_immobilier')
        .from('subscription_payments')
        .select('id, amount, currency, paid_at, period_start, period_end, method, reference, entry_kind, created_at')
        .eq('agency_id', agencyId)
        .order('paid_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as BillingHistoryRow[];
    },
  });
}
