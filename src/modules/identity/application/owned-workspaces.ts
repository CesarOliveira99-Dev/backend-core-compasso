import { ForbiddenException } from "@nestjs/common";
import type { Actor, Customer, Settings } from "../../../core/domain/models.js";
import { Context } from "../../../core/application/context.js";
/** Only authenticated identity links establish ownership; an e-mail match is insufficient. */
export class OwnedWorkspaces {
  constructor(private readonly context: Context) {}
  owner(actor: Actor) {
    this.context.admin(actor);
    const member = this.context.require<Customer>(actor, "customers", actor.id);
    if (member.role !== "admin" || member.active === false || member.internal)
      throw new ForbiddenException();
    const settings = this.context.settings(actor);
    if (settings.ownerId && settings.ownerId !== member.id)
      throw new ForbiddenException(
        "Somente o proprietário pode gerenciar seus espaços.",
      );
    return member;
  }
  list(actor: Actor, includeInactive = false) {
    const owner = this.owner(actor),
      identityId = owner.identityId || owner.id,
      repo = this.context.repository;
    return repo
      .list<{ tenantId: string }>("system", "stores")
      .flatMap(({ tenantId }) => {
        const settings = repo.get<Settings>(tenantId, "settings", "business");
        if (!settings) return [];
        const member = repo
          .list<Customer>(tenantId, "customers")
          .find(
            (c) =>
              !c.internal &&
              c.role === "admin" &&
              (includeInactive || c.active !== false) &&
              (c.identityId || c.id) === identityId &&
              (!settings.ownerId || settings.ownerId === c.id),
          );
        return member
          ? [
              {
                id: tenantId,
                userId: member.id,
                name: settings.businessName,
                workspaceMode:
                  settings.workspaceMode === "solo"
                    ? ("solo" as const)
                    : ("store" as const),
                current: tenantId === actor.tenantId,
              },
            ]
          : [];
      });
  }
  target(actor: Actor, workspaceId: string) {
    const reference = this.list(actor).find((w) => w.id === workspaceId);
    if (!reference)
      throw new ForbiddenException("Você não tem acesso a este espaço.");
    return this.context.repository.get<Customer>(
      reference.id,
      "customers",
      reference.userId,
    )!;
  }
}
