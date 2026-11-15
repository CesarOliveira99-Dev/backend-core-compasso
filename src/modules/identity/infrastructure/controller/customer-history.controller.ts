import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Context } from '../../../../core/application/context.js';
import type { AuthRequest } from '../../application/identity.schemas.js';
import { CustomerHistory } from '../../application/customer-history.js';

@Controller('auth/last-visit')
export class CustomerHistoryController {
  constructor(private readonly context: Context) {}
  @Get() latest(@Req() request: AuthRequest) {
    return { visit: new CustomerHistory(this.context).latest(request.actor) };
  }
  @Post('review') review(@Req() request: AuthRequest, @Body() body: unknown) {
    return new CustomerHistory(this.context).review(request.actor, body);
  }
}
