import { z } from 'zod';

export const checkoutSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string(),
        quantity: z.number().int().min(1).max(50),
        startsAt: z.string().datetime().optional(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(30),
  coupon: z.string().max(40).optional(),
  paymentMethod: z.enum(['on_day', 'online']),
  addressId: z.string().optional(),
  idempotencyKey: z.string().uuid(),
  expectedTotalCents: z.number().int().nonnegative().optional(),
});
