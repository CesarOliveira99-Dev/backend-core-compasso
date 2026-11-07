import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { FeedbackService } from '../../application/feedback-service.js';
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Get('store') storeReviews(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.service.storeReviews(r.actor, query);
  }
  @Post() create(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.create(r.actor, body);
  }
  @Patch(':id') reply(@Req() r: AuthRequest, @Param('id') recordId: string, @Body() body: unknown) {
    return this.service.reply(r.actor, recordId, body);
  }
}
