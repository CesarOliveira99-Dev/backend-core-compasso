import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { SubscriptionBilling } from '../dist/modules/payments/subscription-billing.js';

process.env.DATABASE_PATH = ':memory:';
function fixture(solo = false) {
  Object.assign(process.env, { COMPASSO_SUBSCRIPTIONS_ENABLED: 'true', MP_PLATFORM_ACCESS_TOKEN: 'test', MP_PLATFORM_USER_ID: '123',
    MP_WEBHOOK_SECRET: 'test', APP_URL: 'https://example.test', PUBLIC_API_URL: 'https://api.example.test' });
  const repo = new DocumentRepository();
  if (solo) repo.put('store', 'settings', 'business', { workspaceMode: 'solo', ownerId: 'owner' });
  const actor = { id: 'owner', tenantId: 'store', role: 'admin' as const, name: 'Owner', email: 'owner@test.local', phone: '11999999999' };
  const remote = new Map<string, any>();
  let creates = 0, failCancel = false;
  const call = async (path: string, _token?: string, body?: any) => {
    if (path === '/preapproval') {
      const id = `sub${++creates}`;
      const record = { ...body, id, collector_id: 123, init_point: `https://www.mercadopago.com.br/checkout/${id}` };
      remote.set(id, record); return structuredClone(record);
    }
    if (path.startsWith('/authorized_payments/search')) return { results: [] };
    const id = path.split('/').at(-1)!;
    const record = remote.get(id);
    if (!record) throw new Error(path);
    if (body?.status) {
      if (failCancel) throw new Error('network');
      assert.equal(body.status, 'canceled');
      record.status = body.status;
    }
    return structuredClone(record);
  };
  return { service: new SubscriptionBilling(new Context(repo), call as any), actor, remote, repo,
    creates: () => creates, failCancel: () => { failCancel = true; } };
}

test('abandoned checkouts reuse the same plan and switch all Empresa plans automatically', async () => {
  const f = fixture();
  for (const planId of ['essencial', 'profissional', 'equipe']) {
    await f.service.subscribe(f.actor, { planId });
    const creates = f.creates();
    await f.service.subscribe(f.actor, { planId });
    assert.equal(f.creates(), creates);
    assert.equal(f.service.status(f.actor).subscription?.planId, planId);
    assert.equal([...f.remote.values()].filter(row => row.status === 'pending').length, 1);
  }
  await assert.rejects(() => f.service.preapproval('sub1'), /outra assinatura vigente/);
  assert.equal(f.service.status(f.actor).subscription?.planId, 'equipe');
});

test('a checkout confirmed in another tab wins and prevents a second subscription', async () => {
  const f = fixture(); await f.service.subscribe(f.actor, { planId: 'essencial' });
  f.remote.get('sub1').status = 'authorized';
  await assert.rejects(() => f.service.subscribe(f.actor, { planId: 'profissional' }), /já foi confirmada/);
  assert.equal(f.creates(), 1);
  assert.equal(f.remote.get('sub1').status, 'authorized');
});

test('Solo monthly and annual checkouts switch freely and retain their billing period', async () => {
  const f = fixture(true);
  await f.service.subscribe(f.actor, { planId: 'solo-mensal' });
  await f.service.subscribe(f.actor, { planId: 'solo-anual' });
  assert.equal(f.remote.get('sub1').status, 'canceled');
  assert.equal(f.remote.get('sub2').auto_recurring.frequency, 12);
  assert.equal(f.remote.get('sub2').auto_recurring.transaction_amount, 110);
  await f.service.subscribe(f.actor, { planId: 'solo-mensal' });
  assert.equal(f.remote.get('sub3').auto_recurring.frequency, 1);
  assert.equal(f.remote.get('sub3').auto_recurring.transaction_amount, 15);
});

test('paid time and tenant boundaries cannot be bypassed by changing plans', async () => {
  const f = fixture(); await f.service.subscribe(f.actor, { planId: 'essencial' });
  const current = f.repo.get<any>('store', 'billing', 'subscription');
  f.repo.put('store', 'billing', 'subscription', { ...current, paidThrough: Date.now() + 86400000 });
  await assert.rejects(() => f.service.subscribe(f.actor, { planId: 'equipe' }), /já foi confirmada/);
  await assert.rejects(() => f.service.subscribe({ ...f.actor, role: 'customer' }, { planId: 'equipe' }));
  assert.equal(f.creates(), 1);
  assert.equal(f.remote.get('sub1').status, 'pending');
});

test('failed cancellation and concurrent clicks never create another checkout', async () => {
  const f = fixture(); await f.service.subscribe(f.actor, { planId: 'essencial' });
  f.failCancel();
  const results = await Promise.allSettled(['profissional', 'equipe'].map(planId => f.service.subscribe(f.actor, { planId })));
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(f.creates(), 1);
  assert.equal(f.remote.get('sub1').status, 'pending');
});
