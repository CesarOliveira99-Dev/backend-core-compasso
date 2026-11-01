import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { CatalogService } from '../../application/catalog-service.js';
@Controller('catalog')
export class CatalogController {
  constructor(private readonly service: CatalogService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Post() create(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.service.save(r.actor, b);
  }
  @Patch(':id') update(@Req() r: AuthRequest, @Param('id') itemId: string, @Body() b: unknown) {
    return this.service.update(r.actor, b, itemId);
  }
}
