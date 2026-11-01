import { Controller, Get, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { InsightsService } from '../../application/insights-service.js';
@Controller('insights')
export class InsightsController {
  constructor(private readonly service: InsightsService) {}
  @Get('dashboard') dashboard(@Req() r: AuthRequest) {
    return this.service.dashboard(r.actor);
  }
  @Get('wallet') wallet(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.service.wallet(r.actor, query);
  }
  @Get('report') report(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.service.report(r.actor, query);
  }
}
