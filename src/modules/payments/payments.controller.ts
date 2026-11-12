import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Public, type AuthRequest } from '../identity/application/identity.schemas.js';
import { PaymentsService } from './payments.service.js';
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}
  @Get('recommendation') recommendation(@Req() request:AuthRequest){return this.service.addon.status(request.actor);}
  @Post('recommendation') purchaseRecommendation(@Req() request:AuthRequest,@Body() body:unknown){return this.service.addon.purchase(request.actor,body);}
  @Get('status') status(@Req() request: AuthRequest) {
    return this.service.status(request.actor);
  }
  @Post('connect') connect(@Req() request: AuthRequest) {
    return this.service.connect(request.actor);
  }
  @Post('orders/:id') checkout(@Req() request: AuthRequest, @Param('id') id: string) {
    return this.service.checkout(request.actor, id);
  }
  @Post('orders/:id/bricks') prepareBricks(@Req() request: AuthRequest, @Param('id') id: string) {
    return this.service.bricks.prepare(request.actor, id);
  }
  @Post('orders/:id/bricks/pay') payBricks(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.bricks.pay(request.actor, id, body);
  }
  @Get('orders/:id/bricks/status') bricksStatus(@Req() request: AuthRequest, @Param('id') id: string) {
    return this.service.bricks.status(request.actor, id);
  }
  @Post('subscribe') subscribe(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.service.subscribe(request.actor, body);
  }
  @Post('subscription/refresh') refresh(@Req() request: AuthRequest) {
    return this.service.refreshSubscription(request.actor);
  }
  @Post('subscription/extras') extras(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.service.billing.changeExtras(request.actor, body);
  }
  @Public() @Get('callback') async callback(
    @Query('state') state = '',
    @Query('code') code = '',
    @Res() response: { redirect(url: string): void },
  ) {
    response.redirect(await this.service.callback(state, code));
  }
  @Public() @Post('webhook') webhook(
    @Query('data.id') id = '',
    @Headers('x-request-id') requestId = '',
    @Headers('x-signature') signature = '',
    @Body() body: { type?: string; user_id?: number },
  ) {
    return this.service.webhook(id, requestId, signature, body);
  }
}
