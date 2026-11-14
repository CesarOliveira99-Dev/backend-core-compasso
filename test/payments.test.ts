import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { encrypt, decrypt, validSignature } from '../dist/modules/payments/payment-security.js';
import { PaymentsService } from '../dist/modules/payments/payments.service.js';

process.env.DATABASE_PATH = ':memory:';
process.env.PAYMENTS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.MP_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.MP_SANDBOX = 'true';
function signature(id: string, ts = String(Date.now())) {
  const v1 = createHmac('sha256', process.env.MP_WEBHOOK_SECRET!)
    .update(`id:${id};request-id:request;ts:${ts};`)
    .digest('hex');
  return `ts=${ts},v1=${v1}`;
}
const actor = {
  id: 'owner',
  tenantId: 'store-a',
  role: 'admin' as const,
  name: 'Owner',
  email: 'owner@test.local',
  phone: '5511999999999',
};
test('subscription update rejection logs a safe provider reason without exposing personal data', async t => {
  const service = new PaymentsService(new Context(new DocumentRepository()));
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { message: 'Invalid status transition', cause: [{ message: 'payer owner@test.local' }] },
    { status: 400, headers: { 'x-request-id': 'request-123' } },
  ));
  await assert.rejects(() => service.call('/preapproval/sub', 'test-token', { status: 'canceled' }, undefined, 'PUT'),
    /HTTP 400/);
  assert.deepEqual(warnings[0]?.[1], {
    status: 400, code: null, message: null, fields: ['message', 'cause'], method: 'PUT', resource: 'preapproval', requestId: 'request-123',
  });
  assert.ok(!JSON.stringify(warnings).includes('owner@test.local'));
});
test('payment secrets are encrypted and tampering fails; webhook requires valid recent signature', () => {
  const secret = { access_token: 'private-token' };
  const sealed = encrypt(secret);
  assert.ok(!sealed.includes(secret.access_token));
  assert.deepEqual(decrypt(sealed), secret);
  const changed = Buffer.from(sealed, 'base64');
  changed[30] ^= 1;
  assert.throws(() => decrypt(changed.toString('base64')));
  assert.equal(
    validSignature('42', 'request', signature('42'), process.env.MP_WEBHOOK_SECRET!),
    true,
  );
  assert.equal(
    validSignature('43', 'request', signature('42'), process.env.MP_WEBHOOK_SECRET!),
    false,
  );
  assert.equal(
    validSignature('42', 'request', signature('42', '100'), process.env.MP_WEBHOOK_SECRET!),
    false,
  );
  assert.equal(
    validSignature('42', 'request', 'ts=1,v1=bad', process.env.MP_WEBHOOK_SECRET!),
    false,
  );
});
test('billing stays disabled until explicitly enabled; catalog is always visible to the owner', () => {
  delete process.env.COMPASSO_SUBSCRIPTIONS_ENABLED;
  const status = new PaymentsService(new Context(new DocumentRepository())).status(actor);
  assert.equal(status.billingEnabled, false);
  assert.deepEqual(status.plans.map(plan => plan.priceCents), [5990, 7990, 9990]);
});
test('verified API data settles only the correct merchant/order/amount, deduplicates and handles refunds', async (t) => {
  const repo = new DocumentRepository();
  const service = new PaymentsService(new Context(repo));
  repo.put('store-a', 'payment_connections', 'mercadopago', {
    userId: '123',
    encrypted: encrypt({ access_token: 'test-token' }),
    expiresAt: Date.now() + 1000000,
  });
  repo.put('__compasso_payments__', 'merchants', '123', { tenantId: 'store-a' });
  const order = {
    id: 'order',
    customerId: 'buyer',
    paymentMethod: 'online',
    totalCents: 1000,
    status: 'pending',
    paymentStatus: 'pending',
  };
  repo.put('store-a', 'orders', 'order', order);
  repo.put('store-b', 'orders', 'order', order);
  repo.put('store-a', 'appointments', 'appt', {
    id: 'appt',
    orderId: 'order',
    status: 'confirmed',
    paymentStatus: 'pending',
  });
  const payment = {
    id: 42,
    collector_id: 123,
    external_reference: 'store-a:order',
    status: 'approved',
    transaction_amount: 10,
    currency_id: 'BRL',
    live_mode: false,
  };
  const mock = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(String(url), 'https://api.mercadopago.com/v1/payments/42');
    return Response.json(payment);
  });
  const webhook = () =>
    service.webhook('42', 'request', signature('42'), { type: 'payment', user_id: 123 });
  await assert.rejects(() =>
    service.webhook('42', 'request', 'invalid', { type: 'payment', user_id: 123 }),
  );
  assert.equal(mock.mock.calls.length, 0);
  payment.transaction_amount = 11;
  await assert.rejects(webhook);
  assert.equal(repo.get<any>('store-a', 'orders', 'order').paymentStatus, 'pending');
  payment.transaction_amount = 10;
  payment.collector_id = 456;
  await assert.rejects(webhook);
  payment.collector_id = 123;
  payment.external_reference = 'store-b:order';
  await assert.rejects(webhook);
  payment.external_reference = 'store-a:order';
  await webhook();
  await webhook();
  assert.equal(repo.get<any>('store-a', 'orders', 'order').paymentStatus, 'paid');
  assert.equal(repo.get<any>('store-b', 'orders', 'order').paymentStatus, 'pending');
  assert.equal(repo.get<any>('store-a', 'appointments', 'appt').paymentStatus, 'paid');
  assert.equal(repo.list('store-a', 'payment_events').length, 1);
  payment.status = 'refunded';
  await webhook();
  assert.equal(repo.get<any>('store-a', 'orders', 'order').paymentStatus, 'pending');
  assert.equal(repo.get<any>('store-a', 'appointments', 'appt').paymentStatus, 'pending');
});
test('customer cannot connect accounts or subscribe, nor pay another customers order', async () => {
  const repo = new DocumentRepository();
  const service = new PaymentsService(new Context(repo));
  const customer = { ...actor, role: 'customer' as const, id: 'buyer' };
  repo.put(actor.tenantId, 'orders', 'private', { customerId: 'other' });
  await assert.rejects(() => service.connect(customer));
  await assert.rejects(() => service.subscribe(customer, { planId: 'essencial' }));
  await assert.rejects(() => service.checkout(customer, 'private'));
});
test('OAuth uses random state and PKCE; state cannot be replayed', async (t) => {
  process.env.MP_CLIENT_ID = 'app';
  process.env.MP_CLIENT_SECRET = 'secret';
  process.env.PUBLIC_API_URL = 'https://api.example.test/v1';
  process.env.APP_URL = 'https://example.test';
  const repo = new DocumentRepository();
  const service = new PaymentsService(new Context(repo));
  const url = new URL((await service.connect(actor)).url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://api.example.test/v1/payments/callback',
  );
  const state = url.searchParams.get('state')!;
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      access_token: 'test',
      refresh_token: 'refresh',
      user_id: 123,
      expires_in: 3600,
    }),
  );
  assert.equal(
    await service.callback(state, 'code'),
    'https://example.test/?payment_connection=success',
  );
  assert.equal(service.status(actor).connected, true);
  assert.ok(!JSON.stringify(service.status(actor)).includes('refresh'));
  await assert.rejects(() => service.callback(state, 'code'));
});

