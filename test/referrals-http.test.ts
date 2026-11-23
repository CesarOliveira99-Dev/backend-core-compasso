import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
const base = 'http://127.0.0.1:4127/v1';
let server: ChildProcess;
before(async () => {
  server = spawn(process.execPath, [resolve('dist/main.js')], { env: {
    ...process.env, DATABASE_PATH: ':memory:', PORT: '4127', HOST: '127.0.0.1', NODE_ENV: 'test', SEED_DEMO: 'false',
    COMPASSO_REFERRALS_ENABLED: 'true', COMPASSO_REFERRAL_BILLING_ENABLED: 'false',
    COMPASSO_SUBSCRIPTIONS_ENABLED: 'false', MP_PLATFORM_ACCESS_TOKEN: '', RESEND_API_KEY: '', APPOINTMENT_EMAILS_ENABLED: 'false',
  }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Isolated referral API did not start.');
});
after(() => server?.kill());
async function request(path: string, token = '', body?: unknown) {
  const response = await fetch(base + '/' + path, { method: body ? 'POST' : 'GET', headers: {
    'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json() };
}
test('public configuration and authenticated referral code work through HTTP; customer access is denied and signup carries attribution', async () => {
  assert.deepEqual((await request('auth/referral-config')).data, { enabled: true });
  assert.equal((await request('payments/referrals')).status, 401);
  const body = { name: 'Pessoa Teste', phone: '11999999999', email: 'issuer@http.test', password: 'StrongPassword123', confirmPassword: 'StrongPassword123', role: 'admin',
    workspaceMode: 'store', businessName: 'Empresa Teste', address: { postalCode: '01001000', street: 'Rua Teste', number: '1', district: 'Centro', city: 'São Paulo', state: 'SP', complement: '' } };
  const issuer = await request('auth/register', '', body);
  assert.equal(issuer.status, 201);
  const status = await request('payments/referrals', issuer.data.token);
  assert.equal(status.status, 200); assert.match(status.data.code, /^[A-Z0-9]{12}$/);
  const referred = await request('auth/register', '', { ...body, email: 'referred@http.test', workspaceMode: 'solo', referralCode: status.data.code });
  assert.equal(referred.status, 201);
  const updated = await request('payments/referrals', issuer.data.token);
  assert.equal(updated.data.pending, 1); assert.equal(updated.data.balancePercent, 0);
  assert.equal(JSON.stringify(updated.data).includes('referred@http.test'), false);
  const customer = await request('auth/register', '', { ...body, email: 'customer@http.test', role: 'customer' });
  assert.equal(customer.status, 201);
  assert.equal((await request('payments/referrals', customer.data.token)).status, 403);
});
