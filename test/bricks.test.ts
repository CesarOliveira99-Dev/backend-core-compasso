import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { BricksCheckout } from '../dist/modules/payments/bricks-checkout.js';
import { PaymentsService } from '../dist/modules/payments/payments.service.js';

process.env.DATABASE_PATH = ':memory:';
process.env.PAYMENTS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.PUBLIC_API_URL = 'https://api.example.test/v1';
process.env.MP_SANDBOX = 'true';
const actor = { id: 'buyer', tenantId: 'store-a', role: 'customer' as const,
  name: 'Buyer', email: 'buyer@example.test', phone: '11999999999' };
const credentials = async () => ({ accessToken: 'seller-secret', publicKey: 'public-seller', sellerId: '123' });
const formData = { token: 'tokenized-card', installments: 1, payment_method_id: 'visa',
  payer: { email: actor.email, identification: { type: 'CPF', number: '12345678909' } } };
function fixture() {
  const repo = new DocumentRepository();
  const context = new Context(repo);
  const bricks = new BricksCheckout(context, credentials);
  const order = { id: 'order', customerId: actor.id, totalCents: 1250, status: 'pending',
    paymentStatus: 'pending', paymentMethod: 'online', items: [{ name: 'Corte', quantity: 1, unitPriceCents: 1500 }] };
  repo.put(actor.tenantId, 'orders', 'order', order);
  repo.put(actor.tenantId, 'appointments', 'appointment', { id: 'appointment', orderId: 'order', status: 'confirmed', paymentStatus: 'pending' });
  return { repo, context, bricks, order };
}
function payment(changes = {}) {
  return { id: 42, collector_id: 123, external_reference: 'store-a:order', transaction_amount: 12.5,
    currency_id: 'BRL', live_mode: false, status: 'approved', ...changes };
}

test('Bricks uses the stored discounted total and seller token, strips client overrides and settles appointments once', async t => {
  const { repo, bricks } = fixture();
  const session = await bricks.prepare(actor, 'order');
  assert.equal(session.publicKey, 'public-seller');
  assert.ok(!JSON.stringify(session).includes('seller-secret'));
  let count = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    count++;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer seller-secret');
    assert.equal(headers['X-Idempotency-Key'], session.attemptId);
    const body = JSON.parse(String(init.body));
    assert.equal(body.transaction_amount, 12.5);
    assert.equal(body.external_reference, 'store-a:order');
    assert.equal(body.notification_url, 'https://api.example.test/v1/payments/webhook');
    assert.equal(body.collector_id, undefined);
    assert.equal(body.payer.access_token, undefined);
    return Response.json(payment());
  });
  const body = { attemptId: session.attemptId, formData: { ...formData, transaction_amount: .01, collector_id: 999,
    payer: { ...formData.payer, access_token: 'attacker' } } };
  await bricks.pay(actor, 'order', body);
  await assert.rejects(() => bricks.pay(actor, 'order', body));
  assert.equal(count, 1);
  assert.equal(repo.get<any>(actor.tenantId, 'orders', 'order').paymentStatus, 'paid');
  assert.equal(repo.get<any>(actor.tenantId, 'appointments', 'appointment').paymentStatus, 'paid');
  assert.equal(repo.get<any>(actor.tenantId, 'brick_attempts', 'order').encryptedRequest, undefined);
  assert.equal((await bricks.status(actor, 'order')).paid, true);
});

test('Bricks authorization, triage and cancellations prevent provider calls or attempts', async t => {
  const { repo, bricks, order } = fixture();
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  await assert.rejects(() => bricks.prepare({ ...actor, id: 'other' }, 'order'));
  await assert.rejects(() => bricks.status({ ...actor, tenantId: 'store-b' }, 'order'));
  repo.put(actor.tenantId, 'triage', 'triage', { orderId: 'order', status: 'pending' });
  await assert.rejects(() => bricks.prepare(actor, 'order'));
  repo.remove(actor.tenantId, 'triage', 'triage');
  repo.put(actor.tenantId, 'orders', 'order', { ...order, status: 'cancelled' });
  await assert.rejects(() => bricks.prepare(actor, 'order'));
  assert.equal(repo.list(actor.tenantId, 'brick_attempts').length, 0);
  assert.equal(mock.mock.calls.length, 0);
});

test('lost response is recovered with exactly the same encrypted request and idempotency key after restart', async t => {
  const { repo, context, bricks } = fixture();
  const session = await bricks.prepare(actor, 'order');
  const calls: { body: string; key: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls.push({ body: String(init.body), key: (init.headers as Record<string, string>)['X-Idempotency-Key'] });
    if (calls.length === 1) throw new Error('response lost');
    return Response.json(payment({ status: 'pending' }));
  });
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
  const persisted = repo.get<any>(actor.tenantId, 'brick_attempts', 'order');
  assert.ok(persisted.encryptedRequest);
  assert.ok(!JSON.stringify(persisted).includes('tokenized-card'));
  const restarted = new BricksCheckout(context, credentials);
  assert.equal((await restarted.prepare(actor, 'order')).attemptId, session.attemptId);
  await restarted.pay(actor, 'order', { attemptId: session.attemptId, formData: { ...formData, token: 'different-token' } });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(repo.get<any>(actor.tenantId, 'orders', 'order').paymentStatus, 'pending');
  assert.equal((await restarted.prepare(actor, 'order')).attemptId, session.attemptId);
});

test('parallel submits cannot create two charges and stale attempt IDs cannot overwrite a retry', async t => {
  const { bricks } = fixture();
  const session = await bricks.prepare(actor, 'order');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let called!: () => void;
  const entered = new Promise<void>(resolve => { called = resolve; });
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    called(); await gate; return Response.json(payment({ status: 'rejected' }));
  });
  const submit = bricks.pay(actor, 'order', { attemptId: session.attemptId, formData });
  await entered;
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
  release(); await submit;
  const next = await bricks.prepare(actor, 'order');
  assert.notEqual(next.attemptId, session.attemptId);
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
  assert.equal(mock.mock.calls.length, 1);
});

test('Pix pending keeps the order unpaid and server status confirms approval without trusting the browser', async t => {
  const { repo, bricks } = fixture();
  const session = await bricks.prepare(actor, 'order');
  const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.payment_method_id, 'pix');
    assert.equal(body.token, undefined);
    return Response.json(payment({ status: 'pending' }));
  });
  const response = await bricks.pay(actor, 'order', { attemptId: session.attemptId,
    formData: { payment_method_id: 'pix', payer: { email: actor.email } } });
  assert.equal(response?.paymentId, '42');
  assert.equal(repo.get<any>(actor.tenantId, 'orders', 'order').paymentStatus, 'pending');
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async (url: unknown) => {
    assert.equal(url, 'https://api.mercadopago.com/v1/payments/42');
    return Response.json(payment());
  });
  assert.equal((await bricks.status(actor, 'order')).paid, true);
});

test('wrong merchant, amount, environment, currency or order never settles money', async t => {
  for (const override of [{ collector_id: 999 }, { transaction_amount: 1 }, { live_mode: true },
    { currency_id: 'USD' }, { external_reference: 'store-a:another-order' }]) {
    const { repo, bricks } = fixture();
    const session = await bricks.prepare(actor, 'order');
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(payment(override)));
    await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
    assert.equal(repo.get<any>(actor.tenantId, 'orders', 'order').paymentStatus, 'pending');
    assert.equal(repo.list(actor.tenantId, 'settlements').length, 0);
    mock.mock.restore();
  }
});

test('malformed input and changed order totals are rejected before a charge', async t => {
  const { repo, bricks, order } = fixture();
  const session = await bricks.prepare(actor, 'order');
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData: { ...formData, token: undefined } }));
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData, paymentStatus: 'paid' }));
  repo.put(actor.tenantId, 'orders', 'order', { ...order, totalCents: 2000 });
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
  assert.equal(mock.mock.calls.length, 0);
});

test('existing Pro links and new Bricks sessions cannot produce competing payment routes', async t => {
  const { repo, bricks, context } = fixture();
  repo.put(actor.tenantId, 'checkout_links', 'order', { url: 'https://www.mercadopago.com.br/old' });
  const session = await bricks.prepare(actor, 'order');
  assert.equal(session.legacyUrl, 'https://www.mercadopago.com.br/old');
  assert.equal(repo.list(actor.tenantId, 'brick_attempts').length, 0);
  repo.remove(actor.tenantId, 'checkout_links', 'order');
  await bricks.prepare(actor, 'order');
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  await assert.rejects(() => new PaymentsService(context).checkout(actor, 'order'));
  assert.equal(mock.mock.calls.length, 0);
});

test('uncertain requests older than the recovery window never replay a charge', async t => {
  const { repo, bricks } = fixture();
  const session = await bricks.prepare(actor, 'order');
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('lost'); });
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
  const attempt = repo.get<any>(actor.tenantId, 'brick_attempts', 'order');
  repo.put(actor.tenantId, 'brick_attempts', 'order', { ...attempt, submittedAt: Date.now() - 11 * 60_000 });
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId }));
  assert.equal(mock.mock.calls.length, 1);
});

test('provider validation errors permit corrected input while transport errors remain locked', async t => {
  const { bricks } = fixture();
  const session = await bricks.prepare(actor, 'order');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_token' }, { status: 400 }));
  await assert.rejects(() => bricks.pay(actor, 'order', { attemptId: session.attemptId, formData }));
  assert.notEqual((await bricks.prepare(actor, 'order')).attemptId, session.attemptId);
});
