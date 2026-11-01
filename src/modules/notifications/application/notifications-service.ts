import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, parse } from '../../../core/application/context.js';
import type { Actor, Customer, Notification } from '../../../core/domain/models.js';
@Injectable()
export class NotificationsService {
  constructor(private readonly context: Context) {}
  list(actor: Actor) {
    return this.context.repository
      .list<Notification>(actor.tenantId, 'notifications')
      .filter((n) => n.userId === actor.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }
  read(actor: Actor, recordId: string) {
    const notification = this.context.require<Notification>(actor, 'notifications', recordId);
    if (notification.userId !== actor.id)
      throw new BadRequestException('Notificação indisponível.');
    return this.context.repository.put(actor.tenantId, 'notifications', recordId, {
      ...notification,
      read: true,
    });
  }
  message(actor: Actor, body: unknown) {
    this.context.admin(actor);
    const input = parse(
      z.object({
        customerId: z.string(),
        title: z.string().min(2).max(100),
        message: z.string().min(3).max(2000),
      }),
      body,
    );
    const customer = this.context.require<Customer>(actor, 'customers', input.customerId);
    if (customer.role !== 'customer') throw new BadRequestException('Destinatário inválido.');
    this.context.notify(actor, input.customerId, input.title, input.message);
    return { ok: true, channel: 'in_app' };
  }
}
