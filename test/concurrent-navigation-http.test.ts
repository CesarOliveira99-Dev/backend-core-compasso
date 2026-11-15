import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { randomUUID, createHmac } from "node:crypto";
const base = "http://127.0.0.1:4115/v1",
  secret = "test-only-proxy-secret-0123456789abcdef";
let server: ChildProcess,
  output = "";
before(async () => {
  server = spawn(process.execPath, [resolve("dist/main.js")], {
    env: {
      ...process.env,
      PORT: "4115",
      HOST: "127.0.0.1",
      DATABASE_PATH: ":memory:",
      NODE_ENV: "test",
      SEED_DEMO: "false",
      BFF_PROXY_SECRET: secret,
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
  throw new Error(output.slice(-1200));
});
after(() => server?.kill());
function proof(path: string, id: string, method = "GET", time = Date.now()) {
  const t = String(time),
    signature = createHmac("sha256", secret)
      .update(`proxy-v1\n${t}\n${method}\n/v1/${path}\n${id}`)
      .digest("hex");
  return {
    "X-Compasso-Visitor": id,
    "X-Compasso-Proxy-Time": t,
    "X-Compasso-Proxy-Signature": signature,
  };
}
async function request(
  path: string,
  token = "",
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(base + "/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
let accounts: { token: string; user: { id: string; tenantId: string } }[] = [];
test("32 users with four simultaneous six-request tabs do not consume another users budget", async () => {
  for (let i = 0; i < 32; i++) {
    const response = await request("auth/register", "", "POST", {
      role: "admin",
      workspaceMode: "solo",
      name: "Pessoa Simultânea",
      phone: "11999991234",
      email: randomUUID() + "@test.local",
      password: "StrongPassword123",
      confirmPassword: "StrongPassword123",
    });
    assert.equal(response.status, 201);
    accounts.push(await response.json());
  }
  const results = await Promise.all(
    accounts.map(async (a) => {
      const replies = await Promise.all(
        Array.from({ length: 4 }, () =>
          [
            "auth/me",
            "settings",
            "catalog",
            "appointments",
            "notifications",
            "insights/dashboard",
          ].map((p) => request(p, a.token)),
        ).flat(),
      );
      assert.ok(
        replies.every((r) => r.status === 200),
        replies.map((r) => r.status).join(","),
      );
      const actors = await Promise.all(
        [0, 6, 12, 18].map((i) => replies[i].json()),
      );
      assert.ok(actors.every((actor) => actor.id === a.user.id));
      return replies.length;
    }),
  );
  assert.equal(
    results.reduce((s, n) => s + n, 0),
    768,
  );
});
test("exhausting one verified user does not block other users behind the same proxy", async () => {
  const a = accounts[0],
    b = accounts[1];
  const replies = await Promise.all(
    Array.from({ length: 305 }, () => request("appointments", a.token)),
  );
  assert.ok(replies.some((r) => r.status === 429));
  const blocked = replies.find((r) => r.status === 429)!;
  assert.equal(blocked.headers.get("retry-after"), "60");
  const other = await Promise.all(
    Array.from({ length: 30 }, () => request("auth/me", b.token)),
  );
  assert.ok(other.every((r) => r.status === 200));
});
test("anonymous budgets cannot be assigned by raw forwarded headers or forged signatures", async () => {
  const a = "v1:" + "a".repeat(64),
    b = "v1:" + "b".repeat(64),
    body = { email: "none@test.local", password: "WrongPassword123" };
  for (let i = 0; i < 15; i++) {
    const result = await request("auth/login", "", "POST", body, {
      ...proof("auth/login", a, "POST"),
      "X-Forwarded-For": `198.51.100.${i}`,
    });
    assert.equal(result.status, 401);
  }
  const blocked = await request(
    "auth/login",
    "",
    "POST",
    body,
    proof("auth/login", a, "POST"),
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "900");
  assert.equal(
    (
      await request(
        "auth/login",
        "",
        "POST",
        body,
        proof("auth/login", b, "POST"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request("auth/login", "", "POST", body, {
        ...proof("auth/login", a, "POST"),
        "X-Compasso-Visitor": b,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "auth/login",
        "",
        "POST",
        body,
        proof("auth/login", b, "POST", Date.now() - 60000),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        "settings",
        accounts[2].token,
        "GET",
        undefined,
        proof("auth/me", b),
      )
    ).status,
    403,
  );
  assert.equal((await request("auth/me", accounts[2].token)).status, 200);
});
test("simultaneous writes keep one reservation and idempotent retries do not duplicate it", async () => {
  const a = accounts[2],
    at = new Date(Date.now() + 5 * 86400000);
  at.setUTCHours(15, 0, 0, 0);
  const body = {
    idempotencyKey: randomUUID(),
    itemId: "solo-personal",
    customerId: "solo-self",
    professionalId: "principal",
    startsAt: at.toISOString(),
  };
  const same = await Promise.all(
    Array.from({ length: 16 }, () =>
      request("appointments", a.token, "POST", body),
    ),
  );
  assert.ok(same.every((r) => r.status === 201));
  const ids = await Promise.all(same.map((r) => r.json()));
  assert.equal(new Set(ids.map((a) => a.id)).size, 1);
  at.setUTCHours(18, 0, 0, 0);
  const races = await Promise.all(
    Array.from({ length: 16 }, () =>
      request("appointments", a.token, "POST", {
        ...body,
        idempotencyKey: randomUUID(),
        startsAt: at.toISOString(),
      }),
    ),
  );
  assert.equal(races.filter((r) => r.status === 201).length, 1);
  assert.equal(races.filter((r) => r.status === 409).length, 15);
  assert.equal(
    (
      await request(
        "appointments",
        a.token,
        "POST",
        { ...body, idempotencyKey: randomUUID() },
        { "X-Compasso-Workspace": accounts[3].user.tenantId },
      )
    ).status,
    409,
  );
  assert.equal(
    (await (await request("appointments", accounts[3].token)).json()).length,
    0,
  );
  assert.equal(
    (await (await request("appointments", a.token)).json()).length,
    2,
  );
});
