import { z } from 'zod';

export const discountSchema = z
  .object({
    name: z.string().min(2).max(100),
    code: z.string().max(40).optional(),
    percent: z.number().int().min(1).max(100),
    itemIds: z.array(z.string()).max(100).default([]),
    kinds: z.array(z.enum(['service', 'product'])).default([]),
    weekdays: z.array(z.number().int().min(0).max(6)).default([]),
    startsAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    maxUses: z.number().int().min(0).max(1000000).default(0),
    active: z.boolean().default(true),
  })
  .refine(
    (v) => new Date(v.expiresAt) > new Date(v.startsAt),
    'A validade deve terminar após o início.',
  );
