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
export type PlatformProfileRole = 'admin' | 'agency';
export type RevenueOperationType = 'sale' | 'rental' | 'commission' | 'other';
export type RevenueOperationStatus = 'completed' | 'pending' | 'cancelled';

export interface RevenueOperationRow {
  id: string;
  agency_id: string;
  property_id: string | null;
  operation_type: RevenueOperationType;
  amount: number;
  commission: number | null;
  operation_date: string;
  status: RevenueOperationStatus;
  source: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

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
  logo_url: string | null;
  description: string | null;
  commission_rate: number;
  rental_commission_rate: number;
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
  email: string | null;
  role: PlatformProfileRole;
  created_at: string;
  updated_at: string;
  must_change_password?: boolean | null;
}

export interface PlatformAdminRow {
  id: string;
  user_id: string;
  role: string;
  status: string;
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
  commission_rate: number | null;
  rental_commission_rate: number | null;
  metadata: Json;
  created_at: string;
  updated_at: string;
  /** BLOC 6 : bien masqué des listes courantes mais conservé (historique, CA). */
  is_archived: boolean;
  archived_at: string | null;
}

export interface PropertyMediaRow {
  id: string;
  agency_id: string;
  property_id: string;
  media_type: string;
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

export interface PropertyVisitRow {
  id: string;
  agency_id: string;
  appointment_id: string | null;
  contact_id: string;
  property_id: string;
  agent_user_id: string | null;
  status: string;
  feedback: string | null;
  visited_at: string | null;
  notes: string | null;
  visit_type: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  agency_id: string;
  contact_id: string;
  whatsapp_connection_id: string | null;
  status: string;
  mode: string;
  assigned_user_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessageRow {
  id: string;
  agency_id: string;
  conversation_id: string;
  sender_type: string;
  sender_user_id: string | null;
  message_type: string;
  content: string | null;
  provider_message_id: string | null;
  metadata: Json;
  created_at: string;
}

export interface FollowUpRow {
  id: string;
  agency_id: string;
  contact_id: string;
  assigned_user_id: string | null;
  conversation_id: string | null;
  type: string;
  scheduled_at: string;
  completed_at: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppConnectionRow {
  id: string;
  agency_id: string;
  provider: string;
  connection_name: string;
  phone_number: string | null;
  phone_number_id: string | null;
  instance_id: string | null;
  status: string;
  credentials_ref: string | null;
  config: Json;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: string;
  agency_id: string;
  user_id: string | null;
  type: string;
  title: string;
  message: string;
  data: Json;
  read_at: string | null;
  created_at: string;
}

export interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  price_monthly: number;
  currency: string;
  max_members: number;
  max_properties: number;
  max_whatsapp_connections: number;
  monthly_ai_tokens: number;
  monthly_conversations: number;
  features: Json;
  created_at: string;
  updated_at: string;
  /** LOT A : libellé commercial (« Essentiel », « Pro », « Premium »). */
  display_name: string | null;
  setup_fee: number | null;
  max_photos_per_property: number | null;
  monthly_agent_messages: number | null;
  monthly_follow_ups?: number | null;
  modules: string[] | null;
  sort_order: number | null;
}

export interface AgencySubscriptionRow {
  id: string;
  agency_id: string;
  plan_id: string;
  status: string;
  starts_at: string;
  ends_at: string | null;
  trial_ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionPaymentRow {
  id: string;
  agency_id: string;
  subscription_id: string | null;
  amount: number;
  currency: string;
  paid_at: string;
  period_start: string | null;
  period_end: string | null;
  method: string;
  recorded_by: string | null;
  note: string | null;
  created_at: string;
}

export interface ActivityLogRow {
  id: string;
  agency_id: string | null;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  metadata: Json;
  created_at: string;
}

export interface UsageEventRow {
  id: string;
  agency_id: string;
  user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Json;
  event_key: string;
  created_at: string;
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
      platform_admins: TableDefinition<PlatformAdminRow>;
      properties: TableDefinition<PropertyRow>;
      property_media: TableDefinition<PropertyMediaRow>;
      contacts: TableDefinition<ContactRow>;
      sales_pipeline: TableDefinition<SalesPipelineRow>;
      property_visits: TableDefinition<PropertyVisitRow>;
      conversations: TableDefinition<ConversationRow>;
      conversation_messages: TableDefinition<ConversationMessageRow>;
      follow_ups: TableDefinition<FollowUpRow>;
      whatsapp_connections: TableDefinition<WhatsAppConnectionRow>;
      notifications: TableDefinition<NotificationRow>;
      plans: TableDefinition<PlanRow>;
      agency_subscriptions: TableDefinition<AgencySubscriptionRow>;
      activity_log: TableDefinition<ActivityLogRow>;
      usage_events: TableDefinition<UsageEventRow>;
      revenue_operations: TableDefinition<RevenueOperationRow>;
      subscription_payments: TableDefinition<SubscriptionPaymentRow>;
    };
    Views: Record<string, never>;
    Functions: {
      mon_etat_compte: {
        Args: Record<string, never>;
        Returns: Json;
      };
      agence_active: {
        Args: { p_agency_id: string };
        Returns: boolean;
      };
      create_agency_for_self: {
        Args: {
          p_name: string;
          p_legal_name?: string | null;
          p_phone?: string | null;
          p_email?: string | null;
          p_address?: string | null;
          p_city?: string | null;
          p_country?: string;
          p_timezone?: string;
          p_currency?: string;
          p_description?: string | null;
          p_logo_url?: string | null;
        };
        Returns: AgencyRow;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
