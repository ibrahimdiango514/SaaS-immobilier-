import { z } from 'zod';
import { visitDateKey } from './visit-utils.js';

export const pipelineFormSchema = z.object({
  client_id: z.string().trim().min(1, 'Choisissez un contact'),
  property_id: z.string().trim().min(1, 'Choisissez un bien'),
  etape: z.string().trim().min(1, 'L’étape est obligatoire'),
  probabilite: z.coerce.number()
    .min(0, 'La probabilité doit être comprise entre 0 et 100')
    .max(100, 'La probabilité doit être comprise entre 0 et 100'),
  date_visite: z.string().optional().refine(
    (value) => !value || visitDateKey(value) !== null,
    'Choisissez une date de visite valide',
  ),
  notes: z.string().trim().optional(),
});
