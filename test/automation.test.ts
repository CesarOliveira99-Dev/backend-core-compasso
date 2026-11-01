import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { ReminderWorker } from '../dist/modules/notifications/application/reminder-worker.js';
test('automatic completion respects end time and confirmation, preserves payment and deduplicates messages', () => {
  process.env.DATABASE_PATH = ':memory:';
  const repository = new DocumentRepository();
  const context = new Context(repository);
  const worker = new ReminderWorker(context);
  const admin = {
    id: 'admin',
    tenantId: 'tenant',
    role: 'admin',
    name: 'Admin',
    email: 'admin@test.local',
    phone: '5511999999999',
  };
  repository.put('system', 'stores', 'test', { tenantId: 'tenant' });
  repository.put('tenant', 'customers', 'admin', admin);
  repository.put('tenant', 'settings', 'business', {
    completionMode: 'automatic',
    timezone: 'America/Sao_Paulo',
  });
  const appointment = {
    id: 'finished',
    customerId: 'customer',
    customerName: 'Customer',
    itemName: 'Service',
    startsAt: '2026-10-31T12:00:00Z',
    endsAt: '2026-10-31T13:00:00Z',
    status: 'confirmed',
    paymentStatus: 'pending',
  };
  repository.put('tenant', 'appointments', appointment.id, appointment);
  repository.put('tenant', 'appointments', 'triage', {
    ...appointment,
    id: 'triage',
    status: 'pending',
  });
  repository.put('tenant', 'appointments', 'upcoming', {
    ...appointment,
    id: 'upcoming',
    endsAt: '2026-10-31T16:00:00Z',
  });
  worker.run(new Date('2026-10-31T14:00:00Z'));
  worker.run(new Date('2026-10-31T14:00:00Z'));
  assert.equal(repository.get('tenant', 'appointments', 'finished').status, 'completed');
  assert.equal(repository.get('tenant', 'appointments', 'finished').paymentStatus, 'pending');
  assert.equal(repository.get('tenant', 'appointments', 'triage').status, 'pending');
  assert.equal(repository.get('tenant', 'appointments', 'upcoming').status, 'confirmed');
  assert.equal(
    repository
      .list('tenant', 'notifications')
      .filter((n: { key: string }) => n.key === 'feedback:finished').length,
    1,
  );
});
