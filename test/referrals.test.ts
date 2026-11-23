import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { GoogleIdentity } from '../dist/modules/identity/application/google-identity.js';
import { Referrals, REFERRAL_SCOPE, discountAmount } from '../dist/modules/payments/referrals.js';
import { SubscriptionBilling, subscriptionPeriodEnd } from '../dist/modules/payments/subscription-billing.js';

process.env.DATABASE_PATH = ':memory:';
Object.assign(process.env, { COMPASSO_REFERRALS_ENABLED: 'true', COMPASSO_REFERRAL_BILLING_ENABLED: 'true',
  MP_PLATFORM_ACCESS_TOKEN: 'fixture', MP_PLATFORM_USER_ID: '123', MP_SANDBOX: 'true', COMPASSO_SUBSCRIPTIONS_ENABLED: 'true',
  MP_WEBHOOK_SECRET: 'fixture', APP_URL: 'https://example.test', PUBLIC_API_URL: 'https://api.example.test' });
const address = { postalCode: '01001000', street: 'Rua Teste', number: '1', district: 'Centro', city: 'São Paulo', state: 'SP', complement: '' };
function fixture() {
  const repo = new DocumentRepository(), context = new Context(repo), identity = new IdentityService(context, new GoogleIdentity());
  const register = (email: string, referralCode?: string, workspaceMode = 'store') => identity.register({
    name: 'Pessoa Teste', email, phone: '11999999999', password: 'StrongPassword123', role: 'admin', businessName: 'Empresa Teste', address, workspaceMode, referralCode,
  }).user;
  const issuer = register('issuer@fixture.test');
  const referrals = new Referrals(context), code = referrals.status(issuer).code;
  return { repo, context, identity, register, issuer, referrals, code };
}
test('referral attaches at signup, rejects invalid and existing accounts, isolates code ownership and rolls back failed registration', () => {
  const f = fixture();
  const user = f.register('new@fixture.test', f.code.toLowerCase(), 'solo');
  assert.equal(f.repo.get<any>(REFERRAL_SCOPE, 'attributions', user.tenantId).referrerTenantId, f.issuer.tenantId);
  assert.throws(() => f.referrals.status({ ...f.issuer, role: 'customer' }));
  assert.notEqual(f.referrals.status(user).code, f.code);
  assert.throws(() => f.register('invalid@fixture.test', 'FFFFFFFFFFFF'), /indicação/);
  assert.equal(f.repo.list<any>('system', 'accounts').filter(row => f.repo.get<any>(row.tenantId, 'customers', row.userId)?.email === 'invalid@fixture.test').length, 0);
  assert.throws(() => f.referrals.attribute(f.issuer, f.code), /não pode/);
  assert.throws(() => f.referrals.attribute({ ...user, tenantId: 'other' }, f.code), /já possui/);
  assert.throws(() => f.referrals.attribute({ ...user, id: 'another', identityId: 'another', tenantId: 'other' }, f.code), /já possui/);
  assert.throws(() => f.referrals.attribute(user, f.code, true), /não pode/);
  assert.doesNotThrow(() => f.register('blank@fixture.test', ''));
});
test('trial completion AND approved payment are required; retries are idempotent and refunds reverse unconsumed benefit', () => {
  const f = fixture(), user = f.register('new@fixture.test', f.code);
  const trial = f.repo.get<any>(user.tenantId, 'billing', 'trial');
  const row = f.repo.get<any>(REFERRAL_SCOPE, 'attributions', user.tenantId);
  f.referrals.reconcile(user.tenantId, trial.endsAt + 1);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
  f.repo.put(user.tenantId, 'subscription_invoices', 'first', { approved: true, paidAmountCents: 0, approvedAt: row.createdAt + 1, endsAt: trial.endsAt + 86400000 });
  f.referrals.reconcile(user.tenantId, trial.endsAt + 1);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0, 'a free discounted cycle is not a paid conversion');
  f.repo.put(user.tenantId, 'subscription_invoices', 'first', { approved: true, paidAmountCents: 1500, approvedAt: row.createdAt + 1, endsAt: trial.endsAt + 86400000 });
  f.referrals.reconcile(user.tenantId, trial.endsAt - 1);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
  f.referrals.reconcile(user.tenantId, trial.endsAt); f.referrals.reconcile(user.tenantId, trial.endsAt);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 1500);
  f.repo.put(user.tenantId, 'subscription_invoices', 'first', { approved: false, endsAt: 0 });
  f.referrals.reconcile(user.tenantId, trial.endsAt);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
});
test('Google signup preserves the referral and an unknown code rolls back the Google account', () => {
  const f = fixture();
  const enroll = (email: string, token: string) => f.repo.put('system', 'google_enrollments', createHash('sha256').update(token).digest('hex'), {
    sub: email, email, name: 'Pessoa Google', expiresAt: Date.now() + 60000,
  });
  const token = 'a'.repeat(64); enroll('google@fixture.test', token);
  const result = f.identity.completeGoogle({ enrollmentToken: token, name: 'Pessoa Google', phone: '11999999999', role: 'admin', workspaceMode: 'solo', referralCode: f.code });
  assert.equal(f.repo.get<any>(REFERRAL_SCOPE, 'attributions', result.user.tenantId).referrerTenantId, f.issuer.tenantId);
  const other = 'b'.repeat(64); enroll('invalidgoogle@fixture.test', other);
  assert.throws(() => f.identity.completeGoogle({ enrollmentToken: other, name: 'Pessoa Google', phone: '11999999999', role: 'admin', workspaceMode: 'solo', referralCode: 'FFFFFFFFFFFF' }));
  assert.equal(f.repo.list<any>('system', 'accounts').filter(row => f.repo.get<any>(row.tenantId, 'customers', row.userId)?.email === 'invalidgoogle@fixture.test').length, 0);
});
test('unlimited percentage accumulates; cycles reserve at most 100% and extras remain payable', () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) f.repo.put(REFERRAL_SCOPE, 'attributions', String(i), { tenantId: String(i), referrerTenantId: f.issuer.tenantId, eligible: true });
  assert.equal(f.referrals.balance(f.issuer.tenantId), 45000);
  f.repo.put(f.issuer.tenantId, 'referral_cycles', 'cycle', { discountBps: 10000 });
  assert.equal(f.referrals.balance(f.issuer.tenantId), 35000);
  assert.equal(discountAmount(5990, 5990, 1500), 5091);
  assert.equal(discountAmount(9990, 12490, 10000), 2500);
  assert.equal(discountAmount(11000, 11000, 1500), 9350);
  assert.equal(discountAmount(5990, 5990, 10000), 0);
  assert.throws(() => discountAmount(5990, 5990, 10001));
});

async function billingFixture(planId = 'essencial', price = 5990) {
  const f = fixture();
  let amount = price / 100, due = Date.now() + 7 * 86400000, puts = 0, lost = false, wrong = false;
  let reference = '', debit = due, paymentStatus = 'approved', invoiceAmount = amount, advanced = false;
  const raw = () => ({ id: wrong ? 'wrong' : 'sub', collector_id: 123, external_reference: reference, status: 'authorized',
    init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=sub', next_payment_date: new Date(due).toISOString(),
    auto_recurring: { transaction_amount: amount, currency_id: 'BRL', frequency: planId === 'solo-anual' ? 12 : 1, frequency_type: 'months' } });
  const call = async <T>(path: string, _token?: string, body?: any, _key?: string, method?: string): Promise<T> => {
    let result: unknown;
    if (path === '/preapproval') { reference = body.external_reference; result = raw(); }
    else if (path === '/preapproval/sub' && method === 'PUT') { puts++; amount = body.auto_recurring.transaction_amount; if (lost) { lost = false; throw new Error('transport lost'); } result = raw(); }
    else if (path === '/preapproval/sub') result = raw();
    else if (path.startsWith('/authorized_payments/search')) result = { results: advanced ? [{ id: 44 }] : [] };
    else if (path === '/authorized_payments/44') result = { id: 44, preapproval_id: 'sub', currency_id: 'BRL', transaction_amount: invoiceAmount, debit_date: new Date(debit).toISOString(), payment: { id: 42 } };
    else if (path === '/v1/payments/42') result = { id: 42, collector_id: 123, currency_id: 'BRL', transaction_amount: invoiceAmount, status: paymentStatus, live_mode: false, date_approved: new Date(debit).toISOString() };
    else throw new Error(path);
    return result as T;
  };
  if (planId === 'solo-anual') {
    f.repo.put(f.issuer.tenantId, 'settings', 'business', { ...f.repo.get<any>(f.issuer.tenantId, 'settings', 'business'), workspaceMode: 'solo' });
  }
  const billing = new SubscriptionBilling(f.context, call);
  await billing.subscribe(f.issuer, { planId });
  f.repo.put(f.issuer.tenantId, 'billing', 'subscription', { ...f.repo.get<any>(f.issuer.tenantId, 'billing', 'subscription'), paidThrough: due });
  f.repo.put(f.issuer.tenantId, 'subscription_invoices', 'initial', { approved: true, approvedAt: Date.now(), subscriptionId: 'sub', endsAt: due });
  const grant = (count = 1) => { for (let i = 0; i < count; i++) f.repo.put(REFERRAL_SCOPE, 'attributions', `new-${i}`, { tenantId: `new-${i}`, referrerTenantId: f.issuer.tenantId, eligible: true }); };
  return { ...f, billing, grant, amount: () => amount, puts: () => puts, due: () => due,
    lost: () => { lost = true; }, wrong: () => { wrong = true; }, reject: () => { paymentStatus = 'rejected'; },
    advance: () => { advanced = true; invoiceAmount = amount; debit = due; due = subscriptionPeriodEnd(due, planId === 'solo-anual' ? 12 : 1); } };
}
test('monthly renewal receives a single 15% discount, duplicate webhooks do not spend twice, baseline returns', async t => {
  const f = await billingFixture(); f.grant();
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.amount(), 50.91); assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
  const debit = f.due(); f.advance(); t.mock.method(Date, 'now', () => debit + 1000);
  await f.billing.invoice('44');
  assert.equal(f.amount(), 59.9);
  await f.billing.invoice('44');
  assert.equal(f.amount(), 59.9);
  // Replaying this payment with its original approved amount is covered by the cycle's exact invoice binding.
  assert.equal(f.repo.list<any>(f.issuer.tenantId, 'referral_cycles').length, 1);
  assert.equal(f.repo.list<any>(f.issuer.tenantId, 'referral_cycles')[0].state, 'consumed');
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
});
test('annual renewal keeps twelve-month billing and receives 15% of the annual amount', async () => {
  const f = await billingFixture('solo-anual', 11000); f.grant();
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.amount(), 93.5);
  assert.equal(f.repo.list<any>(f.issuer.tenantId, 'referral_cycles')[0].baseCents, 11000);
});
test('disabling new referrals still reconciles existing discounted renewals and restores their normal price', async t => {
  const f = await billingFixture(); f.grant();
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  process.env.COMPASSO_REFERRALS_ENABLED = 'false';
  process.env.COMPASSO_REFERRAL_BILLING_ENABLED = 'false';
  t.after(() => { process.env.COMPASSO_REFERRALS_ENABLED = 'true'; process.env.COMPASSO_REFERRAL_BILLING_ENABLED = 'true'; });
  const debit = f.due(); f.advance(); t.mock.method(Date, 'now', () => debit + 1000);
  await f.billing.invoice('44');
  assert.equal(f.amount(), 59.9);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
});
test('rejected renewals retain the scheduled discount without consuming another referral', async t => {
  const f = await billingFixture(); f.grant();
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  const debit = f.due(); f.advance(); f.reject(); t.mock.method(Date, 'now', () => debit + 1000);
  await f.billing.invoice('44'); await f.billing.invoice('44');
  assert.equal(f.amount(), 50.91);
  assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
  assert.equal(f.repo.list<any>(f.issuer.tenantId, 'referral_cycles')[0].state, 'applied');
});
test('ambiguous transport failure retains a retryable reservation without spending credits twice', async () => {
  const f = await billingFixture(); f.grant(); f.lost();
  await assert.rejects(() => f.billing.syncReferralPricing(f.issuer.tenantId), /transport lost/);
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.amount(), 50.91); assert.equal(f.referrals.balance(f.issuer.tenantId), 0);
  assert.equal(f.repo.list<any>(f.issuer.tenantId, 'referral_cycles').length, 1);
});
test('wrong provider identity cannot change subscriptions or consume referral credits', async () => {
  const f = await billingFixture(); f.grant(); f.wrong();
  await assert.rejects(() => f.billing.syncReferralPricing(f.issuer.tenantId), /incompatível/);
  assert.equal(f.puts(), 0); assert.equal(f.referrals.balance(f.issuer.tenantId), 1500);
});
test('100% renewals are gated until zero-amount subscription behavior is homologated; excess balance stays intact', async () => {
  const f = await billingFixture(); f.grant(7);
  delete process.env.COMPASSO_REFERRAL_ZERO_AMOUNT_VERIFIED;
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.puts(), 0); assert.equal(f.referrals.balance(f.issuer.tenantId), 10500);
});
test('confirmed zero-amount cycle carries excess discount into subsequent cycles and grants one period only', async t => {
  process.env.COMPASSO_REFERRAL_ZERO_AMOUNT_VERIFIED = 'true';
  t.after(() => { delete process.env.COMPASSO_REFERRAL_ZERO_AMOUNT_VERIFIED; });
  const f = await billingFixture(); f.grant(7);
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.amount(), 0); assert.equal(f.referrals.balance(f.issuer.tenantId), 500);
  const debit = f.due(); f.advance(); t.mock.method(Date, 'now', () => debit + 1000);
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.amount(), 56.9);
  assert.equal(f.repo.get<any>(f.issuer.tenantId, 'billing', 'subscription').paidThrough, f.due());
  await f.billing.syncReferralPricing(f.issuer.tenantId);
  assert.equal(f.repo.list<any>(f.issuer.tenantId, 'referral_cycles').length, 2);
});
