import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { SettingsService } from '../../application/settings-service.js';
@Controller('settings')
export class SettingsController {
  constructor(private readonly service: SettingsService) {}
  @Get() get(@Req() r: AuthRequest) {
    return this.service.get(r.actor);
  }
  @Patch() update(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.update(r.actor, body);
  }
}
