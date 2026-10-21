// =============================================================================
// BLOC 1 — PAIEMENT MANUEL (côté agence)
// =============================================================================
// L'agence déclare un paiement effectué par Orange Money ou Wave. Aucun
// paiement en ligne : la plateforme valide ensuite manuellement (BLOC 2).
//
// Autorisations : TOUT est tranché côté base.
//   - lecture   : public.agency_payment_access(agency_id) vérifie is_agency_member
//   - écriture  : public.submit_payment_declaration(...) vérifie is_agency_member
//   - capture   : bucket PRIVÉ `payment-proofs`, chemin `<agency_id>/<uuid>-<nom>`.
//     La politique `payment_proofs_owner_select` exige que le premier dossier
//     soit l'UUID de l'agence (public.storage_agency_id) : toute capture est
//     donc lisible uniquement par les membres de cette agence et par l'admin.
// =============================================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';

/** Bucket privé déjà créé (5 Mo, jpeg/png/webp/pdf). */
export const PAYMENT_PROOFS_BUCKET = 'payment-proofs';
export const MAX_PROOF_SIZE = 5 * 1024 * 1024;
export const SUPPORTED_PROOF_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export type PaymentMethod = 'orange_money' | 'wave';

export const PAYMENT_METHODS: Array<{ value: PaymentMethod; label: string; hint: string }> = [
  { value: 'orange_money', label: 'Orange Money', hint: 'Transfert vers le numéro Orange Money indiqué' },
  { value: 'wave', label: 'Wave', hint: 'Transfert vers le numéro Wave indiqué' },
];

export type DeclarationStatus = 'pending' | 'approved' | 'rejected';

export interface PaymentDeclarationRow {
  id: string;
  amount: number;
  currency: string;
  method: string;
  transaction_reference: string;
  paid_on: string;
  status: DeclarationStatus;
  note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  has_proof: boolean;
}

export interface PaymentChannel {
  name: string;
  number: string;
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
}

export interface AgencyPaymentAccess {
  can_manage: boolean;
  instructions: {
    orange_money?: Partial<PaymentChannel>;
    wave?: Partial<PaymentChannel>;
    beneficiary?: string;
    note?: string;
  };
  grace_days: number;
  billing: BillingState;
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
  declarations: PaymentDeclarationRow[];
}

/** Cast : database.types.ts est incomplet et n'expose pas les signatures RPC. */
type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};
const rpc = () => getSupabaseClient() as unknown as RpcClient;

export const getPaymentAccessQueryKey = (agencyId?: string) =>
  ['paiements', 'access', agencyId] as const;

export function useAgencyPaymentAccess(agencyId?: string) {
  return useQuery({
    queryKey: getPaymentAccessQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<AgencyPaymentAccess> => {
      const { data, error } = await rpc().rpc('agency_payment_access', {
        p_agency_id: agencyId as string,
      });
      if (error) throw error;
      return data as AgencyPaymentAccess;
    },
  });
}

export interface PaymentDeclarationInput {
  amount: number;
  method: PaymentMethod;
  transactionReference: string;
  paidOn: string;
  proof?: File | null;
}

function proofFileName(name: string) {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-60);
  return base || 'capture';
}

export function validateProofFile(file: File): string | null {
  if (!SUPPORTED_PROOF_TYPES.has(file.type)) {
    return 'Format de capture non accepté. Utilisez JPG, PNG, WebP ou PDF.';
  }
  if (file.size > MAX_PROOF_SIZE) {
    return 'Capture trop lourde (5 Mo maximum).';
  }
  return null;
}

/**
 * Envoie la capture dans le bucket PRIVÉ puis déclare le paiement.
 * Si la déclaration échoue, la capture déjà envoyée est supprimée : on ne
 * laisse jamais de fichier orphelin dans le stockage.
 */
export function useSubmitPaymentDeclaration(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PaymentDeclarationInput): Promise<{ id: string; proofPath: string | null }> => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new Error('Le montant payé doit être un nombre supérieur à zéro.');
      }
      if (!input.transactionReference.trim()) {
        throw new Error('La référence de la transaction est obligatoire.');
      }
      if (!input.paidOn) throw new Error('La date de paiement est obligatoire.');

      const client = getSupabaseClient();
      let proofPath: string | null = null;

      if (input.proof) {
        const invalid = validateProofFile(input.proof);
        if (invalid) throw new Error(invalid);
        // Premier dossier = UUID de l'agence : c'est ce que lit la politique
        // de lecture du bucket (public.storage_agency_id).
        proofPath = `${agencyId}/${crypto.randomUUID()}-${proofFileName(input.proof.name)}`;
        const { error: uploadError } = await client.storage
          .from(PAYMENT_PROOFS_BUCKET)
          .upload(proofPath, input.proof, {
            cacheControl: '3600',
            contentType: input.proof.type,
            upsert: false,
          });
        if (uploadError) {
          throw new Error(getSupabaseErrorMessage(uploadError, 'envoyer la capture'));
        }
      }

      const { data, error } = await rpc().rpc('submit_payment_declaration', {
        p_agency_id: agencyId,
        p_amount: input.amount,
        p_method: input.method,
        p_transaction_reference: input.transactionReference.trim(),
        p_paid_on: input.paidOn,
        p_proof_path: proofPath ?? '',
      });
      if (error) {
        if (proofPath) {
          await client.storage.from(PAYMENT_PROOFS_BUCKET).remove([proofPath]).catch(() => undefined);
        }
        throw error;
      }
      return { id: data as string, proofPath };
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getPaymentAccessQueryKey(agencyId) });
    },
  });
}

/** URL signée (15 min) d'une capture : lisible par les membres de l'agence. */
export function usePaymentProofUrl(proofPath: string | null) {
  return useQuery({
    queryKey: ['paiements', 'proof-url', proofPath],
    enabled: Boolean(proofPath),
    staleTime: 10 * 60 * 1000,
    queryFn: async (): Promise<string | null> => {
      if (!proofPath) return null;
      const { data, error } = await getSupabaseClient()
        .storage.from(PAYMENT_PROOFS_BUCKET)
        .createSignedUrl(proofPath, 15 * 60);
      if (error) return null;
      return data.signedUrl;
    },
  });
}

export const DECLARATION_STATUS_LABELS: Record<DeclarationStatus, string> = {
  pending: 'En attente de validation',
  approved: 'Validée',
  rejected: 'Rejetée',
};

export function describeDeclarationStatus(status: string): DeclarationStatus {
  return status === 'approved' || status === 'rejected' ? status : 'pending';
}
