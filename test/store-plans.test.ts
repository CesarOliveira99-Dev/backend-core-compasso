import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { startStoreTrial, storeEntitlement, requireStoreService, requireEmployeeSeat, employeeSeats, STORE_PLANS } from '../dist/core/application/store-plans.js';
import { reserveEmail, finishEmail, emailQuota, notifyEmailQuota } from '../dist/core/application/email-quota.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { GoogleIdentity } from '../dist/modules/identity/application/google-identity.js';
import { SubscriptionBilling, subscriptionPeriodEnd } from '../dist/modules/payments/subscription-billing.js';
import { ProfessionalsService } from '../dist/modules/professionals/professionals.module.js';

process.env.DATABASE_PATH = ':memory:';
const owner = { id: 'owner', tenantId: 'store', email: 'owner@test.local', name: 'Owner', phone: '11999999999', role: 'admin' as const };
const now = Date.now();
const paid = (repo: DocumentRepository, planId = 'essencial') => repo.put('store', 'billing', 'subscription', { id: 'sub', planId, paidThrough: now + 86400000 });

test('owner registration starts exactly fourteen days; customers have no billing and existing pilot is preserved', () => {
  const repo = new DocumentRepository(), identity = new IdentityService(new Context(repo), new GoogleIdentity());
  const result = identity.register({ ...owner, password: 'StrongPassword123', role: 'admin', businessName: 'New Store',
    address: { postalCode: '19806060', street: 'Rua Teste', number: '10', district: 'Centro', city: 'Assis', state: 'SP', complement: '' } });
  const trial = repo.get<any>(result.user.tenantId, 'billing', 'trial');
  assert.equal(trial.endsAt - trial.startedAt, 14 * 86400000);
  assert.equal(storeEntitlement(repo, result.user.tenantId, trial.endsAt - 1).mode, 'trial');
  assert.equal(storeEntitlement(repo, result.user.tenantId, trial.endsAt).mode, 'expired');
  assert.throws(() => requireStoreService(repo, result.user.tenantId, trial.endsAt), /responsável/);
  assert.equal(storeEntitlement(repo, 'old-pilot').mode, 'pilot');
  assert.equal(repo.get('old-pilot', 'billing', 'trial'), undefined);
  const customer = identity.register({ name: 'Buyer', email: 'buyer@test.local', phone: owner.phone, role: 'customer', password: 'StrongPassword123' });
  assert.equal(repo.list(customer.user.tenantId, 'billing').length, 0);
  startStoreTrial(repo, { ...owner, tenantId: 'second', email: ' OWNER@test.local ' }, trial.endsAt + 1);
  assert.deepEqual(repo.get('second', 'billing', 'trial'), trial);
  assert.equal(storeEntitlement(repo, 'second', trial.endsAt + 1).mode, 'expired');
});

test('employee seats count active people once, exclude principal, enforce reactivation and allow deactivation', () => {
  const repo = new DocumentRepository(); paid(repo);
  repo.put('store', 'professionals', 'principal', { id: 'principal', active: true });
  repo.put('store', 'professionals', 'one', { id: 'one', active: true });
  repo.put('store', 'customers', 'one-user', { id: 'one-user', role: 'employee', active: true, professionalId: 'one' });
  assert.equal(employeeSeats(repo, 'store'), 1);
  assert.throws(() => requireEmployeeSeat(repo, 'store'), /1 funcionário/);
  assert.doesNotThrow(() => requireEmployeeSeat(repo, 'another-store'));
  const service = new ProfessionalsService(new Context(repo));
  const input = { name: 'Second', active: true, serviceIds: [], openingHour: 8, closingHour: 18, workDays: [1, 2, 3] };
  assert.throws(() => service.save(owner, input), /funcionário/);
  assert.doesNotThrow(() => service.save(owner, { ...input, active: false }));
  const inactive = repo.list<any>('store', 'professionals').find(p => p.name === 'Second');
  assert.throws(() => service.save(owner, input, inactive.id), /funcionário/);
  paid(repo, 'profissional');
  assert.doesNotThrow(() => service.save(owner, input, inactive.id));
  assert.equal(employeeSeats(repo, 'store'), 2);
});

test('email reservation is atomic and idempotent; rejection releases quota, uncertain or sent delivery keeps one slot', () => {
  const repo = new DocumentRepository(); paid(repo);
  for (let i = 0; i < 100; i++) assert.equal(reserveEmail(repo, 'store', String(i), now), true);
  assert.equal(reserveEmail(repo, 'store', '101', now), false);
  assert.equal(reserveEmail(repo, 'store', '1', now), true);
  assert.equal(emailQuota(repo, 'store', now).daily.used, 100);
  finishEmail(repo, 'store', '1', false);
  assert.equal(reserveEmail(repo, 'store', '101', now), true);
  finishEmail(repo, 'store', '101', true); finishEmail(repo, 'store', '101', false);
  assert.equal(emailQuota(repo, 'store', now).daily.used, 100);
  assert.equal(emailQuota(repo, 'another', now).monthly.used, 0);
  const period = emailQuota(repo, 'store', now);
  repo.put('store', 'email_usage', period.day, { count: 0 });
  repo.put('store', 'email_usage', period.month, { count: 1000 });
  assert.equal(reserveEmail(repo, 'store', 'monthly-full', now), false);
});

test('email limits reset on São Paulo day/month; threshold notifications are deduplicated by store and period', () => {
  const repo = new DocumentRepository(), context = new Context(repo); paid(repo);
  const before = Date.parse('2026-12-01T02:59:59Z'), after = before + 1000;
  repo.put('store', 'billing', 'subscription', { planId: 'essencial', paidThrough: after + 86400000 });
  assert.equal(reserveEmail(repo, 'store', 'november', before), true);
  assert.equal(emailQuota(repo, 'store', before).month, '2026-11');
  assert.equal(emailQuota(repo, 'store', after).month, '2026-12');
  assert.equal(emailQuota(repo, 'store', after).monthly.used, 0);
  repo.put('store', 'customers', owner.id, owner);
  const usage = emailQuota(repo, 'store', after);
  repo.put('store', 'email_usage', usage.month, { count: 800 });
  notifyEmailQuota(context, 'store', after); notifyEmailQuota(context, 'store', after);
  assert.equal(repo.list('store', 'notifications').length, 1);
  repo.put('store', 'email_usage', usage.month, { count: 1000 }); notifyEmailQuota(context, 'store', after);
  assert.equal(repo.list('store', 'notifications').length, 2);
});

function billingEnv() {
  Object.assign(process.env, { COMPASSO_SUBSCRIPTIONS_ENABLED: 'true', MP_PLATFORM_ACCESS_TOKEN: 'test-token', MP_PLATFORM_USER_ID: '123',
    MP_WEBHOOK_SECRET: 'test-secret', APP_URL: 'https://example.test', PUBLIC_API_URL: 'https://api.example.test/v1', MP_SANDBOX: 'true' });
}
function fixture() {
  billingEnv(); const repo = new DocumentRepository();
  let external = '', status = 'authorized', paymentStatus = 'approved', collector = 123, amount = 59.9, refunded = 0, live = false;
  let creates = 0, fail = false;
  const preapproval = () => ({ id: 'sub', collector_id: 123, external_reference: external, status, init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=sub',
    auto_recurring: { transaction_amount: amount, currency_id: 'BRL', frequency: 1, frequency_type: 'months' } });
  const bodies: any[] = [];
  const call = async (path: string, _token?: string, body?: any) => {
    if (path === '/preapproval') { creates++; bodies.push(body); external = body.external_reference; amount = body.auto_recurring.transaction_amount; if (fail) throw new Error('network'); return preapproval(); }
    if (path.startsWith('/preapproval/search')) return { results: [preapproval()] };
    if (path === '/preapproval/sub') { if (body?.status === 'cancelled') status = 'cancelled'; return preapproval(); }
    if (path.startsWith('/authorized_payments/search')) return { results: [{ id: 44 }] };
    if (path === '/authorized_payments/44') return { id: 44, preapproval_id: 'sub', currency_id: 'BRL', transaction_amount: '59.90', debit_date: new Date(now).toISOString(), payment: { id: 42 } };
    if (path === '/v1/payments/42') return { id: 42, collector_id: collector, currency_id: 'BRL', transaction_amount: amount,
      live_mode: live, status: paymentStatus, transaction_amount_refunded: refunded, date_approved: new Date(now).toISOString() };
    throw new Error(path);
  };
  const service = new SubscriptionBilling(new Context(repo), call as any);
  return { repo, service, bodies, creates: () => creates, fail: () => { fail = true; }, mutate: (next: any) => {
    status = next.status ?? status; paymentStatus = next.paymentStatus ?? paymentStatus; collector = next.collector ?? collector;
    amount = next.amount ?? amount; refunded = next.refunded ?? refunded; live = next.live ?? live;
  } };
}

test('catalog prices are server controlled and checkout during a trial does not grant paid access', async () => {
  const f = fixture(); startStoreTrial(f.repo, owner, now);
  await assert.rejects(() => f.service.subscribe({ ...owner, role: 'customer' }, { planId: 'essencial' }));
  await assert.rejects(() => f.service.subscribe(owner, { planId: 'essencial', priceCents: 1 }));
  assert.equal(f.creates(), 0);
  await f.service.subscribe(owner, { planId: 'essencial' });
  assert.equal(f.bodies[0].auto_recurring.transaction_amount, 59.9);
  assert.equal(f.bodies[0].auto_recurring.start_date, undefined);
  assert.equal(storeEntitlement(f.repo, 'store').mode, 'trial');
  await f.service.subscribe(owner, { planId: 'essencial' }); assert.equal(f.creates(), 1);
  assert.deepEqual(STORE_PLANS.map(p => p.priceCents), [5990, 7990, 9990]);
});

test('an unpaid pending checkout can be cancelled before choosing another plan', async () => {
  const f = fixture(); f.mutate({ status: 'pending' });
  await f.service.subscribe(owner, { planId: 'essencial' });
  assert.equal(f.service.status(owner).subscription?.status, 'pending');
  await f.service.cancelPending(owner);
  assert.equal(f.service.status(owner).subscription?.status, 'cancelled');
  f.mutate({ status: 'pending' });
  await f.service.subscribe(owner, { planId: 'profissional' });
  assert.equal(f.creates(), 2);
  await assert.rejects(() => f.service.cancelPending({ ...owner, tenantId: 'another-store' }), /Somente uma contratação pendente/);
  f.mutate({ status: 'authorized' });
  await assert.rejects(() => f.service.cancelPending(owner), /mudou no Mercado Pago/);
});

test('approved invoice activates only its store, duplicates cannot extend period; wrong amounts, collector and environment fail; refunds revoke', async () => {
  const f = fixture(); await f.service.subscribe(owner, { planId: 'essencial' });
  for (const invalid of [{ amount: 1 }, { collector: 99 }, { live: true }]) {
    f.mutate(invalid); await assert.rejects(() => f.service.invoice('44'));
    assert.equal(f.service.status(owner).subscription?.paidThrough, undefined);
    f.mutate({ amount: 59.9, collector: 123, live: false });
  }
  f.mutate({ paymentStatus: 'pending' }); await f.service.invoice('44');
  assert.equal(storeEntitlement(f.repo, 'store').mode, 'expired');
  f.mutate({ paymentStatus: 'approved' }); await f.service.invoice('44');
  const expiry = f.service.status(owner).subscription?.paidThrough;
  assert.equal(expiry, subscriptionPeriodEnd(now)); assert.equal(storeEntitlement(f.repo, 'store').mode, 'active');
  await f.service.invoice('44'); assert.equal(f.service.status(owner).subscription?.paidThrough, expiry);
  assert.equal(f.repo.list('another-store', 'subscription_invoices').length, 0);
  f.mutate({ status: 'cancelled' }); await f.service.preapproval('sub');
  assert.equal(storeEntitlement(f.repo, 'store').mode, 'active');
  f.mutate({ refunded: 59.9, paymentStatus: 'refunded' }); await f.service.payment('42');
  assert.equal(storeEntitlement(f.repo, 'store').mode, 'expired');
  assert.equal(new Date(subscriptionPeriodEnd(Date.parse('2027-01-31T12:00:00Z'))).toISOString(), '2027-02-28T12:00:00.000Z');
});

test('lost creation response is recovered by reference without creating a second subscription', async () => {
  const f = fixture(); f.fail();
  await assert.rejects(() => f.service.subscribe(owner, { planId: 'essencial' }), /network/);
  assert.equal(f.service.status(owner).setupPending, true);
  await f.service.subscribe(owner, { planId: 'essencial' }); assert.equal(f.creates(), 1);
  assert.equal(f.service.status(owner).setupPending, false);
});

test('payment search cannot grant a subscription for a different payment ID', async () => {
  const f = fixture(); await f.service.subscribe(owner, { planId: 'essencial' });
  assert.equal(await f.service.payment('999'), false);
  assert.equal(f.service.status(owner).subscription?.paidThrough, undefined);
  assert.equal(await f.service.payment('42'), true);
  assert.equal(storeEntitlement(f.repo, 'store').mode, 'active');
});
