import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AgencyMemberRow,
  AgencyRow,
  ContactRow,
  ContactStatus,
  PropertyRow,
  PropertyStatus,
  PropertyTransactionType,
  SalesPipelineRow,
  UserProfileRow,
} from './database.types';
import { getSupabaseClient } from './supabase';

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
      const [properties, available, contacts, pipeline, members] = await Promise.all([
        schema.from('properties').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        schema
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('status', 'available'),
        schema.from('contacts').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        schema.from('sales_pipeline').select('id', { count: 'exact', head: true }).eq('agency_id', agencyId),
        schema
          .from('agency_members')
          .select('id', { count: 'exact', head: true })
          .eq('agency_id', agencyId)
          .eq('status', 'active'),
      ]);
      const firstError = [properties, available, contacts, pipeline, members].find((result) => result.error)?.error;
      if (firstError) throw firstError;
      return {
        properties: properties.count ?? 0,
        availableProperties: available.count ?? 0,
        contacts: contacts.count ?? 0,
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
        .update(input)
        .eq('id', userId)
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
