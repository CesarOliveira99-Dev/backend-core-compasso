import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IdentityService } from '../../application/identity-service.js';
import { AuthRequest, Public } from '../../application/identity.schemas.js';
@Controller('auth')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Public() @Post('login') login(@Body() body: unknown) {
    return this.identity.login(body);
  }
  @Public() @Post('register') register(@Body() body: unknown) {
    return this.identity.register(body);
  }
  @Get('me') me(@Req() request: AuthRequest) {
    return request.actor;
  }
  @Post('logout') logout(@Req() request: AuthRequest) {
    return this.identity.logout(request.headers.authorization?.replace('Bearer ', '') || '');
  }
}
