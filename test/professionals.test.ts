import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { ProfessionalsService } from '../dist/modules/professionals/professionals.module.js';
import { AppointmentsService } from '../dist/modules/appointments/application/appointments-service.js';
import { CheckoutService } from '../dist/modules/checkout/application/checkout-service.js';
import { randomUUID } from 'node:crypto';

test('three professionals accept the same time; overlaps, ineligible services and cross-store staff are rejected', () => {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository();
  const context = new Context(repo);
  const staff = new ProfessionalsService(context);
  const appointments = new AppointmentsService(context, staff);
  const checkout = new CheckoutService(context, appointments);
  const admin = {
    id: 'owner',
    tenantId: 'barbearia',
    role: 'admin' as const,
    name: 'Barbeiro 1',
    email: 'a@b.test',
    phone: '5518999999999',
  };
  const customer = { ...admin, id: 'buyer', role: 'customer' as const };
  repo.put(admin.tenantId, 'settings', 'business', {
    name: 'Barbeiro 1',
    timezone: 'America/Sao_Paulo',
    openingHour: 8,
    closingHour: 20,
    workDays: [0, 1, 2, 3, 4, 5, 6],
    payOnAppointment: true,
    pixKey: 'pix@test.local',
  });
  repo.put(admin.tenantId, 'customers', customer.id, { ...customer, addresses: [] });
  repo.put(admin.tenantId, 'catalog', 'cut', {
    id: 'cut',
    name: 'Corte',
    kind: 'service',
    active: true,
    durationMinutes: 30,
    priceCents: 5000,
  });
  repo.put(admin.tenantId, 'catalog', 'skin', {
    id: 'skin',
    name: 'Pele',
    kind: 'service',
    active: true,
    durationMinutes: 30,
    priceCents: 5000,
  });
  const profile = {
    name: 'Barbeiro 2',
    active: true,
    serviceIds: ['cut'],
    openingHour: 8,
    closingHour: 18,
    workDays: [0, 1, 2, 3, 4, 5, 6],
  };
  const second = staff.save(admin, profile);
  const third = staff.save(admin, { ...profile, name: 'Barbeiro 3' });
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const startsAt = `${date}T10:00:00-03:00`;
  const iso = new Date(startsAt).toISOString();
  const book = (professionalId: string, start = iso, itemId = 'cut') =>
    repo.transaction(() =>
      appointments.create(customer, { professionalId, itemId, startsAt: start }),
    );
  for (const professionalId of ['principal', second.id, third.id])
    assert.equal(book(professionalId).professionalId, professionalId);
  assert.equal(repo.list(admin.tenantId, 'appointments').length, 3);
  assert.throws(() => book(second.id), /reservado/);
  assert.throws(() => book(second.id, `${date}T13:15:00.000Z`), /reservado/);
  assert.doesNotThrow(() => book(second.id, `${date}T13:30:00.000Z`));
  assert.throws(() => book(second.id, `${date}T14:00:00.000Z`, 'skin'), /profissional/);
  assert.throws(() => book('outside-store', `${date}T14:00:00.000Z`), /profissional/);
  assert.throws(() => book(second.id, `${date}T22:00:00.000Z`), /expediente/);
  assert.throws(
    () => appointments.create(customer, { itemId: 'cut', startsAt: `${date}T14:00:00.000Z` }),
    /profissional/,
  );
  const thirdAppointment = appointments.list(admin).find((a) => a.professionalId === third.id)!;
  book(third.id, `${date}T14:00:00.000Z`);
  assert.throws(
    () =>
      appointments.transition(admin, thirdAppointment.id, { startsAt: `${date}T14:15:00.000Z` }),
    /reservado/,
  );
  appointments.transition(admin, thirdAppointment.id, { status: 'cancelled' });
  assert.doesNotThrow(() => book(third.id));
  const order = checkout.create(customer, {
    items: ['principal', second.id, third.id].map((professionalId) => ({
      itemId: 'cut',
      professionalId,
      quantity: 1,
      startsAt: `${date}T16:00:00.000Z`,
    })),
    paymentMethod: 'on_day',
    idempotencyKey: randomUUID(),
  });
  assert.equal(order.totalCents, 15000);
  assert.equal(appointments.list(admin).filter((a) => a.orderId === order.id).length, 3);
  const count = appointments.list(admin).length;
  assert.throws(
    () =>
      checkout.create(customer, {
        items: [1, 2].map(() => ({
          itemId: 'cut',
          professionalId: second.id,
          quantity: 1,
          startsAt: `${date}T17:00:00.000Z`,
        })),
        paymentMethod: 'on_day',
        idempotencyKey: randomUUID(),
      }),
    /reservado/,
  );
  assert.equal(appointments.list(admin).length, count);
  staff.save(admin, { ...profile, active: false }, second.id);
  assert.throws(() => book(second.id, `${date}T18:00:00.000Z`), /profissional/);
  assert.throws(() => staff.save(customer, profile), /administrador/);
  assert.throws(
    () => staff.save({ ...admin, tenantId: 'another' }, profile, third.id),
    /nesta loja/,
  );
  repo.put(admin.tenantId, 'appointments', 'legacy', {
    id: 'legacy',
    startsAt: `${date}T18:00:00.000Z`,
    endsAt: `${date}T18:30:00.000Z`,
    status: 'confirmed',
  });
  assert.throws(() => book('principal', `${date}T18:00:00.000Z`), /reservado/);
  assert.doesNotThrow(() => book(third.id, `${date}T18:00:00.000Z`));
});
