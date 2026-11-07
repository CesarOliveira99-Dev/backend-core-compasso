import { z } from 'zod';
import { weeklyHoursSchema } from './weekly-hours.schema.js';
import { businessProfileFields } from './business-profile.schemas.js';

export const settingsSchema = z
  .object({
    ...businessProfileFields,
    name: z.string().trim().min(2).max(100),
    businessName: z.string().trim().min(2).max(100),
    timezone: z.literal('America/Sao_Paulo'),
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
