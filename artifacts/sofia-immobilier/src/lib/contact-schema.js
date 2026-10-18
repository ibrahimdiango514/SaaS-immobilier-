import { z } from 'zod';

export const contactFormSchema = z.object({
  first_name: z.string().trim().min(1, 'Le prénom est obligatoire'),
  last_name: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.preprocess(
    (value) => typeof value === 'string' ? value.trim() : value,
    z.string().email('Adresse e-mail invalide').or(z.literal('')).optional(),
  ),
  whatsapp_number: z.string().trim().optional(),
  status: z.enum(['lead', 'prospect', 'client', 'inactive']),
  assigned_user_id: z.string().uuid('Choisissez un membre valide').or(z.literal('')),
  source: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});
