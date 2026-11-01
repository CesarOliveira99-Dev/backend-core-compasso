import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { PromotionsService } from '../../application/promotions-service.js';
@Controller('discounts')
export class PromotionsController {
  constructor(private readonly service: PromotionsService) {}
  @Get(':kind') list(@Req() r: AuthRequest, @Param('kind') kind: string) {
    return this.service.list(r.actor, kind);
  }
  @Post(':kind') create(@Req() r: AuthRequest, @Param('kind') kind: string, @Body() body: unknown) {
    return this.service.create(r.actor, kind, body);
  }
  @Patch(':kind/:id') toggle(
    @Req() r: AuthRequest,
    @Param('kind') kind: string,
    @Param('id') recordId: string,
    @Body() body: unknown,
  ) {
    return this.service.toggle(r.actor, kind, recordId, body);
  }
}
