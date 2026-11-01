import { z } from 'zod';

export const addressSchema = z.object({
  label: z.string().min(1).max(50),
  street: z.string().min(3).max(150),
  number: z.string().min(1).max(20),
  city: z.string().min(2).max(100),
  postalCode: z.string().min(8).max(10),
  isDefault: z.boolean().default(false),
});
