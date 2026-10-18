export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type AgencyRole = 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
export type AgencyMemberStatus = 'active' | 'invited' | 'suspended' | 'removed';
export type PropertyTransactionType = 'sale' | 'rent' | 'lease';
export type PropertyStatus =
  | 'available'
  | 'reserved'
  | 'sold'
  | 'rented'
  | 'unavailable'
  | 'draft'
  | 'archived';
export type ContactStatus = 'lead' | 'prospect' | 'client' | 'inactive';
export type PropertyMediaType = 'photo' | 'video' | 'document';

export interface AgencyRow {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string;
  timezone: string;
  currency: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgencyMemberRow {
  id: string;
  agency_id: string;
  user_id: string;
  role: AgencyRole;
  status: AgencyMemberStatus;
  created_at: string;
  updated_at: string;
}

export interface UserProfileRow {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyRow {
  id: string;
  agency_id: string;
  reference: string;
  title: string;
  description: string | null;
  transaction_type: PropertyTransactionType;
  property_type: string;
  status: PropertyStatus;
  price: number;
  currency: string;
  neighborhood: string | null;
  city: string | null;
  address: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area_m2: number | null;
  latitude: number | null;
  longitude: number | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface PropertyMediaRow {
  id: string;
  agency_id: string;
  property_id: string;
  media_type: PropertyMediaType;
  storage_path: string;
  public_url: string | null;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  sort_order: number;
  metadata: Json;
  created_at: string;
}

export interface ContactRow {
  id: string;
  agency_id: string;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  whatsapp_number: string | null;
  status: ContactStatus;
  source: string | null;
  assigned_user_id: string | null;
  notes: string | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface SalesPipelineRow {
  id: string;
  agency_id: string;
  client_id: string;
  property_id: string;
  etape: string;
  probabilite: number;
  notes: string | null;
  date_visite: string | null;
  created_at: string;
  updated_at: string;
}

type TableDefinition<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
  saas_immobilier: {
    Tables: {
      agencies: TableDefinition<AgencyRow>;
      agency_members: TableDefinition<AgencyMemberRow>;
      user_profiles: TableDefinition<UserProfileRow>;
      properties: TableDefinition<PropertyRow>;
      property_media: TableDefinition<PropertyMediaRow>;
      contacts: TableDefinition<ContactRow>;
      sales_pipeline: TableDefinition<SalesPipelineRow>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
