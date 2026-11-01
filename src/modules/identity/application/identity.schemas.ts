import { SetMetadata } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../../../core/domain/models.js';

export const Public = () => SetMetadata('public', true);
export interface AuthRequest {
  actor: Actor;
  headers: Record<string, string | undefined>;
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':');
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex'));
}
export const credentialsSchema = z.object({
  email: z
    .string()
    .email()
    .transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(128),
  slug: z.string().min(2).max(60).default('studio'),
});
export const registrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(100),
  phone: z.string().min(10).max(20),
  role: z.enum(['admin', 'customer']),
  businessName: z.string().max(100).optional(),
});
