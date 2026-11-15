import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const base = "http://127.0.0.1:4114/v1";
let server: ChildProcess,
  output = "";
before(async () => {
  server = spawn(process.execPath, [resolve("dist/main.js")], {
    env: {
      ...process.env,
      PORT: "4114",
      HOST: "127.0.0.1",
      DATABASE_PATH: ":memory:",
      SEED_DEMO: "false",
      NODE_ENV: "test",
      COMPASSO_SUBSCRIPTIONS_ENABLED: "false",
      RESEND_API_KEY: "",
      MP_PLATFORM_ACCESS_TOKEN: "",
      APPOINTMENT_EMAILS_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (d) => (output += d));
  server.stderr?.on("data", (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/auth/me")).status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(output.slice(-1000));
});
after(() => server?.kill());
async function request(
  path: string,
  token = "",
  method = "GET",
  body?: unknown,
  workspace?: string,
) {
  const r = await fetch(base + "/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(workspace ? { "X-Compasso-Workspace": workspace } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: r.status,
    data: r.headers.get("content-type")?.includes("csv")
      ? await r.text()
      : await r.json(),
  };
}
const address = {
  postalCode: "01001000",
  street: "Praça da Sé",
  number: "100",
  district: "Centro",
  city: "São Paulo",
  state: "SP",
  complement: "",
};
test("HTTP owner can create and select two spaces; stale tabs, employees and outsiders cannot write or switch into the wrong tenant", async () => {
  const input = {
    role: "admin",
    workspaceMode: "solo",
    name: "Dona dos Espaços",
    phone: "18997499717",
    email: "owner-http@test.local",
    password: "StrongPassword123",
    confirmPassword: "StrongPassword123",
  };
  const solo = (await request("auth/register", "", "POST", input)).data;
  assert.ok(solo.token);
  const body = {
    workspaceMode: "store",
    idempotencyKey: randomUUID(),
    businessName: "Minha Empresa",
    address,
  };
  const created = await request(
    "auth/workspaces",
    solo.token,
    "POST",
    body,
    solo.user.tenantId,
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const shop = created.data;
  assert.notEqual(shop.user.tenantId, solo.user.tenantId);
  assert.equal((await request("auth/workspaces", shop.token)).data.length, 2);
  assert.equal(
    (await request("auth/workspaces", solo.token, "POST", body)).data.user.id,
    shop.user.id,
  );
  assert.equal(
    (
      await request("auth/login", "", "POST", {
        email: input.email,
        password: input.password,
      })
    ).data.stores.length,
    2,
  );
  const newContact = {
    idempotencyKey: randomUUID(),
    name: "Contato da Empresa",
  };
  assert.equal(
    (
      await request(
        "workspace/contacts",
        shop.token,
        "POST",
        newContact,
        solo.user.tenantId,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("workspace/customers", shop.token)).data.length,
    0,
  );
  assert.equal(
    (
      await request(
        "workspace/contacts",
        shop.token,
        "POST",
        newContact,
        shop.user.tenantId,
      )
    ).status,
    201,
  );
  assert.equal(
    (await request("workspace/customers", solo.token)).data.length,
    0,
  );
  assert.equal(
    (
      await request(
        "workspace/customers",
        shop.token,
        "GET",
        undefined,
        solo.user.tenantId,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("auth/me", shop.token, "GET", undefined, solo.user.tenantId))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        "workspace/export?days=7",
        shop.token,
        "GET",
        undefined,
        solo.user.tenantId,
      )
    ).status,
    409,
  );
  const switched = await request(
    "auth/workspaces/switch",
    shop.token,
    "POST",
    { workspaceId: solo.user.tenantId },
    shop.user.tenantId,
  );
  assert.equal(switched.status, 201);
  assert.equal(switched.data.user.id, solo.user.id);
  assert.equal(
    (await request("settings", switched.data.token)).data.workspaceMode,
    "solo",
  );
  assert.equal(
    (await request("payments/status", shop.token)).data.plans.length,
    3,
  );
  assert.equal(
    (await request("payments/status", solo.token)).data.plans.length,
    2,
  );
  const other = (
    await request("auth/register", "", "POST", {
      ...input,
      email: "outside-http@test.local",
    })
  ).data;
  const before = (await request("auth/workspaces", other.token)).data.length;
  assert.equal(
    (
      await request("auth/workspaces/switch", other.token, "POST", {
        workspaceId: solo.user.tenantId,
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("auth/workspaces", other.token)).data.length,
    before,
  );
  assert.equal(
    (await request("auth/stores")).data.some(
      (s: any) => s.workspaceMode === "solo",
    ),
    false,
  );
  const invite = (await request("auth/team/invite", shop.token, "POST", {}))
    .data;
  const employee = (
    await request("auth/invite/register", "", "POST", {
      ...input,
      email: "employee-http@test.local",
      name: "Funcionária da Loja",
      token: invite.token,
    })
  ).data;
  assert.equal(employee.user.role, "employee");
  assert.equal((await request("auth/workspaces", employee.token)).status, 403);
  assert.equal(
    (
      await request("auth/workspaces/switch", employee.token, "POST", {
        workspaceId: solo.user.tenantId,
      })
    ).status,
    403,
  );
});

test('Solo HTTP accepts per-appointment duration, exposes late slots and validates custom financial dates', async () => {
 const input={name:'Agenda Refinada',phone:'18997499717',email:'refinement-http@test.local',password:'StrongPassword123',confirmPassword:'StrongPassword123',role:'admin',workspaceMode:'solo'};
 const account=(await request('auth/register','','POST',input)).data;
 const date=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
 const availability=await request(`appointments/availability?itemId=solo-personal&professionalId=principal&date=${date}&durationMinutes=90`,account.token);
 assert.equal(availability.status,200);assert.equal(availability.data.slots.at(-1).label,'23:45');
 const booked=await request('appointments',account.token,'POST',{itemId:'solo-personal',customerId:'solo-self',startsAt:new Date(date+'T23:45:00-03:00').toISOString(),durationMinutes:90,idempotencyKey:randomUUID()});assert.equal(booked.status,201,JSON.stringify(booked.data));assert.equal(Date.parse(booked.data.endsAt)-Date.parse(booked.data.startsAt),90*60000);
 assert.equal((await request('insights/wallet?from=2020-01-01&to=2020-01-02',account.token)).data.periodEnd,'2020-01-02');assert.equal((await request('insights/wallet?from=2020-02-31&to=2020-03-02',account.token)).status,400);
});
test('care HTTP preserves authentication, private spaces, preview validation and booking conflicts',async()=>{
 const register=async()=>request('auth/register','','POST',{role:'admin',workspaceMode:'solo',name:'Pessoa dos Cuidados',phone:'11999991234',email:randomUUID()+'@test.local',password:'StrongPassword123',confirmPassword:'StrongPassword123'});
 const owner=(await register()).data,other=(await register()).data;
 assert.equal((await request('workspace/care/template')).status,401);
 const bootstrap={catalog:(await request('catalog',owner.token)).data};
 const customer=(await request('workspace/contacts',owner.token,'POST',{idempotencyKey:randomUUID(),name:'Contato HTTP',phone:'11999991234'})).data;
 const startsAt=new Date(Date.now()+4*86400000).toISOString(),endsAt=new Date(Date.parse(startsAt)+3600000).toISOString();
 const booking=await request('appointments',owner.token,'POST',{itemId:bootstrap.catalog[0].id,customerId:customer.id,professionalId:'principal',startsAt});assert.equal(booking.status,201);
 const preview=await request(`workspace/care/appointments/${booking.data.id}/reminder`,owner.token,'POST',{});assert.equal(preview.status,201);assert.equal(preview.data.automatic,false);assert.match(preview.data.message,/Contato HTTP/);
 assert.equal((await request(`workspace/care/appointments/${booking.data.id}/reminder`,owner.token,'POST',{template:'{senha}'})).status,400);
 assert.equal((await request(`workspace/care/appointments/${booking.data.id}/reminder`,other.token,'POST',{})).status,403);
 assert.equal((await request(`workspace/care/customers/${customer.id}`,other.token)).status,404);
 assert.equal((await request('workspace/care/blocks',owner.token,'POST',{idempotencyKey:randomUUID(),professionalId:'principal',title:'Conflito',startsAt,endsAt})).status,409);
 assert.equal((await request(`workspace/care/appointments/${booking.data.id}/missed`,owner.token,'POST',{})).status,400);
 assert.equal((await request('workspace/care/returns',owner.token,'PUT',{customerId:customer.id,itemId:bootstrap.catalog[0].id,professionalId:'principal',intervalDays:30,revision:0})).status,200);
 assert.equal((await request('workspace/care/returns',other.token)).data.length,0);
});
