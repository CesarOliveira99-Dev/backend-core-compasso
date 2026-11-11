import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { queueAppointmentMail } from '../dist/modules/notifications/application/appointment-mail.js';
import { AppointmentMailWorker, ResendAppointmentMail, MailProviderRejected } from '../dist/modules/notifications/application/appointment-mail-worker.js';
import { emailQuota } from '../dist/core/application/email-quota.js';
import { ReminderWorker } from '../dist/modules/notifications/application/reminder-worker.js';
import { TriageService } from '../dist/modules/triage/application/triage-service.js';
import { AppointmentsService } from '../dist/modules/appointments/application/appointments-service.js';
import { ProfessionalsService } from '../dist/modules/professionals/professionals.module.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  Object.assign(process.env, { DATABASE_PATH: ':memory:', APPOINTMENT_EMAILS_ENABLED: 'true', RESEND_API_KEY: 'fixture', MAIL_FROM: 'Compasso <hello@fixture.test>', APP_URL: 'https://fixture.test' });
  const repo = new DocumentRepository();
  const context = new Context(repo);
  const now = Date.parse('2026-11-10T12:00:00Z');
  const actor = { tenantId: 'tenant', id: 'admin', role: 'admin', name: 'Admin', email: 'admin@fixture.test', phone: '' };
  const appointment = { id: 'booking', customerId: 'client', customerName: 'Client', itemId: 'service', itemName: 'Serviço', professionalName: 'Equipe', startsAt: '2026-11-10T12:45:00Z', endsAt: '2026-11-10T13:15:00Z', status: 'confirmed', paymentStatus: 'pending', priceCents: 1000, notes: 'PRIVATE NOTE', createdAt: '2026-11-10T11:59:00Z' };
  repo.put('system', 'stores', 'store', { tenantId: 'tenant' });
  repo.put('tenant', 'customers', 'admin', actor);
  repo.put('tenant', 'customers', 'client', { id: 'client', role: 'customer', name: 'Cliente', email: 'client@fixture.test', emailVerified: true });
  repo.put('tenant', 'settings', 'business', { businessName: 'Loja', timezone: 'America/Sao_Paulo', completionMode: 'manual' });
  repo.put('tenant', 'appointments', appointment.id, appointment);
  const queue = (kind: 'confirmation' | 'reminder' = 'confirmation') => queueAppointmentMail(context, actor as any, appointment as any, kind, now);
  const jobs = () => repo.list<any>('tenant', 'appointment_mail');
  return { repo, context, now, actor, appointment, queue, jobs, worker: new AppointmentMailWorker(context) };
}

test('queue persists one event, correct local time, no private notes and tenant-scoped keys', (t) => {
  const f = fixture(t);
  f.queue(); f.queue();
  assert.equal(f.jobs().length, 1);
  assert.match(f.jobs()[0].text, /09:45/);
  assert.ok(!f.jobs()[0].text.includes('PRIVATE NOTE'));
  f.repo.put('other', 'customers', 'client', f.repo.get('tenant', 'customers', 'client'));
  f.repo.put('other', 'settings', 'business', f.repo.get('tenant', 'settings', 'business'));
  queueAppointmentMail(f.context, { tenantId: 'other' }, f.appointment as any, 'confirmation', f.now);
  assert.notEqual(f.jobs()[0].id, f.repo.list<any>('other', 'appointment_mail')[0].id);
});

test('disabled, unverified and pending bookings never enqueue', (t) => {
  const f = fixture(t);
  process.env.APPOINTMENT_EMAILS_ENABLED = 'false'; f.queue();
  process.env.APPOINTMENT_EMAILS_ENABLED = 'true';
  queueAppointmentMail(f.context, f.actor as any, { ...f.appointment, status: 'pending' } as any, 'confirmation', f.now);
  f.repo.put('tenant', 'customers', 'client', { id: 'client', role: 'customer', emailVerified: false }); f.queue();
  assert.equal(f.jobs().length, 0);
});

test('booking, replay, reschedule and transaction rollback preserve the outbox', (t) => {
  const f = fixture(t);
  const settings = f.repo.get<any>('tenant', 'settings', 'business');
  f.repo.put('tenant', 'settings', 'business', { ...settings, openingHour: 8, closingHour: 20, workDays: [0,1,2,3,4,5,6], payOnAppointment: true });
  f.repo.put('tenant', 'catalog', 'cut', { id: 'cut', name: 'Cut', active: true, kind: 'service', durationMinutes: 30, priceCents: 5000 });
  const professionals = new ProfessionalsService(f.context);
  const professional = professionals.save(f.actor as any, { name: 'Equipe', active: true, serviceIds: ['cut'], openingHour: 8, closingHour: 20, workDays: [0,1,2,3,4,5,6], breaks: [], daysOff: [] });
  const service = new AppointmentsService(f.context, professionals);
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const input = { itemId: 'cut', customerId: 'client', professionalId: professional.id, startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(), idempotencyKey: 'f3b1edce-a829-49a6-8b5a-8acf2fab08ea' };
  const booking = f.repo.transaction(() => service.create(f.actor as any, input));
  f.repo.transaction(() => service.create(f.actor as any, input));
  assert.equal(f.jobs().length, 1);
  service.transition(f.actor as any, booking.id, { startsAt: new Date(`${date}T11:00:00-03:00`).toISOString() });
  assert.equal(f.jobs().length, 2);
  assert.throws(() => f.repo.transaction(() => { f.queue(); throw Error('rollback'); }));
  assert.equal(f.jobs().length, 2);
});

test('concurrent cycles cannot dispatch the same pending job twice', async (t) => {
  const f = fixture(t); f.queue();
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const first = f.worker.run(f.now, { send: async () => { calls++; await gate; } });
  await f.worker.run(f.now, { send: async () => { calls++; } });
  assert.equal(calls, 1);
  finish(); await first;
});

test('retry stops after six failures', async (t) => {
  const f = fixture(t); f.queue();
  const sender = { send: async () => { throw Error('unavailable'); } };
  for (let i = 0; i < 6; i++) await f.worker.run(f.jobs()[0].nextAttemptAt, sender);
  assert.equal(f.jobs()[0].state, 'failed');
  await f.worker.run(f.now + 2200000, { send: async () => { assert.fail('retry limit'); } });
});

test('worker retries identical persisted payload and does not resend after restart', async (t) => {
  const f = fixture(t); f.queue();
  const seen: any[] = [];
  await f.worker.run(f.now, { send: async (job) => { seen.push(job); throw Error('timeout'); } });
  assert.equal(f.jobs()[0].attempts, 1);
  await f.worker.run(f.now + 1000, { send: async () => { assert.fail('too early'); } });
  await new AppointmentMailWorker(f.context).run(f.now + 60000, { send: async (job) => { seen.push(job); } });
  assert.equal(seen[0].text, seen[1].text);
  assert.equal(seen[0].id, seen[1].id);
  assert.equal(f.jobs()[0].state, 'sent');
  await new AppointmentMailWorker(f.context).run(f.now + 120000, { send: async () => { assert.fail('duplicate'); } });
});

for (const change of ['cancelled', 'rescheduled', 'email-changed', 'unverified', 'customer-mismatch', 'expired']) {
  test(`worker skips ${change} booking safely`, async (t) => {
    const f = fixture(t); f.queue();
    if (change === 'cancelled') f.appointment.status = 'cancelled';
    if (change === 'rescheduled') f.appointment.startsAt = '2026-11-10T14:00:00Z';
    if (change === 'customer-mismatch') f.appointment.customerId = 'other';
    f.repo.put('tenant', 'appointments', 'booking', f.appointment);
    if (change === 'email-changed' || change === 'unverified') {
      const customer = f.repo.get<any>('tenant', 'customers', 'client');
      f.repo.put('tenant', 'customers', 'client', { ...customer, email: change === 'email-changed' ? 'other@fixture.test' : customer.email, emailVerified: change !== 'unverified' });
    }
    await f.worker.run(f.now + (change === 'expired' ? 24 * 3600000 : 0), { send: async () => { assert.fail('stale mail'); } });
    assert.equal(f.jobs()[0].state, 'skipped');
  });
}

test('hourly reminders enqueue once and cancelled or triage bookings do not trigger', (t) => {
  const f = fixture(t);
  const worker = new ReminderWorker(f.context);
  worker.run(new Date(f.now)); worker.run(new Date(f.now));
  assert.equal(f.jobs().length, 1);
  assert.equal(f.jobs()[0].kind, 'reminder');
  f.repo.put('tenant', 'appointments', 'pending', { ...f.appointment, id: 'pending', status: 'pending' });
  f.repo.put('tenant', 'appointments', 'cancelled', { ...f.appointment, id: 'cancelled', status: 'cancelled' });
  worker.run(new Date(f.now));
  assert.equal(f.jobs().length, 1);
});

test('triage approval queues confirmation with the appointment transaction', (t) => {
  const f = fixture(t);
  f.repo.put('tenant', 'appointments', 'booking', { ...f.appointment, status: 'pending' });
  f.repo.put('tenant', 'triage', 'triage', { id: 'triage', customerId: 'client', appointmentId: 'booking', status: 'pending' });
  new TriageService(f.context).decide(f.actor as any, 'triage', { status: 'approved', decision: 'Aprovado' });
  assert.equal(f.jobs()[0].kind, 'confirmation');
});

test('transport sends stable provider idempotency key and handles rejection', async (t) => {
  const f = fixture(t); f.queue();
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal((init.headers as any)['Idempotency-Key'], `appointment/${f.jobs()[0].id}`);
    assert.equal(JSON.parse(init.body as string).to[0], 'client@fixture.test');
    return new Response('', { status: 429 });
  }) as typeof fetch;
  await assert.rejects(() => new ResendAppointmentMail().send(f.jobs()[0]), /429/);
});

test('full quota defers mail without consuming retries or cancelling the appointment', async t => {
  const f = fixture(t); f.queue();
  f.repo.put('tenant', 'billing', 'subscription', { planId: 'essencial', paidThrough: f.now + 86400000 });
  const quota = emailQuota(f.repo, 'tenant', f.now);
  f.repo.put('tenant', 'email_usage', quota.day, { count: 100 });
  await f.worker.run(f.now, { send: async () => assert.fail('quota should prevent provider call') });
  assert.equal(f.jobs()[0].attempts, 0); assert.equal(f.jobs()[0].state, 'pending');
  assert.equal(f.repo.get<any>('tenant', 'appointments', 'booking').status, 'confirmed');
});

test('definite first rejection releases quota, but rejection after an uncertain delivery preserves the reservation', async t => {
  const f = fixture(t); f.queue();
  await f.worker.run(f.now, { send: async () => { throw new MailProviderRejected('429'); } });
  assert.equal(emailQuota(f.repo, 'tenant', f.now).monthly.used, 0);
  await f.worker.run(f.now + 60000, { send: async () => { throw new Error('unknown delivery'); } });
  assert.equal(emailQuota(f.repo, 'tenant', f.now).monthly.used, 1);
  await f.worker.run(f.now + 180000, { send: async () => { throw new MailProviderRejected('409'); } });
  assert.equal(emailQuota(f.repo, 'tenant', f.now).monthly.used, 1);
});
