import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, id, parse } from '../../../core/application/context.js';
import type { Actor, Discount } from '../../../core/domain/models.js';
import { discountSchema } from './promotions.schemas.js';
@Injectable()
export class PromotionsService {
  constructor(private readonly context: Context) {}
  list(actor: Actor, kind: string) {
    this.context.admin(actor);
    return this.context.repository.list<Discount>(
      actor.tenantId,
      kind === 'coupons' ? 'coupons' : 'promotions',
    );
  }
  create(actor: Actor, kind: string, body: unknown) {
    this.context.admin(actor);
    const input = parse(discountSchema, body);
    const coupon = kind === 'coupons';
    const recordId = coupon
      ? (input.code || input.name).trim().toUpperCase().replace(/\s+/g, '')
      : id();
    if (this.context.repository.get(actor.tenantId, coupon ? 'coupons' : 'promotions', recordId))
      throw new BadRequestException('Já existe um cupom com este código.');
    return this.context.repository.put(
      actor.tenantId,
      coupon ? 'coupons' : 'promotions',
      recordId,
      { ...input, id: recordId, code: coupon ? recordId : undefined, uses: 0 },
    );
  }
  toggle(actor: Actor, kind: string, recordId: string, body: unknown) {
    this.context.admin(actor);
    const input = parse(z.object({ active: z.boolean() }), body);
    const collection = kind === 'coupons' ? 'coupons' : 'promotions';
    const current = this.context.require<Discount>(actor, collection, recordId);
    return this.context.repository.put(actor.tenantId, collection, recordId, {
      ...current,
      ...input,
    });
  }
}
