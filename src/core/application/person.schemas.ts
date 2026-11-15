import { z } from 'zod';
import { personNameError, phoneError } from '../domain/person-validation.js';
export const personNameSchema = z.string().superRefine((value, ctx) => {
  const message = personNameError(value);
  if (message) ctx.addIssue({ code: 'custom', message });
}).transform(value => value.normalize('NFC').trim().replace(/\s+/gu, ' '));
export const phoneSchema = z.string().superRefine((value, ctx) => {
  const message = phoneError(value);
  if (message) ctx.addIssue({ code: 'custom', message });
}).transform(value => value.replace(/\D/g, ''));
