import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, parse } from '../../../core/application/context.js';
import type { Actor, Appointment, Order, Triage } from '../../../core/domain/models.js';
@Injectable()
export class TriageService {
  constructor(private readonly context: Context) {}
  list(actor: Actor) {
    return this.context.repository
      .list<Triage>(
        actor.tenantId,
        'triage',
        actor.role === 'admin' ? {} : { customerId: actor.id },
      )
      .filter((t) => actor.role === 'admin' || t.customerId === actor.id);
  }
  decide(actor: Actor, recordId: string, body: unknown) {
    this.context.admin(actor);
    const input = parse(
      z.object({
        status: z.enum(['approved', 'declined']),
        decision: z.string().trim().min(3).max(2000),
      }),
      body,
    );
    return this.context.repository.transaction(() => {
      const triage = this.context.require<Triage>(actor, 'triage', recordId);
      if (triage.status !== 'pending')
        throw new BadRequestException('Esta triagem já recebeu uma decisão.');
      if (triage.appointmentId) {
        const appointment = this.context.require<Appointment>(
          actor,
          'appointments',
          triage.appointmentId,
        );
        if (appointment.status !== 'pending')
          throw new BadRequestException('O agendamento já foi alterado.');
        this.context.repository.put(actor.tenantId, 'appointments', appointment.id, {
          ...appointment,
          status: input.status === 'approved' ? 'confirmed' : 'cancelled',
        });
      }
      if (triage.orderId && input.status === 'declined') {
        const order = this.context.require<Order>(actor, 'orders', triage.orderId);
        this.context.repository.put(actor.tenantId, 'orders', order.id, {
          ...order,
          status: 'cancelled',
        });
        this.context.repository
          .list<Appointment>(actor.tenantId, 'appointments')
          .filter((a) => a.orderId === order.id && a.status !== 'completed')
          .forEach((a) =>
            this.context.repository.put(actor.tenantId, 'appointments', a.id, {
              ...a,
              status: 'cancelled',
            }),
          );
      }
      this.context.notify(
        actor,
        triage.customerId,
        input.status === 'approved'
          ? 'Sua solicitação foi aprovada'
          : 'Atualização da sua solicitação',
        input.decision,
      );
      return this.context.repository.put(actor.tenantId, 'triage', recordId, {
        ...triage,
        ...input,
      });
    });
  }
}
