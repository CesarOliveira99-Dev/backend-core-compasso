import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { CustomerHistory } from '../dist/modules/identity/application/customer-history.js';
import type { Actor } from '../dist/core/domain/models.js';

function fixture() {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository();
  const history = new CustomerHistory(new Context(repo));
  const person: Actor = { id: 'person', identityId: 'person', tenantId: 'personal', role: 'customer', name: 'Cliente', email: 'client@fixture.test', phone: '' };
  for (const tenantId of ['first', 'second']) {
    repo.put('system', 'stores', tenantId, { tenantId });
    repo.put(tenantId, 'settings', 'business', { slug: tenantId, businessName: `Loja ${tenantId}`, timezone: 'America/Sao_Paulo' });
    repo.put(tenantId, 'customers', 'member', { ...person, id: 'member', tenantId, addresses: [], passwordHash: 'SECRET' });
    repo.put(tenantId, 'catalog', 'service', { id: 'service', kind: 'service', active: true, media: [{ type: 'image', url: '/api/media/fixture' }] });
    repo.put(tenantId, 'appointments', 'appointment', { id: 'appointment', customerId: 'member', itemId: 'service', itemName: 'Corte', professionalName: 'Ana', startsAt: '2026-11-10T13:00:00Z', endsAt: '2026-11-10T14:00:00Z', status: 'completed', completedAt: tenantId === 'second' ? '2026-11-10T14:00:00Z' : '2026-11-09T14:00:00Z', notes: 'PRIVATE' });
  }
  return { repo, history, person };
}

test('personal home gets most recently completed visit across proven memberships with minimal data', () => {
  const f = fixture();
  const visit = f.history.latest(f.person)!;
  assert.equal(visit.store.slug, 'second');
  assert.equal(visit.service.image, '/api/media/fixture');
  assert.equal(visit.professionalName, 'Ana');
  assert.equal(visit.review, null);
  assert.ok(!JSON.stringify(visit).includes('PRIVATE'));
  assert.ok(!JSON.stringify(visit).includes('SECRET'));
  assert.ok(!JSON.stringify(visit).includes('client@fixture.test'));
});

test('same email does not grant history and foreign review keys cannot cross identities', () => {
  const f = fixture();
  const key = f.history.latest(f.person)!.key;
  const stranger = { ...f.person, id: 'stranger', identityId: 'stranger' };
  assert.equal(f.history.latest(stranger), null);
  assert.throws(() => f.history.review(stranger, { key, rating: 5, comment: 'Bom atendimento' }), /não encontrado/);
  assert.equal(f.repo.list('second', 'feedback').length, 0);
});

test('direct review from personal home uses correct store/member and cannot be duplicated', () => {
  const f = fixture();
  const key = f.history.latest(f.person)!.key;
  f.history.review(f.person, { key, rating: 4, comment: 'Ótimo cuidado', published: false, tenantId: 'first', appointmentId: 'foreign' });
  assert.equal(f.repo.list('first', 'feedback').length, 0);
  const saved = f.repo.list<any>('second', 'feedback')[0];
  assert.equal(saved.customerId, 'member');
  assert.equal(saved.appointmentId, 'appointment');
  assert.equal(saved.published, false);
  assert.deepEqual(f.history.latest(f.person)!.review, { rating: 4 });
  assert.throws(() => f.history.review(f.person, { key, rating: 5, comment: 'Repetido' }), /já foi avaliado/);
  assert.equal(f.repo.list('second', 'feedback').length, 1);
});

test('pending/cancelled visits, inactive memberships and staff roles are excluded', () => {
  const f = fixture();
  f.repo.put('second', 'customers', 'member', { ...f.repo.get<any>('second', 'customers', 'member'), active: false });
  assert.equal(f.history.latest(f.person)!.store.slug, 'first');
  f.repo.put('first', 'appointments', 'appointment', { ...f.repo.get<any>('first', 'appointments', 'appointment'), status: 'confirmed' });
  assert.equal(f.history.latest(f.person), null);
  assert.throws(() => f.history.latest({ ...f.person, role: 'admin' }), /exclusiva/);
});

test('legacy current-store customer remains eligible without merging other accounts', () => {
  const f = fixture();
  f.repo.put('first', 'customers', 'legacy', { ...f.person, id: 'legacy', identityId: undefined, tenantId: 'first' });
  f.repo.put('first', 'appointments', 'legacy-visit', { ...f.repo.get<any>('first', 'appointments', 'appointment'), id: 'legacy-visit', customerId: 'legacy' });
  assert.equal(f.history.latest({ ...f.person, id: 'legacy', identityId: undefined, tenantId: 'first' })!.appointmentId, 'legacy-visit');
});

test('inactive or removed services keep history while disabling repeat booking', () => {
  const f = fixture();
  f.repo.remove('second', 'catalog', 'service');
  const visit = f.history.latest(f.person)!;
  assert.equal(visit.service.available, false);
  assert.equal(visit.service.name, 'Corte');
  assert.equal(visit.service.image, undefined);
});
