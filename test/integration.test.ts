import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const base = 'http://127.0.0.1:4107/v1';
const mediaPath = mkdtempSync(resolve(tmpdir(), 'compasso-media-test-'));
let server: ChildProcess;
let output = '';
let readinessError: unknown;
before(async () => {
  server = spawn(process.execPath, [resolve('dist/main.js')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      DATABASE_PATH: ':memory:',
      PORT: '4107',
      MEDIA_PATH: mediaPath,
      SEED_DEMO: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (data) => (output += data.toString()));
  server.stderr?.on('data', (data) => (output += data.toString()));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/auth/me`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 401) return;
      readinessError = new Error(`Readiness returned HTTP ${response.status}; expected 401.`);
    } catch (error) {
      readinessError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Test API did not become reachable at ${base}. Check local network permissions and server output: ${output.slice(-3000)}`,
    { cause: readinessError },
  );
});
after(() => {
  server?.kill();
  if (mediaPath.startsWith(resolve(tmpdir(), 'compasso-media-test-')))
    rmSync(mediaPath, { recursive: true, force: true });
});
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
      confirmPassword: 'SecureTest!42',
      name: `${role} test`,
      phone: '5511999999999',
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  };
  const admin = await register('alpha', 'admin', 'admin@alpha.test');
  await t.test('personal customer HTTP session works without a shop and cannot bypass store authorization', async () => {
    const personal = await request('auth/register', '', 'POST', {
      name:'Personal Client', email:'personal@fixture.test', phone:'5511999999999',
      role:'customer', password:'SecureTest!42', confirmPassword:'SecureTest!42',
      tenantId:admin.user.tenantId, storeSelected:true,
    });
    assert.equal(personal.status,201,JSON.stringify(personal.data));
    assert.equal(personal.data.user.storeSelected,false);
    assert.notEqual(personal.data.user.tenantId,admin.user.tenantId);
    assert.equal((await request('customers/profile',personal.data.token)).data.email,'personal@fixture.test');
    for (const path of ['settings','catalog','appointments','orders','customers','auth/team'])
      assert.equal((await request(path,personal.data.token)).status,403,path);
    assert.equal((await request('appointments',personal.data.token,'POST',{})).status,403);
    assert.equal((await request('auth/team/invite',personal.data.token,'POST',{})).status,403);
    assert.equal((await request('auth/discovery',personal.data.token)).status,200);
    assert.equal((await request('customers',admin.token)).data.some((user:any)=>user.email==='personal@fixture.test'),false);
    const entered=await request('auth/switch-store',personal.data.token,'POST',{slug:'alpha',role:'admin'});
    assert.equal(entered.status,201);
    assert.equal(entered.data.user.role,'customer');
    assert.equal(entered.data.user.storeSelected,true);
    assert.equal(entered.data.user.tenantId,admin.user.tenantId);
    assert.equal((await request('auth/switch-store',personal.data.token,'POST',{slug:'alpha'})).data.user.id,entered.data.user.id);
    assert.equal((await request('auth/login','','POST',{email:'personal@fixture.test',password:'SecureTest!42'})).data.user.id,personal.data.user.id);
  });
  await t.test(
    'password registration requires a matching confirmation before creating an account',
    async () => {
      const registration = {
        slug: 'confirm-test',
        role: 'admin',
        email: 'confirmation@test.local',
        name: 'Confirmation Test',
        phone: '5518999999999',
        password: 'SecureTest!42',
      };
      assert.equal((await request('auth/register', '', 'POST', registration)).status, 400);
      const mismatch = await request('auth/register', '', 'POST', {
        ...registration,
        confirmPassword: 'Different!42',
      });
      assert.equal(mismatch.status, 400);
      assert.match(mismatch.data.message, /senhas não coincidem/);
      const valid = await request('auth/register', '', 'POST', {
        ...registration,
        confirmPassword: registration.password,
      });
      assert.equal(valid.status, 201);
      assert.equal('confirmPassword' in valid.data.user, false);
    },
  );
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
  await t.test('public storefront exposes only active catalog and public profile, while booking requires login', async () => {
    const inactive = await request('catalog', admin.token, 'POST', {
      name: 'Private draft', kind: 'service', category: 'Care', priceCents: 999,
      durationMinutes: 30, active: false,
    });
    assert.equal(inactive.status, 201);
    const preview = await request('auth/store/alpha');
    assert.equal(preview.status, 200);
    assert.equal(preview.data.store.slug, 'alpha');
    assert.deepEqual(Object.keys(preview.data.professionals[0]).sort(), ['id','name','serviceIds']);
    assert.equal(preview.data.professionals[0].name, 'admin test');
    assert.equal(preview.data.reputation.summary.count, 0);
    assert.deepEqual(preview.data.reputation.reviews, []);
    assert.deepEqual(preview.data.catalog.map((item: {id:string}) => item.id).sort(), [service.id, product.id].sort());
    for (const key of ['bankAccount', 'pixKey', 'tenantId', 'name', 'payment_connections'])
      assert.equal(key in preview.data.store, false, key);
    assert.equal((await request('auth/store/beta')).data.catalog.length, 0);
    assert.equal((await request('auth/store/missing-store')).status, 404);
    assert.equal((await request('appointments', '', 'POST', {itemId:service.id})).status, 401);
  });
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
    'availability requires authentication, exposes only free slots and validates reschedule ownership',
    async () => {
      const path = `appointments/availability?itemId=${service.id}&professionalId=principal&date=${date}`;
      assert.equal((await request(path)).status, 401);
      const available = await request(path, otherClient.token);
      assert.equal(available.status, 200);
      assert.equal(
        available.data.slots.some((slot: { startsAt: string }) => slot.startsAt === startsAt),
        false,
      );
      assert.equal(JSON.stringify(available.data).includes(client.user.id), false);
      assert.equal(
        (await request(`${path}&appointmentId=${booked.data.id}`, otherClient.token)).status,
        403,
      );
      const own = await request(`${path}&appointmentId=${booked.data.id}`, client.token);
      assert.equal(own.status, 200);
      assert.ok(own.data.slots.some((slot: { startsAt: string }) => slot.startsAt === startsAt));
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
    'manual Pix preserves the key on the order and only an admin confirms receipt',
    async () => {
      const settings = (await request('settings', admin.token)).data;
      const updated = await request('settings', admin.token, 'PATCH', {
        ...settings,
        pixKey: 'merchant@example.test',
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.data.manualPixEnabled, true);
      assert.equal((await request('settings', client.token)).data.manualPixEnabled, true);
      const response = await request('orders', client.token, 'POST', {
        items: [{ itemId: product.id, quantity: 1 }],
        paymentMethod: 'pix_manual',
        idempotencyKey: randomUUID(),
      });
      assert.equal(response.status, 201);
      assert.equal(response.data.pixKey, 'merchant@example.test');
      assert.equal(response.data.paymentStatus, 'pending');
      assert.equal(
        (
          await request(`orders/${response.data.id}`, client.token, 'PATCH', {
            paymentStatus: 'paid',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request(`orders/${response.data.id}`, admin.token, 'PATCH', {
            paymentStatus: 'paid',
          })
        ).status,
        200,
      );
      assert.equal((await request('payments/status', client.token)).status, 403);
      assert.equal((await request('payments/status', admin.token)).data.billingEnabled, false);
      assert.equal((await request('payments/subscribe', admin.token, 'POST', {})).status, 400);
      assert.equal((await request('health')).status, 200);
    },
  );
  await t.test(
    'store media upload validates type, permissions, ownership and persists both store and service galleries',
    async () => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0sAAAAASUVORK5CYII=',
        'base64',
      );
      async function upload(token: string, buffer: Buffer, type: string) {
        const body = new FormData();
        body.set('file', new Blob([buffer], { type }), 'photo.png');
        return fetch(`${base}/media`, {
          method: 'POST',
          body,
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      }
      assert.equal((await upload('', png, 'image/png')).status, 401);
      assert.equal((await upload(client.token, png, 'image/png')).status, 403);
      assert.equal(
        (await upload(admin.token, Buffer.from('<script>alert(1)</script>'), 'image/png')).status,
        400,
      );
      const response = await upload(admin.token, png, 'image/png');
      assert.equal(response.status, 201);
      const asset = { ...(await response.json()), category: 'portfolio' };
      const image = await fetch(`${base}/${asset.url.replace('/api/', '')}`);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
      const current = (await request('settings', admin.token)).data;
      const address = {
        postalCode: '19806060',
        street: 'Rua Teste',
        number: '274',
        district: 'Centro',
        city: 'Assis',
        state: 'SP',
        complement: '',
      };
      const updated = await request('settings', admin.token, 'PATCH', {
        ...current,
        address,
        phone: '18999999999',
        media: [asset],
        setupComplete: true,
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.data));
      assert.equal(updated.data.setupComplete, true);
      const publicSettings = (await request('settings', client.token)).data;
      assert.equal(publicSettings.address.city, 'Assis');
      assert.equal(publicSettings.media[0].url, asset.url);
      assert.equal(publicSettings.media[0].category, 'portfolio');
      assert.equal(
        (
          await request('settings', admin.token, 'PATCH', {
            ...updated.data,
            media: [{ ...asset, category: 'invalid' }],
          })
        ).status,
        400,
      );
      assert.equal('bankAccount' in publicSettings, false);
      assert.ok(publicSettings.ratingCount > 0);
      assert.equal('customerName' in publicSettings, false);
      assert.equal(
        (
          await request(`catalog/${service.id}`, admin.token, 'PATCH', {
            ...service,
            media: [asset],
          })
        ).status,
        200,
      );
      const otherSettings = (await request('settings', outsider.token)).data;
      assert.equal(
        (await request('settings', outsider.token, 'PATCH', { ...otherSettings, media: [asset] }))
          .status,
        400,
      );
      assert.equal(
        (
          await request('settings', admin.token, 'PATCH', {
            ...current,
            address: { ...address, state: 'XX' },
          })
        ).status,
        400,
      );
    },
  );
  await t.test(
    'store reputation is tenant-scoped, paginated and does not publish old private comments or accept badge overrides',
    async () => {
      assert.equal((await request('feedback/store')).status, 401);
      assert.equal((await request('feedback/store?page=0', client.token)).status, 400);
      const reputation = await request('feedback/store', client.token);
      const publicReputation = (await request('auth/store/alpha')).data.reputation;
      assert.deepEqual(publicReputation, reputation.data);
      assert.equal(reputation.status, 200);
      assert.ok(reputation.data.summary.count > 0);
      assert.equal(reputation.data.reviews.length, 0);
      assert.equal(reputation.data.recommendation.active, false);
      assert.equal((await request('feedback/store', outsider.token)).data.summary.count, 0);
      const current = (await request('settings', admin.token)).data;
      assert.equal(
        (
          await request('settings', admin.token, 'PATCH', {
            ...current,
            recommendation: { active: true },
            paidAddonActive: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (await request('feedback/store', client.token)).data.recommendation.paidAddonActive,
        false,
      );
    },
  );
  await t.test(
    'online checkout requires a connected account and customer settings omit bank details',
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
  await t.test('employee HTTP access is scoped, cannot manage prices or payments, can notify own clients and is immediately revocable',async()=>{
    const invitation=await request('auth/team/invite',admin.token,'POST',{});assert.equal(invitation.status,201);
    const registration=await request('auth/invite/register','','POST',{token:invitation.data.token,name:'Worker HTTP',email:'worker-http@fixture.test',phone:'18999990000',password:'WorkerHttp123!',confirmPassword:'WorkerHttp123!',role:'admin'});assert.equal(registration.status,201,JSON.stringify(registration.data));const worker=registration.data;
    assert.equal(worker.user.role,'employee');
    for(const path of ['customers','orders','insights/wallet','payments/status','auth/team'])assert.equal((await request(path,worker.token)).status,403,path);
    assert.equal((await request('catalog/'+service.id,worker.token,'PATCH',{priceCents:1})).status,403);
    assert.equal((await request('professionals/principal',worker.token,'PATCH',{})).status,403);
    const newClient=await register('alpha','customer','employee-client@fixture.test');
    const startsAt=new Date(`${date}T16:00:00-03:00`).toISOString();const appointment=await request('appointments',newClient.token,'POST',{itemId:service.id,professionalId:worker.user.professionalId,startsAt});assert.equal(appointment.status,201);
    const agenda=await request('appointments',worker.token);assert.deepEqual(agenda.data.map((item:any)=>item.id),[appointment.data.id]);
    assert.equal((await request('appointments/'+booked.data.id,worker.token,'PATCH',{status:'cancelled'})).status,403);
    assert.equal((await request('appointments/'+appointment.data.id,worker.token,'PATCH',{paymentStatus:'paid'})).status,403);
    assert.equal((await request('notifications/message',worker.token,'POST',{customerId:otherClient.user.id,title:'Hello',message:'Own only'})).status,403);
    assert.equal((await request('notifications/message',worker.token,'POST',{customerId:newClient.user.id,title:'Horário',message:'Seu atendimento está confirmado.'})).status,201);
    assert.equal((await request('appointments/'+appointment.data.id,worker.token,'PATCH',{status:'completed'})).status,200);
    await request('auth/team/'+worker.user.id,admin.token,'PATCH',{active:false});assert.equal((await request('auth/me',worker.token)).status,401);
  });

});
