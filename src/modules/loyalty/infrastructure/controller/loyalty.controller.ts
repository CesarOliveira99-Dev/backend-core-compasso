import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { LoyaltyService } from '../../application/loyalty-service.js';
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly service: LoyaltyService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Post() create(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.create(r.actor, body);
  }
}
