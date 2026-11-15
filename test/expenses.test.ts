import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { InsightsService } from '../dist/modules/insights/application/insights-service.js';
import { localDate } from '../dist/core/domain/policies.js';

function fixture() {
  process.env.DATABASE_PATH = ':memory:';
  const repository = new DocumentRepository();
  const service = new InsightsService(new Context(repository));
  const actor = {
    id: 'owner',
    tenantId: 'shop',
    role: 'admin' as const,
    name: 'Owner',
    email: 'owner@fixture.test',
    phone: '',
  };
  repository.put('shop', 'settings', 'business', { timezone: 'America/Sao_Paulo' });
  return { repository, service, actor };
}

test('expenses are validated, scoped to administrators and tenants, and safely retried by identifier', () => {
  const { repository, service, actor } = fixture();
  const key = randomUUID();
  const input = {
    description: 'Materiais',
    category: 'supplies',
    amountCents: 1250,
    paidOn: localDate(new Date()),
  };
  const saved = service.saveExpense(actor, key, input);
  assert.deepEqual(service.saveExpense(actor, key, input), saved);
  assert.equal(repository.list('shop', 'expenses').length, 1);
  for (const role of ['employee', 'customer'] as const) {
    assert.throws(() => service.saveExpense({ ...actor, role }, randomUUID(), input));
    assert.throws(() => service.removeExpense({ ...actor, role }, key));
    assert.throws(() => service.wallet({ ...actor, role }, {}));
  }
  assert.throws(() => service.removeExpense({ ...actor, tenantId: 'other' }, key));
  for (const amountCents of [0, -1, 1.5, 100_000_001]) {
    assert.throws(() => service.saveExpense(actor, randomUUID(), { ...input, amountCents }));
  }
  for (const paidOn of ['2026-02-30', '9999-01-01', 'bad']) {
    assert.throws(() => service.saveExpense(actor, randomUUID(), { ...input, paidOn }));
  }
  assert.throws(() => service.saveExpense(actor, randomUUID(), { ...input, tenantId: 'other' }));
  service.removeExpense(actor, key);
  assert.equal(repository.list('shop', 'expenses').length, 0);
});

test('cash uses payment dates, counts products and services once, and subtracts only period expenses', () => {
  const { repository, service, actor } = fixture();
  const now = new Date().toISOString();
  const old = '2000-01-01T12:00:00Z';
  const appointment = {
    id: 'service',
    customerName: 'Client',
    itemName: 'Service',
    priceCents: 10000,
    startsAt: old,
    endsAt: old,
    completedAt: old,
    status: 'completed',
    paymentStatus: 'paid',
    paidAt: now,
  };
  repository.put('shop', 'appointments', 'service', { ...appointment, orderId: 'mixed' });
  repository.put('shop', 'appointments', 'unpaid', {
    ...appointment,
    id: 'unpaid',
    completedAt: now,
    paymentStatus: 'pending',
  });
  repository.put('shop', 'appointments', 'advance', {
    ...appointment,
    id: 'advance',
    status: 'confirmed',
    priceCents: 2000,
  });
  repository.put('shop', 'appointments', 'undated', {
    ...appointment,
    id: 'undated',
    paidAt: undefined,
    priceCents: 3000,
  });
  repository.put('shop', 'appointments', 'old', {
    ...appointment,
    id: 'old',
    paidAt: old,
    priceCents: 4000,
  });
  repository.put('shop', 'appointments', 'cancelled', {
    ...appointment,
    id: 'cancelled',
    status: 'cancelled',
    priceCents: 500,
  });
  repository.put('other', 'appointments', 'foreign', {
    ...appointment,
    id: 'foreign',
    priceCents: 999999,
  });
  repository.put('shop', 'orders', 'mixed', {
    id: 'mixed',
    totalCents: 12000,
    discountCents: 0,
    customerName: 'Client',
    paymentStatus: 'paid',
    paidAt: now,
    status: 'completed',
    completedAt: now,
    items: [
      { kind: 'service', name: 'Service', quantity: 1, unitPriceCents: 10000 },
      { kind: 'product', name: 'Product', quantity: 2, unitPriceCents: 1000 },
    ],
  });
  service.saveExpense(actor, randomUUID(), {
    description: 'Materials',
    category: 'supplies',
    amountCents: 15000,
    paidOn: localDate(now),
  });
  service.saveExpense(actor, randomUUID(), {
    description: 'Old expense',
    category: 'rent',
    amountCents: 99999,
    paidOn: '2000-01-01',
  });
  repository.put('other', 'expenses', 'foreign', {
    id: 'foreign',
    amountCents: 999999,
    paidOn: localDate(now),
  });
  const wallet = service.wallet(actor, { days: 30 });
  assert.equal(wallet.cashReceivedCents, 14500);
  assert.equal(wallet.expenseCents, 15000);
  assert.equal(wallet.balanceCents, -500);
  assert.equal(wallet.undatedReceivedCents, 3000);
  assert.equal(wallet.cashEntries.length, 3);
  assert.equal(wallet.expenses.length, 1);
  assert.equal(wallet.unpaidCents, 10000);
});

test('discounted paid order total is counted once including cancelled services without an automatic refund', () => {
  const { repository, service, actor } = fixture();
  const now = new Date().toISOString();
  repository.put('shop', 'orders', 'discounted', {
    id: 'discounted',
    paymentStatus: 'paid',
    paidAt: now,
    totalCents: 9000,
    discountCents: 3000,
    customerName: 'Client',
    items: [
      { kind: 'service', name: 'Service', quantity: 1, unitPriceCents: 7500 },
      { kind: 'product', name: 'Product', quantity: 2, unitPriceCents: 750 },
    ],
  });
  repository.put('shop', 'appointments', 'service', {
    id: 'service',
    orderId: 'discounted',
    paymentStatus: 'paid',
    paidAt: now,
    priceCents: 7500,
    status: 'completed',
    endsAt: now,
  });
  repository.put('shop', 'appointments', 'cancelled-unpaid', {
    id: 'cancelled-unpaid',
    orderId: 'discounted',
    paymentStatus: 'pending',
    priceCents: 7500,
    status: 'cancelled',
  });
  const wallet = service.wallet(actor, { days: 30 });
  assert.equal(wallet.cashReceivedCents, 9000);
  assert.equal(wallet.cashEntries.length, 1);
  assert.equal(wallet.cashEntries[0].amountCents, 9000);
});

test('period includes exactly N local calendar dates and shares boundaries for receipts, production and expenses', () => {
  const { repository, service, actor } = fixture();
  const initial = service.wallet(actor, { days: 30 });
  const firstDate = initial.periodStart;
  assert.equal((Date.parse(initial.periodEnd) - Date.parse(firstDate)) / 86400000, 29);
  const previousDate = new Date(Date.parse(firstDate) - 86400000).toISOString().slice(0, 10);
  for (const [id, date] of [
    ['boundary', `${firstDate}T03:00:00Z`],
    ['outside', `${firstDate}T02:59:59Z`],
  ]) {
    repository.put('shop', 'appointments', id, {
      id,
      paymentStatus: 'paid',
      paidAt: date,
      status: 'completed',
      completedAt: date,
      priceCents: 1000,
    });
  }
  for (const [id, paidOn] of [
    ['boundary', firstDate],
    ['outside', previousDate],
  ]) {
    repository.put('shop', 'expenses', id, { id, amountCents: 500, paidOn, createdAt: paidOn });
  }
  const wallet = service.wallet(actor, { days: 30 });
  assert.equal(wallet.cashReceivedCents, 1000);
  assert.equal(wallet.earnedCents, 1000);
  assert.equal(wallet.expenseCents, 500);
  assert.equal(wallet.balanceCents, 500);
  const day = service.wallet(actor, { days: 1 });
  assert.equal(day.periodStart, day.periodEnd);
});
