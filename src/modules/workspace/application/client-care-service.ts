import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Context, parse } from "../../../core/application/context.js";
import type {
  Actor,
  Appointment,
  CatalogItem,
} from "../../../core/domain/models.js";
import { assertWorkspaceOwner } from "../../../core/application/workspace-policy.js";
import { requireStoreService } from "../../../core/application/store-plans.js";
import { localDate } from "../../../core/domain/policies.js";
import { AppointmentsService } from "../../appointments/application/appointments-service.js";
import { bookingSchema } from "../../appointments/application/appointments.schemas.js";
import {
  localTimestamp,
  validCalendarDate,
} from "../../appointments/domain/availability.js";
import { WorkspaceService } from "./workspace-service.js";
import {
  addCalendarDays,
  clientSummary,
  defaultReminder,
  renderReminder,
} from "../domain/client-care.js";
const revision = z.number().int().nonnegative();
const day = z.string().refine(validCalendarDate, "Informe uma data válida.");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const active = (a: Appointment) => ["confirmed", "pending"].includes(a.status);
export interface ReturnRule {
  enabled?: boolean;
  id: string;
  customerId: string;
  itemId: string;
  professionalId: string;
  intervalDays: number;
  revision: number;
}
export interface AgendaBlock {
  id: string;
  professionalId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  revision: number;
  active: boolean;
}
export interface WaitEntry {
  id: string;
  customerId: string;
  itemId: string;
  professionalId: string;
  from: string;
  to: string;
  after: string;
  before: string;
  status: "waiting" | "contacted" | "booked" | "cancelled";
  revision: number;
  appointmentId?: string;
}
@Injectable()
export class ClientCareService {
  constructor(
    private readonly context: Context,
    private readonly workspace: WorkspaceService,
    private readonly appointments: AppointmentsService,
  ) {}
  private get repo() {
    return this.context.repository;
  }
  private staff(actor: Actor) {
    if (!["admin", "employee"].includes(actor.role))
      throw new ForbiddenException("Recurso exclusivo da equipe.");
    assertWorkspaceOwner(this.repo, actor);
    if (actor.role === "employee" && !actor.professionalId)
      throw new ForbiddenException();
  }
  private write(actor: Actor) {
    this.staff(actor);
    requireStoreService(this.repo, actor.tenantId);
  }
  private professional(actor: Actor, id: string) {
    this.staff(actor);
    if (actor.role === "employee" && actor.professionalId !== id)
      throw new ForbiddenException("Agenda de outro profissional.");
    const profiles = this.repo.list<{ id: string; active: boolean }>(
      actor.tenantId,
      "professionals",
    );
    if (id !== "principal" && !profiles.some((p) => p.id === id && p.active))
      throw new BadRequestException("Profissional indisponível.");
  }
  private history(actor: Actor) {
    this.staff(actor);
    return this.appointments.list(actor);
  }
  private appointment(actor: Actor, id: string) {
    const value = this.history(actor).find((a) => a.id === id);
    if (!value) throw new ForbiddenException("Atendimento indisponível.");
    return value;
  }
  private item(actor: Actor, id: string) {
    const item = this.context.require<CatalogItem>(actor, "catalog", id);
    if (item.kind !== "service" || !item.active)
      throw new BadRequestException("Serviço indisponível.");
    return item;
  }
  private once<T>(actor: Actor, key: string, input: unknown, run: () => T): T {
    return this.repo.transaction(() => {
      const id = actor.id + ":" + key,
        fingerprint = JSON.stringify(input);
      const old = this.repo.get<{ fingerprint: string; value: T }>(
        actor.tenantId,
        "care_keys",
        id,
      );
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ConflictException("Chave já usada em outra ação.");
        return old.value;
      }
      const value = run();
      this.repo.put(actor.tenantId, "care_keys", id, { fingerprint, value });
      return value;
    });
  }
  template(actor: Actor) {
    this.staff(actor);
    const saved = this.repo.get<{
      revision: number;
      template?: string;
      templates?: { id: string; title: string; message: string }[];
    }>(actor.tenantId, "reminder_templates", actor.id);
    const templates = saved?.templates ?? [
      {
        id: "default",
        title: "Lembrete de atendimento",
        message: saved?.template || defaultReminder,
      },
    ];
    return {
      revision: saved?.revision || 0,
      templates,
      template: templates[0]?.message || defaultReminder,
    };
  }
  saveTemplate(actor: Actor, body: unknown) {
    this.write(actor);
    const model = z
      .object({
        id: z.string().regex(/^[\w-]{1,60}$/),
        title: z.string().trim().min(2).max(60),
        message: z.string().trim().min(1).max(1500),
      })
      .strict();
    const input = parse(
      z.union([
        z.object({ revision, templates: z.array(model).max(20) }).strict(),
        z
          .object({ revision, template: z.string().trim().min(1).max(1500) })
          .strict(),
      ]),
      body,
    );
    const templates =
      "templates" in input
        ? input.templates
        : [
            {
              id: "default",
              title: "Lembrete de atendimento",
              message: input.template,
            },
          ];
    if (
      new Set(templates.map((t) => t.id)).size !== templates.length ||
      new Set(templates.map((t) => t.title.toLocaleLowerCase("pt-BR"))).size !==
        templates.length
    )
      throw new BadRequestException(
        "Use títulos e identificadores distintos para cada lembrete.",
      );
    for (const template of templates)
      renderReminder(template.message, {
        nome: "Cliente",
        servico: "Serviço",
        data: "01/01/2030",
        horario: "10:00",
        profissional: "Profissional",
        estabelecimento: "Estabelecimento",
      });
    return this.repo.transaction(() => {
      if (input.revision !== this.template(actor).revision)
        throw new ConflictException(
          "A configuração de lembretes mudou. Atualize antes de salvar.",
        );
      this.repo.put(actor.tenantId, "reminder_templates", actor.id, {
        revision: input.revision + 1,
        templates,
      });
      return this.template(actor);
    });
  }
  reminder(actor: Actor, id: string, body: unknown) {
    this.staff(actor);
    const a = this.appointment(actor, id);
    if (!active(a))
      throw new BadRequestException("Lembretes são para atendimentos ativos.");
    const input = parse(
      z
        .object({
          template: z.string().max(1500).optional(),
          templateId: z.string().max(60).optional(),
        })
        .strict(),
      body,
    );
    const selected = input.templateId
      ? this.template(actor).templates.find((t) => t.id === input.templateId)
      : undefined;
    if (input.templateId && !selected)
      throw new BadRequestException(
        "Lembrete indisponível. Escolha outro modelo ou escreva uma mensagem avulsa.",
      );
    const customer = this.workspace.dossier(actor, a.customerId).customer,
      settings = this.context.settings(actor);
    const date = new Date(a.startsAt);
    return {
      phone: customer.phone,
      message: renderReminder(
        input.template ?? selected?.message ?? this.template(actor).template,
        {
          nome: customer.name,
          servico: a.itemName,
          data: date.toLocaleDateString("pt-BR", {
            timeZone: settings.timezone,
          }),
          horario: date.toLocaleTimeString("pt-BR", {
            timeZone: settings.timezone,
            hour: "2-digit",
            minute: "2-digit",
          }),
          profissional: a.professionalName || settings.name,
          estabelecimento: settings.businessName,
        },
      ),
      automatic: false,
    };
  }
  customer(actor: Actor, id: string) {
    const data = this.workspace.dossier(actor, id);
    const summary = clientSummary(
      data.appointments,
      this.context.settings(actor).timezone,
    );
    return {
      summary,
      preferences: data.dossier.preferences,
      notes: data.dossier.notes,
    };
  }
  returns(actor: Actor) {
    const history = this.history(actor),
      today = localDate(new Date(), this.context.settings(actor).timezone);
    return this.repo
      .list<ReturnRule>(actor.tenantId, "return_rules")
      .filter(
        (r) =>
          actor.role === "admin" || r.professionalId === actor.professionalId,
      )
      .flatMap((rule) => {
        let customer;
        try {
          customer = this.workspace.dossier(actor, rule.customerId).customer;
        } catch {
          return [];
        }
        const list = history.filter(
          (a) =>
            a.customerId === rule.customerId &&
            a.itemId === rule.itemId &&
            (a.professionalId || "principal") === rule.professionalId,
        );
        const last = list
          .filter(
            (a) =>
              a.status === "completed" && Date.parse(a.startsAt) <= Date.now(),
          )
          .sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
        const due = last
          ? addCalendarDays(
              localDate(last.startsAt, this.context.settings(actor).timezone),
              rule.intervalDays,
            )
          : null;
        const next = list
          .filter((a) => active(a) && Date.parse(a.startsAt) > Date.now())
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
        return [
          {
            ...rule,
            customerName: customer.name,
            phone: customer.phone,
            itemName:
              this.repo.get<CatalogItem>(actor.tenantId, "catalog", rule.itemId)
                ?.name ||
              last?.itemName ||
              "Serviço",
            lastVisit: last?.startsAt || null,
            due,
            nextAppointment: next?.startsAt || null,
            state:
              rule.enabled === false
                ? "paused"
                : next
                  ? "scheduled"
                  : !due
                    ? "no_history"
                    : due < today
                      ? "overdue"
                      : due <= addCalendarDays(today, 7)
                        ? "due"
                        : "later",
          },
        ];
      });
  }
  saveReturn(actor: Actor, body: unknown) {
    this.write(actor);
    const input = parse(
      z
        .object({
          customerId: z.string(),
          itemId: z.string(),
          professionalId: z.string(),
          intervalDays: z.number().int().min(1).max(730),
          enabled: z.boolean().default(true),
          revision,
        })
        .strict(),
      body,
    );
    this.workspace.dossier(actor, input.customerId);
    if (input.enabled !== false) this.item(actor, input.itemId);
    this.professional(actor, input.professionalId);
    const id = [input.customerId, input.itemId, input.professionalId].join(":");
    return this.repo.transaction(() => {
      const old = this.repo.get<ReturnRule>(actor.tenantId, "return_rules", id);
      if ((old?.revision || 0) !== input.revision)
        throw new ConflictException("O retorno mudou. Atualize a tela.");
      return this.repo.put(actor.tenantId, "return_rules", id, {
        ...input,
        id,
        revision: input.revision + 1,
      });
    });
  }
  blocks(actor: Actor) {
    this.staff(actor);
    return this.repo
      .list<AgendaBlock>(actor.tenantId, "agenda_blocks")
      .filter(
        (b) =>
          b.active &&
          (actor.role === "admin" || b.professionalId === actor.professionalId),
      );
  }
  createBlock(actor: Actor, body: unknown) {
    this.write(actor);
    const input = parse(
      z
        .object({
          idempotencyKey: z.uuid(),
          title: z.string().trim().min(2).max(100),
          professionalId: z.string(),
          startsAt: z.iso.datetime(),
          endsAt: z.iso.datetime(),
        })
        .strict(),
      body,
    );
    this.professional(actor, input.professionalId);
    const start = Date.parse(input.startsAt),
      end = Date.parse(input.endsAt);
    if (start <= Date.now() || end <= start || end - start > 7 * 86400000)
      throw new BadRequestException("Escolha um período futuro de até 7 dias.");
    return this.once(actor, input.idempotencyKey, input, () => {
      const busy = this.repo
        .list<Appointment>(actor.tenantId, "appointments")
        .filter(
          (a) =>
            active(a) &&
            (a.professionalId || "principal") === input.professionalId,
        );
      if (
        [
          ...busy,
          ...this.blocks(actor).filter(
            (b) => b.professionalId === input.professionalId,
          ),
        ].some(
          (a) => Date.parse(a.startsAt) < end && Date.parse(a.endsAt) > start,
        )
      )
        throw new ConflictException("Há uma reserva nesse período.");
      const id = randomUUID();
      return this.repo.put(actor.tenantId, "agenda_blocks", id, {
        id,
        ...input,
        revision: 1,
        active: true,
      });
    });
  }
  removeBlock(actor: Actor, id: string, body: unknown) {
    this.write(actor);
    const input = parse(z.object({ revision }).strict(), body);
    return this.repo.transaction(() => {
      const block = this.context.require<AgendaBlock>(
        actor,
        "agenda_blocks",
        id,
      );
      this.professional(actor, block.professionalId);
      if (block.revision !== input.revision)
        throw new ConflictException("O bloqueio mudou.");
      return this.repo.put(actor.tenantId, "agenda_blocks", id, {
        ...block,
        active: false,
        revision: block.revision + 1,
      });
    });
  }
  series(actor: Actor, body: unknown) {
    this.write(actor);
    this.context.admin(actor);
    const input = parse(
      bookingSchema
        .extend({
          idempotencyKey: z.uuid(),
          count: z.number().int().min(2).max(12),
          intervalWeeks: z.number().int().min(1).max(8),
        })
        .strict(),
      body,
    );
    return this.once(actor, "series:" + input.idempotencyKey, input, () => {
      const timezone = this.context.settings(actor).timezone,
        date = localDate(input.startsAt, timezone);
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .format(new Date(input.startsAt))
        .split(":")
        .map(Number);
      const items = [];
      for (let i = 0; i < input.count; i++) {
        const startsAt = new Date(
          localTimestamp(
            addCalendarDays(date, i * input.intervalWeeks * 7),
            parts[0] * 60 + parts[1],
            timezone,
          ),
        ).toISOString();
        items.push(
          this.appointments.create(actor, {
            ...input,
            idempotencyKey: randomUUID(),
            startsAt,
          }),
        );
      }
      return { appointments: items, count: items.length };
    });
  }
  waitlist(actor: Actor) {
    this.staff(actor);
    const today = localDate(new Date(), this.context.settings(actor).timezone);
    return this.repo
      .list<WaitEntry>(actor.tenantId, "wait_entries")
      .filter(
        (e) =>
          (actor.role === "admin" ||
            e.professionalId === actor.professionalId) &&
          (!["waiting", "contacted"].includes(e.status) || e.to >= today),
      )
      .map((e) => {
        const customer = this.workspace.dossier(actor, e.customerId).customer;
        return {
          ...e,
          customerName: customer.name,
          phone: customer.phone,
          itemName:
            this.repo.get<CatalogItem>(actor.tenantId, "catalog", e.itemId)
              ?.name || "Serviço",
        };
      });
  }
  createWait(actor: Actor, body: unknown) {
    this.write(actor);
    const input = parse(
      z
        .object({
          idempotencyKey: z.uuid(),
          customerId: z.string(),
          itemId: z.string(),
          professionalId: z.string(),
          from: day,
          to: day,
          after: clock,
          before: clock,
        })
        .strict(),
      body,
    );
    this.workspace.dossier(actor, input.customerId);
    this.item(actor, input.itemId);
    this.professional(actor, input.professionalId);
    const today = localDate(new Date(), this.context.settings(actor).timezone);
    if (
      input.from < today ||
      input.to < input.from ||
      input.to > addCalendarDays(input.from, 90) ||
      input.before <= input.after
    )
      throw new BadRequestException(
        "Informe datas futuras (até 90 dias) e horários em ordem.",
      );
    return this.once(actor, input.idempotencyKey, input, () => {
      const id = randomUUID();
      return this.repo.put(actor.tenantId, "wait_entries", id, {
        ...input,
        id,
        status: "waiting",
        revision: 1,
      });
    });
  }
  updateWait(actor: Actor, id: string, body: unknown) {
    this.write(actor);
    const input = parse(
      z
        .object({
          revision,
          status: z.enum(["waiting", "contacted", "cancelled"]),
        })
        .strict(),
      body,
    );
    return this.repo.transaction(() => {
      const entry = this.context.require<WaitEntry>(actor, "wait_entries", id);
      this.professional(actor, entry.professionalId);
      this.workspace.dossier(actor, entry.customerId);
      if (entry.revision !== input.revision || entry.status === "booked")
        throw new ConflictException("A entrada mudou. Atualize a tela.");
      return this.repo.put(actor.tenantId, "wait_entries", id, {
        ...entry,
        status: input.status,
        revision: entry.revision + 1,
      });
    });
  }
  suggestions(actor: Actor, id: string) {
    this.staff(actor);
    const entry = this.context.require<WaitEntry>(actor, "wait_entries", id);
    this.professional(actor, entry.professionalId);
    this.workspace.dossier(actor, entry.customerId);
    if (!["waiting", "contacted"].includes(entry.status)) return [];
    const timezone = this.context.settings(actor).timezone,
      today = localDate(new Date(), timezone),
      from = entry.from > today ? entry.from : today,
      slots = [];
    for (let i = 0; i < 7 && slots.length < 3; i++) {
      const date = addCalendarDays(from, i);
      if (date > entry.to) break;
      const availability = this.appointments.availability(actor, {
        itemId: entry.itemId,
        professionalId: entry.professionalId,
        date,
      });
      for (const slot of availability.slots) {
        const start = new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(slot.startsAt));
        const end = new Intl.DateTimeFormat("en-GB", {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(new Date(slot.endsAt));
        if (
          start >= entry.after &&
          end <= entry.before &&
          localDate(slot.startsAt, timezone) ===
            localDate(slot.endsAt, timezone)
        )
          slots.push(slot);
        if (slots.length === 3) break;
      }
    }
    return slots;
  }
  bookWait(actor: Actor, id: string, body: unknown) {
    this.write(actor);
    this.context.admin(actor);
    const input = parse(
      z
        .object({
          revision,
          idempotencyKey: z.uuid(),
          startsAt: z.iso.datetime(),
        })
        .strict(),
      body,
    );
    return this.once(
      actor,
      "wait:" + input.idempotencyKey,
      { id, ...input },
      () => {
        const entry = this.context.require<WaitEntry>(
          actor,
          "wait_entries",
          id,
        );
        if (
          entry.revision !== input.revision ||
          !["waiting", "contacted"].includes(entry.status)
        )
          throw new ConflictException("A entrada mudou.");
        if (
          !this.suggestions(actor, id).some(
            (s) => s.startsAt === input.startsAt,
          )
        )
          throw new ConflictException(
            "O horário não está mais disponível. Consulte as sugestões novamente.",
          );
        const appointment = this.appointments.create(actor, {
          customerId: entry.customerId,
          itemId: entry.itemId,
          professionalId: entry.professionalId,
          startsAt: input.startsAt,
          idempotencyKey: randomUUID(),
        });
        this.repo.put(actor.tenantId, "wait_entries", id, {
          ...entry,
          status: "booked",
          appointmentId: appointment.id,
          revision: entry.revision + 1,
        });
        return appointment;
      },
    );
  }
  missed(actor: Actor, id: string) {
    this.write(actor);
    return this.repo.transaction(() => {
      const a = this.appointment(actor, id);
      if (a.attendanceOutcome === "no_show") return a;
      if (!active(a) || Date.parse(a.startsAt) > Date.now())
        throw new BadRequestException(
          "Registre a falta após o início de um atendimento ativo.",
        );
      return this.repo.put(actor.tenantId, "appointments", id, {
        ...a,
        status: "cancelled",
        attendanceOutcome: "no_show",
        attendanceRecordedAt: new Date().toISOString(),
        attendanceRecordedBy: actor.id,
      });
    });
  }
}
