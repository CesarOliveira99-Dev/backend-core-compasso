import { z } from 'zod';

export const itemSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().max(1000).default(''),
    kind: z.enum(['service', 'product']),
    category: z.string().min(1).max(80),
    priceCents: z.number().int().min(1).max(100000000),
    durationMinutes: z.number().int().min(0).max(720),
    requiresTriage: z.boolean().default(false),
    active: z.boolean().default(true),
  })
  .refine(
    (item) => item.kind !== 'service' || item.durationMinutes > 0,
    'Serviços precisam de duração.',
  );
