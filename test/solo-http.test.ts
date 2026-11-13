import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const base = "http://127.0.0.1:4113/v1";
let server: ChildProcess,
  output = "";
before(async () => {
  server = spawn(process.execPath, [resolve("dist/main.js")], {
    cwd: resolve("."),
    env: {
      ...process.env,
      DATABASE_PATH: ":memory:",
      PORT: "4113",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      SEED_DEMO: "false",
      COMPASSO_SUBSCRIPTIONS_ENABLED: "false",
      MP_PLATFORM_ACCESS_TOKEN: "",
      RESEND_API_KEY: "",
      APPOINTMENT_EMAILS_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (data) => {
    output += data.toString();
  });
  server.stderr?.on("data", (data) => {
    output += data.toString();
  });
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`${base}/auth/me`)).status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Isolated test API did not start: " + output.slice(-1200));
});
after(() => server?.kill());
async function request(
  path: string,
  token = "",
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: response.headers.get("content-type")?.includes("csv")
      ? await response.text()
      : await response.json(),
  };
}
test("Solo HTTP lifecycle keeps public routes and teams closed while allowing private booking, dossiers, scoped export and manual finance", async () => {
  const input = {
    name: "Dona da Agenda",
    email: "solo-http@test.local",
    password: "StrongPassword123",
    confirmPassword: "StrongPassword123",
    phone: "18997499717",
    role: "admin",
    workspaceMode: "solo",
  };
  const registered = await request("auth/register", "", "POST", input);
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  const owner = registered.data,
    token = owner.token;
  const settings = (await request("settings", token)).data;
  assert.equal(settings.workspaceMode, "solo");
  assert.equal(settings.setupComplete, true);
  assert.equal((await request("auth/stores")).data.length, 0);
  assert.equal((await request("auth/discovery")).data.items.length, 0);
  assert.equal((await request(`auth/store/${settings.slug}`)).status, 404);
  const publicCustomer = (
    await request("auth/register", "", "POST", {
      ...input,
      name: "Cliente Externo",
      email: "customer-http@test.local",
      role: "customer",
      workspaceMode: "store",
    })
  ).data;
  assert.equal(
    (
      await request("auth/switch-store", publicCustomer.token, "POST", {
        slug: settings.slug,
      })
    ).status,
    404,
  );
  for (const path of [
    "auth/team/invite",
    "payments/connect",
    "payments/orders/x",
    "payments/subscription/extras",
    "media",
    "orders",
    "notifications/message",
  ])
    assert.equal((await request(path, token, "POST", {})).status, 403, path);
  const contact = await request("workspace/contacts", token, "POST", {
    idempotencyKey: randomUUID(),
    name: "Cliente Interno",
    phone: "18997499717",
  });
  assert.equal(contact.status, 201);
  const catalog = await request("catalog", token);
  assert.equal(catalog.data[0].priceCents, 0);
  const date = new Date(Date.now() + 3 * 86400000);
  date.setUTCHours(14, 0, 0, 0);
  const body = {
    itemId: "solo-personal",
    customerId: contact.data.id,
    startsAt: date.toISOString(),
    idempotencyKey: randomUUID(),
  };
  const booking = await request("appointments", token, "POST", body);
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  assert.equal(
    (await request("appointments", token, "POST", body)).data.id,
    booking.data.id,
  );
  const preferences = (await request("workspace/preferences", token)).data;
  const saved = await request("workspace/preferences", token, "PUT", {
    ...preferences,
    theme: "dark",
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (
      await request(
        `workspace/appointments/${booking.data.id}/style`,
        token,
        "PUT",
        { categoryId: "personal" },
      )
    ).status,
    200,
  );
  const completed = await request(
    `appointments/${booking.data.id}`,
    token,
    "PATCH",
    { status: "completed" },
  );
  assert.equal(completed.status, 200);
  assert.equal(
    (
      await request(`appointments/${booking.data.id}`, token, "PATCH", {
        paymentStatus: "paid",
      })
    ).status,
    200,
  );
  const dossier = (
    await request(`workspace/customers/${contact.data.id}`, token)
  ).data;
  assert.equal(
    (
      await request(`workspace/customers/${contact.data.id}`, token, "PUT", {
        ...dossier.dossier,
        notes: "Registro interno",
        fields: [{ label: "Preferência", value: "Manhã" }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `workspace/customers/${contact.data.id}`,
        publicCustomer.token,
      )
    ).status,
    403,
  );
  assert.equal((await request("workspace/export?days=7", token)).status, 200);
  assert.equal(
    (await request("insights/wallet?days=7", token)).data.cashReceivedCents,
    0,
  );
  assert.deepEqual(
    (await request("payments/status", token)).data.plans.map(
      (plan: any) => plan.priceCents,
    ),
    [1500, 11000],
  );
  assert.equal(
    (
      await request("payments/subscribe", token, "POST", {
        planId: "essencial",
      })
    ).status,
    403,
  );
  const ownerRecord = (await request("customers", token)).data.find(
    (c: any) => c.id === contact.data.id,
  );
  assert.ok(ownerRecord);
  assert.equal("passwordHash" in ownerRecord, false);
});

test("staff tools are scoped through HTTP and private style never appears in customer responses", async () => {
  const account = {
    name: "Dono da Loja",
    phone: "18997499717",
    email: "staff-owner@test.local",
    password: "StrongPassword123",
    confirmPassword: "StrongPassword123",
    role: "admin",
    slug: "staff-tools",
  };
  const owner = (await request("auth/register", "", "POST", account)).data;
  const invitation = (
    await request("auth/team/invite", owner.token, "POST", {})
  ).data;
  const employee = (
    await request("auth/invite/register", "", "POST", {
      ...account,
      name: "Profissional da Loja",
      email: "staff@test.local",
      token: invitation.token,
    })
  ).data;
  assert.equal(employee.user.role, "employee");
  const client = (
    await request("auth/register", "", "POST", {
      ...account,
      role: "customer",
      name: "Cliente da Loja",
      email: "staff-client@test.local",
    })
  ).data;
  const another = (
    await request("auth/register", "", "POST", {
      ...account,
      role: "customer",
      name: "Outro Cliente",
      email: "staff-other@test.local",
    })
  ).data;
  const item = (
    await request("catalog", owner.token, "POST", {
      kind: "service",
      name: "Atendimento",
      category: "Serviços",
      priceCents: 5000,
      durationMinutes: 60,
      active: true,
      requiresTriage: false,
    })
  ).data;
  const date = new Date(Date.now() + 4 * 86400000);
  date.setUTCHours(14, 0, 0, 0);
  const booking = await request("appointments", client.token, "POST", {
    itemId: item.id,
    professionalId: employee.user.professionalId,
    startsAt: date.toISOString(),
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  const list = await request("workspace/customers", employee.token);
  assert.deepEqual(
    list.data.map((c: any) => c.id),
    [client.user.id],
  );
  assert.equal(
    (await request(`workspace/customers/${another.user.id}`, employee.token))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        `workspace/customers/${client.user.id}`,
        employee.token,
        "PUT",
        {
          revision: 0,
          notes: "Ficha restrita à equipe",
          preferences: "",
          fields: [],
          tags: [],
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `workspace/customers/${client.user.id}/reward`,
        employee.token,
        "PUT",
        { goal: 2, reward: "Benefício" },
      )
    ).status,
    403,
  );
  const preferences = (await request("workspace/preferences", employee.token))
    .data;
  assert.equal(
    (
      await request("workspace/preferences", employee.token, "PUT", {
        ...preferences,
        storeDefault: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("workspace/preferences", employee.token, "PUT", {
        ...preferences,
        theme: "paper",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `workspace/appointments/${booking.data.id}/style`,
        employee.token,
        "PUT",
        { categoryId: "personal" },
      )
    ).status,
    200,
  );
  const visible = (await request("appointments", client.token)).data.find(
    (a: any) => a.id === booking.data.id,
  );
  assert.equal("categoryName" in visible, false);
  assert.equal("categoryColor" in visible, false);
  assert.equal(
    (await request(`workspace/customers/${client.user.id}`, client.token))
      .status,
    403,
  );
  const completed = await request(
    `appointments/${booking.data.id}`,
    employee.token,
    "PATCH",
    { status: "completed" },
  );
  assert.equal(completed.status, 200);
  assert.equal(
    (await request("workspace/analytics?days=30", employee.token)).data.scope,
    "professional",
  );
  assert.equal(
    (await request("workspace/export?days=30", employee.token)).status,
    200,
  );
});
