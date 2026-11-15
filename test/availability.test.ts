import 'reflect-metadata';
import { freeSlots, scheduleWindow } from '../dist/modules/appointments/domain/availability.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Context } from '../dist/core/application/context.js';
import { DocumentRepository } from '../dist/core/infrastructure/document.repository.js';
import { ProfessionalsService } from '../dist/modules/professionals/professionals.module.js';
import { AppointmentsService } from '../dist/modules/appointments/application/appointments-service.js';
import { CheckoutService } from '../dist/modules/checkout/application/checkout-service.js';
function setup() {
  process.env.DATABASE_PATH = ':memory:';
  const repo = new DocumentRepository(),
    context = new Context(repo),
    staff = new ProfessionalsService(context),
    appointments = new AppointmentsService(context, staff),
    checkout = new CheckoutService(context, appointments);
  const owner = {
    id: 'owner',
    tenantId: 'availability',
    role: 'admin' as const,
    name: 'Owner',
    email: 'owner@fixture.test',
    phone: '18999999999',
  };
  const client = { ...owner, id: 'client', role: 'customer' as const };
  repo.put(owner.tenantId, 'customers', client.id, { ...client, addresses: [] });
  repo.put(owner.tenantId, 'settings', 'business', {
    name: 'Owner',
    timezone: 'America/Sao_Paulo',
    openingHour: 8,
    closingHour: 20,
    workDays: [0, 1, 2, 3, 4, 5, 6],
    payOnAppointment: true,
    payOnDelivery: true,
    pixKey: 'pix@fixture.test',
  });
  repo.put(owner.tenantId, 'catalog', 'cut', {
    id: 'cut',
    name: 'Cut',
    active: true,
    kind: 'service',
    durationMinutes: 45,
    priceCents: 5000,
  });
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const profile = {
    name: 'Staff',
    active: true,
    serviceIds: ['cut'],
    openingHour: 9,
    closingHour: 18,
    workDays: [0, 1, 2, 3, 4, 5, 6],
    breaks: [{ start: '12:00', end: '13:00' }],
    daysOff: [],
  };
  const professional = staff.save(owner, profile);
  const query = { itemId: 'cut', professionalId: professional.id, date };
  return { repo, staff, appointments, checkout, owner, client, date, profile, professional, query };
}
test('availability uses selected professional, duration, opening hours, breaks and reservations, without exposing customer data', () => {
  const { appointments, client, date, query, professional, repo } = setup();
  const booking = repo.transaction(() =>
    appointments.create(client, {
      itemId: 'cut',
      professionalId: professional.id,
      startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
    }),
  );
  const result = appointments.availability(client, query);
  const labels = result.slots.map((slot) => slot.label);
  assert.equal(result.durationMinutes, 45);
  assert.ok(labels.includes('09:00'));
  assert.ok(labels.includes('10:45'));
  assert.ok(labels.includes('17:15'));
  for (const label of [
    '08:00',
    '09:30',
    '09:45',
    '10:00',
    '10:15',
    '10:30',
    '11:30',
    '12:00',
    '12:45',
    '17:30',
  ])
    assert.equal(labels.includes(label), false, label);
  assert.equal(JSON.stringify(result).includes(client.id), false);
  appointments.transition(client, booking.id, { status: 'cancelled' });
  assert.ok(appointments.availability(client, query).slots.some((slot) => slot.label === '10:00'));
});
test('availability rejects incompatible service, foreign professional, invalid date and another customers reschedule exemption', () => {
  const { appointments, client, date, query, professional, repo } = setup();
  assert.throws(() => appointments.availability(client, { ...query, date: '2026-02-30' }));
  assert.throws(() => appointments.availability(client, { ...query, professionalId: 'foreign' }));
  repo.put(client.tenantId, 'catalog', 'other', {
    id: 'other',
    name: 'Other',
    active: true,
    kind: 'service',
    durationMinutes: 30,
    priceCents: 2000,
  });
  assert.throws(() => appointments.availability(client, { ...query, itemId: 'other' }));
  const booking = repo.transaction(() =>
    appointments.create(client, {
      itemId: 'cut',
      professionalId: professional.id,
      startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
    }),
  );
  assert.throws(() =>
    appointments.availability(
      { ...client, id: 'other-client' },
      { ...query, appointmentId: booking.id },
    ),
  );
  assert.ok(
    appointments
      .availability(client, { ...query, appointmentId: booking.id })
      .slots.some((slot) => slot.label === '10:00'),
  );
});
test('write validation uses the same breaks and days off as availability; different professionals remain independent', () => {
  const { appointments, staff, client, owner, date, query, profile, professional, repo } = setup();
  assert.throws(
    () =>
      repo.transaction(() =>
        appointments.create(client, {
          itemId: 'cut',
          professionalId: professional.id,
          startsAt: new Date(`${date}T12:00:00-03:00`).toISOString(),
        }),
      ),
    /expediente|intervalo/,
  );
  const second = staff.save(owner, { ...profile, name: 'Other Staff', breaks: [] });
  assert.doesNotThrow(() =>
    repo.transaction(() =>
      appointments.create(client, {
        itemId: 'cut',
        professionalId: second.id,
        startsAt: new Date(`${date}T12:00:00-03:00`).toISOString(),
      }),
    ),
  );
  staff.save(owner, { ...profile, daysOff: [date] }, professional.id);
  assert.equal(appointments.availability(client, query).slots.length, 0);
  assert.throws(
    () =>
      repo.transaction(() =>
        appointments.create(client, {
          itemId: 'cut',
          professionalId: professional.id,
          startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
        }),
      ),
    /expediente|folga/,
  );
});
test('reschedule keeps the linked order time synchronized and does not charge again', () => {
  const { appointments, checkout, client, date, professional, repo } = setup();
  const order = checkout.create(client, {
    items: [
      {
        itemId: 'cut',
        professionalId: professional.id,
        startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
        quantity: 1,
      },
    ],
    paymentMethod: 'on_day',
    idempotencyKey: randomUUID(),
  });
  const booking = appointments.list(client).find((item) => item.orderId === order.id)!;
  const next = `${date}T14:00:00.000-03:00`;
  const changed = appointments.transition(client, booking.id, {
    startsAt: new Date(next).toISOString(),
  });
  assert.equal(
    repo.get<any>(client.tenantId, 'orders', order.id).items[0].startsAt,
    changed.startsAt,
  );
  assert.equal(changed.paymentStatus, 'pending');
  assert.equal(repo.list(client.tenantId, 'orders').length, 1);
});

test('direct offline booking is idempotent, stays unpaid, and rejects a changed price before reserving', () => {
  const { appointments, client, date, professional, repo } = setup();
  const input = {
    itemId: 'cut',
    professionalId: professional.id,
    startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
    idempotencyKey: randomUUID(),
    expectedPriceCents: 5000,
  };
  assert.throws(
    () => repo.transaction(() => appointments.create(client, { ...input, expectedPriceCents: 1 })),
    /valor foi atualizado/,
  );
  assert.equal(appointments.list(client).length, 0);
  const first = repo.transaction(() => appointments.create(client, input));
  const retry = repo.transaction(() => appointments.create(client, input));
  assert.equal(first.id, retry.id);
  assert.equal(appointments.list(client).length, 1);
  assert.equal(first.status, 'confirmed');
  assert.equal(first.paymentStatus, 'pending');
  assert.equal(first.orderId, undefined);
  assert.equal(repo.list(client.tenantId, 'orders').length, 0);
  assert.throws(
    () => repo.transaction(() => appointments.create(client, { ...input, notes: 'Changed' })),
    /Chave já utilizada/,
  );
});
test('updating a profile preserves omitted exceptions, while explicit empty arrays clear them', () => {
  const { staff, owner, profile, professional, date } = setup();
  staff.save(owner, { ...profile, daysOff: [date] }, professional.id);
  const { breaks, daysOff, ...ordinary } = profile;
  const saved = staff.save(owner, { ...ordinary, name: 'Renamed' }, professional.id);
  assert.deepEqual(saved.breaks, profile.breaks);
  assert.deepEqual(saved.daysOff, [date]);
  const cleared = staff.save(owner, { ...ordinary, breaks: [], daysOff: [] }, professional.id);
  assert.deepEqual(cleared.breaks, []);
  assert.deepEqual(cleared.daysOff, []);
});
test('offline disabled rejects direct and checkout bookings; past and closed dates have no slots', () => {
  const { appointments, checkout, client, date, query, professional, repo } = setup();
  const settings = repo.get<any>(client.tenantId, 'settings', 'business');
  repo.put(client.tenantId, 'settings', 'business', { ...settings, payOnAppointment: false });
  const input = {
    itemId: 'cut',
    professionalId: professional.id,
    startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
  };
  assert.throws(() => repo.transaction(() => appointments.create(client, input)), /desabilitados/);
  assert.throws(
    () =>
      checkout.create(client, {
        items: [{ ...input, quantity: 1 }],
        paymentMethod: 'on_day',
        idempotencyKey: randomUUID(),
      }),
    /indisponível/,
  );
  assert.equal(appointments.list(client).length, 0);
  assert.equal(appointments.availability(client, { ...query, date: '2020-01-01' }).slots.length, 0);
  repo.put(client.tenantId, 'settings', 'business', { ...settings, workDays: [] });
  assert.equal(appointments.availability(client, query).slots.length, 0);
});

test('reschedule availability preserves the booked duration and price after the catalog changes', () => {
  const { appointments, client, date, query, professional, repo } = setup();
  const booking = repo.transaction(() =>
    appointments.create(client, {
      itemId: 'cut',
      professionalId: professional.id,
      startsAt: new Date(`${date}T10:00:00-03:00`).toISOString(),
    }),
  );
  const catalog = repo.get<any>(client.tenantId, 'catalog', 'cut');
  repo.put(client.tenantId, 'catalog', 'cut', {
    ...catalog,
    durationMinutes: 15,
    priceCents: 9000,
  });
  const result = appointments.availability(client, { ...query, appointmentId: booking.id });
  assert.equal(result.durationMinutes, 45);
  assert.equal(result.priceCents, 5000);
  assert.equal(
    result.slots.some((slot) => slot.label === '17:45'),
    false,
  );
});

test('slots ending at midnight fit the same local workday and never extend beyond closing', () => {
  const { repo, owner, profile, date } = setup();
  const settings = repo.get<any>(owner.tenantId, 'settings', 'business');
  const window = scheduleWindow(
    date,
    { ...settings, closingHour: 24 },
    { ...profile, id: 'night', openingHour: 22, closingHour: 24, breaks: [] },
  );
  const slots = freeSlots(window, 45, [], 'America/Sao_Paulo');
  assert.equal(slots.at(-1)?.label, '23:15');
  assert.equal(new Date(slots.at(-1)!.endsAt).getUTCHours(), 3);
  assert.equal(
    slots.some((slot) => slot.label === '23:30'),
    false,
  );
});

test('weekly hours intersect store and staff schedules and dated blocks affect only their date', () => {
  const { repo, owner, profile, date } = setup();
  const settings = repo.get<any>(owner.tenantId, 'settings', 'business');
  const day = new Date(date + 'T12:00:00Z').getUTCDay();
  const store = {...settings, weeklyHours:[{day, openingHour:7, closingHour:13}]};
  const staff = {...profile, id:'weekly', weeklyHours:[{day, openingHour:6, closingHour:18}], breaks:[{start:'10:00',end:'11:00',date}]};
  const slots = freeSlots(scheduleWindow(date, store, staff), 30, [], settings.timezone);
  assert.equal(slots[0].label, '07:00');
  assert.equal(slots.at(-1)?.label, '12:30');
  assert.equal(slots.some(slot => slot.label === '10:00'), false);
  assert.equal(scheduleWindow(date, {...store,weeklyHours:[]}, staff), undefined);
  const otherBlock = {...staff, breaks:[{start:'10:00',end:'11:00',date:'2000-01-01'}]};
  assert.equal(freeSlots(scheduleWindow(date,store,otherBlock),30,[],settings.timezone).some(slot => slot.label === '10:00'),true);
});
test('weekly schedule rejects duplicate days and reversed hours', async () => {
  const { weeklyHoursSchema } = await import('../dist/modules/settings/application/weekly-hours.schema.js');
  assert.equal(weeklyHoursSchema.safeParse([{day:1,openingHour:18,closingHour:7}]).success,false);
  assert.equal(weeklyHoursSchema.safeParse([{day:1,openingHour:7,closingHour:18},{day:1,openingHour:8,closingHour:20}]).success,false);
});
test('employee can persist only their own weekly schedule and dated blocks', () => {
  const { staff, owner, professional, profile, repo } = setup();
  const employee = {...owner, id:'employee-weekly', role:'employee' as const, professionalId:professional.id};
  const input = {openingHour:7,closingHour:18,workDays:[1],weeklyHours:[{day:1,openingHour:7,closingHour:18}],breaks:[{start:'10:00',end:'11:00',date:'2026-12-07'}],daysOff:[]};
  staff.save(employee,input,professional.id);
  assert.deepEqual(repo.get<any>(owner.tenantId,'professionals',professional.id).weeklyHours,input.weeklyHours);
  assert.equal(repo.get<any>(owner.tenantId,'professionals',professional.id).breaks[0].date,'2026-12-07');
  const other = staff.save(owner,{...profile,name:'Other staff'});
  assert.throws(() => staff.save(employee,input,other.id));
  assert.equal(repo.get<any>(owner.tenantId,'professionals',other.id).weeklyHours,undefined);
  assert.throws(() => staff.save(employee,{...input,active:false},professional.id));
});
