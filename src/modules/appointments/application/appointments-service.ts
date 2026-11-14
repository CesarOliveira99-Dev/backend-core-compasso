import { requireStoreService } from "../../../core/application/store-plans.js";
import { assertWorkspaceOwner } from "../../../core/application/workspace-policy.js";
import {
  freeSlots,
  scheduleWindow,
  slotIssue,
  validCalendarDate,
} from "../domain/availability.js";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { z } from "zod";
import {
  Context,
  id,
  parse,
  timestamp,
} from "../../../core/application/context.js";
import type {
  Actor,
  Appointment,
  CatalogItem,
  Customer,
  Discount,
  Triage,
} from "../../../core/domain/models.js";
import {
  discountApplies,
  discountedPrice,
  localDate,
  localWeekday,
} from "../../../core/domain/policies.js";
import { bookingSchema } from "./appointments.schemas.js";
import { queueAppointmentMail } from "../../notifications/application/appointment-mail.js";
import { ProfessionalsService } from "../../professionals/professionals.module.js";
@Injectable()
export class AppointmentsService {
  constructor(
    private readonly context: Context,
    private readonly professionals: ProfessionalsService,
  ) {}
  private view(actor: Actor, appointment: Appointment): Appointment {
    if (actor.role !== "customer") return appointment;
    const {
      categoryId: _id,
      categoryName: _name,
      categoryColor: _color,
      ...visible
    } = appointment;
    return visible;
  }
  list(actor: Actor): Appointment[] {
    assertWorkspaceOwner(this.context.repository, actor);
    return this.context.repository
      .list<Appointment>(
        actor.tenantId,
        "appointments",
        actor.role === "admin"
          ? {}
          : actor.role === "employee"
            ? { professionalId: actor.professionalId || "__none__" }
            : { customerId: actor.id },
      )
      .filter(
        (a) =>
          actor.role === "admin" ||
          (actor.role === "employee"
            ? a.professionalId === actor.professionalId
            : a.customerId === actor.id),
      )
      .map((appointment) => this.view(actor, appointment))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
  private access(actor: Actor, appointment: Appointment) {
    if (actor.role === "employee") {
      if (
        !actor.professionalId ||
        appointment.professionalId !== actor.professionalId
      )
        throw new ForbiddenException("Atendimento de outro profissional.");
    } else this.context.owned(actor, appointment.customerId);
  }
  private reservations(
    actor: Actor,
    professionalId: string,
    ignoreId?: string,
  ) {
    const bookings = this.context.repository
      .list<Appointment>(actor.tenantId, "appointments")
      .filter(
        (appointment) =>
          appointment.id !== ignoreId &&
          (appointment.professionalId || "principal") === professionalId,
      );
    const blocks = this.context.repository.list<{ professionalId: string; startsAt: string; endsAt: string; active: boolean }>(actor.tenantId, "agenda_blocks").filter(b=>b.active && b.professionalId===professionalId).map(b=>({...b,status:"confirmed" as const}));
    return [...bookings, ...blocks];
  }
  private servicePrice(actor: Actor, item: CatalogItem, startsAt: string) {
    const percent = Math.max(
      0,
      ...this.context.repository
        .list<Discount>(actor.tenantId, "promotions")
        .filter((promotion) =>
          discountApplies(
            promotion,
            item.id,
            item.kind,
            new Date(),
            localWeekday(startsAt, this.context.settings(actor).timezone),
          ),
        )
        .map((promotion) => promotion.percent),
    );
    return discountedPrice(item.priceCents, percent);
  }
  availability(actor: Actor, query: unknown) {
    const input = parse(
      z.object({
        itemId: z.string().min(1).max(100),
        professionalId: z.string().min(1).max(100),
        date: z.string().refine(validCalendarDate, "Escolha uma data válida."),
        appointmentId: z.string().max(100).optional(),
        durationMinutes: z.coerce.number().int().min(1).max(720).optional(),
      }),
      query,
    );
    const item = this.context.require<CatalogItem>(
      actor,
      "catalog",
      input.itemId,
    );
    if (!item.active || item.kind !== "service")
      throw new BadRequestException("Serviço indisponível.");
    const professional = this.professionals.resolve(
      actor,
      item.id,
      input.professionalId,
    );
    let durationMinutes = item.durationMinutes;
    let priceCents: number | undefined;
    if (input.appointmentId) {
      const appointment = this.context.require<Appointment>(
        actor,
        "appointments",
        input.appointmentId,
      );
      this.access(actor, appointment);
      if (
        appointment.itemId !== item.id ||
        (appointment.professionalId || "principal") !== professional.id ||
        ["cancelled", "completed"].includes(appointment.status)
      )
        throw new BadRequestException(
          "Este atendimento não pode ser reagendado nesta agenda.",
        );
      durationMinutes =
        (Date.parse(appointment.endsAt) - Date.parse(appointment.startsAt)) /
        60000;
      priceCents = appointment.priceCents;
    }
    if (input.durationMinutes !== undefined) {
      if (actor.role === "customer")
        throw new ForbiddenException("A duração é definida pelo profissional.");
      durationMinutes = input.durationMinutes;
    }
    const settings = this.context.settings(actor);
    return {
      date: input.date,
      timezone: settings.timezone,
      durationMinutes,
      priceCents:
        priceCents ?? this.servicePrice(actor, item, `${input.date}T12:00:00Z`),
      slots: freeSlots(
        scheduleWindow(input.date, settings, professional, durationMinutes),
        durationMinutes,
        this.reservations(actor, professional.id, input.appointmentId),
        settings.timezone,
      ),
    };
  }
  validateSlot(
    actor: Actor,
    startsAt: string,
    durationMinutes: number,
    ignoreId?: string,
    professionalId = "principal",
  ) {
    const settings = this.context.settings(actor);
    const professional = this.professionals
      .list(actor)
      .find((profile) => profile.id === professionalId && profile.active);
    if (!professional)
      throw new BadRequestException("Profissional indisponível.");
    const start = Date.parse(startsAt),
      end = start + durationMinutes * 60000;
    const issue = slotIssue(
      start,
      end,
      scheduleWindow(
        localDate(startsAt, settings.timezone),
        settings,
        professional,
        durationMinutes,
      ),
      this.reservations(actor, professionalId, ignoreId),
      Date.now(),
    );
    if (issue === "past")
      throw new BadRequestException("Escolha um horário futuro.");
    if (issue === "hours")
      throw new BadRequestException(
        "Horário fora do expediente, em intervalo ou dia de folga.",
      );
    if (issue === "busy")
      throw new ConflictException(
        "Este horário já está reservado. Escolha outro horário.",
      );
    return new Date(end).toISOString();
  }
  create(
    actor: Actor,
    body: unknown,
    orderId?: string,
    priceCents?: number,
  ): Appointment {
    const input = parse(bookingSchema, body);
    if (input.durationMinutes !== undefined && actor.role !== "admin")
      throw new ForbiddenException("A duração é definida pelo responsável.");
    const fingerprint = JSON.stringify(input);
    const key =
      input.idempotencyKey && !orderId
        ? `${actor.id}:${input.idempotencyKey}`
        : undefined;
    const previous =
      key &&
      this.context.repository.get<{
        appointmentId: string;
        fingerprint: string;
      }>(actor.tenantId, "booking_keys", key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new BadRequestException(
          "Chave já utilizada em outro agendamento.",
        );
      return this.view(
        actor,
        this.context.require<Appointment>(
          actor,
          "appointments",
          previous.appointmentId,
        ),
      );
    }

    requireStoreService(this.context.repository, actor.tenantId);
    const item = this.context.require<CatalogItem>(
      actor,
      "catalog",
      input.itemId,
    );
    if (!item.active || item.kind !== "service")
      throw new BadRequestException("Serviço indisponível.");
    const customerId = actor.role === "admin" ? input.customerId : actor.id;
    if (!customerId) throw new BadRequestException("Selecione o cliente.");
    const customer = this.context.require<Customer>(
      actor,
      "customers",
      customerId,
    );
    if (customer.role !== "customer")
      throw new BadRequestException("Selecione um cliente.");
    if (item.requiresTriage && input.notes.trim().length < 5)
      throw new BadRequestException("Descreva sua necessidade para a triagem.");
    const professional = this.professionals.resolve(
      actor,
      item.id,
      input.professionalId,
    );
    const endsAt = this.validateSlot(
      actor,
      input.startsAt,
      input.durationMinutes ?? item.durationMinutes,
      undefined,
      professional.id,
    );
    const settings = this.context.settings(actor);
    if (actor.role === "customer" && !settings.payOnAppointment && !orderId)
      throw new BadRequestException(
        "Agendamentos com pagamento no dia estão desabilitados. Entre em contato com o estabelecimento.",
      );
    const currentPrice =
      priceCents ?? this.servicePrice(actor, item, input.startsAt);
    if (
      input.expectedPriceCents !== undefined &&
      input.expectedPriceCents !== currentPrice
    )
      throw new BadRequestException(
        "O valor foi atualizado. Confira o resumo antes de confirmar.",
      );
    const appointment: Appointment = {
      id: id(),
      customerId,
      customerName: customer.name,
      itemId: item.id,
      itemName: item.name,
      professionalId: professional.id,
      professionalName: professional.name,
      startsAt: input.startsAt,
      endsAt,
      priceCents: currentPrice,
      status: item.requiresTriage ? "pending" : "confirmed",
      paymentStatus: "pending",
      notes: input.notes,
      orderId,
      createdAt: timestamp(),
    };
    this.context.repository.put(
      actor.tenantId,
      "appointments",
      appointment.id,
      appointment,
    );
    if (key)
      this.context.repository.put(actor.tenantId, "booking_keys", key, {
        appointmentId: appointment.id,
        fingerprint,
      });
    if (item.requiresTriage) {
      const triage: Triage = {
        id: id(),
        customerId,
        customerName: customer.name,
        appointmentId: appointment.id,
        answers: input.notes,
        status: "pending",
        decision: "",
        createdAt: timestamp(),
      };
      this.context.repository.put(actor.tenantId, "triage", triage.id, triage);
    }
    this.context.notify(
      actor,
      customerId,
      item.requiresTriage ? "Solicitação em triagem" : "Agendamento confirmado",
      `${item.name} • ${new Date(input.startsAt).toLocaleString("pt-BR", { timeZone: this.context.settings(actor).timezone })}`,
    );
    if (professional.userId)
      this.context.notify(
        actor,
        professional.userId,
        "Novo atendimento",
        `${customer.name} • ${item.name} • ${input.startsAt}`,
      );
    this.context.notifyAdmins(
      actor,
      "Novo agendamento",
      `${customer.name} solicitou ${item.name}.`,
    );
    queueAppointmentMail(this.context, actor, appointment, "confirmation");
    return this.view(actor, appointment);
  }
  transition(actor: Actor, appointmentId: string, body: unknown) {
    const input = parse(
      z.object({
        status: z.enum(["completed", "cancelled"]).optional(),
        paymentStatus: z.literal("paid").optional(),
        startsAt: z.string().datetime().optional(),
        durationMinutes: z.number().int().min(1).max(720).optional(),
      }),
      body,
    );
    return this.context.repository.transaction(() => {
      const appointment = this.context.require<Appointment>(
        actor,
        "appointments",
        appointmentId,
      );
      this.access(actor, appointment);
      if (
        input.paymentStatus ||
        (input.status === "completed" && actor.role !== "employee")
      )
        this.context.admin(actor);
      if (input.startsAt || input.durationMinutes !== undefined) {
        if (input.durationMinutes !== undefined && actor.role === "customer")
          throw new ForbiddenException(
            "A duração é definida pelo profissional.",
          );
        const startsAt = input.startsAt || appointment.startsAt;
        if (
          appointment.status === "completed" ||
          appointment.status === "cancelled"
        )
          throw new BadRequestException(
            "Este atendimento não pode ser reagendado.",
          );
        appointment.endsAt = this.validateSlot(
          actor,
          startsAt,
          input.durationMinutes ??
            (new Date(appointment.endsAt).getTime() -
              new Date(appointment.startsAt).getTime()) /
              60000,
          appointment.id,
          appointment.professionalId || "principal",
        );
        if (appointment.orderId) {
          const order = this.context.require<
            import("../../../core/domain/models.js").Order
          >(actor, "orders", appointment.orderId);
          const items = order.items.map((line) =>
            line.kind === "service" &&
            line.itemId === appointment.itemId &&
            line.startsAt === appointment.startsAt &&
            (line.professionalId || "principal") ===
              (appointment.professionalId || "principal")
              ? { ...line, startsAt }
              : line,
          );
          this.context.repository.put(actor.tenantId, "orders", order.id, {
            ...order,
            items,
          });
        }
        appointment.startsAt = startsAt;
      }
      if (input.status) {
        if (appointment.status === input.status)
          return this.view(actor, appointment);
        if (
          appointment.status === "cancelled" ||
          appointment.status === "completed" ||
          (input.status === "completed" && appointment.status === "pending")
        )
          throw new BadRequestException(
            "Transição de atendimento inválida. Resolva a triagem primeiro.",
          );
        if (
          actor.role === "customer" &&
          new Date(appointment.startsAt) <= new Date()
        )
          throw new BadRequestException(
            "Entre em contato para cancelar este atendimento.",
          );
        appointment.status = input.status;
        if (input.status === "completed") {
          appointment.completedAt = timestamp();
          this.context.notify(
            actor,
            appointment.customerId,
            "Como foi seu atendimento?",
            `Seu atendimento de ${appointment.itemName} foi concluído. Deixe sua avaliação e programe a próxima visita.`,
            `feedback:${appointment.id}`,
          );
        } else
          this.context.notify(
            actor,
            appointment.customerId,
            "Agendamento cancelado",
            appointment.itemName,
          );
      }
      if (input.paymentStatus) {
        if (
          appointment.orderId &&
          this.context.require<import("../../../core/domain/models.js").Order>(
            actor,
            "orders",
            appointment.orderId,
          ).paymentMethod === "online"
        )
          throw new BadRequestException(
            "O Mercado Pago confirma este pagamento automaticamente.",
          );
        if (appointment.status === "cancelled")
          throw new BadRequestException("Atendimento cancelado.");
        appointment.paymentStatus = "paid";
        appointment.paidAt ??= timestamp();
      }
      if (
        input.startsAt &&
        input.startsAt !==
          this.context.require<Appointment>(
            actor,
            "appointments",
            appointment.id,
          ).startsAt
      )
        queueAppointmentMail(this.context, actor, appointment, "confirmation");
      const saved = this.context.repository.put(
        actor.tenantId,
        "appointments",
        appointment.id,
        appointment,
      );
      return this.view(actor, saved);
    });
  }
}
