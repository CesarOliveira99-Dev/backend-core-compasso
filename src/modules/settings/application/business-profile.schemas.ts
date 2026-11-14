import { phoneSchema } from '../../../core/application/person.schemas.js';
import { z } from 'zod';

export const businessAddressSchema = z.object({
  postalCode: z
    .string()
    .transform((value) => value.replace(/\D/g, ''))
    .pipe(z.string().regex(/^\d{8}$/, 'Informe um CEP com oito dígitos.')),

  street: z.string().trim().min(2).max(150),
  number: z.string().trim().min(1).max(20),

  district: z.string().trim().max(100).default(''),
  city: z.string().trim().min(2).max(100),

  state: z
    .string()
    .regex(/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/),

  complement: z.string().trim().max(150).default(''),
});

export const mediaAssetSchema = z.object({
  category: z.enum(['workspace', 'portfolio']).optional(),
  url: z.string().regex(/^\/api\/media\/[a-f0-9-]{36}$/),

  type: z.enum(['image', 'video']),
  alt: z.string().trim().max(150).default(''),
});

export const businessProfileFields = {
  phone: phoneSchema.optional(),
  address: businessAddressSchema.optional(),

  description: z.string().trim().max(2000).optional(),
  media: z.array(mediaAssetSchema).max(12).optional(),

  setupComplete: z.boolean().optional(),
};
