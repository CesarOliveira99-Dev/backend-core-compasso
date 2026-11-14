import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { GoogleIdentity } from '../dist/modules/identity/application/google-identity.js';

function setup(t: any) {
  process.env.DATABASE_PATH = ':memory:';
  process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
  const repo = new DocumentRepository();
  const google = new GoogleIdentity();
  const service = new IdentityService(new Context(repo), google);
  const identity = { sub: 'google-customer', email: 'customer@test.local', name: 'Verified Name' };
  const verify = t.mock.method(google, 'verify', async (_credential: string, nonce: string) => {
    assert.ok(nonce.length > 30);
    return { ...identity };
  });
  const owner = service.register({
    name: 'Owner',
    email: 'owner@test.local',
    password: 'SecurePass!123',
    phone: '5518999999999',
    role: 'admin',
    slug: 'barbearia',
    businessName: 'Barbearia Teste',
  });
  const input = () => ({
    ...service.googleChallenge(),
    credential: 'test-credential-at-least-20-chars',
  });
  const complete = (token: string, extra = {}) =>
    service.completeGoogle({
      enrollmentToken: token,
      slug: 'barbearia',
      role: 'customer',
      phone: '5518999999999',
      ...extra,
    });
  return { repo, google, service, identity, verify, owner, input, complete };
}

test('Google first authenticates without registration fields, then completes verified profile once', async (t) => {
  const { repo, service, input, complete } = setup(t);
  const challenge = input();
  const pending = await service.google(challenge);
  assert.equal(pending.status, 'onboarding_required');
  assert.ok('enrollmentToken' in pending);
  if (!('enrollmentToken' in pending)) return;
  assert.equal(repo.list('system', 'sessions').length, 1); // only the owner's pre-existing session
  const result = complete(pending.enrollmentToken, {
    email: 'attacker@test.local',
    name: 'Nome de Exibição',
    sub: 'fake',
  });
  assert.equal(result.user.email, 'customer@test.local');
  // Display name may be corrected during onboarding; verified email/sub remain provider-owned.
  assert.equal(result.user.name, 'Nome de Exibição');
  assert.equal(result.user.role, 'customer');
  assert.equal(service.authenticate(result.token).id, result.user.id);
  assert.throws(() => complete(pending.enrollmentToken), /expirada/);
  await assert.rejects(() => service.google(challenge), /expirado/);
  const again = await service.google({ ...input(), role: 'admin', slug: 'irrelevant' });
  assert.ok('user' in again);
  if ('user' in again) {
    assert.equal(again.user.id, result.user.id);
    assert.equal(again.user.role, 'customer');
  }
});

test('Google onboarding creates a new business but cannot claim an existing store', async (t) => {
  const { service, input, complete } = setup(t);
  const pending = await service.google(input());
  if (!('enrollmentToken' in pending)) throw new Error('Expected onboarding');
  assert.throws(
    () => complete(pending.enrollmentToken, { role: 'admin', businessName: 'Claim' }),
    /já está em uso/,
  );
  assert.throws(() => complete(pending.enrollmentToken, { slug: 'missing' }), /não encontrada/);
  const result = complete(pending.enrollmentToken, {
    role: 'admin',
    slug: 'nova-loja',
    businessName: 'Nova Loja',
  });
  assert.equal(result.user.role, 'admin');
  const again = await service.google(input());
  assert.ok('user' in again);
  if ('user' in again) assert.equal(again.user.tenantId, result.user.tenantId);
});

test('Existing password accounts need ownership proof and retain their stored role', async (t) => {
  const { service, identity, owner, input, complete } = setup(t);
  identity.email = owner.user.email;
  const pending = await service.google(input());
  if (!('enrollmentToken' in pending)) throw new Error('Expected onboarding');
  assert.equal(pending.stores[0].existingAccount, true);
  assert.throws(() => complete(pending.enrollmentToken));
  assert.throws(() => complete(pending.enrollmentToken, { password: 'WrongPass123' }), /inválidos/);
  const linked = complete(pending.enrollmentToken, {
    password: 'SecurePass!123',
    role: 'customer',
  });
  assert.equal(linked.user.id, owner.user.id);
  assert.equal(linked.user.role, 'admin');
  const later = await service.google(input());
  assert.ok('user' in later);
  if ('user' in later) assert.equal(later.user.id, owner.user.id);
});

test('Several linked stores require selection and never trust a requested role', async (t) => {
  const { service, input, complete } = setup(t);
  const first = await service.google(input());
  if (!('enrollmentToken' in first)) throw new Error('Expected onboarding');
  complete(first.enrollmentToken);
  service.register({
    name: 'Other Owner',
    email: 'another@test.local',
    password: 'SecurePass!123',
    phone: '5518999999999',
    role: 'admin',
    slug: 'outra-loja',
  });
  // Another store can be linked explicitly from its authenticated profile.
  const other = service.register({
    name: 'Verified Name',
    email: 'customer@test.local',
    password: 'SecurePass!123',
    phone: '5518999999999',
    role: 'customer',
    slug: 'outra-loja',
  });
  await service.google({ ...input(), mode: 'link', slug: 'outra-loja' }, other.user);
  const choice = await service.google(input());
  if (!('enrollmentToken' in choice)) throw new Error('Expected selection');
  assert.equal(choice.stores.filter((store) => store.linked).length, 2);
  const result = complete(choice.enrollmentToken, { slug: 'outra-loja', role: 'admin' });
  assert.equal(result.user.id, other.user.id);
  assert.equal(result.user.role, 'customer');
});

test('Expired enrollment, invalid Google credentials and unauthorized linking are rejected', async (t) => {
  const { repo, service, owner, verify, input, complete } = setup(t);
  await assert.rejects(() => service.google({ ...input(), mode: 'link', slug: 'barbearia' }));
  await assert.rejects(
    () => service.google({ ...input(), mode: 'link', slug: 'barbearia' }, owner.user),
    /mesmo e-mail/,
  );
  const pending = await service.google(input());
  if (!('enrollmentToken' in pending)) throw new Error('Expected onboarding');
  const key = createHash('sha256').update(pending.enrollmentToken).digest('hex');
  const record = repo.get<any>('system', 'google_enrollments', key);
  repo.put('system', 'google_enrollments', key, { ...record, expiresAt: Date.now() - 1 });
  assert.throws(() => complete(pending.enrollmentToken), /expirada/);
  verify.mock.mockImplementation(async () => {
    throw new Error('invalid signed token');
  });
  await assert.rejects(() => service.google(input()), /invalid signed token/);
  delete process.env.GOOGLE_CLIENT_ID;
  assert.throws(() => service.googleChallenge(), /não configurado/);
});
