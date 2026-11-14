import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "../dist/core/application/context.js";
import { DocumentRepository } from "../dist/core/infrastructure/document.repository.js";
import { IdentityService } from "../dist/modules/identity/application/identity-service.js";
import { GoogleIdentity } from "../dist/modules/identity/application/google-identity.js";
import { WorkspaceService } from "../dist/modules/workspace/application/workspace-service.js";
import { assertWorkspaceRoute } from "../dist/core/application/workspace-policy.js";
import { Memberships } from "../dist/modules/identity/application/memberships.js";
import { storeEntitlement } from "../dist/core/application/store-plans.js";
import { CustomerAccounts } from "../dist/modules/identity/application/customer-accounts.js";
import { AppointmentsService } from "../dist/modules/appointments/application/appointments-service.js";
import { ProfessionalsService } from "../dist/modules/professionals/professionals.module.js";
import { queueAppointmentMail } from "../dist/modules/notifications/application/appointment-mail.js";
import {
  SubscriptionBilling,
  subscriptionPeriodEnd,
} from "../dist/modules/payments/subscription-billing.js";
import { localDate } from "../dist/core/domain/policies.js";
import { SettingsService } from "../dist/modules/settings/application/settings-service.js";
process.env.DATABASE_PATH = ":memory:";
function setup() {
  const repo = new DocumentRepository(),
    context = new Context(repo),
    identity = new IdentityService(context, new GoogleIdentity());
  const input = {
    role: "admin",
    workspaceMode: "solo",
    name: "Ana Maria",
    phone: "18997499717",
    email: `${randomUUID()}@test.local`,
    password: "StrongPassword123",
  };
  const account = identity.register(input);
  return {
    repo,
    context,
    identity,
    input,
    owner: account.user,
    service: new WorkspaceService(context),
  };
}

test("Solo registration is private, has one owner, works without an address and remains accessible through normal password login", () => {
  const f = setup(),
    settings = f.context.settings(f.owner);
  assert.equal(settings.workspaceMode, "solo");
  assert.equal(settings.ownerId, f.owner.id);
  assert.equal(settings.setupComplete, true);
  assert.equal(f.identity.stores().length, 0);
  assert.equal(f.identity.discovery({}).items.length, 0);
  assert.equal(
    f.identity.login({ email: f.input.email, password: f.input.password }).user
      .id,
    f.owner.id,
  );
  assert.equal(
    storeEntitlement(f.repo, f.owner.tenantId).plan?.monthlyEmails,
    0,
  );
  assert.equal(
    f.repo
      .list<any>(f.owner.tenantId, "customers")
      .filter((c) => c.role === "admin").length,
    1,
  );
  assert.throws(() =>
    f.identity.register({
      ...f.input,
      email: "customer@test.local",
      role: "customer",
      slug: settings.slug,
      workspaceMode: "store",
    }),
  );
  const customer = f.identity.register({
    name: "Cliente Externo",
    email: "outside@test.local",
    phone: "18997499717",
    password: f.input.password,
    role: "customer",
  }).user;
  assert.throws(() =>
    new Memberships(f.context).switchStore(customer, settings.slug),
  );
  assert.throws(() => new Memberships(f.context).invite(f.owner));
});
test("Solo owner cannot use disabled business routes and a different admin cannot use its context or shared services", () => {
  const f = setup();
  for (const path of [
    "media",
    "checkout",
    "orders",
    "feedback",
    "triage",
    "auth/team/invite",
    "auth/switch-store",
    "payments/connect",
    "payments/orders/abc",
    "notifications/message",
    "professionals",
  ])
    assert.throws(
      () => assertWorkspaceRoute(f.repo, f.owner, path, "POST"),
      undefined,
      path,
    );
  for (const path of [
    "appointments",
    "workspace/preferences",
    "workspace/customers",
    "workspace/analytics",
    "payments/subscribe",
    "payments/status",
    "insights/wallet",
  ])
    assert.doesNotThrow(() =>
      assertWorkspaceRoute(f.repo, f.owner, path, "GET"),
    );
  const intruder = { ...f.owner, id: "intruder" };
  assert.throws(() => f.context.settings(intruder));
  assert.throws(() => f.service.customers(intruder));
  assert.throws(() =>
    f.identity.session({
      ...f.repo.get<any>(f.owner.tenantId, "customers", f.owner.id),
      id: "intruder",
    }),
  );
});
test("internal contacts create no accounts, cannot sign in, are idempotent and do not block another person registering the same email", () => {
  const f = setup(),
    input = {
      idempotencyKey: randomUUID(),
      name: "Cliente Particular",
      email: "contact@test.local",
      phone: "(18) 99749-9717",
    };
  const first = f.service.createContact(f.owner, input),
    again = f.service.createContact(f.owner, input);
  assert.equal(first.id, again.id);
  assert.throws(() =>
    f.service.createContact(f.owner, { ...input, name: "Outra Pessoa" }),
  );
  const contact = f.repo.get<any>(f.owner.tenantId, "customers", first.id);
  assert.equal(contact.internal, true);
  assert.equal(contact.phone, "18997499717");
  assert.equal(new CustomerAccounts(f.context).all(input.email).length, 0);
  assert.throws(() => f.identity.session(contact));
  assert.equal(
    f.identity.register({
      name: "Cliente Real",
      phone: "18997499717",
      email: input.email,
      password: f.input.password,
      role: "customer",
    }).user.role,
    "customer",
  );
});
test("Solo can reserve a private personal event and mark completion/payment manually without an order, notification or business mail", () => {
  const f = setup();
  Object.assign(process.env, {
    APPOINTMENT_EMAILS_ENABLED: "true",
    RESEND_API_KEY: "fixture",
    MAIL_FROM: "test@example.test",
    APP_URL: "https://test.local",
  });
  const service = new AppointmentsService(
    f.context,
    new ProfessionalsService(f.context),
  );
  const startsAt = new Date(Date.now() + 5 * 86400000);
  startsAt.setUTCHours(14, 0, 0, 0);
  const booking = f.repo.transaction(() =>
    service.create(f.owner, {
      itemId: "solo-personal",
      customerId: "solo-self",
      startsAt: startsAt.toISOString(),
      idempotencyKey: randomUUID(),
    }),
  );
  assert.equal(booking.priceCents, 0);
  assert.equal(f.repo.list(f.owner.tenantId, "orders").length, 0);
  service.transition(f.owner, booking.id, { status: "completed" });
  service.transition(f.owner, booking.id, { paymentStatus: "paid" });
  assert.equal(
    f.repo.get<any>(f.owner.tenantId, "appointments", booking.id).paymentStatus,
    "paid",
  );
  queueAppointmentMail(f.context, f.owner, booking, "confirmation");
  assert.equal(f.repo.list(f.owner.tenantId, "appointment_mail").length, 0);
  assert.equal(
    f.repo
      .list<any>(f.owner.tenantId, "notifications")
      .filter((n) => n.userId !== f.owner.id).length,
    0,
  );
  f.repo.put(f.owner.tenantId, "appointments", booking.id, {
    ...f.repo.get<any>(f.owner.tenantId, "appointments", booking.id),
    startsAt: new Date().toISOString(),
  });
  assert.equal(
    f.service.analytics(f.owner, { days: 30 }).clients,
    0,
    "personal calendar entries must not create retention metrics",
  );
});
function shop() {
  const repo = new DocumentRepository(),
    context = new Context(repo);
  const admin = {
    id: "owner",
    tenantId: "shop",
    role: "admin" as const,
    name: "Owner",
    email: "owner@test.local",
    phone: "",
  };
  const employee = {
    ...admin,
    id: "staff",
    role: "employee" as const,
    professionalId: "p1",
  };
  repo.put("shop", "settings", "business", {
    name: "Shop",
    workspaceMode: "store",
  });
  for (const id of ["c1", "c2"])
    repo.put("shop", "customers", id, {
      id,
      tenantId: "shop",
      role: "customer",
      name: id,
      email: "",
      phone: "",
      addresses: [],
    });
  const now = new Date().toISOString();
  const base = {
    itemId: "cut",
    itemName: "Serviço",
    startsAt: now,
    endsAt: now,
    status: "completed",
    paymentStatus: "paid",
    priceCents: 1000,
    notes: "",
    createdAt: now,
    customerName: "Cliente",
  };
  repo.put("shop", "appointments", "a1", {
    ...base,
    id: "a1",
    customerId: "c1",
    professionalId: "p1",
  });
  repo.put("shop", "appointments", "a2", {
    ...base,
    id: "a2",
    customerId: "c2",
    professionalId: "p2",
    priceCents: 9000,
  });
  return {
    repo,
    context,
    admin,
    employee,
    service: new WorkspaceService(context),
  };
}
test("staff dossiers and analytics include assigned clients only, reject customer access and never expose password hashes", () => {
  const f = shop();
  const charts = f.service.analytics(f.employee, { days: 7 });
  assert.equal(
    charts.services.reduce((sum, row) => sum + row.count, 0),
    1,
  );
  assert.equal(
    charts.attendanceCategories.reduce((sum, row) => sum + row.count, 0),
    1,
  );
  assert.equal(
    charts.clientMix.reduce((sum, row) => sum + row.count, 0),
    1,
  );
  assert.deepEqual(
    f.service.customers(f.employee).map((c) => c.id),
    ["c1"],
  );
  assert.equal(
    f.service.analytics(f.employee, { days: 7 }).productionCents,
    1000,
  );
  assert.equal(
    f.service.analytics(f.admin, { days: 7 }).productionCents,
    10000,
  );
  assert.throws(() => f.service.dossier(f.employee, "c2"));
  assert.throws(() =>
    f.service.analytics({ ...f.employee, role: "customer" }, { days: 7 }),
  );
  assert.throws(() =>
    f.service.dossier({ ...f.employee, tenantId: "other" }, "c1"),
  );
  assert.equal(
    JSON.stringify(f.service.dossier(f.admin, "c1")).includes("passwordHash"),
    false,
  );
});
test("dossiers reject stale edits and protected fields, preserve custom data and record who made a change", () => {
  const f = shop();
  const input = {
    revision: 0,
    notes: "Observação privada",
    preferences: "Prefere manhã",
    tags: ["retorno"],
    fields: [{ label: "Preferência", value: "Sem perfume" }],
  };
  const saved = f.service.saveDossier(f.employee, "c1", input);
  assert.equal(saved.revision, 1);
  assert.equal(saved.updatedBy, f.employee.id);
  assert.throws(
    () => f.service.saveDossier(f.admin, "c1", input),
    /atualizada/,
  );
  assert.throws(() =>
    f.service.saveDossier(f.employee, "c1", {
      ...input,
      revision: 1,
      tenantId: "other",
    }),
  );
  assert.equal(
    f.service.dossier(f.admin, "c1").dossier.fields[0].value,
    "Sem perfume",
  );
});
test("category defaults and personal themes are isolated; staff can style own appointments but not change another professional or store defaults", () => {
  const f = shop();
  const original = f.service.preferences(f.admin);
  const saved = f.service.savePreferences(f.admin, {
    ...original,
    theme: "dark",
    storeDefault: true,
    categories: [{ id: "new", name: "Retorno", color: "#335577" }],
  });
  const inherited = f.service.preferences(f.employee);
  assert.equal(inherited.theme, "dark");
  assert.equal(inherited.revision, 0);
  assert.throws(() =>
    f.service.savePreferences(f.employee, { ...inherited, storeDefault: true }),
  );
  f.service.savePreferences(f.employee, {
    ...inherited,
    theme: "paper",
    storeDefault: false,
  });
  assert.equal(f.service.preferences(f.admin).theme, "dark");
  const appointment = f.service.style(f.employee, "a1", { categoryId: "new" });
  assert.equal(appointment.categoryColor, "#335577");
  assert.equal(appointment.paymentStatus, "paid");
  assert.throws(() => f.service.style(f.employee, "a2", { categoryId: "new" }));
  assert.throws(() =>
    f.service.style(f.employee, "a1", { categoryId: "foreign" }),
  );
  assert.throws(() =>
    f.service.savePreferences(f.admin, {
      ...saved,
      accent: "url(javascript:bad)",
    }),
  );
  assert.throws(() =>
    f.service.savePreferences(f.admin, { ...original, theme: "paper" }),
  );
});
test("loyalty rewards require completed visits, owner-defined rules and exactly-once redemption", () => {
  const f = shop();
  assert.throws(() =>
    f.service.rewardRule(f.employee, "c1", { goal: 1, reward: "Cortesia" }),
  );
  f.service.rewardRule(f.admin, "c1", { goal: 2, reward: "Cortesia" });
  const key = randomUUID();
  assert.throws(
    () => f.service.redeem(f.employee, "c1", { idempotencyKey: key }),
    /meta/,
  );
  f.repo.put("shop", "appointments", "a3", {
    ...f.repo.get<any>("shop", "appointments", "a1"),
    id: "a3",
  });
  f.service.redeem(f.employee, "c1", { idempotencyKey: key });
  f.service.redeem(f.employee, "c1", { idempotencyKey: key });
  assert.equal(f.service.dossier(f.admin, "c1").loyalty?.redemptions, 1);
  assert.throws(() =>
    f.service.redeem(f.employee, "c1", { idempotencyKey: randomUUID() }),
  );
  assert.throws(() =>
    f.service.rewardRule(f.admin, "c1", { goal: 1, reward: "Outro" }),
  );
});
test("CSV export is tenant/professional scoped, escapes quotes and prevents spreadsheet formula injection", () => {
  const f = shop(),
    appointment = f.repo.get<any>("shop", "appointments", "a1");
  f.repo.put("shop", "appointments", "a1", {
    ...appointment,
    itemName: '=HYPERLINK("bad")',
  });
  const csv = f.service.export(f.employee, { days: 7 });
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('""bad""'));
  assert.ok(!csv.includes("90.00"));
  assert.throws(() => f.service.export(f.employee, { days: 5000 }));
});
test("Solo annual payment uses 12-month billing, grants a calendar year only after verified payment and rejects plans from the other family", async () => {
  const f = setup();
  Object.assign(process.env, {
    COMPASSO_SUBSCRIPTIONS_ENABLED: "true",
    MP_PLATFORM_ACCESS_TOKEN: "fixture",
    MP_PLATFORM_USER_ID: "123",
    MP_WEBHOOK_SECRET: "fixture",
    APP_URL: "https://test.local",
    PUBLIC_API_URL: "https://api.test.local/v1",
    MP_SANDBOX: "true",
  });
  let reference = "",
    frequency = 12,
    amount = 110;
  const now = new Date().toISOString();
  const calls: any[] = [];
  const pre = () => ({
    id: "subsolo",
    collector_id: 123,
    external_reference: reference,
    status: "authorized",
    init_point: "https://www.mercadopago.com.br/subscriptions/checkout",
    auto_recurring: {
      frequency,
      frequency_type: "months",
      transaction_amount: amount,
      currency_id: "BRL",
    },
  });
  const billing = new SubscriptionBilling(f.context, (async (
    path: string,
    _token?: string,
    body?: any,
  ) => {
    calls.push({ path, body });
    if (path === "/preapproval") {
      reference = body.external_reference;
      return pre();
    }
    if (path === "/preapproval/subsolo") return pre();
    if (path === "/authorized_payments/42")
      return {
        id: 42,
        preapproval_id: "subsolo",
        currency_id: "BRL",
        transaction_amount: 110,
        debit_date: now,
        payment: { id: 44 },
      };
    if (path === "/v1/payments/44")
      return {
        id: 44,
        collector_id: 123,
        currency_id: "BRL",
        transaction_amount: 110,
        status: "approved",
        live_mode: false,
        date_approved: now,
      };
    throw new Error(path);
  }) as any);
  await assert.rejects(() => billing.subscribe(f.owner, { planId: "equipe" }));
  assert.equal(calls.length, 0);
  await assert.rejects(() => billing.subscribe(f.owner, { planId: "solo-anual" }), /terminar o teste grátis/);
  assert.equal(calls.length, 0);
  f.repo.put(f.owner.tenantId, "billing", "trial", {
    startedAt: Date.now() - 15 * 86400000,
    endsAt: Date.now() - 1,
  });
  await billing.subscribe(f.owner, { planId: "solo-anual" });
  assert.equal(calls[0].body.auto_recurring.frequency, 12);
  assert.equal(calls[0].body.auto_recurring.transaction_amount, 110);
  assert.equal(storeEntitlement(f.repo, f.owner.tenantId).mode, "expired");
  frequency = 1;
  await assert.rejects(() => billing.preapproval("subsolo"));
  frequency = 12;
  await billing.invoice("42");
  assert.equal(
    billing.status(f.owner).subscription?.paidThrough,
    subscriptionPeriodEnd(Date.parse(now), 12),
  );
  assert.equal(storeEntitlement(f.repo, f.owner.tenantId).mode, "active");
  assert.equal(
    new Date(
      subscriptionPeriodEnd(Date.parse("2028-02-29T12:00:00Z"), 12),
    ).toISOString(),
    "2029-02-28T12:00:00.000Z",
  );
  const store = { ...f.owner, tenantId: "store" };
  await assert.rejects(() =>
    billing.subscribe(store, { planId: "solo-mensal" }),
  );
});

test("expired Solo keeps records readable but cannot create a contact or book another event", () => {
  const f = setup();
  const before = f.service.createContact(f.owner, {
    idempotencyKey: randomUUID(),
    name: "Cliente Preservado",
  });
  f.repo.put(f.owner.tenantId, "billing", "trial", {
    startedAt: Date.now() - 15 * 86400000,
    endsAt: Date.now() - 1,
  });
  assert.equal(storeEntitlement(f.repo, f.owner.tenantId).mode, "expired");
  assert.equal(
    f.service.dossier(f.owner, before.id).customer.name,
    "Cliente Preservado",
  );
  assert.throws(() =>
    f.service.createContact(f.owner, {
      idempotencyKey: randomUUID(),
      name: "Novo Cliente",
    }),
  );
  const appointments = new AppointmentsService(
    f.context,
    new ProfessionalsService(f.context),
  );
  assert.throws(() =>
    appointments.create(f.owner, {
      itemId: "solo-personal",
      customerId: before.id,
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      idempotencyKey: randomUUID(),
    }),
  );
  assert.equal(f.repo.list(f.owner.tenantId, "orders").length, 0);
});

test("changing Solo hours also updates an explicitly stored owner professional schedule", () => {
  const f = setup();
  const settings = f.context.settings(f.owner);
  f.repo.put(f.owner.tenantId, "professionals", "principal", {
    id: "principal",
    name: settings.name,
    active: true,
    serviceIds: [],
    openingHour: 8,
    closingHour: 20,
    workDays: [1, 2, 3, 4, 5],
  });
  const service = new SettingsService(f.context, {
    validate() {},
    releaseUnused() {},
  } as any);
  service.update(f.owner, {
    ...settings,
    openingHour: 10,
    closingHour: 16,
    workDays: [1, 3, 5],
  });
  const principal = f.repo.get<any>(
    f.owner.tenantId,
    "professionals",
    "principal",
  );
  assert.equal(principal.openingHour, 10);
  assert.equal(principal.closingHour, 16);
  assert.deepEqual(principal.workDays, [1, 3, 5]);
});
