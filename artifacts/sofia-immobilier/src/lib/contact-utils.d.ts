import type { AgencyMemberRow, ContactRow, ContactStatus, SalesPipelineRow } from './database.types';

export type ContactFilters = {
  search?: string;
  status?: ContactStatus | 'all';
  assignedUserId?: string;
};

export type ContactFormDefaults = {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  whatsapp_number: string;
  status: ContactStatus;
  assigned_user_id: string;
  source: string;
  notes: string;
};

export declare function normalizeContactSearch(value?: string | null): string;
export declare function formatContactName(contact?: Pick<ContactRow, 'first_name' | 'last_name'> | null): string;
export declare function getAssignableContactMembers(members: readonly AgencyMemberRow[]): AgencyMemberRow[];
export declare function canAssignContactToMember(
  userId: string | null | undefined,
  members: readonly AgencyMemberRow[],
  existingAssigneeId?: string | null,
): boolean;
export declare function contactFormDefaults(item: ContactRow | null): ContactFormDefaults;
export declare function filterContacts(contacts: readonly ContactRow[], filters?: ContactFilters): ContactRow[];
export declare function linkedOpportunitiesForContact(
  opportunities: readonly SalesPipelineRow[],
  contactId?: string | null,
): SalesPipelineRow[];
