import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { AccountRecovery } from '../dist/modules/identity/application/account-recovery.js';
import { CustomersService } from '../dist/modules/customers/application/customers-service.js';

const password = 'FixtureOnly123!';
const registration = {
  name: 'Independent Client',
  email: 'client@fixture.test',
  phone: '18999990000',
  role: 'customer',
  password,
};
function setup() {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository(),
    context = new Context(repo);
  const identity = new IdentityService(context, {
    verify: async () => ({
      sub: 'google-global',
      email: registration.email,
      name: 'Google Client',
    }),
  } as any);
  return { repo, context, identity };
}
function shop(identity: IdentityService, slug: string) {
  return identity.register({
    slug,
    name: 'Owner',
    email: `${slug}@fixture.test`,
    phone: registration.phone,
    role: 'admin',
    password,
  });
}

test('customer registers without any shop, logs in and retries registration without creating shop records', () => {
  const { repo, identity } = setup();
  const input = { ...registration, idempotencyKey: crypto.randomUUID() };
  const account = identity.register(input);
  assert.equal(account.user.storeSelected, false);
  assert.equal(identity.authenticate(account.token).storeSelected, false);
  assert.equal(identity.register(input).user.id, account.user.id);
  assert.equal(identity.login({ email: registration.email, password }).user?.id, account.user.id);
  assert.equal(repo.list('system', 'stores').length, 0);
  assert.equal(repo.list(account.user.tenantId, 'settings').length, 0);
  assert.throws(
    () => identity.register({ ...registration, idempotencyKey: crypto.randomUUID() }),
    /já/,
  );
});

test('personal registration and public discovery do not expose a customer to shops; entering a shop keeps roles and records isolated', () => {
  const { repo, context, identity } = setup();
  const alpha = shop(identity, 'alpha'),
    beta = shop(identity, 'beta');
  const account = identity.register(registration);
  const customers = new CustomersService(context);
  identity.discovery({});
  assert.equal(customers.list(alpha.user).length, 0);
  assert.equal(customers.list(beta.user).length, 0);
  const first = identity.memberships.switchStore(account.user, 'alpha');
  assert.equal(first.role, 'customer');
  assert.equal(first.tenantId, alpha.user.tenantId);
  assert.equal(identity.session(first).user.storeSelected, true);
  assert.equal(customers.list(alpha.user).length, 1);
  assert.equal(customers.list(beta.user).length, 0);
  const second = identity.memberships.switchStore(account.user, 'beta');
  assert.notEqual(first.id, second.id);
  assert.equal(identity.memberships.switchStore(second, 'alpha').id, first.id);
  assert.equal(identity.login({ email: registration.email, password }).user?.id, account.user.id);
  assert.equal(repo.list('system', 'stores').length, 2);
  assert.throws(
    () =>
      identity.memberships.register(identity.memberships.invite(alpha.user).token, {
        ...registration,
        confirmPassword: password,
      }),
    /já/,
  );
});

test('existing customer, administrator and employee accounts keep their access and are not silently merged by email', () => {
  const { identity } = setup();
  const owner = shop(identity, 'alpha');
  const legacy = identity.register({ ...registration, slug: 'alpha' });
  assert.equal(identity.login({ email: registration.email, password }).user?.id, legacy.user.id);
  assert.throws(() => identity.register(registration), /já/);
  assert.equal(identity.login({ email: owner.user.email, password }).user?.role, 'admin');
});

test('password recovery includes the personal account and its shop memberships and revokes both sessions', async () => {
  const { identity, context } = setup();
  shop(identity, 'alpha');
  const personal = identity.register(registration);
  const member = identity.session(identity.memberships.switchStore(personal.user, 'alpha'));
  process.env.APP_URL = 'https://fixture.test';
  let link = '';
  const recovery = new AccountRecovery(context, {
    configured: () => true,
    send: async (_email, _subject, value) => {
      link = value;
    },
  });
  await recovery.request('password', { email: registration.email });
  const token = link.split(':').at(-1)!;
  recovery.complete({
    token,
    password: 'ChangedFixture123!',
    confirmPassword: 'ChangedFixture123!',
  });
  assert.throws(() => identity.authenticate(personal.token));
  assert.throws(() => identity.authenticate(member.token));
  assert.equal(
    identity.login({ email: registration.email, password: 'ChangedFixture123!' }).user?.id,
    personal.user.id,
  );
  assert.throws(() => identity.login({ email: registration.email, password }));
});

test('new Google customer needs no shop and later Google login returns to the personal account after visiting a shop', async () => {
  const { identity, repo } = setup();
  process.env.GOOGLE_CLIENT_ID = 'fixture-only';
  const input = () => ({
    ...identity.googleChallenge(),
    credential: 'fixture-credential-at-least-20',
  });
  const pending = await identity.google(input());
  assert.ok('enrollmentToken' in pending);
  if (!('enrollmentToken' in pending)) return;
  const personal = identity.completeGoogle({
    enrollmentToken: pending.enrollmentToken,
    role: 'customer',
    phone: registration.phone,
  });
  assert.equal(personal.user.storeSelected, false);
  assert.equal(repo.list('system', 'stores').length, 0);
  shop(identity, 'alpha');
  identity.memberships.switchStore(personal.user, 'alpha');
  const again = await identity.google(input());
  assert.ok('user' in again);
  if ('user' in again) assert.equal(again.user.id, personal.user.id);
});

test('Google cannot take over a personal password account without proof of its password', async () => {
  const { identity } = setup();
  const personal = identity.register(registration);
  process.env.GOOGLE_CLIENT_ID = 'fixture-only';
  const pending = await identity.google({
    ...identity.googleChallenge(),
    credential: 'fixture-credential-at-least-20',
  });
  if (!('enrollmentToken' in pending)) throw Error('Expected onboarding');
  assert.throws(() =>
    identity.completeGoogle({
      enrollmentToken: pending.enrollmentToken,
      role: 'customer',
      phone: registration.phone,
    }),
  );
  const linked = identity.completeGoogle({
    enrollmentToken: pending.enrollmentToken,
    role: 'customer',
    phone: registration.phone,
    password,
  });
  assert.equal(linked.user.id, personal.user.id);
});

test('a personal Google account accepts an employee invitation without losing its professional login', async () => {
  const { identity } = setup();
  process.env.GOOGLE_CLIENT_ID = 'fixture-only';
  const input = () => ({
    ...identity.googleChallenge(),
    credential: 'fixture-credential-at-least-20',
  });
  const pending = await identity.google(input());
  if (!('enrollmentToken' in pending)) throw Error('Expected onboarding');
  const personal = identity.completeGoogle({
    enrollmentToken: pending.enrollmentToken,
    role: 'customer',
    phone: registration.phone,
  });
  const owner = shop(identity, 'staff-shop');
  const invite = identity.memberships.invite(owner.user);
  const employee = identity.memberships.accept(invite.token, identity.member(personal.user));
  assert.equal(employee.role, 'employee');
  const login = await identity.google(input());
  assert.ok('user' in login);
  if ('user' in login) assert.equal(login.user.role, 'employee');
});
