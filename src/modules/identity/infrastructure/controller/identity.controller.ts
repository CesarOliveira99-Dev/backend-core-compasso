import {z} from 'zod';
const parseSlug = (body:unknown) => parse(z.object({slug:z.string().min(2).max(60)}),body);
import { Body, Controller, Get, Post, Req, Query, Param, Patch } from '@nestjs/common';
import { IdentityService } from '../../application/identity-service.js';
import {
  AuthRequest,
  Public,
  registrationRequestSchema,
} from '../../application/identity.schemas.js';
import { parse } from '../../../../core/application/context.js';
@Controller('auth')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}
  @Post('switch-store') switchStore(@Req() request: AuthRequest, @Body() body: {slug:string}) {
    return this.identity.session(this.identity.memberships.switchStore(request.actor, parseSlug(body).slug));
  }
  @Post('team/invite') invite(@Req() request: AuthRequest) { return this.identity.memberships.invite(request.actor); }
  @Get('team') team(@Req() request: AuthRequest) { return this.identity.memberships.team(request.actor); }
  @Patch('team/:id') updateTeam(@Req() request: AuthRequest,@Param('id') id:string,@Body() body:unknown) { return this.identity.memberships.setActive(request.actor,id,parse(z.object({active:z.boolean()}),body).active); }
  @Public() @Post('invite/preview') previewInvite(@Body() body:{token:string}) { return this.identity.memberships.preview(body.token); }
  @Public() @Post('invite/register') registerInvited(@Body() body: Record<string,unknown>) {
    return this.identity.session(this.identity.memberships.register(String(body.token || ''),body));
  }
  @Post('invite/accept') acceptInvite(@Req() request: AuthRequest,@Body() body:{token:string}) {
    return this.identity.session(this.identity.memberships.accept(body.token, this.identity.member(request.actor)));
  }
  @Public() @Post('password/request') requestPassword(@Body() body:unknown) { return this.identity.recovery.request('password',body); }
  @Post('email/request') requestEmail(@Req() request:AuthRequest) { return this.identity.recovery.request('verify',{email:request.actor.email},request.actor); }
  @Public() @Post('account/complete') completeAccount(@Body() body:unknown) { return this.identity.recovery.complete(body); }
  @Public() @Get('discovery') discovery(@Query() query:unknown) { return this.identity.discovery(query); }
  @Public() @Get('stores') stores() {
    return this.identity.stores();
  }
  @Public() @Get('google/config') googleConfig() {
    return this.identity.googleConfig();
  }
  @Public() @Post('google/challenge') googleChallenge() {
    return this.identity.googleChallenge();
  }
  @Public() @Post('google') google(@Body() body: unknown) {
    return this.identity.google(body);
  }
  @Public() @Post('google/complete') completeGoogle(@Body() body: unknown) {
    return this.identity.completeGoogle(body);
  }
  @Post('google/link') linkGoogle(
    @Req() request: AuthRequest,
    @Body() body: Record<string, unknown>,
  ) {
    return this.identity.google({ ...body, mode: 'link' }, request.actor);
  }
  @Public() @Post('login') login(@Body() body: unknown) {
    return this.identity.login(body);
  }
  @Public() @Post('register') register(@Body() body: unknown) {
    return this.identity.register(parse(registrationRequestSchema, body));
  }
  @Get('me') me(@Req() request: AuthRequest) {
    return request.actor;
  }
  @Post('logout') logout(@Req() request: AuthRequest) {
    return this.identity.logout(request.headers.authorization?.replace('Bearer ', '') || '');
  }
}
