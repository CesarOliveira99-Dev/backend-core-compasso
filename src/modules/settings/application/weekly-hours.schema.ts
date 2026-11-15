import { z } from 'zod';
export const weeklyHoursSchema = z
  .array(
    z
      .object({
        day: z.number().int().min(0).max(6),
        openingHour: z.number().min(0).max(23.999),
        closingHour: z.number().min(0).max(24),
      })
      .refine(
        (value) => value.closingHour > value.openingHour,
        'O fechamento deve ser posterior à abertura.',
      ),
  )
  .max(7)
  .refine(
    (days) => new Set(days.map((day) => day.day)).size === days.length,
    'Dia da semana repetido.',
  )
  .optional();
