import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgencyMemberRow,
  AgencyRow,
  ContactRow,
  ContactStatus,
  PropertyMediaRow,
  PropertyRow,
  PropertyStatus,
  PropertyTransactionType,
  SalesPipelineRow,
  UserProfileRow,
} from './database.types';
import { getSupabaseClient, getSupabaseErrorMessage } from './supabase';

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
    'name' | 'legal_name' | 'phone' | 'email' | 'address' | 'city' | 'country' | 'timezone' | 'currency'
  >
>;

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
const MAX_PROPERTY_IMAGE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_PROPERTY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function sanitizePropertyReference(reference: string) {
  return reference.trim().replace(/[^A-Za-z0-9_-]+/g, '').toUpperCase().slice(0, 24) || 'BIEN';
}

function validatePropertyImage(file: File) {
  if (!SUPPORTED_PROPERTY_IMAGE_TYPES.has(file.type)) {
    throw new Error('Utilisez une image JPG, PNG ou WebP.');
  }
  if (file.size > MAX_PROPERTY_IMAGE_SIZE) {
    throw new Error('Chaque image doit peser 10 Mo maximum.');
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
          media_type: 'image',
          storage_path: objectPath,
          public_url: null,
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
        .select('id, name, slug, legal_name, phone, email, address, city, country, timezone, currency, status, created_at, updated_at')
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
        .select('id, full_name, phone, avatar_url, created_at, updated_at')
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
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, metadata, created_at, updated_at')
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
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, metadata, created_at, updated_at')
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
        .select('id, agency_id, reference, title, description, transaction_type, property_type, status, price, currency, neighborhood, city, address, bedrooms, bathrooms, area_m2, latitude, longitude, metadata, created_at, updated_at')
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
        .select('id, name, slug, legal_name, phone, email, address, city, country, timezone, currency, status, created_at, updated_at')
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
