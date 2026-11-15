import { Body, Controller, Delete, Get, Param, Put, Query, Req } from '@nestjs/common';
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
  @Put('expenses/:id') saveExpense(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.saveExpense(r.actor, id, body);
  }
  @Delete('expenses/:id') removeExpense(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.service.removeExpense(r.actor, id);
  }
  @Get('report') report(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.service.report(r.actor, query);
  }
}
