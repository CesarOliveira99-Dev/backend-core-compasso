import { z } from 'zod';

export const settingsSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    businessName: z.string().trim().min(2).max(100),
    timezone: z.literal('America/Sao_Paulo'),
    completionMode: z.enum(['manual', 'automatic']),
    payOnAppointment: z.boolean(),
    payOnDelivery: z.boolean(),
    bankAccount: z.string().max(100),
    pixKey: z.string().max(100),
    openingHour: z.number().int().min(0).max(23),
    closingHour: z.number().int().min(1).max(24),
    workDays: z.array(z.number().int().min(0).max(6)).min(1),
  })
  .refine(
    (s) => s.closingHour > s.openingHour,
    'Horário de fechamento deve ser posterior à abertura.',
  );
