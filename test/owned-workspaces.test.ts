import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { DocumentRepository } from "../dist/core/infrastructure/document.repository.js";
import { Context } from "../dist/core/application/context.js";
import { IdentityService } from "../dist/modules/identity/application/identity-service.js";
import { GoogleIdentity } from "../dist/modules/identity/application/google-identity.js";
import { AccountRecovery } from "../dist/modules/identity/application/account-recovery.js";
import {
  storeEntitlement,
  startStoreTrial,
} from "../dist/core/application/store-plans.js";
process.env.DATABASE_PATH = ":memory:";
const address = {
  postalCode: "01001000",
  street: "Praça da Sé",
  number: "100",
  district: "Centro",
  city: "São Paulo",
  state: "SP",
  complement: "",
};
function setup(mode: "store" | "solo" = "store") {
  const repo = new DocumentRepository(),
    context = new Context(repo),
    identity = new IdentityService(context, new GoogleIdentity());
  const input = {
    name: "Dona dos Espaços",
    phone: "18997499717",
    email: randomUUID() + "@test.local",
    password: "StrongPassword123",
    role: "admin",
    workspaceMode: mode,
    ...(mode === "store" ? { businessName: "Minha Empresa", address } : {}),
  };
  const first = identity.register(input);
  return { repo, context, identity, input, first, owner: first.user };
}
function second(f: ReturnType<typeof setup>) {
  return {
    workspaceMode: f.input.workspaceMode === "store" ? "solo" : "store",
    idempotencyKey: randomUUID(),
    businessName: "Segundo Espaço",
    ...(f.input.workspaceMode === "solo" ? { address } : {}),
  };
}
test("one authenticated login owns two isolated spaces in either creation order, with one space per modality and idempotent creation", () => {
  for (const mode of ["store", "solo"] as const) {
    const f = setup(mode),
      body = second(f),
      created = f.identity.createWorkspace(f.owner, body);
    assert.notEqual(created.user.tenantId, f.owner.tenantId);
    assert.equal(created.user.identityId, f.owner.identityId);
    assert.equal(created.user.email, f.owner.email);
    assert.equal(f.identity.workspaces.list(created.user).length, 2);
    assert.equal(
      f.identity.createWorkspace(f.owner, body).user.id,
      created.user.id,
    );
    assert.throws(() =>
      f.identity.createWorkspace(f.owner, { ...body, businessName: "Outro" }),
    );
    assert.throws(() =>
      f.identity.createWorkspace(f.owner, {
        ...body,
        idempotencyKey: randomUUID(),
      }),
    );
    const login = f.identity.login({
      email: f.input.email,
      password: f.input.password,
    });
    assert.equal(login.status, "store_selection_required");
    if ("stores" in login) assert.equal(login.stores.length, 2);
    for (const workspace of f.identity.workspaces.list(f.owner)) {
      const target = f.identity.switchWorkspace(f.owner, {
        workspaceId: workspace.id,
      });
      assert.equal(target.user.tenantId, workspace.id);
      assert.equal(
        f.identity.authenticate(target.token).tenantId,
        workspace.id,
      );
    }
    assert.equal(f.identity.stores().length, 1);
    assert.equal(f.identity.discovery({}).items.length, 1);
    assert.equal(f.repo.list("system", "workspace_creation_keys").length, 1);
  }
});
test("ownership checks never link by e-mail or auto-enroll a customer, reject spoofed fields and inactive targets", () => {
  const f = setup(),
    other = f.identity.register({
      ...f.input,
      email: "other-" + randomUUID() + "@test.local",
      businessName: "Outro Negócio",
    }).user,
    created = f.identity.createWorkspace(f.owner, second(f));
  const sourceCount = f.repo.list(other.tenantId, "customers").length;
  assert.throws(() =>
    f.identity.switchWorkspace(f.owner, { workspaceId: other.tenantId }),
  );
  assert.equal(f.repo.list(other.tenantId, "customers").length, sourceCount);
  const outside = f.identity.register({
    name: "Cliente Particular",
    email: randomUUID() + "@test.local",
    phone: "18997499717",
    password: f.input.password,
    role: "customer",
  }).user;
  assert.throws(() => f.identity.workspaces.list(outside));
  assert.throws(() => f.identity.createWorkspace(outside, second(f)));
  assert.throws(() =>
    f.identity.createWorkspace(f.owner, {
      ...second(f),
      tenantId: other.tenantId,
    }),
  );
  const copy = f.repo.get<any>(
    created.user.tenantId,
    "customers",
    created.user.id,
  );
  f.repo.put(created.user.tenantId, "customers", copy.id, {
    ...copy,
    identityId: "unrelated",
    email: f.owner.email,
  });
  assert.equal(f.identity.workspaces.list(f.owner).length, 1);
  assert.throws(() =>
    f.identity.switchWorkspace(f.owner, { workspaceId: created.user.tenantId }),
  );
  f.repo.put(created.user.tenantId, "customers", copy.id, {
    ...copy,
    active: false,
  });
  assert.throws(() =>
    f.identity.switchWorkspace(f.owner, { workspaceId: created.user.tenantId }),
  );
  assert.throws(() =>
    f.identity.createWorkspace(f.owner, {
      ...second(f),
      idempotencyKey: randomUUID(),
    }),
  );
});
test("legacy trial claims do not consume the other modality and subscriptions remain tenant scoped", () => {
  const f = setup(),
    legacy = {
      startedAt: Date.now() - 20 * 86400000,
      endsAt: Date.now() - 6 * 86400000,
    };
  f.repo.put(f.owner.tenantId, "billing", "trial", legacy);
  f.repo.remove(
    "system",
    "store_trial_owners",
    createHash("sha256")
      .update("store:" + f.owner.email)
      .digest("hex"),
  );
  f.repo.put(
    "system",
    "store_trial_owners",
    createHash("sha256").update(f.owner.email).digest("hex"),
    legacy,
  );
  const solo = f.identity.createWorkspace(f.owner, second(f)).user;
  assert.equal(storeEntitlement(f.repo, f.owner.tenantId).mode, "expired");
  assert.equal(storeEntitlement(f.repo, solo.tenantId).mode, "trial");
  f.repo.put(f.owner.tenantId, "billing", "subscription", {
    planId: "essencial",
    priceCents: 5990,
    paidThrough: Date.now() + 86400000,
  });
  assert.equal(storeEntitlement(f.repo, f.owner.tenantId).mode, "active");
  assert.equal(storeEntitlement(f.repo, solo.tenantId).mode, "trial");
  assert.equal(f.repo.get(solo.tenantId, "billing", "subscription"), undefined);
  const again = "repeat";
  f.repo.put(again, "settings", "business", { workspaceMode: "solo" });
  const now = Date.now() + 30 * 86400000;
  startStoreTrial(f.repo, { tenantId: again, email: f.owner.email }, now);
  assert.equal(storeEntitlement(f.repo, again, now).mode, "expired");
});
test("Google linkage propagates only the authenticated identity and password recovery includes a space created after the link was issued", async () => {
  const f = setup();
  f.repo.put("system", "google_persons", f.owner.identityId!, {
    identityId: f.owner.identityId,
    sub: "verified-subject",
  });
  let link = "";
  const recovery = new AccountRecovery(f.context, {
    configured: () => true,
    send: async (_email: string, _subject: string, url: string) => {
      link = url;
    },
  });
  process.env.APP_URL = "https://fixture.test";
  await recovery.request("password", { email: f.owner.email });
  const created = f.identity.createWorkspace(f.owner, second(f));
  assert.equal(
    f.repo.get<any>(
      "system",
      "google_accounts",
      created.user.tenantId + ":verified-subject",
    ).userId,
    created.user.id,
  );
  const token = link.split("password:")[1];
  recovery.complete({
    token,
    password: "ReplacementPassword123",
    confirmPassword: "ReplacementPassword123",
  });
  for (const w of f.identity.workspaces.list(f.owner)) {
    const settings = f.repo.get<any>(w.id, "settings", "business");
    assert.equal(
      "user" in
        f.identity.login({
          slug: settings.slug,
          email: f.owner.email,
          password: "ReplacementPassword123",
        }),
      true,
    );
    assert.throws(() =>
      f.identity.login({
        slug: settings.slug,
        email: f.owner.email,
        password: f.input.password,
      }),
    );
  }
  assert.throws(() => f.identity.authenticate(f.first.token));
  assert.throws(() => f.identity.authenticate(created.token));
});
