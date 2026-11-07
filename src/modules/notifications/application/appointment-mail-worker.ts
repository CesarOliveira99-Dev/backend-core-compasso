import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Context } from '../../../core/application/context.js';
import type { Appointment, Customer } from '../../../core/domain/models.js';
import { appointmentMailEnabled, type AppointmentMailJob } from './appointment-mail.js';

export interface AppointmentMailSender {
  send(job: AppointmentMailJob): Promise<void>;
}

export class ResendAppointmentMail implements AppointmentMailSender {
  async send(job: AppointmentMailJob) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json', 'Idempotency-Key': `appointment/${job.id}`,
      },
      body: JSON.stringify({ from: job.from, to: [job.email], subject: job.subject, text: job.text }),
    });
    if (!response.ok) throw new Error(`Mail provider status ${response.status}`);
  }
}

@Injectable()
export class AppointmentMailWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly context: Context) {}
  onModuleInit() {
    this.timer = setInterval(() => { void this.run().catch(() => console.error('Appointment mail cycle failed')); }, 30000);
    this.timer.unref();
    void this.run().catch(() => console.error('Appointment mail cycle failed'));
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async run(now = Date.now(), sender: AppointmentMailSender = new ResendAppointmentMail()) {
    if (this.running || !appointmentMailEnabled() || !process.env.RESEND_API_KEY) return;
    this.running = true;
    try {
      let processed = 0;
      const repository = this.context.repository;
      for (const store of repository.list<{ tenantId: string }>('system', 'stores')) {
        for (const job of repository.list<AppointmentMailJob>(store.tenantId, 'appointment_mail')) {
          if (job.state !== 'pending' || job.nextAttemptAt > now) continue;
          // Stop well inside Resend's 24-hour idempotency window, even after downtime.
          const expired = now - (job.firstAttemptAt ?? job.createdAt) >= 23 * 3600000;
          const appointment = repository.get<Appointment>(store.tenantId, 'appointments', job.appointmentId);
          const customer = repository.get<Customer>(store.tenantId, 'customers', job.customerId);
          if (expired || !appointment || appointment.status !== 'confirmed' ||
            appointment.startsAt !== job.startsAt || Date.parse(job.startsAt) <= now ||
            !customer?.emailVerified || customer.email !== job.email || customer.role !== 'customer' ||
            appointment.customerId !== job.customerId) {
            repository.put(store.tenantId, 'appointment_mail', job.id, { ...job, state: 'skipped' });
            continue;
          }
          if (processed++ >= 10) return;
          const attempt = { ...job, attempts: job.attempts + 1, firstAttemptAt: job.firstAttemptAt ?? now };
          repository.put(store.tenantId, 'appointment_mail', job.id, attempt);
          try {
            await sender.send(attempt);
            repository.put(store.tenantId, 'appointment_mail', job.id, { ...attempt, state: 'sent' });
          } catch {
            repository.put(store.tenantId, 'appointment_mail', job.id, {
              ...attempt, state: attempt.attempts >= 6 ? 'failed' : 'pending',
              nextAttemptAt: now + Math.min(3600000, 60000 * 2 ** (attempt.attempts - 1)),
            });
            console.error('Appointment email deferred', job.id, attempt.attempts);
          }
          // Respect provider throughput while keeping booking requests independent.
          if (sender instanceof ResendAppointmentMail)
            await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
    } finally { this.running = false; }
  }
}
