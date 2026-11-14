import { recommendationStatus } from '../dist/modules/feedback/domain/reputation.js';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { IdentityService } from '../dist/modules/identity/application/identity-service.js';
import { GoogleIdentity } from '../dist/modules/identity/application/google-identity.js';
import { MediaService } from '../dist/modules/media/media.module.js';
import { CatalogService } from '../dist/modules/catalog/application/catalog-service.js';
import { FeedbackService } from '../dist/modules/feedback/application/feedback-service.js';
function setup() {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository(),
    context = new Context(repo);
  const identity = new IdentityService(context, new GoogleIdentity());
  const owner = identity.register({
    name: 'Owner Test',
    email: 'owner@test.local',
    password: 'TestPass123',
    phone: '18999999999',
    role: 'admin',
    slug: 'studio',
  }).user;
  const customer = identity.register({
    name: 'Ana Silva',
    email: 'ana@test.local',
    password: 'TestPass123',
    phone: '18999999998',
    role: 'customer',
    slug: 'studio',
  }).user;
  const catalog = new CatalogService(context, new MediaService(context));
  const feedback = new FeedbackService(context);
  function appointment(
    id: string,
    status = 'completed',
    days = 2,
    itemId = 'cut',
    tenantId = owner.tenantId,
  ) {
    repo.put(tenantId, 'appointments', id, {
      id,
      customerId: customer.id,
      itemId,
      itemName: 'Corte',
      status,
      startsAt: new Date(Date.now() - days * 86400000).toISOString(),
    });
  }
  return { repo, owner, customer, catalog, feedback, appointment };
}
test('popular services use recent confirmed or completed appointments, excluding cancellations, pending, future and other tenants', () => {
  const { repo, owner, customer, catalog, appointment } = setup();
  const service = {
    name: 'Corte',
    kind: 'service',
    category: 'Cabelo',
    priceCents: 4500,
    durationMinutes: 30,
    active: true,
  };
  catalog.save(owner, service, 'cut');
  catalog.save(owner, { ...service, name: 'Barba' }, 'beard');
  appointment('one');
  appointment('two', 'confirmed');
  appointment('cancel', 'cancelled');
  appointment('pending', 'pending');
  appointment('old', 'completed', 91);
  appointment('future', 'confirmed', -2);
  appointment('other', 'completed', 1, 'cut', 'other-tenant');
  appointment('beard', 'completed', 2, 'beard');
  const list = catalog.list(customer);
  assert.equal(list.find((item) => item.id === 'cut')?.popularityCount, 2);
  assert.equal(list.find((item) => item.id === 'beard')?.popularityCount, 1);
  assert.equal(repo.list(owner.tenantId, 'appointments').length, 7);
});
test('public store reviews contain only opted-in verified comments and aggregate every verified score without private identifiers', () => {
  const { repo, owner, customer, feedback, appointment } = setup();
  appointment('public');
  appointment('private');
  appointment('pending', 'pending');
  feedback.create(customer, {
    appointmentId: 'public',
    rating: 5,
    comment: 'Atendimento excelente.',
    published: true,
  });
  feedback.create(customer, {
    appointmentId: 'private',
    rating: 3,
    comment: 'Comentário reservado.',
  });
  repo.put(owner.tenantId, 'feedback', 'forged', {
    id: 'forged',
    appointmentId: 'pending',
    customerId: customer.id,
    customerName: 'Ana Silva',
    rating: 5,
    comment: 'Não verificado',
    published: true,
    createdAt: new Date().toISOString(),
  });
  const result = feedback.storeReviews(customer, {});
  assert.equal(result.summary.count, 2);
  assert.equal(result.summary.average, 4);
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].customerName, 'Ana');
  assert.equal(JSON.stringify(result).includes(customer.id), false);
  assert.equal(JSON.stringify(result).includes('Comentário reservado'), false);
  assert.equal(result.summary.distribution[5], 1);
  assert.equal(feedback.storeReviews({ ...customer, tenantId: 'empty' }, {}).summary.count, 0);
  assert.throws(() =>
    feedback.create(customer, { appointmentId: 'pending', rating: 6, comment: 'Nota inválida' }),
  );
});
test('Compasso recommendation requires 4.8, ten verified appointments and an active paid entitlement; score changes or expiry revoke it', () => {
  const { repo, owner, customer, feedback, appointment } = setup();
  for (let i = 0; i < 10; i++) {
    appointment(`review-${i}`);
    feedback.create(customer, {
      appointmentId: `review-${i}`,
      rating: i === 0 ? 3 : 5,
      comment: 'Avaliação de teste.',
    });
  }
  let result = feedback.storeReviews(customer, {});
  assert.equal(result.recommendation.qualified, true);
  assert.equal(result.recommendation.active, false);
  repo.put(owner.tenantId, 'platform_entitlements', 'recommendation', {
    status: 'active',
    paid: true,
    paymentId: 'verified-test-payment',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  result = feedback.storeReviews(customer, {});
  assert.equal(result.recommendation.active, true);
  appointment('low');
  feedback.create(customer, { appointmentId: 'low', rating: 1, comment: 'Precisa melhorar.' });
  assert.equal(feedback.storeReviews(customer, {}).recommendation.active, false);
  repo.put(owner.tenantId, 'platform_entitlements', 'recommendation', {
    status: 'active',
    paid: true,
    paymentId: 'verified-test-payment',
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal(feedback.storeReviews(customer, {}).recommendation.paidAddonActive, false);
});

test('recommendation uses the unrounded score, minimum count and strictly valid paid expiry', () => {
  const now = Date.now();
  const entitlement = {
    status: 'active',
    paid: true,
    paymentId: 'verified-fixture',
    expiresAt: new Date(now + 1000).toISOString(),
  };
  const summary = { count: 10, average: 4.8, distribution: {} };
  assert.equal(recommendationStatus({ ...summary, count: 9 }, entitlement, now).active, false);
  assert.equal(
    recommendationStatus({ ...summary, average: 4.799 }, entitlement, now).active,
    false,
  );
  assert.equal(recommendationStatus(summary, entitlement, now).active, true);
  assert.equal(recommendationStatus(summary, { ...entitlement, paid: false }, now).active, false);
  assert.equal(
    recommendationStatus(summary, { ...entitlement, expiresAt: new Date(now).toISOString() }, now)
      .active,
    false,
  );
});
