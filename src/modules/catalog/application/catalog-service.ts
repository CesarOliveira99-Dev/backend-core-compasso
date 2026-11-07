import { recentBookingCounts } from '../domain/popularity.js';
import { MediaService } from '../../media/media.module.js';
import { Injectable } from '@nestjs/common';
import { Context, id, parse } from '../../../core/application/context.js';
import type { Actor, Appointment, CatalogItem, Discount } from '../../../core/domain/models.js';
import { discountApplies, discountedPrice, localWeekday } from '../../../core/domain/policies.js';
import { itemSchema } from './catalog.schemas.js';
@Injectable()
export class CatalogService {
  constructor(
    private readonly context: Context,
    private readonly media: MediaService,
  ) {}
  list(actor: Actor) {
    const bookingCounts = recentBookingCounts(
      this.context.repository.list<Appointment>(actor.tenantId, 'appointments'),
    );
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
          popularityCount: item.kind === 'service' ? bookingCounts.get(item.id) || 0 : 0,
          percentOff: percent,
          currentPriceCents: discountedPrice(item.priceCents, percent),
        };
      });
  }
  save(actor: Actor, body: unknown, itemId = id()) {
    this.context.admin(actor);
    const input = parse(itemSchema, body);
    this.media.validate(actor, input.media);
    const previous=this.context.repository.get<CatalogItem>(actor.tenantId,'catalog',itemId);
    const result=this.context.repository.put(actor.tenantId, 'catalog', itemId, { ...input, id: itemId });
    this.media.releaseUnused(actor,previous?.media);
    return result;
  }
  update(actor: Actor, body: unknown, itemId: string) {
    this.context.admin(actor);
    this.context.require(actor, 'catalog', itemId);
    return this.save(actor, body, itemId);
  }
}
