import { z } from 'zod';

export const bookingSchema = z.object({
  itemId: z.string(),
  customerId: z.string().optional(),
  startsAt: z.string().datetime(),
  notes: z.string().max(2000).default(''),
});
