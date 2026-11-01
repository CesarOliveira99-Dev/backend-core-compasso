import { Injectable } from '@nestjs/common';
import { Context, id, parse } from '../../../core/application/context.js';
import type { Actor, CatalogItem, Discount } from '../../../core/domain/models.js';
import { discountApplies, discountedPrice, localWeekday } from '../../../core/domain/policies.js';
import { itemSchema } from './catalog.schemas.js';
@Injectable()
export class CatalogService {
  constructor(private readonly context: Context) {}
  list(actor: Actor) {
    const promotions = this.context.repository.list<Discount>(actor.tenantId, 'promotions');
    const timezone = this.context.settings(actor).timezone;
    return this.context.repository
      .list<CatalogItem>(actor.tenantId, 'catalog')
      .filter((item) => actor.role === 'admin' || item.active)
      .map((item) => {
        const percent = Math.max(
          0,
          ...promotions
            .filter((p) =>
              discountApplies(
                p,
                item.id,
                item.kind,
                new Date(),
                localWeekday(new Date(), timezone),
              ),
            )
            .map((p) => p.percent),
        );
        return {
          ...item,
          percentOff: percent,
          currentPriceCents: discountedPrice(item.priceCents, percent),
        };
      });
  }
  save(actor: Actor, body: unknown, itemId = id()) {
    this.context.admin(actor);
    const input = parse(itemSchema, body);
    return this.context.repository.put(actor.tenantId, 'catalog', itemId, { ...input, id: itemId });
  }
  update(actor: Actor, body: unknown, itemId: string) {
    this.context.admin(actor);
    this.context.require(actor, 'catalog', itemId);
    return this.save(actor, body, itemId);
  }
}
