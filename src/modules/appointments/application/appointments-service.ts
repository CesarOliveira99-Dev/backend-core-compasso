import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, id, parse, timestamp } from '../../../core/application/context.js';
import type {
  Actor,
  Appointment,
  CatalogItem,
  Customer,
  Discount,
  Triage,
} from '../../../core/domain/models.js';
import {
  discountApplies,
  discountedPrice,
  localDate,
  localWeekday,
  overlaps,
} from '../../../core/domain/policies.js';
import { bookingSchema } from './appointments.schemas.js';
@Injectable()
export class AppointmentsService {
  constructor(private readonly context: Context) {}
  list(actor: Actor): Appointment[] {
    return this.context.repository
      .list<Appointment>(
        actor.tenantId,
        'appointments',
        actor.role === 'admin' ? {} : { customerId: actor.id },
      )
      .filter((a) => actor.role === 'admin' || a.customerId === actor.id)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
  validateSlot(actor: Actor, startsAt: string, durationMinutes: number, ignoreId?: string) {
    const settings = this.context.settings(actor);
    const start = new Date(startsAt);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    if (start < new Date()) throw new BadRequestException('Escolha um horário futuro.');
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: settings.timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(start),
    );
    const endHour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: settings.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .format(end)
        .split(':')
        .reduce((s, n, i) => s + Number(n) / (i ? 60 : 1), 0),
    );
    if (
      !settings.workDays.includes(localWeekday(start, settings.timezone)) ||
      hour < settings.openingHour ||
      endHour > settings.closingHour ||
      localDate(start, settings.timezone) !== localDate(end, settings.timezone)
    )
      throw new BadRequestException('Horário fora do expediente.');
    const appointments = this.context.repository
      .list<Appointment>(actor.tenantId, 'appointments')
      .filter((a) => a.id !== ignoreId);
    if (overlaps(start.toISOString(), end.toISOString(), appointments))
      throw new ConflictException('Este horário já está reservado. Escolha outro horário.');
    return end.toISOString();
  }
  create(actor: Actor, body: unknown, orderId?: string, priceCents?: number): Appointment {
    const input = parse(bookingSchema, body);
    const item = this.context.require<CatalogItem>(actor, 'catalog', input.itemId);
    if (!item.active || item.kind !== 'service')
      throw new BadRequestException('Serviço indisponível.');
    const customerId = actor.role === 'admin' ? input.customerId : actor.id;
    if (!customerId) throw new BadRequestException('Selecione o cliente.');
    const customer = this.context.require<Customer>(actor, 'customers', customerId);
    if (customer.role !== 'customer') throw new BadRequestException('Selecione um cliente.');
    if (item.requiresTriage && input.notes.trim().length < 5)
      throw new BadRequestException('Descreva sua necessidade para a triagem.');
    const endsAt = this.validateSlot(actor, input.startsAt, item.durationMinutes);
    const settings = this.context.settings(actor);
    if (actor.role === 'customer' && !settings.payOnAppointment && !orderId)
      throw new BadRequestException(
        'Agendamentos com pagamento no dia estão desabilitados. Entre em contato com o estabelecimento.',
      );
    const promotions = this.context.repository.list<Discount>(actor.tenantId, 'promotions');
    const percent = Math.max(
      0,
      ...promotions
        .filter((p) =>
          discountApplies(
            p,
            item.id,
            item.kind,
            new Date(),
            localWeekday(input.startsAt, settings.timezone),
          ),
        )
        .map((p) => p.percent),
    );
    const appointment: Appointment = {
      id: id(),
      customerId,
      customerName: customer.name,
      itemId: item.id,
      itemName: item.name,
      startsAt: input.startsAt,
      endsAt,
      priceCents: priceCents ?? discountedPrice(item.priceCents, percent),
      status: item.requiresTriage ? 'pending' : 'confirmed',
      paymentStatus: 'pending',
      notes: input.notes,
      orderId,
      createdAt: timestamp(),
    };
    this.context.repository.put(actor.tenantId, 'appointments', appointment.id, appointment);
    if (item.requiresTriage) {
      const triage: Triage = {
        id: id(),
        customerId,
        customerName: customer.name,
        appointmentId: appointment.id,
        answers: input.notes,
        status: 'pending',
        decision: '',
        createdAt: timestamp(),
      };
      this.context.repository.put(actor.tenantId, 'triage', triage.id, triage);
    }
    this.context.notify(
      actor,
      customerId,
      item.requiresTriage ? 'Solicitação em triagem' : 'Agendamento confirmado',
      `${item.name} • ${new Date(input.startsAt).toLocaleString('pt-BR', { timeZone: this.context.settings(actor).timezone })}`,
    );
    this.context.notifyAdmins(
      actor,
      'Novo agendamento',
      `${customer.name} solicitou ${item.name}.`,
    );
    return appointment;
  }
  transition(actor: Actor, appointmentId: string, body: unknown) {
    const input = parse(
      z.object({
        status: z.enum(['completed', 'cancelled']).optional(),
        paymentStatus: z.literal('paid').optional(),
        startsAt: z.string().datetime().optional(),
      }),
      body,
    );
    return this.context.repository.transaction(() => {
      const appointment = this.context.require<Appointment>(actor, 'appointments', appointmentId);
      this.context.owned(actor, appointment.customerId);
      if (input.paymentStatus || input.status === 'completed') this.context.admin(actor);
      if (input.startsAt) {
        if (appointment.status === 'completed' || appointment.status === 'cancelled')
          throw new BadRequestException('Este atendimento não pode ser reagendado.');
        appointment.endsAt = this.validateSlot(
          actor,
          input.startsAt,
          (new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) /
            60000,
          appointment.id,
        );
        appointment.startsAt = input.startsAt;
      }
      if (input.status) {
        if (appointment.status === input.status) return appointment;
        if (
          appointment.status === 'cancelled' ||
          appointment.status === 'completed' ||
          (input.status === 'completed' && appointment.status === 'pending')
        )
          throw new BadRequestException(
            'Transição de atendimento inválida. Resolva a triagem primeiro.',
          );
        if (actor.role === 'customer' && new Date(appointment.startsAt) <= new Date())
          throw new BadRequestException('Entre em contato para cancelar este atendimento.');
        appointment.status = input.status;
        if (input.status === 'completed') {
          appointment.completedAt = timestamp();
          this.context.notify(
            actor,
            appointment.customerId,
            'Como foi seu atendimento?',
            `Seu atendimento de ${appointment.itemName} foi concluído. Deixe sua avaliação e programe a próxima visita.`,
            `feedback:${appointment.id}`,
          );
        } else
          this.context.notify(
            actor,
            appointment.customerId,
            'Agendamento cancelado',
            appointment.itemName,
          );
      }
      if (input.paymentStatus) {
        if (appointment.status === 'cancelled')
          throw new BadRequestException('Atendimento cancelado.');
        appointment.paymentStatus = 'paid';
        appointment.paidAt ??= timestamp();
      }
      return this.context.repository.put(
        actor.tenantId,
        'appointments',
        appointment.id,
        appointment,
      );
    });
  }
}
