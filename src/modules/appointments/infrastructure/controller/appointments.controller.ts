import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Context } from '../../../../core/application/context.js';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { AppointmentsService } from '../../application/appointments-service.js';
@Controller('appointments')
export class AppointmentsController {
  constructor(
    private readonly service: AppointmentsService,
    private readonly context: Context,
  ) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Get('availability') availability(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.service.availability(r.actor, query);
  }
  @Post() create(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.context.repository.transaction(() => this.service.create(r.actor, b));
  }
  @Patch(':id') update(@Req() r: AuthRequest, @Param('id') recordId: string, @Body() b: unknown) {
    return this.service.transition(r.actor, recordId, b);
  }
}
