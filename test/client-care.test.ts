import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DocumentRepository } from "../dist/core/infrastructure/document.repository.js";
import { Context } from "../dist/core/application/context.js";
import { IdentityService } from "../dist/modules/identity/application/identity-service.js";
import { GoogleIdentity } from "../dist/modules/identity/application/google-identity.js";
import { AppointmentsService } from "../dist/modules/appointments/application/appointments-service.js";
import { ProfessionalsService } from "../dist/modules/professionals/professionals.module.js";
import { WorkspaceService } from "../dist/modules/workspace/application/workspace-service.js";
import { ClientCareService } from "../dist/modules/workspace/application/client-care-service.js";
import {
  addCalendarDays,
  clientSummary,
  renderReminder,
} from "../dist/modules/workspace/domain/client-care.js";
import type { Actor, Appointment } from "../dist/core/domain/models.js";
process.env.DATABASE_PATH = ":memory:";
function setup() {
  const repo = new DocumentRepository(),
    context = new Context(repo),
    identity = new IdentityService(context, new GoogleIdentity()),
    owner = identity.register({
      role: "admin",
      workspaceMode: "solo",
      name: "Pessoa da Agenda",
      phone: "11999991234",
      email: randomUUID() + "@test.local",
      password: "StrongPassword123",
    }).user,
    appointments = new AppointmentsService(
      context,
      new ProfessionalsService(context),
    ),
    workspace = new WorkspaceService(context),
    care = new ClientCareService(context, workspace, appointments);
  const customer = workspace.createContact(owner, {
    idempotencyKey: randomUUID(),
    name: "Cliente da Agenda",
    phone: "11999991234",
  });
  repo.put(owner.tenantId, "catalog", "cut", {
    id: "cut",
    kind: "service",
    name: "Corte",
    category: "Atendimento",
    priceCents: 6000,
    durationMinutes: 60,
    active: true,
    requiresTriage: false,
  });
  const date = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10),
    at = (clock = "10:00", day = date) =>
      new Date(day + "T" + clock + ":00-03:00").toISOString();
  const booking = (clock = "10:00", day = date) =>
    appointments.create(owner, {
      itemId: "cut",
      customerId: customer.id,
      professionalId: "principal",
      startsAt: at(clock, day),
    });
  return {
    repo,
    context,
    identity,
    owner,
    appointments,
    workspace,
    care,
    customer,
    date,
    at,
    booking,
  };
}
test("templates whitelist variables, preserve inserted braces, respect timezone, optimistic revision and never send messages", () => {
  const f = setup(),
    a = f.booking();
  const saved = f.care.saveTemplate(f.owner, {
    revision: 0,
    template:
      "Olá {nome}: {servico}, {data} às {horario}, {profissional}, {estabelecimento}.",
  });
  assert.equal(saved.revision, 1);
  const message = f.care.reminder(f.owner, a.id, {});
  assert.equal(message.phone, "11999991234");
  assert.equal(message.automatic, false);
  assert.match(message.message, /10:00/);
  assert.match(message.message, /Cliente da Agenda/);
  assert.throws(
    () => f.care.saveTemplate(f.owner, { revision: 0, template: "Outra" }),
    /mudou/,
  );
  for (const template of ["{telefone}", "{nome", "nome}", "{{nome}}", ""])
    assert.throws(() => f.care.reminder(f.owner, a.id, { template }));
  assert.equal(f.repo.list(f.owner.tenantId, "manual_messages").length, 0);
  const values = {
    nome: "Cliente {servico}",
    servico: "Corte",
    data: "01/01",
    horario: "10:00",
    profissional: "Ana",
    estabelecimento: "Loja",
  };
  assert.equal(renderReminder("{nome}", values), "Cliente {servico}");
});
test("return forecasts use last completed service, ignore cancelled visits and suppress alerts after scheduling", () => {
  const f = setup(),
    past = f.booking();
  const completed = {
    ...past,
    startsAt: new Date(Date.now() - 40 * 86400000).toISOString(),
    endsAt: new Date(Date.now() - 40 * 86400000 + 3600000).toISOString(),
    status: "completed",
  };
  f.repo.put(f.owner.tenantId, "appointments", past.id, completed);
  f.care.saveReturn(f.owner, {
    customerId: f.customer.id,
    itemId: "cut",
    professionalId: "principal",
    intervalDays: 30,
    revision: 0,
  });
  assert.equal(f.care.returns(f.owner)[0].state, "overdue");
  f.booking("12:00");
  assert.equal(f.care.returns(f.owner)[0].state, "scheduled");
  assert.throws(
    () =>
      f.care.saveReturn(f.owner, {
        customerId: f.customer.id,
        itemId: "cut",
        professionalId: "principal",
        intervalDays: 30,
        revision: 0,
      }),
    /mudou/,
  );
  assert.equal(addCalendarDays("2028-02-28", 2), "2028-03-01");
});
test("blocks remove availability and prevent create/reschedule, preserve adjacent slots and can be released safely", () => {
  const f = setup(),
    body = {
      idempotencyKey: randomUUID(),
      title: "Compromisso pessoal",
      professionalId: "principal",
      startsAt: f.at("10:00"),
      endsAt: f.at("11:00"),
    };
  const block = f.care.createBlock(f.owner, body);
  assert.deepEqual(f.care.createBlock(f.owner, body), block);
  assert.equal(f.care.blocks(f.owner).length, 1);
  assert.throws(() => f.booking(), /reservado/);
  const slots = f.appointments.availability(f.owner, {
    itemId: "cut",
    professionalId: "principal",
    date: f.date,
  }).slots;
  assert.ok(!slots.some((s) => s.label === "10:00"));
  assert.ok(slots.some((s) => s.label === "11:00"));
  const a = f.booking("12:00");
  assert.throws(
    () => f.appointments.transition(f.owner, a.id, { startsAt: f.at("10:30") }),
    /reservado/,
  );
  assert.throws(
    () =>
      f.care.createBlock(f.owner, {
        ...body,
        idempotencyKey: randomUUID(),
        startsAt: f.at("12:00"),
        endsAt: f.at("13:00"),
      }),
    /reserva/,
  );
  assert.throws(
    () => f.care.removeBlock(f.owner, block.id, { revision: 0 }),
    /mudou/,
  );
  f.care.removeBlock(f.owner, block.id, { revision: 1 });
  assert.ok(f.booking());
});
test("recurring series is atomic, bounded, preserves local time and is idempotent", () => {
  const f = setup(),
    body = {
      itemId: "cut",
      customerId: f.customer.id,
      professionalId: "principal",
      startsAt: f.at("23:30"),
      durationMinutes: 90,
      idempotencyKey: randomUUID(),
      intervalWeeks: 1,
      count: 3,
    };
  const result = f.care.series(f.owner, body);
  assert.equal(result.count, 3);
  assert.deepEqual(
    f.care.series(f.owner, body),
    JSON.parse(JSON.stringify(result)),
  );
  assert.equal(f.repo.list(f.owner.tenantId, "appointments").length, 3);
  for (const a of result.appointments) {
    assert.equal(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(a.startsAt)),
      "23:30",
    );
    assert.equal(Date.parse(a.endsAt) - Date.parse(a.startsAt), 90 * 60000);
  }
  assert.throws(() => f.care.series(f.owner, { ...body, count: 4 }), /Chave/);
  const other = setup();
  other.booking("10:00", addCalendarDays(other.date, 7));
  assert.throws(
    () =>
      other.care.series(other.owner, {
        ...body,
        idempotencyKey: randomUUID(),
        customerId: other.customer.id,
        startsAt: other.at(),
        durationMinutes: 60,
      }),
    /reservado/,
  );
  assert.equal(other.repo.list(other.owner.tenantId, "appointments").length, 1);
  for (const count of [0, 1, 13])
    assert.throws(() =>
      f.care.series(f.owner, { ...body, idempotencyKey: randomUUID(), count }),
    );
});
test("waitlist suggestions obey date and time preferences and revalidate before booking; replay does not duplicate", () => {
  const f = setup(),
    body = {
      idempotencyKey: randomUUID(),
      customerId: f.customer.id,
      itemId: "cut",
      professionalId: "principal",
      from: f.date,
      to: f.date,
      after: "10:00",
      before: "12:00",
    };
  const entry = f.care.createWait(f.owner, body);
  assert.deepEqual(f.care.createWait(f.owner, body), entry);
  let suggestions = f.care.suggestions(f.owner, entry.id);
  assert.ok(suggestions.length);
  f.care.createBlock(f.owner, {
    idempotencyKey: randomUUID(),
    professionalId: "principal",
    title: "Bloqueio",
    startsAt: f.at("10:00"),
    endsAt: f.at("11:00"),
  });
  assert.throws(
    () =>
      f.care.bookWait(f.owner, entry.id, {
        idempotencyKey: randomUUID(),
        revision: 1,
        startsAt: suggestions[0].startsAt,
      }),
    /disponível/,
  );
  suggestions = f.care.suggestions(f.owner, entry.id);
  assert.equal(suggestions[0].label, "11:00");
  const request = {
    idempotencyKey: randomUUID(),
    revision: 1,
    startsAt: suggestions[0].startsAt,
  };
  const booked = f.care.bookWait(f.owner, entry.id, request);
  assert.equal(f.care.bookWait(f.owner, entry.id, request).id, booked.id);
  assert.equal(f.repo.list(f.owner.tenantId, "appointments").length, 1);
  assert.equal(f.care.waitlist(f.owner)[0].status, "booked");
  assert.deepEqual(f.care.suggestions(f.owner, entry.id), []);
  assert.throws(() =>
    f.care.createWait(f.owner, {
      ...body,
      idempotencyKey: randomUUID(),
      to: "2026-02-31",
    }),
  );
});
test("staff and workspace boundaries protect contacts, templates, histories, blocks and waiting entries", () => {
  const f = setup(),
    other = f.identity.register({
      role: "admin",
      workspaceMode: "solo",
      name: "Outro Espaço",
      phone: "11999991234",
      email: randomUUID() + "@test.local",
      password: "StrongPassword123",
    }).user;
  const a = f.booking();
  const customerActor = {
    ...f.owner,
    id: f.customer.id,
    role: "customer",
  } as Actor;
  const employee = {
    ...f.owner,
    id: "employee",
    role: "employee",
    professionalId: "other",
  } as Actor;
  assert.throws(() => f.care.customer(other, f.customer.id));
  assert.throws(() => f.care.reminder(other, a.id, {}));
  for (const actor of [customerActor, employee]) {
    assert.throws(() => f.care.customer(actor, f.customer.id));
    assert.throws(() => f.care.reminder(actor, a.id, {}));
    assert.throws(() =>
      f.care.createBlock(actor, {
        idempotencyKey: randomUUID(),
        title: "Privado",
        professionalId: "principal",
        startsAt: f.at(),
        endsAt: f.at("11:00"),
      }),
    );
    assert.throws(() =>
      f.care.saveReturn(actor, {
        customerId: f.customer.id,
        itemId: "cut",
        professionalId: "principal",
        intervalDays: 30,
        revision: 0,
      }),
    );
  }
  assert.throws(() => f.care.template(customerActor));
  assert.throws(() => f.care.template(employee));
  f.care.saveTemplate(f.owner, { revision: 0, template: "Privado {nome}" });
  assert.deepEqual(f.care.blocks(other), []);
});
test("missing attendance is separate from cancellation, cannot mark future/completed, preserves payment and is idempotent", () => {
  const f = setup(),
    a = f.booking();
  assert.throws(() => f.care.missed(f.owner, a.id), /após/);
  const past = {
    ...a,
    startsAt: new Date(Date.now() - 2 * 3600000).toISOString(),
    endsAt: new Date(Date.now() - 3600000).toISOString(),
    paymentStatus: "paid" as const,
  };
  f.repo.put(f.owner.tenantId, "appointments", a.id, past);
  const missed = f.care.missed(f.owner, a.id);
  assert.equal(missed.attendanceOutcome, "no_show");
  assert.equal(missed.paymentStatus, "paid");
  assert.deepEqual(f.care.missed(f.owner, a.id), missed);
  const summary = f.care.customer(f.owner, f.customer.id).summary;
  assert.equal(summary.missed, 1);
  assert.equal(summary.cancelled, 0);
  assert.equal(summary.productionCents, 0);
  assert.equal(f.workspace.analytics(f.owner, { days: 7 }).missed, 1);
});
test("employee only sees their own store history and cannot book recurring or waitlist on behalf of customers", () => {
  const f = setup(),
    settings = f.context.settings(f.owner);
  f.repo.put(f.owner.tenantId, "settings", "business", {
    ...settings,
    workspaceMode: "store",
  });
  f.repo.put(f.owner.tenantId, "professionals", "p", {
    id: "p",
    active: true,
    name: "Profissional",
    serviceIds: [],
    workDays: [0, 1, 2, 3, 4, 5, 6],
    openingHour: 0,
    closingHour: 24,
  });
  const a = f.booking();
  f.repo.put(f.owner.tenantId, "appointments", a.id, {
    ...a,
    professionalId: "p",
    status: "completed",
    startsAt: new Date(Date.now() - 86400000).toISOString(),
  });
  const other = {
    ...a,
    id: "other",
    professionalId: "another",
    status: "completed",
  };
  f.repo.put(f.owner.tenantId, "appointments", other.id, other);
  const employee = {
    ...f.owner,
    id: "employee",
    role: "employee",
    professionalId: "p",
  } as Actor;
  assert.equal(f.care.customer(employee, f.customer.id).summary.completed, 1);
  assert.equal(f.care.template(employee).revision, 0);
  assert.throws(() =>
    f.care.series(employee, {
      itemId: "cut",
      customerId: f.customer.id,
      professionalId: "p",
      startsAt: f.at(),
      count: 2,
      intervalWeeks: 1,
      idempotencyKey: randomUUID(),
    }),
  );
  assert.throws(() => f.care.reminder(employee, "other", {}));
});
test("named reminder models support selection, manual overrides and safe deletion with revisions", () => {
  const f = setup(),
    a = f.booking();
  const models = [
    {
      id: "confirm",
      title: "Confirmar horário",
      message: "Olá {nome}, dia {data} às {horario}.",
    },
    {
      id: "thanks",
      title: "Orientações",
      message: "Olá {nome}, seu serviço é {servico}.",
    },
  ];
  const result = f.care.saveTemplate(f.owner, {
    revision: 0,
    templates: models,
  });
  assert.equal(result.templates.length, 2);
  assert.match(
    f.care.reminder(f.owner, a.id, { templateId: "thanks" }).message,
    /seu serviço é Corte/,
  );
  assert.equal(
    f.care.reminder(f.owner, a.id, {
      templateId: "confirm",
      template: "Mensagem avulsa para {nome}",
    }).message,
    "Mensagem avulsa para Cliente da Agenda",
  );
  assert.throws(
    () =>
      f.care.saveTemplate(f.owner, {
        revision: 1,
        templates: [models[0], { ...models[1], title: "Confirmar horário" }],
      }),
    /distintos/,
  );
  assert.throws(() =>
    f.care.saveTemplate(f.owner, {
      revision: 1,
      templates: [{ ...models[0], message: "{telefone}" }],
    }),
  );
  assert.throws(
    () => f.care.saveTemplate(f.owner, { revision: 0, templates: [] }),
    /mudou/,
  );
  f.care.saveTemplate(f.owner, { revision: 1, templates: [models[0]] });
  assert.throws(
    () => f.care.reminder(f.owner, a.id, { templateId: "thanks" }),
    /indisponível/,
  );
  assert.equal(
    f.care.reminder(f.owner, a.id, { template: "Mensagem livre" }).message,
    "Mensagem livre",
  );
  f.care.saveTemplate(f.owner, { revision: 2, templates: [] });
  assert.equal(f.care.template(f.owner).templates.length, 0);
  assert.ok(f.care.reminder(f.owner, a.id, { template: "Olá {nome}" }).message);
});
test("paused return rules stay visible in history without contributing to due actions", () => {
  const f = setup(),
    body = {
      customerId: f.customer.id,
      itemId: "cut",
      professionalId: "principal",
      intervalDays: 30,
      revision: 0,
    };
  const saved = f.care.saveReturn(f.owner, body);
  f.care.saveReturn(f.owner, {
    ...body,
    revision: saved.revision,
    enabled: false,
  });
  assert.equal(f.care.returns(f.owner)[0].state, "paused");
  f.care.saveReturn(f.owner, { ...body, revision: 2, enabled: true });
  assert.equal(f.care.returns(f.owner)[0].state, "no_history");
});
test("production comparisons use the same prior duration and do not claim pending payments as receipts", () => {
  const f = setup(),
    a = f.booking(),
    today = new Date(),
    current = new Date(+today - 2 * 86400000).toISOString(),
    previous = new Date(+today - 9 * 86400000).toISOString();
  f.repo.put(f.owner.tenantId, "appointments", a.id, {
    ...a,
    startsAt: current,
    endsAt: new Date(Date.parse(current) + 3600000).toISOString(),
    status: "completed",
    paymentStatus: "pending",
  });
  f.repo.put(f.owner.tenantId, "appointments", "prev", {
    ...a,
    id: "prev",
    startsAt: previous,
    status: "completed",
    priceCents: 12000,
  });
  const stats = f.workspace.analytics(f.owner, { days: 7 });
  assert.equal(stats.productionCents, 6000);
  assert.equal(stats.comparison.previousProductionCents, 12000);
  assert.equal(stats.comparison.productionChangePercent, -50);
  assert.equal(stats.serviceProduction[0].amountCents, 6000);
  assert.equal(
    f.repo.get<Appointment>(f.owner.tenantId, "appointments", a.id)
      ?.paymentStatus,
    "pending",
  );
});
test("expired waiting preferences no longer appear as pending opportunities", () => {
  const f = setup(),
    entry = f.care.createWait(f.owner, {
      idempotencyKey: randomUUID(),
      customerId: f.customer.id,
      itemId: "cut",
      professionalId: "principal",
      from: f.date,
      to: f.date,
      after: "10:00",
      before: "12:00",
    });
  f.repo.put(f.owner.tenantId, "wait_entries", entry.id, {
    ...entry,
    from: "2020-01-01",
    to: "2020-01-02",
  });
  assert.deepEqual(f.care.waitlist(f.owner), []);
  assert.deepEqual(f.care.suggestions(f.owner, entry.id), []);
});
