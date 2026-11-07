import { validCalendarDate } from '../appointments/domain/availability.js';
import {
  BadRequestException,
  ForbiddenException,
  Body,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { weeklyHoursSchema } from '../settings/application/weekly-hours.schema.js';
import { Context, id, parse } from '../../core/application/context.js';
import type { Actor, CatalogItem } from '../../core/domain/models.js';
import type { AuthRequest } from '../identity/identity.module.js';

import type { Professional } from '../../core/domain/professional.js';
export type { Professional } from '../../core/domain/professional.js';
const schema = z
  .object({
    breaks: z
      .array(
        z
          .object({
            date: z.string().refine(validCalendarDate, 'Data inválida.').optional(),
            start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
            end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          })
          .refine(
            (interval) => interval.end > interval.start,
            'O fim do intervalo deve ser posterior ao início.',
          ),
      )
      .max(8)
      .optional(),
    daysOff: z
      .array(z.string().refine(validCalendarDate, 'Data de folga inválida.'))
      .max(366)
      .optional(),
    name: z.string().trim().min(2).max(100),
    active: z.boolean(),
    serviceIds: z.array(z.string()).max(200),
    weeklyHours: weeklyHoursSchema,
    openingHour: z.number().int().min(0).max(23),
    closingHour: z.number().int().min(1).max(24),
    workDays: z.array(z.number().int().min(0).max(6)).max(7),
  })
  .refine(
    (value) => value.closingHour > value.openingHour,
    'Confira o expediente do profissional.',
  );
@Injectable()
export class ProfessionalsService {
  constructor(private readonly context: Context) {}
  list(actor: Actor): Professional[] {
    const settings = this.context.settings(actor);
    const saved = this.context.repository.list<Professional>(actor.tenantId, 'professionals');
    if (!saved.some((p) => p.id === 'principal'))
      saved.unshift({
        id: 'principal',
        name: settings.name,
        active: true,
        serviceIds: [],
        openingHour: settings.openingHour,
        closingHour: settings.closingHour,
        workDays: settings.workDays,
      });
    return saved.filter((p) => actor.role === 'admin' || p.active);
  }
  resolve(actor: Actor, serviceId: string, professionalId?: string): Professional {
    const eligible = this.list(actor).filter(
      (p) => p.active && (!p.serviceIds.length || p.serviceIds.includes(serviceId)),
    );
    const professional = professionalId
      ? eligible.find((p) => p.id === professionalId)
      : eligible.length === 1
        ? eligible[0]
        : undefined;
    if (!professional)
      throw new BadRequestException('Escolha um profissional ativo que realize este serviço.');
    return professional;
  }
  save(actor: Actor, body: unknown, existingId?: string) {
    if (actor.role === 'employee') {
      if (!existingId || existingId !== actor.professionalId) throw new ForbiddenException();
      const previous = this.context.require<Professional>(actor,'professionals',existingId);
      const allowed = parse(z.object({weeklyHours:weeklyHoursSchema,openingHour:z.number().int().min(0).max(23),closingHour:z.number().int().min(1).max(24),workDays:z.array(z.number().int().min(0).max(6)).max(7),breaks:z.array(z.object({start:z.string(),end:z.string(),date:z.string().optional()})).max(8),daysOff:z.array(z.string()).max(366)}).strict(),body);
      body = {...previous,...allowed};
    } else this.context.admin(actor);
    const recordId = existingId || id();
    if (
      existingId &&
      recordId !== 'principal' &&
      !this.context.repository.get(actor.tenantId, 'professionals', recordId)
    )
      throw new BadRequestException('Profissional não encontrado nesta loja.');
    const input = parse(schema, body);
    for (const serviceId of input.serviceIds) {
      const service = this.context.require<CatalogItem>(actor, 'catalog', serviceId);
      if (service.kind !== 'service')
        throw new BadRequestException('Selecione apenas serviços desta loja.');
    }
    const previous = this.context.repository.get<Professional>(actor.tenantId,'professionals',recordId);
    return this.context.repository.put(actor.tenantId, 'professionals', recordId, {
      ...input,
      ...(previous?.userId ? {userId:previous.userId} : {}),
      breaks:
        input.breaks ??
        this.context.repository.get<Professional>(actor.tenantId, 'professionals', recordId)
          ?.breaks ??
        [],
      daysOff:
        input.daysOff ??
        this.context.repository.get<Professional>(actor.tenantId, 'professionals', recordId)
          ?.daysOff ??
        [],
      id: recordId,
    });
  }
}
@Controller('professionals')
class ProfessionalsController {
  constructor(private readonly service: ProfessionalsService) {}
  @Get() list(@Req() request: AuthRequest) {
    return this.service.list(request.actor);
  }
  @Post() create(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.service.save(request.actor, body);
  }
  @Patch(':id') update(
    @Req() request: AuthRequest,
    @Param('id') recordId: string,
    @Body() body: unknown,
  ) {
    return this.service.save(request.actor, body, recordId);
  }
}
@Global()
@Module({
  controllers: [ProfessionalsController],
  providers: [ProfessionalsService],
  exports: [ProfessionalsService],
})
export class ProfessionalsModule {}
