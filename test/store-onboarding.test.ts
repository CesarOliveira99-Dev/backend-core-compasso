import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { GoogleIdentity } from '../dist/modules/identity/application/google-identity.js';
const address = {
  postalCode: '19806060',
  street: 'Rua Teste',
  number: '274',
  district: 'Centro',
  city: 'Assis',
  state: 'SP',
  complement: '',
};

test('new businesses generate internal identifiers, save location and start in setup; password login needs no store code', () => {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository();
  const identity = new IdentityService(new Context(repo), new GoogleIdentity());
  const registration = {
    name: 'Owner Test',
    email: 'owner@new.test',
    password: 'SecurePass123',
    phone: '18999999999',
    role: 'admin',
    businessName: 'Meu Negócio',
    address,
  };
  const first = identity.register(registration);
  const second = identity.register({ ...registration, email: 'another@new.test' });
  assert.notEqual(first.user.tenantId, second.user.tenantId);
  const settings = repo.get<any>(first.user.tenantId, 'settings', 'business');
  assert.deepEqual(settings.address, address);
  assert.equal(settings.setupComplete, false);
  assert.equal(settings.phone, registration.phone);
  assert.equal(
    identity.login({ email: registration.email, password: registration.password }).user.id,
    first.user.id,
  );
  const stores = identity.stores();
  assert.equal(stores.length, 2);
  assert.equal('bankAccount' in stores[0], false);
  assert.equal('email' in stores[0], false);
});

test('password login selects by business name only after verifying credentials, keeping tenant roles isolated', () => {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository();
  const identity = new IdentityService(new Context(repo), new GoogleIdentity());
  const registration = {
    name: 'Owner Test',
    email: 'same@new.test',
    password: 'SecurePass123',
    phone: '18999999999',
    role: 'admin',
    businessName: 'Meu Negócio',
    address,
  };
  const first = identity.register({ ...registration, slug: 'first' });
  const second = identity.register({ ...registration, slug: 'second' });
  const choice = identity.login({ email: registration.email, password: registration.password });
  assert.equal(choice.status, 'store_selection_required');
  assert.equal(choice.stores.length, 2);
  assert.equal('token' in choice, false);
  assert.equal(
    identity.login({ email: registration.email, password: registration.password, slug: 'second' })
      .user.id,
    second.user.id,
  );
  assert.throws(
    () => identity.login({ email: registration.email, password: 'WrongPass123' }),
    /inválidos/,
  );
  assert.notEqual(first.user.tenantId, second.user.tenantId);
});

test('Google administrator onboarding accepts location without a store code', async (t) => {
  process.env.DATABASE_PATH = ':memory:';
  process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
  const repo = new DocumentRepository();
  const google = new GoogleIdentity();
  t.mock.method(google, 'verify', async () => ({
    sub: 'new-google',
    email: 'new@google.test',
    name: 'New Owner',
  }));
  const identity = new IdentityService(new Context(repo), google);
  const pending = await identity.google({
    ...identity.googleChallenge(),
    credential: 'credential-at-least-20-characters',
  });
  assert.throws(
    () =>
      identity.completeGoogle({
        enrollmentToken: pending.enrollmentToken,
        role: 'admin',
        businessName: 'New Store',
        phone: '18999999999',
      }),
    /localização/,
  );
  const account = identity.completeGoogle({
    enrollmentToken: pending.enrollmentToken,
    role: 'admin',
    businessName: 'New Store',
    phone: '18999999999',
    address,
  });
  assert.equal(repo.get<any>(account.user.tenantId, 'settings', 'business').address.city, 'Assis');
  const trial = repo.get<any>(account.user.tenantId, 'billing', 'trial');
  assert.equal(trial.endsAt - trial.startedAt, 14 * 86400000);
  const later = await identity.google({
    ...identity.googleChallenge(),
    credential: 'credential-at-least-20-characters',
  });
  assert.equal(later.user.id, account.user.id);
});

test('discovery filters by city and state while allowing unrestricted manual searches', () => {
  process.env.DATABASE_PATH=':memory:';
  const repo=new DocumentRepository(), identity=new IdentityService(new Context(repo),new GoogleIdentity());
  for(const [slug,city,state] of [['one','São Paulo','SP'],['two','Assis','SP'],['three','Assis','RS']]) {
    repo.put('system','stores',slug,{tenantId:slug});
    repo.put(slug,'settings','business',{slug,businessName:`Loja ${slug}`,address:{city,state}});
  }
  assert.deepEqual(identity.discovery({city:'sao paulo',state:'SP'}).items.map(s=>s.slug),['one']);
  assert.deepEqual(identity.discovery({city:'Assis',state:'SP'}).items.map(s=>s.slug),['two']);
  assert.equal(identity.discovery({q:'Assis'}).items.length,2);
  assert.equal(identity.discovery({}).items.length,3);
});
