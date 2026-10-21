import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActivityLogRow,
  AgencyMemberRow,
  AgencyRow,
  AgencySubscriptionRow,
  ContactRow,
  ContactStatus,
  ConversationMessageRow,
  ConversationRow,
  FollowUpRow,
  NotificationRow,
  PlanRow,
  PlatformAdminRow,
  PropertyMediaRow,
  PropertyRow,
  PropertyStatus,
  PropertyTransactionType,
  PropertyVisitRow,
  RevenueOperationRow,
  SubscriptionPaymentRow,
  SalesPipelineRow,
  UserProfileRow,
  UsageEventRow,
  WhatsAppConnectionRow,
} from './database.types';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';
// BLOC 4 : preparation et chemins du logo d'agence (partage avec les Parametres).
import { AGENCY_ASSETS_BUCKET, logoObjectPath, prepareLogo } from './agency-logo';

const db = () => getSupabaseClient().schema('saas_immobilier');

export const getAgencyMembershipsQueryKey = (userId?: string) =>
  ['sofia', 'memberships', userId] as const;
export const getAgenciesQueryKey = (agencyIds: string[]) =>
  ['sofia', 'agencies', ...agencyIds] as const;
export const getAgencyRosterQueryKey = (agencyId?: string) =>
  ['sofia', 'agency-roster', agencyId] as const;
export const getCurrentProfileQueryKey = (userId?: string) =>
  ['sofia', 'profile', userId] as const;
export const getDashboardSummaryQueryKey = (agencyId?: string) =>
  ['sofia', 'dashboard', agencyId] as const;
export const getPropertiesQueryKey = (agencyId?: string) =>
  ['sofia', 'properties', agencyId] as const;
export const getContactsQueryKey = (agencyId?: string) =>
  ['sofia', 'contacts', agencyId] as const;
export const getPipelineQueryKey = (agencyId?: string) =>
  ['sofia', 'pipeline', agencyId] as const;
export const getPropertyMediaQueryKey = (agencyId?: string, propertyId?: string) =>
  ['sofia', 'property-media', agencyId, propertyId] as const;
export const getVisitsQueryKey = (agencyId?: string) => ['sofia', 'visits', agencyId] as const;
export const getConversationsQueryKey = (agencyId?: string) =>
  ['sofia', 'conversations', agencyId] as const;
export const getConversationMessagesQueryKey = (conversationId?: string) =>
  ['sofia', 'conversation-messages', conversationId] as const;
export const getFollowUpsQueryKey = (agencyId?: string) => ['sofia', 'follow-ups', agencyId] as const;
export const getWhatsAppConnectionsQueryKey = (agencyId?: string) =>
  ['sofia', 'whatsapp-connections', agencyId] as const;
export const getNotificationsQueryKey = (agencyId?: string) =>
  ['sofia', 'notifications', agencyId] as const;
export const getPlatformRoleQueryKey = (userId?: string) =>
  ['sofia', 'platform-role', userId] as const;
export const getPlatformSummaryQueryKey = () => ['sofia', 'platform', 'summary'] as const;
export const getAllAgenciesQueryKey = () => ['sofia', 'platform', 'agencies'] as const;
export const getAllPropertiesQueryKey = () => ['sofia', 'platform', 'properties'] as const;
export const getAllContactsQueryKey = () => ['sofia', 'platform', 'contacts'] as const;
export const getActivityLogQueryKey = (limit = 100) =>
  ['sofia', 'platform', 'activity', limit] as const;
export const getPlansQueryKey = () => ['sofia', 'plans'] as const;
export const getSubscriptionsQueryKey = () => ['sofia', 'subscriptions'] as const;

export type PropertyCreateInput = Pick<
  PropertyRow,
  'reference' | 'title' | 'transaction_type' | 'property_type' | 'price' | 'currency'
> &
  Partial<
    Pick<
      PropertyRow,
      | 'description'
      | 'status'
      | 'neighborhood'
      | 'city'
      | 'address'
      | 'bedrooms'
      | 'bathrooms'
      | 'area_m2'
      | 'latitude'
      | 'longitude'
      | 'commission_rate'
      | 'rental_commission_rate'
      | 'metadata'
    >
  >;

export type PropertyUpdateInput = Partial<PropertyCreateInput> & {
  status?: PropertyStatus;
};

export type ContactCreateInput = Pick<ContactRow, 'first_name'> &
  Partial<
    Pick<
      ContactRow,
      | 'last_name'
      | 'phone'
      | 'email'
      | 'whatsapp_number'
      | 'status'
      | 'source'
      | 'assigned_user_id'
      | 'notes'
      | 'metadata'
    >
  >;

export type ContactUpdateInput = Partial<ContactCreateInput> & {
  status?: ContactStatus;
};

export type PipelineCreateInput = Pick<SalesPipelineRow, 'client_id' | 'property_id'> &
  Partial<Pick<SalesPipelineRow, 'etape' | 'probabilite' | 'notes' | 'date_visite'>>;

export type PipelineUpdateInput = Partial<
  Pick<SalesPipelineRow, 'client_id' | 'property_id' | 'etape' | 'probabilite' | 'notes' | 'date_visite'>
>;

export type AgencySettingsInput = Partial<
  Pick<
    AgencyRow,
    | 'name'
    | 'legal_name'
    | 'phone'
    | 'email'
    | 'address'
    | 'city'
    | 'country'
    | 'timezone'
    | 'currency'
    | 'description'
    | 'logo_url'
    | 'commission_rate'
    | 'rental_commission_rate'
  >
>;

export type VisitCreateInput = Pick<PropertyVisitRow, 'contact_id' | 'property_id'> &
  Partial<
    Pick<PropertyVisitRow, 'status' | 'feedback' | 'visited_at' | 'notes' | 'visit_type' | 'agent_user_id'>
  >;
export type VisitUpdateInput = Partial<VisitCreateInput>;

export type ConversationCreateInput = Pick<ConversationRow, 'contact_id'> &
  Partial<Pick<ConversationRow, 'status' | 'mode' | 'whatsapp_connection_id' | 'assigned_user_id'>>;
export type ConversationUpdateInput = Partial<ConversationCreateInput>;

export type MessageCreateInput = Pick<ConversationMessageRow, 'conversation_id' | 'content'> & {
  sender_type?: string;
  message_type?: string;
};

export type FollowUpCreateInput = Pick<FollowUpRow, 'contact_id' | 'scheduled_at'> &
  Partial<Pick<FollowUpRow, 'type' | 'status' | 'notes' | 'assigned_user_id' | 'completed_at'>>;
export type FollowUpUpdateInput = Partial<FollowUpCreateInput>;

export type WhatsAppConnectionCreateInput = Pick<WhatsAppConnectionRow, 'connection_name'> &
  Partial<Pick<WhatsAppConnectionRow, 'provider' | 'phone_number' | 'status' | 'credentials_ref' | 'config'>>;
export type WhatsAppConnectionUpdateInput = Partial<WhatsAppConnectionCreateInput>;

export type OnboardingInput = {
  name: string;
  legal_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string;
  timezone?: string;
  currency?: string;
  description?: string | null;
  logo?: File | null;
};

export type PlatformSummary = {
  agenciesTotal: number;
  agenciesActive: number;
  agenciesSuspended: number;
  propertiesTotal: number;
  propertiesAvailable: number;
  propertiesSold: number;
  propertiesWithoutPhoto: number;
  contactsTotal: number;
  leadsTotal: number;
  visitsTotal: number;
  conversationsTotal: number;
  messagesTotal: number;
  followUpsPending: number;
  activeSubscriptions: number;
  trialSubscriptions: number;
  expiredSubscriptions: number;
  inactiveAgencies: number;
  incompleteProperties: number;
};

const AGENCY_COLUMNS =
  'id, name, slug, legal_name, phone, email, address, city, country, timezone, currency, status, logo_url, description, commission_rate, rental_commission_rate, created_at, updated_at';

export type ProfileUpdateInput = Partial<Pick<UserProfileRow, 'full_name' | 'phone'>>;
export type PropertyMediaPreview = PropertyMediaRow & {
  signedUrl: string | null;
  signedUrlError: string | null;
};
export type PropertyMediaUploadInput = {
  file: File;
  propertyReference: string;
  sortOrder: number;
};

const PROPERTY_IMAGES_BUCKET = 'property-images';
const MAX_PROPERTY_IMAGE_SIZE = 5 * 1024 * 1024;
const SUPPORTED_PROPERTY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function sanitizePropertyReference(reference: string) {
  return reference.trim().replace(/[^A-Za-z0-9_-]+/g, '').toUpperCase().slice(0, 24) || 'BIEN';
}

function validatePropertyImage(file: File) {
  if (!SUPPORTED_PROPERTY_IMAGE_TYPES.has(file.type)) {
    throw new Error('Utilisez une image JPG, PNG ou WebP.');
  }
  if (file.size > MAX_PROPERTY_IMAGE_SIZE) {
    throw new Error('Chaque image doit peser 5 Mo maximum après compression.');
  }
}

function propertyImageFileName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'photo';
}

export function usePropertyMedia(agencyId?: string, propertyId?: string) {
  return useQuery({
    queryKey: getPropertyMediaQueryKey(agencyId, propertyId),
    enabled: Boolean(agencyId && propertyId),
    queryFn: async (): Promise<PropertyMediaPreview[]> => {
      if (!agencyId || !propertyId) return [];
      const { data, error } = await db()
        .from('property_media')
        .select('id, agency_id, property_id, media_type, storage_path, public_url, file_name, mime_type, file_size, sort_order, metadata, created_at')
        .eq('agency_id', agencyId)
        .eq('property_id', propertyId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;

      const storage = getSupabaseClient().storage.from(PROPERTY_IMAGES_BUCKET);
      return Promise.all(
        (data ?? []).map(async (media) => {
          const { data: signed, error: signedError } = await storage.createSignedUrl(
            media.storage_path,
            30 * 60,
          );
          return {
            ...media,
            signedUrl: signed?.signedUrl ?? null,
            signedUrlError: signedError
              ? getSupabaseErrorMessage(signedError, 'charger la photo')
              : null,
          };
        }),
      );
    },
  });
}

export function useUploadPropertyMedia(agencyId?: string, propertyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PropertyMediaUploadInput) => {
      if (!agencyId || !propertyId) throw new Error('Aucune agence ni aucun bien actif n’est sélectionné.');
      validatePropertyImage(input.file);

      const objectPath = `properties/${sanitizePropertyReference(input.propertyReference)}/${crypto.randomUUID()}-${propertyImageFileName(input.file.name)}`;
      const { data: media, error: mediaError } = await db()
        .from('property_media')
        .insert({
          agency_id: agencyId,
          property_id: propertyId,
          media_type: 'photo',
          storage_path: objectPath,
          // LOT B (point A) : URL publique permanente, lisible par l'agent Sofia
      // sans compte utilisateur. Le bucket property-images est public.
      public_url: getSupabaseClient()
        .storage
        .from(PROPERTY_IMAGES_BUCKET)
        .getPublicUrl(objectPath).data.publicUrl,
          file_name: input.file.name,
          mime_type: input.file.type,
          file_size: input.file.size,
          sort_order: Math.max(0, Math.trunc(input.sortOrder)),
          metadata: {},
        })
        .select('id, agency_id, property_id, media_type, storage_path, public_url, file_name, mime_type, file_size, sort_order, metadata, created_at')
        .single();
      if (mediaError) throw mediaError;

      const storage = getSupabaseClient().storage.from(PROPERTY_IMAGES_BUCKET);
      const { error: uploadError } = await storage.upload(objectPath, input.file, {
        cacheControl: '1800',
        contentType: input.file.type,
        upsert: false,
      });
      if (uploadError) {
        const message = getSupabaseErrorMessage(uploadError, 'envoyer la photo');
        const { error: statusError } = await db()
          .from('property_media')
          .update({ metadata: { upload_failed: true, upload_error: message } })
          .eq('id', media.id)
          .eq('agency_id', agencyId)
          .eq('property_id', propertyId);
        if (statusError) {
          throw new Error(`${message} Le suivi de l’échec n’a pas pu être enregistré : ${getSupabaseErrorMessage(statusError, 'mettre à jour la fiche photo')}`);
        }
        throw new Error(message);
      }

      return media;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getPropertyMediaQueryKey(agencyId, propertyId),
      });
    },
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: getPropertyMediaQueryKey(agencyId, propertyId),
      });
    },
  });
}

export function useDeletePropertyMedia(
  agencyId?: string,
  propertyId?: string,
  canDelete = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (media: Pick<PropertyMediaRow, 'id' | 'storage_path'>) => {
      if (!agencyId || !propertyId) throw new Error('Aucune agence ni aucun bien actif n’est sélectionné.');
      if (!canDelete) throw new Error('Seuls les administrateurs et propriétaires peuvent supprimer une photo.');

      const { error: storageError } = await getSupabaseClient()
        .storage.from(PROPERTY_IMAGES_BUCKET)
        .remove([media.storage_path]);
      if (storageError) throw storageError;

      const { error } = await db()
        .from('property_media')
        .delete()
        .eq('id', media.id)
        .eq('agency_id', agencyId)
        .eq('property_id', propertyId);
      if (error) throw error;
      return media.id;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: getPropertyMediaQueryKey(agencyId, propertyId),
      });
    },
  });
}

export function useAgencyMemberships(userId?: string) {
  return useQuery({
    queryKey: getAgencyMembershipsQueryKey(userId),
    enabled: Boolean(userId),
    queryFn: async (): Promise<AgencyMemberRow[]> => {
      if (!userId) return [];
      const { data, error } = await db()
        .from('agency_members')
        .select('id, agency_id, user_id, role, status, created_at, updated_at')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useAgencies(agencyIds: string[]) {
  const uniqueIds = [...new Set(agencyIds)].sort();
  return useQuery({
    queryKey: getAgenciesQueryKey(uniqueIds),
    enabled: uniqueIds.length > 0,
    queryFn: async (): Promise<AgencyRow[]> => {
      if (uniqueIds.length === 0) return [];
      const { data, error } = await db()
        .from('agencies')
        .select(AGENCY_COLUMNS)
        .in('id', uniqueIds)
        .order('name', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useAgencyRoster(agencyId?: string) {
  return useQuery({
    queryKey: getAgencyRosterQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<AgencyMemberRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('agency_members')
        .select('id, agency_id, user_id, role, status, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useCurrentProfile(userId?: string) {
  return useQuery({
    queryKey: getCurrentProfileQueryKey(userId),
    enabled: Boolean(userId),
    queryFn: async (): Promise<UserProfileRow | null> => {
      if (!userId) return null;
      const { data, error } = await db()
        .from('user_profiles')
        .select('id, full_name, phone, avatar_url, email, role, must_change_password, created_at, updated_at')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useDashboardSummary(agencyId?: string) {
  return useQuery({
    queryKey: getDashboardSummaryQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async () => {
      if (!agencyId) return null;
      const schema = db();
      const [
        properties,
        available,
        rented,
        sold,
        contacts,
        activeContacts,
        prospects,
        pipeline,
        members,
      ] = await Promise.all([
        schema.from('properties').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        schema
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('status', 'available'),
        schema
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('status', 'rented'),
        schema
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('status', 'sold'),
        schema.from('contacts').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        schema
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .neq('status', 'inactive'),
        schema
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .in('status', ['lead', 'prospect']),
        schema.from('sales_pipeline').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        schema
          .from('agency_members')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('status', 'active'),
      ]);
      const firstError = [
        properties,
        available,
        rented,
        sold,
        contacts,
        activeContacts,
        prospects,
        pipeline,
        members,
      ].find((result) => result.error)?.error;
      if (firstError) throw firstError;
      return {
        properties: properties.count ?? 0,
        availableProperties: available.count ?? 0,
        rentedProperties: rented.count ?? 0,
        soldProperties: sold.count ?? 0,
        contacts: contacts.count ?? 0,
        activeContacts: activeContacts.count ?? 0,
        prospects: prospects.count ?? 0,
        opportunities: pipeline.count ?? 0,
        activeMembers: members.count ?? 0,
      };
    },
  });
}

export function useProperties(agencyId?: string) {
  return useQuery({
    queryKey: getPropertiesQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<PropertyRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('properties')
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, commission_rate, rental_commission_rate, metadata, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useContacts(agencyId?: string) {
  return useQuery({
    queryKey: getContactsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<ContactRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('contacts')
        .select('id, agency_id, first_name, last_name, phone, email, whatsapp_number, status, source, assigned_user_id, notes, metadata, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function usePipeline(agencyId?: string) {
  return useQuery({
    queryKey: getPipelineQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<SalesPipelineRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('sales_pipeline')
        .select('id, agency_id, client_id, property_id, etape, probabilite, notes, date_visite, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateProperty(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PropertyCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('properties')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, commission_rate, rental_commission_rate, metadata, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPropertiesQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useUpdateProperty(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: PropertyUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('properties')
        .update(input)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, commission_rate, rental_commission_rate, metadata, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPropertiesQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useCreateContact(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ContactCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('contacts')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, first_name, last_name, phone, email, whatsapp_number, status, source, assigned_user_id, notes, metadata, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getContactsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useUpdateContact(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: ContactUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('contacts')
        .update(input)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, first_name, last_name, phone, email, whatsapp_number, status, source, assigned_user_id, notes, metadata, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getContactsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useCreatePipelineItem(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PipelineCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('sales_pipeline')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, client_id, property_id, etape, probabilite, notes, date_visite, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPipelineQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useUpdatePipelineItem(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: PipelineUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('sales_pipeline')
        .update(input)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, client_id, property_id, etape, probabilite, notes, date_visite, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPipelineQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useUpdateAgency(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AgencySettingsInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('agencies')
        .update(input)
        .eq('id', agencyId)
        .select(AGENCY_COLUMNS)
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sofia', 'agencies'] });
      await queryClient.invalidateQueries({ queryKey: getAgenciesQueryKey(agencyId ? [agencyId] : []) });
    },
  });
}

export function useUpdateCurrentProfile(userId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProfileUpdateInput) => {
      if (!userId) throw new Error('Aucune session utilisateur n’est active.');
      const { data, error } = await db()
        .from('user_profiles')
        .upsert({ id: userId, ...input }, { onConflict: 'id' })
        .select('id, full_name, phone, avatar_url, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getCurrentProfileQueryKey(userId) });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Rôle plateforme (admin)                                             */
/* ------------------------------------------------------------------ */

export type PlatformRole = {
  isAdmin: boolean;
  profile: UserProfileRow | null;
  platformAdmin: PlatformAdminRow | null;
};

export async function getPlatformRole(userId?: string): Promise<PlatformRole> {
  if (!userId) return { isAdmin: false, profile: null, platformAdmin: null };
  const [profileRes, adminRes] = await Promise.all([
    db()
      .from('user_profiles')
      .select('id, full_name, phone, avatar_url, email, role, created_at, updated_at')
      .eq('id', userId)
      .maybeSingle(),
    db()
      .from('platform_admins')
      .select('id, user_id, role, status, created_at, updated_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle(),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (adminRes.error) throw adminRes.error;
  const profile = profileRes.data;
  const platformAdmin = adminRes.data;
  return {
    isAdmin: profile?.role === 'admin' || Boolean(platformAdmin),
    profile,
    platformAdmin,
  };
}

export function usePlatformRole(userId?: string) {
  return useQuery({
    queryKey: getPlatformRoleQueryKey(userId),
    enabled: Boolean(userId),
    staleTime: 60_000,
    queryFn: async (): Promise<PlatformRole> => getPlatformRole(userId),
  });
}

/* ------------------------------------------------------------------ */
/* Visites                                                             */
/* ------------------------------------------------------------------ */

export function useVisits(agencyId?: string) {
  return useQuery({
    queryKey: getVisitsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<PropertyVisitRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('property_visits')
        .select('id, agency_id, appointment_id, contact_id, property_id, agent_user_id, status, feedback, visited_at, notes, visit_type, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateVisit(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VisitCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('property_visits')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, appointment_id, contact_id, property_id, agent_user_id, status, feedback, visited_at, notes, visit_type, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getVisitsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export function useUpdateVisit(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: VisitUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('property_visits')
        .update(input)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, appointment_id, contact_id, property_id, agent_user_id, status, feedback, visited_at, notes, visit_type, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getVisitsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

export function useDeleteVisit(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { error } = await db()
        .from('property_visits')
        .delete()
        .eq('id', id)
        .eq('agency_id', agencyId);
      if (error) throw error;
      return id;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getVisitsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Conversations WhatsApp                                              */
/* ------------------------------------------------------------------ */

export function useConversations(agencyId?: string) {
  return useQuery({
    queryKey: getConversationsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<ConversationRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('conversations')
        .select('id, agency_id, contact_id, whatsapp_connection_id, status, mode, assigned_user_id, last_message_at, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateConversation(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConversationCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('conversations')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, contact_id, whatsapp_connection_id, status, mode, assigned_user_id, last_message_at, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getConversationsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export function useUpdateConversation(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: ConversationUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('conversations')
        .update(input)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, contact_id, whatsapp_connection_id, status, mode, assigned_user_id, last_message_at, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getConversationsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getConversationMessagesQueryKey(variables.id) }),
      ]);
    },
  });
}

export function useDeleteConversation(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      // Suppression du fil + des messages (pas de cascade garantie côté client).
      const messages = await db()
        .from('conversation_messages')
        .delete()
        .eq('conversation_id', id)
        .eq('agency_id', agencyId);
      if (messages.error) throw messages.error;
      const { error } = await db()
        .from('conversations')
        .delete()
        .eq('id', id)
        .eq('agency_id', agencyId);
      if (error) throw error;
      return id;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getConversationsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export function useConversationMessages(agencyId?: string, conversationId?: string) {
  return useQuery({
    queryKey: getConversationMessagesQueryKey(conversationId),
    enabled: Boolean(agencyId && conversationId),
    queryFn: async (): Promise<ConversationMessageRow[]> => {
      if (!agencyId || !conversationId) return [];
      const { data, error } = await db()
        .from('conversation_messages')
        .select('id, agency_id, conversation_id, sender_type, sender_user_id, message_type, content, provider_message_id, metadata, created_at')
        .eq('agency_id', agencyId)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useSendMessage(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: MessageCreateInput & { sender_user_id?: string | null }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('conversation_messages')
        .insert({
          agency_id: agencyId,
          conversation_id: input.conversation_id,
          sender_type: input.sender_type ?? 'agent',
          sender_user_id: input.sender_user_id ?? null,
          message_type: input.message_type ?? 'text',
          content: input.content,
          metadata: {},
        })
        .select('id, agency_id, conversation_id, sender_type, sender_user_id, message_type, content, provider_message_id, metadata, created_at')
        .single();
      if (error) throw error;
      await db()
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', input.conversation_id)
        .eq('agency_id', agencyId);
      return data;
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getConversationMessagesQueryKey(variables.conversation_id) }),
        queryClient.invalidateQueries({ queryKey: getConversationsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
      ]);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Relances (automatisations)                                          */
/* ------------------------------------------------------------------ */

export function useFollowUps(agencyId?: string) {
  return useQuery({
    queryKey: getFollowUpsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<FollowUpRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('follow_ups')
        .select('id, agency_id, contact_id, assigned_user_id, conversation_id, type, scheduled_at, completed_at, status, notes, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('scheduled_at', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateFollowUp(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: FollowUpCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('follow_ups')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, contact_id, assigned_user_id, conversation_id, type, scheduled_at, completed_at, status, notes, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getFollowUpsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getDashboardSummaryQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export function useUpdateFollowUp(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: FollowUpUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('follow_ups')
        .update(input)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, contact_id, assigned_user_id, conversation_id, type, scheduled_at, completed_at, status, notes, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getFollowUpsQueryKey(agencyId) });
    },
  });
}

export function useDeleteFollowUp(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { error } = await db()
        .from('follow_ups')
        .delete()
        .eq('id', id)
        .eq('agency_id', agencyId);
      if (error) throw error;
      return id;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getFollowUpsQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Connexions WhatsApp                                                 */
/* ------------------------------------------------------------------ */

export function useWhatsAppConnections(agencyId?: string) {
  return useQuery({
    queryKey: getWhatsAppConnectionsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<WhatsAppConnectionRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('whatsapp_connections')
        .select('id, agency_id, provider, connection_name, phone_number, phone_number_id, instance_id, status, credentials_ref, config, last_connected_at, created_at, updated_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateWhatsAppConnection(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: WhatsAppConnectionCreateInput) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { data, error } = await db()
        .from('whatsapp_connections')
        .insert({ ...input, agency_id: agencyId })
        .select('id, agency_id, provider, connection_name, phone_number, phone_number_id, instance_id, status, credentials_ref, config, last_connected_at, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getWhatsAppConnectionsQueryKey(agencyId) });
    },
  });
}

export function useUpdateWhatsAppConnection(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: WhatsAppConnectionUpdateInput }) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const payload = {
        ...input,
        ...(input.status === 'connected' ? { last_connected_at: new Date().toISOString() } : {}),
      };
      const { data, error } = await db()
        .from('whatsapp_connections')
        .update(payload)
        .eq('id', id)
        .eq('agency_id', agencyId)
        .select('id, agency_id, provider, connection_name, phone_number, phone_number_id, instance_id, status, credentials_ref, config, last_connected_at, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getWhatsAppConnectionsQueryKey(agencyId) });
    },
  });
}

export function useDeleteWhatsAppConnection(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { error } = await db()
        .from('whatsapp_connections')
        .delete()
        .eq('id', id)
        .eq('agency_id', agencyId);
      if (error) throw error;
      return id;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getWhatsAppConnectionsQueryKey(agencyId) });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export function useNotifications(agencyId?: string) {
  return useQuery({
    queryKey: getNotificationsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<NotificationRow[]> => {
      if (!agencyId) return [];
      const { data, error } = await db()
        .from('notifications')
        .select('id, agency_id, user_id, type, title, message, data, read_at, created_at')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data;
    },
  });
}

export function useMarkNotificationRead(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { error } = await db()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .eq('agency_id', agencyId)
        .is('read_at', null);
      if (error) throw error;
      return id;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getNotificationsQueryKey(agencyId) });
    },
  });
}

export function useMarkAllNotificationsRead(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!agencyId) throw new Error('Aucune agence active n’est sélectionnée.');
      const { error } = await db()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('agency_id', agencyId)
        .is('read_at', null);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getNotificationsQueryKey(agencyId) });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Suivi des consultations de biens (statistiques réelles)             */
/* ------------------------------------------------------------------ */

export function useTrackPropertyView(agencyId?: string, propertyId?: string) {
  return useMutation({
    mutationFn: async () => {
      if (!agencyId || !propertyId) return;
      const { error } = await db().from('usage_events').insert({
        agency_id: agencyId,
        event_type: 'property_viewed',
        entity_type: 'property',
        entity_id: propertyId,
        metadata: {},
        event_key: `view:${propertyId}:${crypto.randomUUID()}`,
      });
      if (error) throw error;
    },
    retry: false,
  });
}

/* ------------------------------------------------------------------ */
/* Inscription d’agence (onboarding)                                   */
/* ------------------------------------------------------------------ */


export function useCreateAgency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: OnboardingInput): Promise<AgencyRow> => {
      const { data, error } = await db().rpc('create_agency_for_self', {
        p_name: input.name,
        p_legal_name: input.legal_name ?? null,
        p_phone: input.phone ?? null,
        p_email: input.email ?? null,
        p_address: input.address ?? null,
        p_city: input.city ?? null,
        p_country: input.country ?? 'Mali',
        p_timezone: input.timezone ?? 'Africa/Bamako',
        p_currency: input.currency ?? 'XOF',
        p_description: input.description ?? null,
        p_logo_url: null,
      });
      if (error) throw error;
      const agency = data as unknown as AgencyRow;

      if (input.logo && agency?.id) {
        // BLOC 4 : mêmes règles partout (PNG/JPG/WebP, 2 Mo, redimensionné à
        // 512 px) — voir lib/agency-logo.ts.
        const file = await prepareLogo(input.logo);
        const objectPath = logoObjectPath(agency.id, file.name);
        const storage = getSupabaseClient().storage.from(AGENCY_ASSETS_BUCKET);
        const { error: uploadError } = await storage.upload(objectPath, file, {
          cacheControl: '3600',
          contentType: file.type,
          upsert: false,
        });
        if (uploadError) throw uploadError;
        const { data: publicUrlData } = storage.getPublicUrl(objectPath);
        const logoUrl = publicUrlData?.publicUrl ?? null;
        if (logoUrl) {
          const { error: updateError } = await db()
            .from('agencies')
            .update({ logo_url: logoUrl })
            .eq('id', agency.id);
          if (updateError) throw updateError;
          agency.logo_url = logoUrl;
        }
      }

      return agency;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sofia', 'memberships'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia', 'agencies'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia', 'platform-role'] }),
        queryClient.invalidateQueries({ queryKey: ['sofia', 'profile'] }),
      ]);
    },
  });
}

/* ------------------------------------------------------------------ */
/* Espace plateforme (admin)                                           */
/* ------------------------------------------------------------------ */

export function useAllAgencies() {
  return useQuery({
    queryKey: getAllAgenciesQueryKey(),
    queryFn: async () => {
      const [agenciesRes, subscriptionsRes, plansRes, membersRes] = await Promise.all([
        db().from('agencies').select(AGENCY_COLUMNS).order('created_at', { ascending: false }),
        db()
          .from('agency_subscriptions')
          .select('id, agency_id, plan_id, status, starts_at, ends_at, trial_ends_at, created_at, updated_at'),
        // BLOC 2 : display_name / sort_order / setup_fee / modules ajoutés à la
        // projection — la console admin affiche « Essentiel / Pro / Premium »
        // au lieu des slugs techniques, et le changement d'offre en un clic a
        // besoin du prix affiché.
        db()
          .from('plans')
          .select('id, name, display_name, description, price_monthly, setup_fee, currency, max_members, max_properties, max_photos_per_property, max_whatsapp_connections, monthly_ai_tokens, monthly_conversations, monthly_agent_messages, modules, sort_order, features, created_at, updated_at')
          .order('sort_order', { ascending: true }),
        db()
          .from('agency_members')
          .select('id, agency_id, user_id, role, status, created_at, updated_at'),
      ]);
      const firstError =
        agenciesRes.error ?? subscriptionsRes.error ?? plansRes.error ?? membersRes.error;
      if (firstError) throw firstError;
      return {
        agencies: agenciesRes.data as AgencyRow[],
        subscriptions: subscriptionsRes.data as AgencySubscriptionRow[],
        plans: plansRes.data as PlanRow[],
        members: membersRes.data as AgencyMemberRow[],
      };
    },
  });
}

export function useAllProperties() {
  return useQuery({
    queryKey: getAllPropertiesQueryKey(),
    queryFn: async (): Promise<PropertyRow[]> => {
      const { data, error } = await db()
        .from('properties')
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, commission_rate, rental_commission_rate, metadata, created_at, updated_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useAllContacts() {
  return useQuery({
    queryKey: getAllContactsQueryKey(),
    queryFn: async (): Promise<ContactRow[]> => {
      const { data, error } = await db()
        .from('contacts')
        .select('id, agency_id, first_name, last_name, phone, email, whatsapp_number, status, source, assigned_user_id, notes, metadata, created_at, updated_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useAllMediaRefs() {
  return useQuery({
    queryKey: ['sofia', 'platform', 'media-refs'],
    queryFn: async (): Promise<Array<{ agency_id: string; property_id: string; storage_path: string; sort_order: number }>> => {
      const { data, error } = await db()
        .from('property_media')
        .select('agency_id, property_id, storage_path, sort_order')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

export function usePropertyViewStats() {
  return useQuery({
    queryKey: ['sofia', 'platform', 'property-views'],
    queryFn: async (): Promise<Array<{ property_id: string; views: number }>> => {
      const { data, error } = await db()
        .from('usage_events')
        .select('entity_id, event_type')
        .eq('event_type', 'property_viewed')
        .limit(2000);
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        if (!row.entity_id) continue;
        counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1);
      }
      return [...counts.entries()].map(([property_id, views]) => ({ property_id, views }));
    },
    refetchInterval: 60_000,
  });
}

export function useActivityLog(limit = 100) {
  return useQuery({
    queryKey: getActivityLogQueryKey(limit),
    queryFn: async (): Promise<ActivityLogRow[]> => {
      const { data, error } = await db()
        .from('activity_log')
        .select('id, agency_id, user_id, action, entity_type, entity_id, summary, metadata, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },
  });
}

export function usePlatformSummary() {
  return useQuery({
    queryKey: getPlatformSummaryQueryKey(),
    queryFn: async (): Promise<PlatformSummary> => {
      const headCount = async (
        table:
          | 'agencies'
          | 'properties'
          | 'contacts'
          | 'property_visits'
          | 'conversations'
          | 'conversation_messages'
          | 'follow_ups'
          | 'activity_log',
      ) => {
        const { count, error } = await db()
          .from(table)
          .select('id', { count: 'exact', head: true });
        if (error) throw error;
        return count ?? 0;
      };

      const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

      const [
        agencies,
        agenciesActive,
        properties,
        propertiesAvailable,
        propertiesSold,
        contacts,
        leads,
        visits,
        conversations,
        messages,
        followUpsPending,
        subscriptions,
        inactiveAgenciesAgg,
        incompleteAgg,
      ] = await Promise.all([
        headCount('agencies'),
        db().from('agencies').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        headCount('properties'),
        db().from('properties').select('id', { count: 'exact', head: true }).eq('status', 'available'),
        db().from('properties').select('id', { count: 'exact', head: true }).in('status', ['sold', 'rented']),
        headCount('contacts'),
        db().from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'lead'),
        headCount('property_visits'),
        headCount('conversations'),
        headCount('conversation_messages'),
        db().from('follow_ups').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        db().from('agency_subscriptions').select('id, agency_id, status, ends_at, trial_ends_at'),
        db().from('agencies').select('id, status, updated_at'),
        db().from('properties').select('id, status, description, city, price'),
      ]);

      const headErrors = [
        agenciesActive,
        propertiesAvailable,
        propertiesSold,
        leads,
        followUpsPending,
        subscriptions,
        inactiveAgenciesAgg,
        incompleteAgg,
      ]
        .map((r) => r.error)
        .filter(Boolean);
      if (headErrors.length) throw headErrors[0];

      const mediaRefs = await db().from('property_media').select('property_id');
      if (mediaRefs.error) throw mediaRefs.error;
      const withPhoto = new Set((mediaRefs.data ?? []).map((row) => row.property_id));
      const propertiesWithoutPhoto = (incompleteAgg.data ?? []).filter(
        (row) => !withPhoto.has(row.id),
      ).length;

      const incompleteProperties = (incompleteAgg.data ?? []).filter((row) => {
        const missingDescription = !row.description || row.description.trim().length < 10;
        const missingCity = !row.city || row.city.trim().length === 0;
        const missingPrice = typeof row.price !== 'number' || row.price <= 0;
        const draftOrUnavailable = ['draft', 'archived'].includes(row.status);
        return !draftOrUnavailable && (missingDescription || missingCity || missingPrice);
      }).length;

      const lastActivityByAgency = new Map<string, string>();
      const activity = await db()
        .from('activity_log')
        .select('agency_id, created_at')
        .not('agency_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(500);
      if (activity.error) throw activity.error;
      for (const row of activity.data ?? []) {
        if (row.agency_id && !lastActivityByAgency.has(row.agency_id)) {
          lastActivityByAgency.set(row.agency_id, row.created_at);
        }
      }
      const inactiveAgencies = (inactiveAgenciesAgg.data ?? []).filter((agency) => {
        const last = lastActivityByAgency.get(agency.id);
        if (!last) return true;
        return new Date(last).getTime() < new Date(since30d).getTime();
      }).length;

      const subs = subscriptions.data ?? [];
      const now = Date.now();
      const activeSubscriptions = subs.filter(
        (s) =>
          s.status === 'active' &&
          (!s.ends_at || new Date(s.ends_at).getTime() > now),
      ).length;
      const trialSubscriptions = subs.filter(
        (s) =>
          s.status === 'trial' &&
          (!s.trial_ends_at || new Date(s.trial_ends_at).getTime() > now),
      ).length;
      const expiredSubscriptions = subs.filter(
        (s) =>
          (s.status === 'active' && s.ends_at && new Date(s.ends_at).getTime() <= now) ||
          (s.status === 'trial' && s.trial_ends_at && new Date(s.trial_ends_at).getTime() <= now),
      ).length;

      return {
        agenciesTotal: agencies,
        agenciesActive: agenciesActive.count ?? 0,
        agenciesSuspended: agencies - (agenciesActive.count ?? 0),
        propertiesTotal: properties,
        propertiesAvailable: propertiesAvailable.count ?? 0,
        propertiesSold: propertiesSold.count ?? 0,
        propertiesWithoutPhoto,
        contactsTotal: contacts,
        leadsTotal: leads.count ?? 0,
        visitsTotal: visits,
        conversationsTotal: conversations,
        messagesTotal: messages,
        followUpsPending: followUpsPending.count ?? 0,
        activeSubscriptions,
        trialSubscriptions,
        expiredSubscriptions,
        inactiveAgencies,
        incompleteProperties,
      };
    },
    refetchInterval: 60_000,
  });
}

export type AgencyAdminActionInput = {
  agencyId: string;
  status: string;
  subscriptionStatus?: string;
};

export function useAdminUpdateAgency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ agencyId, status, subscriptionStatus }: AgencyAdminActionInput) => {
      const { data, error } = await db()
        .from('agencies')
        .update({ status })
        .eq('id', agencyId)
        .select(AGENCY_COLUMNS)
        .single();
      if (error) throw error;
      if (subscriptionStatus) {
        const { error: subError } = await db()
          .from('agency_subscriptions')
          .update({ status: subscriptionStatus })
          .eq('agency_id', agencyId);
        if (subError) throw subError;
      }
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getAllAgenciesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getPlatformSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ['sofia', 'agencies'] }),
      ]);
    },
  });
}

export function useAdminUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      subscriptionId,
      status,
      ends_at,
      trial_ends_at,
    }: {
      subscriptionId: string;
      status: string;
      ends_at?: string;
      trial_ends_at?: string;
    }) => {
      const payload: { status: string; ends_at?: string; trial_ends_at?: string } = { status };
      if (ends_at !== undefined) payload.ends_at = ends_at;
      if (trial_ends_at !== undefined) payload.trial_ends_at = trial_ends_at;
      const { data, error } = await db()
        .from('agency_subscriptions')
        .update(payload)
        .eq('id', subscriptionId)
        .select('id, agency_id, plan_id, status, starts_at, ends_at, trial_ends_at, created_at, updated_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getSubscriptionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getAllAgenciesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getPlatformSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export type UsageEventInsert = Pick<UsageEventRow, 'agency_id' | 'event_type' | 'event_key'> &
  Partial<Pick<UsageEventRow, 'user_id' | 'entity_type' | 'entity_id' | 'metadata'>>;

export function useLogUsageEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UsageEventInsert) => {
      const { data, error } = await db()
        .from('usage_events')
        .insert({ metadata: {}, ...input })
        .select('id, agency_id, user_id, event_type, entity_type, entity_id, metadata, event_key, created_at')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['sofia', 'activity'] });
    },
    retry: false,
  });
}

/* ------------------------------------------------------------------ */
/* État du compte — blocage des agences suspendues                     */
/* ------------------------------------------------------------------ */

export type AccountMembership = {
  agency_id: string;
  agency_name: string;
  agency_status: string;
  role: string;
};

export type AccountState = {
  is_admin: boolean;
  memberships: AccountMembership[];
};

export const getAccountStateQueryKey = () => ['sofia', 'account-state'] as const;

export async function getAccountState(): Promise<AccountState> {
  const { data, error } = await db().rpc('mon_etat_compte');
  if (error) throw error;
  const payload = (data ?? {}) as { is_admin?: boolean | null; memberships?: AccountMembership[] | null };
  return {
    is_admin: Boolean(payload.is_admin),
    memberships: Array.isArray(payload.memberships) ? payload.memberships : [],
  };
}

export function isBlockedAccount(state?: AccountState | null): boolean {
  if (!state || state.is_admin) return false;
  return state.memberships.some((membership) => membership.agency_status === 'suspended');
}

export function useAccountState(enabled = true) {
  return useQuery({
    queryKey: getAccountStateQueryKey(),
    enabled,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
    queryFn: () => getAccountState(),
  });
}

/* ------------------------------------------------------------------ */
/* Chiffre d'affaires — revenue_operations                             */
/* ------------------------------------------------------------------ */

export const getRevenueOperationsQueryKey = (agencyId?: string) =>
  ['sofia', 'revenue-operations', agencyId ?? 'platform'] as const;

export type RevenueOperationCreateInput = {
  agency_id: string;
  property_id?: string | null;
  operation_type: RevenueOperationRow['operation_type'];
  amount: number;
  commission?: number | null;
  operation_date: string;
  status?: RevenueOperationRow['status'];
  note?: string | null;
};

export type RevenueOperationUpdateInput = Partial<
  Pick<
    RevenueOperationRow,
    'property_id' | 'operation_type' | 'amount' | 'commission' | 'operation_date' | 'status' | 'note'
  >
>;

const REVENUE_COLUMNS =
  'id, agency_id, property_id, operation_type, amount, commission, operation_date, status, source, note, created_by, created_at, updated_at';

function invalidateRevenue(queryClient: ReturnType<typeof useQueryClient>, agencyId?: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: getRevenueOperationsQueryKey(agencyId) }),
    queryClient.invalidateQueries({ queryKey: getRevenueOperationsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
  ]);
}

export function useRevenueOperations(agencyId?: string) {
  return useQuery({
    queryKey: getRevenueOperationsQueryKey(agencyId),
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<RevenueOperationRow[]> => {
      const { data, error } = await db()
        .from('revenue_operations')
        .select(REVENUE_COLUMNS)
        .eq('agency_id', agencyId as string)
        .order('operation_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useAllRevenueOperations() {
  return useQuery({
    queryKey: getRevenueOperationsQueryKey(),
    queryFn: async (): Promise<RevenueOperationRow[]> => {
      const { data, error } = await db()
        .from('revenue_operations')
        .select(REVENUE_COLUMNS)
        .order('operation_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateRevenueOperation(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RevenueOperationCreateInput) => {
      const { data, error } = await db()
        .from('revenue_operations')
        .insert({ ...input, created_by: null })
        .select(REVENUE_COLUMNS)
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateRevenue(queryClient, agencyId),
  });
}

export function useUpdateRevenueOperation(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: RevenueOperationUpdateInput }) => {
      const { data, error } = await db()
        .from('revenue_operations')
        .update({ ...input, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select(REVENUE_COLUMNS)
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateRevenue(queryClient, agencyId),
  });
}

export function useDeleteRevenueOperation(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from('revenue_operations').delete().eq('id', id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => invalidateRevenue(queryClient, agencyId),
  });
}

/* ------------------------------------------------------------------ */
/* Photos de biens — envois en lot, réordonnancement, couverture       */
/* ------------------------------------------------------------------ */

export type PropertyMediaBatchInput = {
  files: File[];
  propertyId: string;
  propertyReference: string;
  startSortOrder: number;
  onProgress?: (done: number, total: number) => void;
};

async function uploadPropertyMediaFile(
  agencyId: string,
  propertyId: string,
  input: { file: File; propertyReference: string; sortOrder: number },
): Promise<PropertyMediaRow> {
  validatePropertyImage(input.file);

  const objectPath = `properties/${sanitizePropertyReference(input.propertyReference)}/${crypto.randomUUID()}-${propertyImageFileName(input.file.name)}`;
  const { data: media, error: mediaError } = await db()
    .from('property_media')
    .insert({
      agency_id: agencyId,
      property_id: propertyId,
      media_type: 'photo',
      storage_path: objectPath,
      // LOT B (point A) : URL publique permanente, lisible par l'agent Sofia
      // sans compte utilisateur. Le bucket property-images est public.
      public_url: getSupabaseClient()
        .storage
        .from(PROPERTY_IMAGES_BUCKET)
        .getPublicUrl(objectPath).data.publicUrl,
      file_name: input.file.name,
      mime_type: input.file.type,
      file_size: input.file.size,
      sort_order: Math.max(0, Math.trunc(input.sortOrder)),
      metadata: {},
    })
    .select('id, agency_id, property_id, media_type, storage_path, public_url, file_name, mime_type, file_size, sort_order, metadata, created_at')
    .single();
  if (mediaError) throw mediaError;

  const storage = getSupabaseClient().storage.from(PROPERTY_IMAGES_BUCKET);
  const { error: uploadError } = await storage.upload(objectPath, input.file, {
    cacheControl: '1800',
    contentType: input.file.type,
    upsert: false,
  });
  if (uploadError) {
    const message = getSupabaseErrorMessage(uploadError, 'envoyer la photo');
    await db()
      .from('property_media')
      .update({ metadata: { upload_failed: true, upload_error: message } })
      .eq('id', media.id)
      .eq('agency_id', agencyId)
      .eq('property_id', propertyId);
    throw new Error(message);
  }
  return media;
}

/**
 * BLOC 3 : résultat détaillé d'un envoi en lot.
 * `failed` liste les photos refusées (limite de l'offre appliquée par le trigger
 * `enforce_photo_limit`, fichier illisible, poids, réseau…) : un envoi multiple
 * n'est plus interrompu au premier échec, les photos qui passent sont conservées
 * et les refusées sont annoncées à l'utilisateur.
 */
export type PropertyMediaBatchResult = {
  uploaded: PropertyMediaRow[];
  failed: Array<{ file: File; reason: string }>;
};

export function useUploadPropertyMediaBatch(agencyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PropertyMediaBatchInput): Promise<PropertyMediaBatchResult> => {
      if (!agencyId || !input.propertyId) throw new Error('Aucune agence ni aucun bien actif n’est sélectionné.');
      if (!input.files.length) return { uploaded: [], failed: [] };
      const uploaded: PropertyMediaRow[] = [];
      const failed: Array<{ file: File; reason: string }> = [];
      input.onProgress?.(0, input.files.length);
      for (const file of input.files) {
        try {
          const media = await uploadPropertyMediaFile(agencyId, input.propertyId, {
            file,
            propertyReference: input.propertyReference,
            sortOrder: input.startSortOrder + uploaded.length,
          });
          uploaded.push(media);
        } catch (error) {
          failed.push({ file, reason: getSupabaseErrorMessage(error, 'envoyer la photo') });
        }
        input.onProgress?.(uploaded.length + failed.length, input.files.length);
      }
      return { uploaded, failed };
    },
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPropertyMediaQueryKey(agencyId, variables.propertyId) }),
        queryClient.invalidateQueries({ queryKey: getPropertiesQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export function useDeletePropertyMediaMany(agencyId?: string, propertyId?: string, canDelete = false) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rows: Array<Pick<PropertyMediaRow, 'id' | 'storage_path'>>) => {
      if (!agencyId || !propertyId) throw new Error('Aucune agence ni aucun bien actif n’est sélectionné.');
      if (!canDelete) throw new Error('Seuls les administrateurs et propriétaires peuvent supprimer des photos.');
      if (!rows.length) return [];
      const storage = getSupabaseClient().storage.from(PROPERTY_IMAGES_BUCKET);
      const { error: storageError } = await storage.remove(rows.map((row) => row.storage_path));
      if (storageError) throw storageError;
      const { error } = await db()
        .from('property_media')
        .delete()
        .in('id', rows.map((row) => row.id))
        .eq('agency_id', agencyId)
        .eq('property_id', propertyId);
      if (error) throw error;
      return rows.map((row) => row.id);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getPropertyMediaQueryKey(agencyId, propertyId) }),
        queryClient.invalidateQueries({ queryKey: getPropertiesQueryKey(agencyId) }),
        queryClient.invalidateQueries({ queryKey: getActivityLogQueryKey() }),
      ]);
    },
  });
}

export function useReorderPropertyMedia(agencyId?: string, propertyId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (order: Array<{ id: string; sort_order: number }>) => {
      if (!agencyId || !propertyId) throw new Error('Aucune agence ni aucun bien actif n’est sélectionné.');
      for (const item of order) {
        const { error } = await db()
          .from('property_media')
          .update({ sort_order: Math.max(0, Math.trunc(item.sort_order)) })
          .eq('id', item.id)
          .eq('agency_id', agencyId)
          .eq('property_id', propertyId);
        if (error) throw error;
      }
      return order;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getPropertyMediaQueryKey(agencyId, propertyId) });
    },
  });
}

export function useAgencyMediaRefs(agencyId?: string) {
  return useQuery({
    queryKey: ['sofia', 'agency-media-refs', agencyId ?? 'none'],
    enabled: Boolean(agencyId),
    queryFn: async (): Promise<Array<{ property_id: string; storage_path: string; public_url: string | null; sort_order: number }>> => {
      const { data, error } = await db()
        .from('property_media')
        .select('property_id, storage_path, public_url, sort_order')
        .eq('agency_id', agencyId as string)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

/* ---------------------------------------------------------------------------
 * Paiements d'abonnements (historique — admin plateforme uniquement via RLS).
 * ------------------------------------------------------------------------ */

export const getSubscriptionPaymentsQueryKey = () => ['sofia', 'subscription-payments'] as const;

export function useAllSubscriptionPayments() {
  return useQuery({
    queryKey: getSubscriptionPaymentsQueryKey(),
    queryFn: async (): Promise<SubscriptionPaymentRow[]> => {
      const { data, error } = await db()
        .from('subscription_payments')
        .select('id, agency_id, subscription_id, amount, currency, paid_at, period_start, period_end, method, recorded_by, note, created_at')
        .order('paid_at', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

/**
 * Enregistre un paiement reçu (manuel, admin) ET prolonge l'abonnement
 * de 30 jours à partir de la date de fin courante ou du jour.
 */
export function useRecordSubscriptionPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      agencyId: string;
      subscriptionId: string;
      amount: number;
      planName?: string;
      note?: string;
    }): Promise<SubscriptionPaymentRow> => {
      if (!Number.isFinite(input.amount) || input.amount < 0) {
        throw new Error('Le montant du paiement doit être un nombre positif.');
      }
      const auth = getSupabaseClient().auth;
      const { data: session } = await auth.getUser();
      const currentEndsAt = (() => {
        const now = new Date();
        const base = now.getTime();
        return new Date(base + 30 * 24 * 3600 * 1000).toISOString();
      })();
      const periodStart = new Date().toISOString().slice(0, 10);
      const periodEnd = currentEndsAt.slice(0, 10);
      const { data: payment, error: payError } = await db()
        .from('subscription_payments')
        .insert({
          agency_id: input.agencyId,
          subscription_id: input.subscriptionId,
          amount: input.amount,
          currency: 'XOF',
          period_start: periodStart,
          period_end: periodEnd,
          method: 'manual',
          recorded_by: session.user?.id ?? null,
          note: input.note ?? (input.planName ? `Paiement reçu — formule ${input.planName}` : 'Paiement reçu'),
        })
        .select('id, agency_id, subscription_id, amount, currency, paid_at, period_start, period_end, method, recorded_by, note, created_at')
        .single();
      if (payError) throw payError;
      const { error: subError } = await db()
        .from('agency_subscriptions')
        .update({ status: 'active', ends_at: currentEndsAt, updated_at: new Date().toISOString() })
        .eq('id', input.subscriptionId);
      if (subError) throw subError;
      return payment;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getSubscriptionPaymentsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getSubscriptionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getAllAgenciesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getPlatformSummaryQueryKey() }),
      ]);
    },
  });
}
