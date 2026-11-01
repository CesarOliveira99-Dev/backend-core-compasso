import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const base = 'http://127.0.0.1:4107/v1';
let server: ChildProcess;
let output = '';
before(async () => {
  server = spawn(process.execPath, [resolve('dist/main.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_PATH: ':memory:',
      PORT: '4107',
      SEED_DEMO: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (data) => (output += data.toString()));
  server.stderr?.on('data', (data) => (output += data.toString()));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/auth/me`)).status === 401) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start: ${output.slice(-3000)}`);
});
after(() => server?.kill());
async function request(path: string, token = '', method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
test('isolated business lifecycle preserves access, scheduling, money, discounts and idempotency', async (t) => {
  const register = async (slug: string, role: string, email: string) => {
    const response = await request('auth/register', '', 'POST', {
      slug,
      role,
      email,
      password: 'SecureTest!42',
      name: `${role} test`,
      phone: '5511999999999',
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  const admin = await register('alpha', 'admin', 'admin@alpha.test');
  const outsider = await register('beta', 'admin', 'admin@beta.test');
  const client = await register('alpha', 'customer', 'client@alpha.test');
  const otherClient = await register('alpha', 'customer', 'other@alpha.test');
  const serviceResponse = await request('catalog', admin.token, 'POST', {
    name: 'Service',
    kind: 'service',
    category: 'Care',
    priceCents: 10000,
    durationMinutes: 60,
    active: true,
  });
  const productResponse = await request('catalog', admin.token, 'POST', {
    name: 'Product',
    kind: 'product',
    category: 'Care',
    priceCents: 2000,
    durationMinutes: 0,
    active: true,
  });
  assert.equal(serviceResponse.status, 201);
  assert.equal(productResponse.status, 201);
  const service = serviceResponse.data;
  const product = productResponse.data;
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const startsAt = new Date(`${date}T10:00:00-03:00`).toISOString();
  const booked = await request('appointments', client.token, 'POST', {
    itemId: service.id,
    startsAt,
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  await t.test(
    'unauthenticated, customer administration and cross-tenant writes are denied',
    async () => {
      assert.equal((await request('customers')).status, 401);
      assert.equal((await request('customers', client.token)).status, 403);
      assert.equal(
        (
          await request(`appointments/${booked.data.id}`, outsider.token, 'PATCH', {
            status: 'completed',
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request(`appointments/${booked.data.id}`, client.token, 'PATCH', {
            paymentStatus: 'paid',
          })
        ).status,
        403,
      );
      assert.equal((await request('appointments', otherClient.token)).data.length, 0);
      assert.equal((await request('catalog', outsider.token)).data.length, 0);
    },
  );
  await t.test(
    'overlap is blocked atomically, including conflicting lines inside one checkout',
    async () => {
      assert.equal(
        (await request('appointments', otherClient.token, 'POST', { itemId: service.id, startsAt }))
          .status,
        409,
      );
      const nextDate = new Date(`${date}T14:00:00-03:00`).toISOString();
      const failed = await request('orders', client.token, 'POST', {
        items: [
          { itemId: service.id, quantity: 1, startsAt: nextDate },
          { itemId: service.id, quantity: 1, startsAt: nextDate },
        ],
        paymentMethod: 'on_day',
        idempotencyKey: randomUUID(),
      });
      assert.equal(failed.status, 409);
      assert.equal(
        (await request('appointments', client.token)).data.length,
        1,
        'failed multi-line checkout must roll back every reservation',
      );
    },
  );
  await t.test(
    'completion does not imply payment; feedback and loyalty unlock afterward',
    async () => {
      assert.equal(
        (
          await request('feedback', client.token, 'POST', {
            appointmentId: booked.data.id,
            rating: 5,
            comment: 'Great care',
          })
        ).status,
        400,
      );
      const finished = await request(`appointments/${booked.data.id}`, admin.token, 'PATCH', {
        status: 'completed',
      });
      assert.equal(finished.data.status, 'completed');
      assert.equal(finished.data.paymentStatus, 'pending');
      assert.equal(
        (
          await request('feedback', client.token, 'POST', {
            appointmentId: booked.data.id,
            rating: 5,
            comment: 'Great care',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request('feedback', client.token, 'POST', {
            appointmentId: booked.data.id,
            rating: 5,
            comment: 'Duplicate',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request('loyalty', client.token, 'POST', {
            itemId: service.id,
            nextDate: date,
            note: 'Return',
          })
        ).status,
        201,
      );
    },
  );
  await request('customers/addresses', client.token, 'POST', {
    label: 'Home',
    street: 'Test street',
    number: '10',
    city: 'São Paulo',
    postalCode: '01310100',
    isDefault: true,
  });
  const dates = {
    startsAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  await request('discounts/promotions', admin.token, 'POST', {
    name: 'Season',
    percent: 5,
    ...dates,
  });
  await request('discounts/coupons', admin.token, 'POST', {
    name: 'Welcome',
    code: 'WELCOME',
    percent: 10,
    maxUses: 1,
    ...dates,
  });
  const checkout = {
    items: [{ itemId: product.id, quantity: 1 }],
    paymentMethod: 'on_day',
    coupon: 'WELCOME',
    idempotencyKey: randomUUID(),
  };
  await t.test(
    'quotes do not redeem; checkout applies best discount and retry cannot duplicate',
    async () => {
      const quote = await request('orders/quote', client.token, 'POST', checkout);
      assert.equal(quote.status, 201, JSON.stringify(quote.data));
      assert.equal(quote.data.totalCents, 1800);
      assert.equal((await request('discounts/coupons', admin.token)).data[0].uses, 0);
      const order = await request('orders', client.token, 'POST', checkout);
      assert.equal(order.status, 201);
      assert.equal(order.data.totalCents, 1800);
      assert.equal(order.data.discountCents, 200);
      assert.equal(
        (await request('orders', client.token, 'POST', checkout)).data.id,
        order.data.id,
      );
      assert.equal((await request('orders', client.token)).data.length, 1);
      assert.equal((await request('discounts/coupons', admin.token)).data[0].uses, 1);
      assert.equal(
        (
          await request('orders', client.token, 'POST', {
            ...checkout,
            idempotencyKey: randomUUID(),
          })
        ).status,
        400,
      );
      await request(`orders/${order.data.id}`, admin.token, 'PATCH', {
        status: 'completed',
        paymentStatus: 'paid',
      });
      const wallet = await request('insights/wallet?days=30', admin.token);
      assert.equal(wallet.data.earnedCents, 11800);
      assert.equal(wallet.data.receivedCents, 1800);
      assert.equal(wallet.data.unpaidCents, 10000);
    },
  );
  await t.test('product triage blocks fulfillment until an admin decision', async () => {
    const item = await request('catalog', admin.token, 'POST', {
      name: 'Personalized product',
      kind: 'product',
      category: 'Care',
      priceCents: 1500,
      durationMinutes: 0,
      requiresTriage: true,
      active: true,
    });
    const order = await request('orders', client.token, 'POST', {
      items: [
        { itemId: item.data.id, quantity: 1, notes: 'I need a personalized recommendation.' },
      ],
      paymentMethod: 'on_day',
      idempotencyKey: randomUUID(),
    });
    assert.equal(order.status, 201, JSON.stringify(order.data));
    assert.equal(
      (await request(`orders/${order.data.id}`, admin.token, 'PATCH', { status: 'completed' }))
        .status,
      400,
    );
    const triage = (await request('triage', admin.token)).data.find(
      (entry: { orderId: string }) => entry.orderId === order.data.id,
    );
    assert.equal(
      (
        await request(`triage/${triage.id}`, client.token, 'PATCH', {
          status: 'approved',
          decision: 'Approved',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`triage/${triage.id}`, admin.token, 'PATCH', {
          status: 'approved',
          decision: 'We can fulfill this request.',
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(`orders/${order.data.id}`, admin.token, 'PATCH', { status: 'completed' }))
        .status,
      200,
    );
  });
  await t.test('a changed quoted total cannot be confirmed silently', async () => {
    const response = await request('orders', client.token, 'POST', {
      items: [{ itemId: product.id, quantity: 1 }],
      paymentMethod: 'on_day',
      idempotencyKey: randomUUID(),
      expectedTotalCents: 1,
    });
    assert.equal(response.status, 400);
  });
  await t.test(
    'online checkout stays disabled and customer settings omit bank details',
    async () => {
      assert.equal(
        (
          await request('orders', client.token, 'POST', {
            ...checkout,
            coupon: undefined,
            paymentMethod: 'online',
            idempotencyKey: randomUUID(),
          })
        ).status,
        400,
      );
      const settings = (await request('settings', client.token)).data;
      assert.equal(settings.onlinePaymentsEnabled, false);
      assert.equal('bankAccount' in settings, false);
      assert.equal('pixKey' in settings, false);
      await request('auth/logout', client.token, 'POST', {});
      assert.equal((await request('auth/me', client.token)).status, 401);
    },
  );
});
