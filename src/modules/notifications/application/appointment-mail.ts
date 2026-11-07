import { createHash } from 'node:crypto';
import { Context } from '../../../core/application/context.js';
import type { Actor, Appointment, Customer, Settings } from '../../../core/domain/models.js';

export type AppointmentMailKind = 'confirmation' | 'reminder';
export interface AppointmentMailJob {
  id: string;
  appointmentId: string;
  startsAt: string;
  customerId: string;
  email: string;
  from: string;
  subject: string;
  text: string;
  kind: AppointmentMailKind;
  state: 'pending' | 'sent' | 'skipped' | 'failed';
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  firstAttemptAt?: number;
}

export const appointmentMailEnabled = () => process.env.APPOINTMENT_EMAILS_ENABLED === 'true';

/** Persisted with the booking transaction; network I/O belongs to the worker. */
export function queueAppointmentMail(
  context: Context,
  actor: Pick<Actor, 'tenantId'>,
  appointment: Appointment,
  kind: AppointmentMailKind,
  now = Date.now(),
) {
  if (!appointmentMailEnabled() || appointment.status !== 'confirmed') return;
  const repository = context.repository;
  const customer = repository.get<Customer>(actor.tenantId, 'customers', appointment.customerId);
  const settings = repository.get<Settings>(actor.tenantId, 'settings', 'business');
  if (!customer?.emailVerified || customer.role !== 'customer' || !settings) return;
  if (!process.env.MAIL_FROM || !process.env.APP_URL || !process.env.RESEND_API_KEY) return;
  if (!URL.canParse(process.env.APP_URL)) return;
  const origin = new URL(process.env.APP_URL);
  if (origin.protocol !== 'https:' && process.env.NODE_ENV === 'production') return;
  const id = createHash('sha256')
    .update(`${actor.tenantId}:${appointment.id}:${appointment.startsAt}:${kind}`)
    .digest('hex');
  if (repository.get(actor.tenantId, 'appointment_mail', id)) return;
  const subject = kind === 'confirmation' ? 'Agendamento confirmado — Compasso' : 'Seu atendimento está chegando — Compasso';
  const date = new Date(appointment.startsAt).toLocaleString('pt-BR', { timeZone: settings.timezone });
  const text = [
    `Olá, ${customer.name}!`,
    kind === 'confirmation' ? 'Seu agendamento foi confirmado.' : 'Lembrete: seu atendimento começa em até uma hora.',
    `Estabelecimento: ${settings.businessName || settings.name}`,
    `Serviço: ${appointment.itemName}`,
    `Profissional: ${appointment.professionalName || 'Equipe do estabelecimento'}`,
    `Data e horário: ${date} (${settings.timezone})`,
    `Acompanhe os detalhes e alterações na sua conta: ${origin.origin}/`,
    'Compasso',
  ].join('\n\n');
  repository.put<AppointmentMailJob>(actor.tenantId, 'appointment_mail', id, {
    id, appointmentId: appointment.id, startsAt: appointment.startsAt,
    customerId: customer.id, email: customer.email, from: process.env.MAIL_FROM,
    subject, text, kind, state: 'pending', attempts: 0, createdAt: now, nextAttemptAt: now,
  });
}
