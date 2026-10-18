import type { ContactStatus } from './database.types';

export type ContactFormValues = {
  first_name: string;
  last_name?: string;
  phone?: string;
  email?: string;
  whatsapp_number?: string;
  status: ContactStatus;
  assigned_user_id: string;
  source?: string;
  notes?: string;
};

export declare const contactFormSchema: import('zod').ZodType<ContactFormValues>;
