import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Repository } from "../domain/document-repository.js";
import type { Actor, Settings } from "../domain/models.js";
export function isSolo(repo: Repository, tenantId: string) {
  return (
    repo.get<Settings>(tenantId, "settings", "business")?.workspaceMode ===
    "solo"
  );
}
export function assertPublicWorkspace(repo: Repository, tenantId: string) {
  if (isSolo(repo, tenantId))
    throw new NotFoundException("Estabelecimento não encontrado.");
}
export function assertWorkspaceOwner(repo: Repository, actor: Actor) {
  const settings = repo.get<Settings>(actor.tenantId, "settings", "business");
  if (
    settings?.workspaceMode === "solo" &&
    (actor.role !== "admin" || actor.id !== settings.ownerId)
  )
    throw new ForbiddenException(
      "Esta agenda é privada e exclusiva do proprietário.",
    );
}
export function assertWorkspaceRoute(
  repo: Repository,
  actor: Actor,
  path: string,
  method: string,
) {
  assertWorkspaceOwner(repo, actor);
  if (!isSolo(repo, actor.tenantId)) return;
  if (
    /^(media|checkout|orders|triage|feedback|discounts|procurement)(\/|$)/.test(
      path,
    ) ||
    path === "notifications/message" ||
    /^auth\/(team|invite|switch-store)/.test(path) ||
    /^payments\/(connect|recommendation|orders|subscription\/extras)/.test(
      path,
    ) ||
    (path === "professionals" && method !== "GET") ||
    (path.startsWith("professionals/") && path !== "professionals/principal")
  )
    throw new ForbiddenException(
      "Este recurso não faz parte da agenda individual.",
    );
}
