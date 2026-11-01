import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { TriageService } from '../../application/triage-service.js';
@Controller('triage')
export class TriageController {
  constructor(private readonly service: TriageService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Patch(':id') decide(
    @Req() r: AuthRequest,
    @Param('id') recordId: string,
    @Body() body: unknown,
  ) {
    return this.service.decide(r.actor, recordId, body);
  }
}
