import { isSolo } from "../../../core/application/workspace-policy.js";
import {
  reviewSummary,
  verifiedReviews,
} from "../../feedback/domain/reputation.js";
import { MediaService } from "../../media/media.module.js";
import { BadRequestException, Injectable } from "@nestjs/common";
import { Context, parse } from "../../../core/application/context.js";
import type {
  Actor,
  Appointment,
  Customer,
  Feedback,
} from "../../../core/domain/models.js";
import type { Professional } from "../../../core/domain/professional.js";
import { settingsSchema } from "./settings.schemas.js";
@Injectable()
export class SettingsService {
  constructor(
    private readonly context: Context,
    private readonly media: MediaService,
  ) {}
  get(actor: Actor) {
    const settings = this.context.settings(actor);
    const summary = reviewSummary(
      verifiedReviews(
        this.context.repository.list<Feedback>(actor.tenantId, "feedback"),
        this.context.repository.list<Appointment>(
          actor.tenantId,
          "appointments",
        ),
      ),
    );
    const { bankAccount, pixKey, ...publicSettings } = settings;
    return {
      ratingCount: summary.count,
      averageRating: summary.average,
      ...(actor.role === "admin" ? settings : publicSettings),
      onlinePaymentsEnabled: Boolean(
        this.context.repository.get(
          actor.tenantId,
          "payment_connections",
          "mercadopago",
        ),
      ),
      manualPixEnabled: Boolean(pixKey.trim()),
      whatsappEnabled: false,
    };
  }
  update(actor: Actor, body: unknown) {
    this.context.admin(actor);
    const input = parse(settingsSchema, body);
    if (isSolo(this.context.repository, actor.tenantId) && input.media?.length)
      throw new BadRequestException("A agenda individual não permite mídia.");
    this.media.validate(actor, input.media);
    const previous = this.context.settings(actor);
    const settings = { ...previous, ...input };
    if (
      settings.workspaceMode !== "solo" &&
      settings.setupComplete &&
      (!settings.address || !settings.phone)
    )
      throw new BadRequestException(
        "Informe telefone e endereço para concluir a configuração.",
      );
    const result = this.context.repository.transaction(() => {
      this.context.repository.put(
        actor.tenantId,
        "settings",
        "business",
        settings,
      );
      const principal = this.context.repository.get<Professional>(
        actor.tenantId,
        "professionals",
        "principal",
      );
      if (settings.workspaceMode === "solo" && principal) {
        this.context.repository.put(
          actor.tenantId,
          "professionals",
          "principal",
          {
            ...principal,
            name: settings.name,
            weeklyHours: settings.weeklyHours,
            openingHour: settings.openingHour,
            closingHour: settings.closingHour,
            workDays: settings.workDays,
          },
        );
      }
      const customer = this.context.require<Customer>(
        actor,
        "customers",
        actor.id,
      );
      this.context.repository.put(actor.tenantId, "customers", actor.id, {
        ...customer,
        name: input.name,
      });
      return this.get(actor);
    });
    this.media.releaseUnused(actor, previous.media);
    return result;
  }
}
