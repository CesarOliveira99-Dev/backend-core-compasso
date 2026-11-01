import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Context, timestamp } from '../../../core/application/context.js';
import type { Actor, Appointment, Loyalty, Settings } from '../../../core/domain/models.js';
import { localDate } from '../../../core/domain/policies.js';
@Injectable()
export class ReminderWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly context: Context) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (error) {
        console.error(
          'Reminder cycle failed',
          error instanceof Error ? error.message : 'Unknown error',
        );
      }
    }, 30000);
    this.timer.unref();
    this.run();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  run(now = new Date()) {
    for (const store of this.context.repository.list<{ tenantId: string }>('system', 'stores')) {
      const settings = this.context.repository.get<Settings>(
        store.tenantId,
        'settings',
        'business',
      );
      if (!settings) continue;
      const admin = this.context.repository
        .list<Actor>(store.tenantId, 'customers')
        .find((u) => u.role === 'admin');
      if (!admin) continue;
      for (const appointment of this.context.repository
        .list<Appointment>(store.tenantId, 'appointments')
        .filter((a) => a.status === 'confirmed')) {
        const until = new Date(appointment.startsAt).getTime() - now.getTime();
        if (until > 0 && until <= 3600000) {
          this.context.notify(
            admin,
            appointment.customerId,
            'Seu atendimento está chegando',
            `${appointment.itemName} começa em breve.`,
            `reminder:${appointment.id}:${appointment.startsAt}`,
          );
          this.context.notifyAdmins(
            admin,
            'Próximo atendimento',
            `${appointment.customerName} • ${appointment.itemName}`,
            `admin-reminder:${appointment.id}:${appointment.startsAt}`,
          );
        }
        if (settings.completionMode === 'automatic' && new Date(appointment.endsAt) <= now) {
          this.context.repository.put(store.tenantId, 'appointments', appointment.id, {
            ...appointment,
            status: 'completed',
            completedAt: timestamp(),
          });
          this.context.notify(
            admin,
            appointment.customerId,
            'Como foi seu atendimento?',
            'O atendimento foi finalizado automaticamente. Você já pode avaliar e programar o próximo.',
            `feedback:${appointment.id}`,
          );
        }
      }
      for (const loyalty of this.context.repository
        .list<Loyalty>(store.tenantId, 'loyalty')
        .filter((l) => l.status === 'active' && l.nextDate <= localDate(now, settings.timezone))) {
        this.context.notify(
          admin,
          loyalty.customerId,
          'Hora de cuidar de você novamente',
          `Você pediu um lembrete para ${loyalty.itemName}. Faça uma nova solicitação quando desejar.`,
          `loyalty:${loyalty.id}`,
        );
        this.context.repository.put(store.tenantId, 'loyalty', loyalty.id, {
          ...loyalty,
          status: 'reminded',
        });
      }
    }
  }
}
