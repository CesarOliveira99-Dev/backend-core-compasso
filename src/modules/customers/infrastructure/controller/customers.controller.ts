import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { AuthRequest } from '../../../identity/identity.module.js';
import { CustomersService } from '../../application/customers-service.js';
@Controller('customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}
  @Get() list(@Req() r: AuthRequest) {
    return this.service.list(r.actor);
  }
  @Get('profile') profile(@Req() r: AuthRequest) {
    return this.service.profile(r.actor);
  }
  @Patch('profile') update(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.update(r.actor, body);
  }
  @Post('addresses') address(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.address(r.actor, body);
  }
  @Patch('addresses/:id/default') defaultAddress(
    @Req() r: AuthRequest,
    @Param('id') addressId: string,
  ) {
    return this.service.defaultAddress(r.actor, addressId);
  }
}
