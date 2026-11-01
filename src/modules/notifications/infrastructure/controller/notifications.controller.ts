import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { NotificationsService } from '../../application/notifications-service.js';
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Patch(':id') read(@Req() r: AuthRequest, @Param('id') recordId: string) {
    return this.service.read(r.actor, recordId);
  }
  @Post('message') message(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.message(r.actor, body);
  }
}
