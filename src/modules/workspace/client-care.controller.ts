import { Body, Controller, Get, Param, Post, Put, Req } from "@nestjs/common";
import type { AuthRequest } from "../identity/application/identity.schemas.js";
import { ClientCareService } from "./application/client-care-service.js";
@Controller("workspace/care")
export class ClientCareController {
  constructor(private readonly care: ClientCareService) {}
  @Get("template") template(@Req() r: AuthRequest) {
    return this.care.template(r.actor);
  }
  @Put("template") saveTemplate(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.care.saveTemplate(r.actor, b);
  }
  @Get("customers/:id") customer(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.care.customer(r.actor, id);
  }
  @Post("appointments/:id/reminder") reminder(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.care.reminder(r.actor, id, b);
  }
  @Post("appointments/:id/missed") missed(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.care.missed(r.actor, id);
  }
  @Get("returns") returns(@Req() r: AuthRequest) {
    return this.care.returns(r.actor);
  }
  @Put("returns") saveReturn(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.care.saveReturn(r.actor, b);
  }
  @Get("blocks") blocks(@Req() r: AuthRequest) {
    return this.care.blocks(r.actor);
  }
  @Post("blocks") block(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.care.createBlock(r.actor, b);
  }
  @Put("blocks/:id") removeBlock(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.care.removeBlock(r.actor, id, b);
  }
  @Post("series") series(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.care.series(r.actor, b);
  }
  @Get("waitlist") waitlist(@Req() r: AuthRequest) {
    return this.care.waitlist(r.actor);
  }
  @Post("waitlist") createWait(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.care.createWait(r.actor, b);
  }
  @Put("waitlist/:id") updateWait(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.care.updateWait(r.actor, id, b);
  }
  @Get("waitlist/:id/slots") slots(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.care.suggestions(r.actor, id);
  }
  @Post("waitlist/:id/book") book(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() b: unknown,
  ) {
    return this.care.bookWait(r.actor, id, b);
  }
}
