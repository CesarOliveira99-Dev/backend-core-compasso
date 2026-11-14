import { AppointmentsModule } from "../appointments/appointments.module.js";
import { ClientCareService } from "./application/client-care-service.js";
import { ClientCareController } from "./client-care.controller.js";
import {
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { AuthRequest } from "../identity/application/identity.schemas.js";
import { WorkspaceService } from "./application/workspace-service.js";
@Controller("workspace")
class WorkspaceController {
  constructor(private readonly service: WorkspaceService) {}
  @Get("preferences") preferences(@Req() r: AuthRequest) {
    return this.service.preferences(r.actor);
  }
  @Put("preferences") savePreferences(
    @Req() r: AuthRequest,
    @Body() body: unknown,
  ) {
    return this.service.savePreferences(r.actor, body);
  }
  @Get("customers") customers(@Req() r: AuthRequest) {
    return this.service.customers(r.actor);
  }
  @Post("contacts") contact(@Req() r: AuthRequest, @Body() body: unknown) {
    return this.service.createContact(r.actor, body);
  }
  @Get("customers/:id") dossier(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return this.service.dossier(r.actor, id);
  }
  @Put("customers/:id") saveDossier(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.saveDossier(r.actor, id, body);
  }
  @Put("customers/:id/reward") rule(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.rewardRule(r.actor, id, body);
  }
  @Post("customers/:id/redeem") redeem(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.redeem(r.actor, id, body);
  }
  @Put("appointments/:id/style") style(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.service.style(r.actor, id, body);
  }
  @Get("analytics") analytics(@Req() r: AuthRequest, @Query() query: unknown) {
    return this.service.analytics(r.actor, query);
  }
  @Get("export") export(
    @Req() r: AuthRequest,
    @Query() query: unknown,
    @Res()
    response: {
      setHeader(name: string, value: string): void;
      send(data: string): void;
    },
  ) {
    const content = this.service.export(r.actor, query);
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="compasso-atendimentos.csv"',
    );
    response.setHeader("Cache-Control", "no-store");
    response.send(content);
  }
}
@Module({
  imports: [AppointmentsModule],
  controllers: [WorkspaceController, ClientCareController],
  providers: [WorkspaceService, ClientCareService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
