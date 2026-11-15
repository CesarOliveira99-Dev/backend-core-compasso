import { personNameSchema, phoneSchema } from '../../../core/application/person.schemas.js';
import { z } from 'zod';
import { weeklyHoursSchema } from './weekly-hours.schema.js';
import { businessProfileFields } from './business-profile.schemas.js';

export const settingsSchema = z
  .object({
    ...businessProfileFields,
    name: personNameSchema,
    businessName: z.string().trim().min(2).max(100),
    timezone: z.string().min(1).max(64).refine(value => {
      try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }).format(); return value.includes('/'); }
      catch { return false; }
    }, 'Escolha um fuso horário válido.'),
    completionMode: z.enum(['manual', 'automatic']),
    payOnAppointment: z.boolean(),
    payOnDelivery: z.boolean(),
    bankAccount: z.string().max(100),
    pixKey: z.string().max(100),
    weeklyHours: weeklyHoursSchema,
    openingHour: z.number().int().min(0).max(23),
    closingHour: z.number().int().min(1).max(24),
    workDays: z.array(z.number().int().min(0).max(6)).max(7),
  })
  .refine(
    (s) => s.closingHour > s.openingHour,
    'Horário de fechamento deve ser posterior à abertura.',
  );

