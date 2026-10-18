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
import {
  propertyImageObjectPath,
  propertyMediaDeleteStorageAction,
  propertyMediaInsertFailureAction,
  propertyStorageUploadFailureAction,
  validatePropertyImage,
} from './property-media-utils.js';

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
  sortOrder: number;
};

const PROPERTY_IMAGES_BUCKET = 'property-images';

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

export function useUploadPropertyMedia(
  agencyId?: string,
  propertyId?: string,
  canUpload = false,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PropertyMediaUploadInput) => {
      if (!agencyId || !propertyId) {
        throw new Error('Aucune agence ni aucun bien actif n’est sélectionné.');
      }
      if (!canUpload) {
        throw new Error('Votre rôle ne permet pas d’ajouter des photos à ce bien.');
      }
      validatePropertyImage(input.file);

      const objectPath = propertyImageObjectPath(agencyId, propertyId, input.file.name);
      const storage = getSupabaseClient().storage.from(PROPERTY_IMAGES_BUCKET);
      const { error: uploadError } = await storage.upload(objectPath, input.file, {
        cacheControl: '1800',
        contentType: input.file.type,
        upsert: false,
      });
      if (uploadError) {
        if (propertyStorageUploadFailureAction(uploadError) === 'do-not-clean') {
          throw uploadError;
        }
        const uploadMessage = getSupabaseErrorMessage(uploadError, 'envoyer la photo');
        const { error: cleanupError } = await storage.remove([objectPath]);
        if (cleanupError) {
          throw new Error(
            `${uploadMessage} Le nettoyage a échoué; un administrateur doit vérifier le chemin ${objectPath}. ` +
              getSupabaseErrorMessage(cleanupError, 'nettoyer le téléversement'),
          );
        }
        throw uploadError;
      }

      const { error: mediaError } = await db()
        .from('property_media')
        .insert({
          agency_id: agencyId,
          property_id: propertyId,
          media_type: 'photo',
          storage_path: objectPath,
          public_url: null,
          file_name: input.file.name,
          mime_type: input.file.type,
          file_size: input.file.size,
          sort_order: Math.max(0, Math.trunc(input.sortOrder)),
          metadata: {},
        });

      if (mediaError) {
        const registrationMessage = getSupabaseErrorMessage(
          mediaError,
          'enregistrer la fiche de la photo',
        );
        const { data: existingMedia, error: verificationError } = await db()
          .from('property_media')
          .select('id')
          .eq('agency_id', agencyId)
          .eq('property_id', propertyId)
          .eq('storage_path', objectPath)
          .maybeSingle();
        const action = propertyMediaInsertFailureAction({
          rowFound: Boolean(existingMedia),
          verificationFailed: Boolean(verificationError),
          insertErrorCode: (mediaError as { code?: unknown }).code,
        });

        if (action === 'registered') return objectPath;
        if (action === 'preserve-for-review') {
          const verificationMessage = verificationError
            ? ` Vérification impossible : ${getSupabaseErrorMessage(verificationError, 'vérifier la fiche de la photo')}`
            : ' La réponse de l’insertion est ambiguë; la fiche n’a pas pu être confirmée.';
          throw new Error(
            `${registrationMessage}${verificationMessage} Le fichier est conservé pour éviter de supprimer une photo peut-être enregistrée. ` +
              `Chemin à vérifier : ${objectPath}.`,
          );
        }

        const { error: cleanupError } = await storage.remove([objectPath]);
        if (cleanupError) {
          throw new Error(
            `${registrationMessage} Le fichier temporaire n’a pas pu être supprimé. ` +
              `Un administrateur devra vérifier le chemin ${objectPath}. ` +
              getSupabaseErrorMessage(cleanupError, 'supprimer le fichier temporaire'),
          );
        }
        throw mediaError;
      }

      return objectPath;
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

      const { data: deletedMedia, error: metadataError } = await db()
        .from('property_media')
        .delete()
        .eq('id', media.id)
        .eq('agency_id', agencyId)
        .eq('property_id', propertyId)
        .select('id')
        .maybeSingle();

      // Retirer d'abord la référence SQL. La suppression Storage est un système
      // séparé; une erreur de vérification conserve le blob au lieu de risquer
      // d'effacer un fichier encore référencé.
      const { data: linkedMedia, error: verificationError } = await db()
        .from('property_media')
        .select('id')
        .eq('storage_path', media.storage_path);
      const deleteAction = propertyMediaDeleteStorageAction({
        targetMediaId: media.id,
        linkedMediaIds: linkedMedia?.map((row) => row.id) ?? [],
        verificationFailed: Boolean(verificationError),
      });

      if (deleteAction === 'preserve-for-review') {
        const verificationMessage = verificationError
          ? getSupabaseErrorMessage(verificationError, 'vérifier les références de la photo')
          : 'Les références de la photo n’ont pas pu être vérifiées.';
        throw new Error(
          `La fiche a peut-être été retirée, mais le fichier Storage est conservé jusqu’à vérification. ${verificationMessage}`,
        );
      }
      if (deleteAction === 'preserve-linked-metadata') {
        const deletionMessage = metadataError
          ? getSupabaseErrorMessage(metadataError, 'supprimer la fiche de la photo')
          : 'La suppression de la fiche n’a pas été confirmée.';
        throw new Error(
          `La fiche média existe encore; le fichier Storage n’a pas été touché. ${deletionMessage}`,
        );
      }
      if (deleteAction === 'keep-referenced-object') {
        if (metadataError && !deletedMedia) {
          throw new Error(
            `La suppression de la fiche n’a pas été confirmée; le fichier est conservé car une autre fiche le référence. ${getSupabaseErrorMessage(metadataError, 'supprimer la fiche de la photo')}`,
          );
        }
        return media.id;
      }

      const { error: storageError } = await getSupabaseClient()
        .storage.from(PROPERTY_IMAGES_BUCKET)
        .remove([media.storage_path]);
      if (storageError) {
        throw new Error(
          `La fiche a été retirée, mais le fichier Storage reste à nettoyer (${media.storage_path}). ${getSupabaseErrorMessage(storageError, 'supprimer le fichier photo')}`,
        );
      }
      return media.id;
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
