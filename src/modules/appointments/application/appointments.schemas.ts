import { z } from "zod";

export const bookingSchema = z.object({
  idempotencyKey: z.string().uuid().optional(),
  expectedPriceCents: z.number().int().nonnegative().optional(),
  durationMinutes: z.number().int().min(1).max(720).optional(),
  itemId: z.string(),
  professionalId: z.string().optional(),
  customerId: z.string().optional(),
  startsAt: z.string().datetime(),
  notes: z.string().max(2000).default(""),
});
