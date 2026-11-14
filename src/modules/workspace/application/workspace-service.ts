import { agendaCharts } from "../domain/agenda-analytics.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Context,
  parse,
  timestamp,
} from "../../../core/application/context.js";
import {
  personNameSchema,
  phoneSchema,
} from "../../../core/application/person.schemas.js";
import { requireStoreService } from "../../../core/application/store-plans.js";
import { assertWorkspaceOwner } from "../../../core/application/workspace-policy.js";
import { hashPassword } from "../../identity/application/identity.schemas.js";
import { localDate } from "../../../core/domain/policies.js";
import type {
  Actor,
  Appointment,
  Customer,
} from "../../../core/domain/models.js";

import {
  preferencesSchema,
  defaults,
  dossierSchema,
  type AgendaPreferences,
  type Dossier,
  type RewardRule,
} from "./workspace.schemas.js";
export type { AgendaPreferences } from "./workspace.schemas.js";

@Injectable()
export class WorkspaceService {
  constructor(private readonly context: Context) {}
  private get repo() {
    return this.context.repository;
  }
  private staff(actor: Actor) {
    if (actor.role !== "admin" && actor.role !== "employee")
      throw new ForbiddenException("Recurso exclusivo da equipe.");
    assertWorkspaceOwner(this.repo, actor);
    if (actor.role === "employee" && !actor.professionalId)
      throw new ForbiddenException();
  }
  private appointments(actor: Actor) {
    this.staff(actor);
    return this.repo
      .list<Appointment>(actor.tenantId, "appointments")
      .filter(
        (a) =>
          actor.role === "admin" || a.professionalId === actor.professionalId,
      );
  }
  private customer(actor: Actor, customerId: string) {
    this.staff(actor);
    const customer = this.context.require<Customer>(
      actor,
      "customers",
      customerId,
    );
    if (
      customer.role !== "customer" ||
      (actor.role === "employee" &&
        !this.appointments(actor).some((a) => a.customerId === customerId))
    )
      throw new ForbiddenException("Cliente fora dos seus atendimentos.");
    return customer;
  }
  preferences(actor: Actor): AgendaPreferences {
    this.staff(actor);
    const own = this.repo.get<AgendaPreferences>(
      actor.tenantId,
      "agenda_preferences",
      actor.id,
    );
    const standard = this.repo.get<AgendaPreferences>(
      actor.tenantId,
      "agenda_preferences",
      "store-default",
    );
    return structuredClone(
      own || { ...(standard || defaults), revision: 0, storeDefault: false },
    );
  }
  savePreferences(actor: Actor, body: unknown) {
    this.staff(actor);
    const input = parse(preferencesSchema, body);
    if (input.storeDefault) this.context.admin(actor);
    return this.repo.transaction(() => {
      const previous = this.preferences(actor);
      if (previous.revision !== input.revision)
        throw new ConflictException(
          "As preferências mudaram. Atualize a tela antes de salvar.",
        );
      const result = { ...input, revision: previous.revision + 1 };
      this.repo.put(actor.tenantId, "agenda_preferences", actor.id, result);
      if (input.storeDefault)
        this.repo.put(
          actor.tenantId,
          "agenda_preferences",
          "store-default",
          result,
        );
      return result;
    });
  }
  style(actor: Actor, appointmentId: string, body: unknown) {
    this.staff(actor);
    requireStoreService(this.repo, actor.tenantId);
    const { categoryId } = parse(
      z.object({ categoryId: z.string().max(40).nullable() }).strict(),
      body,
    );
    const appointment = this.context.require<Appointment>(
      actor,
      "appointments",
      appointmentId,
    );
    if (
      actor.role === "employee" &&
      appointment.professionalId !== actor.professionalId
    )
      throw new ForbiddenException("Atendimento de outro profissional.");
    const category = this.preferences(actor).categories.find(
      (c) => c.id === categoryId,
    );
    if (categoryId && !category)
      throw new BadRequestException("Escolha uma categoria da sua agenda.");
    const {
      categoryId: _id,
      categoryName: _name,
      categoryColor: _color,
      ...rest
    } = appointment;
    return this.repo.put(actor.tenantId, "appointments", appointment.id, {
      ...rest,
      ...(category
        ? {
            categoryId: category.id,
            categoryName: category.name,
            categoryColor: category.color,
          }
        : {}),
    });
  }
  customers(actor: Actor) {
    this.staff(actor);
    const appointments = this.appointments(actor),
      ids = new Set(appointments.map((a) => a.customerId));
    return this.repo
      .list<Customer>(actor.tenantId, "customers")
      .filter(
        (c) =>
          c.role === "customer" &&
          !c.systemContact &&
          (actor.role === "admin" || ids.has(c.id)),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        internal: !!c.internal,
        visits: appointments.filter(
          (a) => a.customerId === c.id && a.status === "completed",
        ).length,
      }));
  }
  createContact(actor: Actor, body: unknown) {
    this.context.admin(actor);
    this.staff(actor);
    requireStoreService(this.repo, actor.tenantId);
    const input = parse(
      z
        .object({
          idempotencyKey: z.uuid(),
          name: personNameSchema,
          email: z.union([z.email().max(254), z.literal("")]).default(""),
          phone: z.union([phoneSchema, z.literal("")]).default(""),
        })
        .strict(),
      body,
    );
    const fingerprint = JSON.stringify(input),
      key = `${actor.id}:${input.idempotencyKey}`;
    return this.repo.transaction(() => {
      const previous = this.repo.get<{ id: string; fingerprint: string }>(
        actor.tenantId,
        "contact_keys",
        key,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ConflictException("Chave já usada para outro contato.");
        return { id: previous.id };
      }
      const id = randomUUID();
      const contact: Customer = {
        id,
        tenantId: actor.tenantId,
        role: "customer",
        internal: true,
        name: input.name,
        email: input.email,
        phone: input.phone,
        passwordHash: hashPassword(randomUUID()),
        addresses: [],
        emailVerified: false,
      };
      this.repo.put(actor.tenantId, "customers", id, contact);
      this.repo.put(actor.tenantId, "contact_keys", key, { id, fingerprint });
      return { id };
    });
  }
  dossier(actor: Actor, customerId: string) {
    const c = this.customer(actor, customerId);
    const dossier = this.repo.get<Dossier>(
      actor.tenantId,
      "customer_dossiers",
      customerId,
    ) || { revision: 0, notes: "", preferences: "", tags: [], fields: [] };
    const visits = this.repo
      .list<Appointment>(actor.tenantId, "appointments")
      .filter(
        (a) => a.customerId === customerId && a.status === "completed",
      ).length;
    const rule = this.repo.get<RewardRule>(
      actor.tenantId,
      "customer_rewards",
      customerId,
    );
    return {
      customer: {
        id: c.id,
        name: c.name,
        email: c.email,
        phone: c.phone,
        internal: !!c.internal,
      },
      dossier,
      appointments: this.appointments(actor).filter(
        (a) => a.customerId === customerId,
      ),
      loyalty: rule
        ? {
            ...rule,
            visits,
            available: Math.max(
              0,
              Math.floor(visits / rule.goal) - rule.redemptions,
            ),
          }
        : null,
    };
  }
  saveDossier(actor: Actor, customerId: string, body: unknown) {
    this.customer(actor, customerId);
    requireStoreService(this.repo, actor.tenantId);
    const input = parse(dossierSchema, body);
    return this.repo.transaction(() => {
      const previous = this.repo.get<Dossier>(
        actor.tenantId,
        "customer_dossiers",
        customerId,
      );
      if ((previous?.revision || 0) !== input.revision)
        throw new ConflictException(
          "Esta ficha foi atualizada por outra pessoa. Reabra antes de salvar.",
        );
      return this.repo.put(actor.tenantId, "customer_dossiers", customerId, {
        ...input,
        revision: input.revision + 1,
        updatedBy: actor.id,
        updatedAt: timestamp(),
      });
    });
  }
  rewardRule(actor: Actor, customerId: string, body: unknown) {
    this.context.admin(actor);
    this.customer(actor, customerId);
    requireStoreService(this.repo, actor.tenantId);
    const input = parse(
      z
        .object({
          goal: z.number().int().min(1).max(1000),
          reward: z.string().trim().min(2).max(200),
        })
        .strict(),
      body,
    );
    const previous = this.repo.get<RewardRule>(
      actor.tenantId,
      "customer_rewards",
      customerId,
    );
    if (previous?.redemptions && previous.goal !== input.goal)
      throw new ConflictException(
        "Mantenha a meta deste histórico após um resgate.",
      );
    return this.repo.put(actor.tenantId, "customer_rewards", customerId, {
      ...input,
      redemptions: previous?.redemptions || 0,
      updatedAt: timestamp(),
    });
  }
  redeem(actor: Actor, customerId: string, body: unknown) {
    this.customer(actor, customerId);
    requireStoreService(this.repo, actor.tenantId);
    const { idempotencyKey } = parse(
      z.object({ idempotencyKey: z.uuid() }).strict(),
      body,
    );
    return this.repo.transaction(() => {
      const key = `${actor.id}:${idempotencyKey}`,
        previous = this.repo.get<{ customerId: string }>(
          actor.tenantId,
          "reward_redemptions",
          key,
        );
      if (previous) {
        if (previous.customerId !== customerId)
          throw new ConflictException("Chave já utilizada.");
        return previous;
      }
      const info = this.dossier(actor, customerId).loyalty;
      if (!info || info.available < 1)
        throw new BadRequestException(
          "Cliente ainda não atingiu a meta de atendimentos concluídos.",
        );
      this.repo.put(actor.tenantId, "customer_rewards", customerId, {
        goal: info.goal,
        reward: info.reward,
        redemptions: info.redemptions + 1,
        updatedAt: timestamp(),
      });
      return this.repo.put(actor.tenantId, "reward_redemptions", key, {
        customerId,
        reward: info.reward,
        actorId: actor.id,
        createdAt: timestamp(),
      });
    });
  }
  analytics(actor: Actor, query: unknown) {
    const { days } = parse(
      z
        .object({ days: z.coerce.number().int().min(1).max(366).default(30) })
        .strict(),
      query,
    );
    const today = localDate(new Date()),
      first = new Date(`${today}T12:00:00Z`);
    first.setUTCDate(first.getUTCDate() - days + 1);
    const firstDate = first.toISOString().slice(0, 10);
    const history = this.appointments(actor);
    const items = history.filter((a) => {
      const d = localDate(a.startsAt);
      return d >= firstDate && d <= today;
    });
    const completed = items.filter((a) => a.status === "completed"),
      cancelled = items.filter((a) => a.status === "cancelled" && a.attendanceOutcome !== "no_show");
    const clients = new Map<string, number>();
    completed
      .filter(
        (a) =>
          !this.repo.get<Customer>(actor.tenantId, "customers", a.customerId)
            ?.systemContact,
      )
      .forEach((a) =>
        clients.set(a.customerId, (clients.get(a.customerId) || 0) + 1),
      );
    const breakdown = new Map<
      string,
      { name: string; color: string; count: number; amountCents: number }
    >();
    items.forEach((a) => {
      const key = a.categoryName || "Sem categoria";
      const row = breakdown.get(key) || {
        name: key,
        color: a.categoryColor || "#64748b",
        count: 0,
        amountCents: 0,
      };
      row.count++;
      if (a.status === "completed") row.amountCents += a.priceCents;
      breakdown.set(key, row);
    });
    const daily = Array.from({ length: days }, (_, i) => {
      const d = new Date(first);
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      const list = items.filter((a) => localDate(a.startsAt) === date);
      return {
        date,
        count: list.length,
        completed: list.filter((a) => a.status === "completed").length,
      };
    });
    const previousStart = new Date(`${firstDate}T12:00:00Z`);
    previousStart.setUTCDate(previousStart.getUTCDate() - days);
    const previousCompleted = history.filter(a => a.status === "completed" && localDate(a.startsAt) >= previousStart.toISOString().slice(0,10) && localDate(a.startsAt) < firstDate);
    const previousProductionCents = previousCompleted.reduce((sum,a)=>sum+a.priceCents,0);
    const productionCents = completed.reduce((sum,a)=>sum+a.priceCents,0);
    const serviceProduction = new Map<string,{id:string;name:string;count:number;amountCents:number}>();
    for (const appointment of completed) {
      if (this.repo.get<Customer>(actor.tenantId,"customers",appointment.customerId)?.systemContact) continue;
      const row = serviceProduction.get(appointment.itemId) || {id:appointment.itemId,name:appointment.itemName,count:0,amountCents:0};
      row.count++; row.amountCents += appointment.priceCents; serviceProduction.set(row.id,row);
    }
    return {
      comparison: {previousCompleted:previousCompleted.length,previousProductionCents,productionChangePercent:previousProductionCents ? Math.round((productionCents-previousProductionCents)/previousProductionCents*1000)/10 : null},
      serviceProduction: [...serviceProduction.values()].sort((a,b)=>b.amountCents-a.amountCents || a.name.localeCompare(b.name)),
      ...agendaCharts(
        history,
        new Set(
          this.repo
            .list<Customer>(actor.tenantId, "customers")
            .filter((c) => c.systemContact)
            .map((c) => c.id),
        ),
        firstDate,
        today,
        days,
      ),
      firstDate,
      today,
      days,
      total: items.length,
      completed: completed.length,
      cancelled: cancelled.length,
      missed: items.filter(a=>a.attendanceOutcome === "no_show").length,
      productionCents: completed.reduce((sum, a) => sum + a.priceCents, 0),
      clients: clients.size,
      returningClients: [...clients.values()].filter((count) => count > 1)
        .length,
      categories: [...breakdown.values()],
      daily,
      scope: actor.role === "admin" ? "workspace" : "professional",
    };
  }
  export(actor: Actor, query: unknown) {
    const stats = this.analytics(actor, query);
    const rows = this.appointments(actor).filter((a) => {
      const date = localDate(a.startsAt);
      return date >= stats.firstDate && date <= stats.today;
    });
    if (rows.length > 10000)
      throw new BadRequestException(
        "Reduza o período para exportar até 10.000 atendimentos.",
      );
    const cell = (value: string | number) => {
      let text = String(value);
      if (/^\s*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    return (
      "\uFEFF" +
      [
        [
          "Data",
          "Cliente",
          "Serviço",
          "Categoria",
          "Atendimento",
          "Pagamento",
          "Valor BRL",
        ],
        ...rows.map((a) => [
          a.startsAt,
          a.customerName,
          a.itemName,
          a.categoryName || "",
          a.attendanceOutcome === "no_show" ? "no_show" : a.status,
          a.paymentStatus,
          (a.priceCents / 100).toFixed(2),
        ]),
      ]
        .map((row) => row.map(cell).join(";"))
        .join("\r\n")
    );
  }
}
