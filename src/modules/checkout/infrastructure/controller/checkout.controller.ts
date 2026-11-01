import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Context } from '../../../../core/application/context.js';
import type { Order } from '../../../../core/domain/models.js';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { CheckoutService } from '../../application/checkout-service.js';
@Controller('orders')
export class CheckoutController {
  constructor(
    private readonly service: CheckoutService,
    private readonly context: Context,
  ) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.context.repository
      .list<Order>(r.actor.tenantId, 'orders')
      .filter((o) => r.actor.role === 'admin' || o.customerId === r.actor.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  @Post('quote') quote(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.service.quote(r.actor, b);
  }
  @Post() create(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.service.create(r.actor, b);
  }
  @Patch(':id') update(@Req() r: AuthRequest, @Param('id') orderId: string, @Body() b: unknown) {
    return this.service.update(r.actor, orderId, b);
  }
}
