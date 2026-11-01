import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, id, parse, timestamp } from '../../../core/application/context.js';
import type {
  Actor,
  Appointment,
  CatalogItem,
  Loyalty,
  Order,
} from '../../../core/domain/models.js';
@Injectable()
export class LoyaltyService {
  constructor(private readonly context: Context) {}
  list(actor: Actor) {
    return this.context.repository
      .list<Loyalty>(
        actor.tenantId,
        'loyalty',
        actor.role === 'admin' ? {} : { customerId: actor.id },
      )
      .filter((l) => actor.role === 'admin' || l.customerId === actor.id);
  }
  create(actor: Actor, body: unknown) {
    if (actor.role !== 'customer') throw new BadRequestException('Use uma conta de cliente.');
    const input = parse(
      z.object({
        itemId: z.string(),
        nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().max(500).default(''),
      }),
      body,
    );
    if (new Date(`${input.nextDate}T23:59:59-03:00`) <= new Date())
      throw new BadRequestException('Escolha uma data futura.');
    const item = this.context.require<CatalogItem>(actor, 'catalog', input.itemId);
    const hasCompleted =
      this.context.repository
        .list<Appointment>(actor.tenantId, 'appointments')
        .some(
          (a) => a.customerId === actor.id && a.itemId === item.id && a.status === 'completed',
        ) ||
      this.context.repository
        .list<Order>(actor.tenantId, 'orders')
        .some(
          (o) =>
            o.customerId === actor.id &&
            o.status === 'completed' &&
            o.items.some((i) => i.itemId === item.id),
        );
    if (!hasCompleted)
      throw new BadRequestException('Disponível após concluir uma solicitação deste item.');
    const loyalty: Loyalty = {
      ...input,
      id: id(),
      itemName: item.name,
      customerId: actor.id,
      status: 'active',
      createdAt: timestamp(),
    };
    return this.context.repository.put(actor.tenantId, 'loyalty', loyalty.id, loyalty);
  }
}
