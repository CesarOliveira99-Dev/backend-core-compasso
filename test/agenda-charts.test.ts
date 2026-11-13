import { test } from "node:test";
import assert from "node:assert/strict";
import { agendaCharts } from "../dist/modules/workspace/domain/agenda-analytics.js";
import type { Appointment } from "../src/core/domain/models.js";
function visit(
  id: string,
  customerId: string,
  date: string,
  extra: Partial<Appointment> = {},
): Appointment {
  return {
    id,
    customerId,
    customerName: customerId,
    itemId: "cut",
    itemName: "Atendimento",
    startsAt: date + "T14:00:00Z",
    endsAt: date + "T15:00:00Z",
    createdAt: date + "T14:00:00Z",
    status: "completed",
    paymentStatus: "paid",
    priceCents: 7000,
    notes: "",
    categoryId: "general",
    categoryName: "Atendimento",
    categoryColor: "#397c96",
    ...extra,
  };
}
test("charts deduplicate clients, recognize previous visits outside the window and separate requested services from completed attendance", () => {
  const history = [
    visit("prior", "returning", "2026-10-01"),
    visit("1", "returning", "2026-11-10"),
    visit("2", "new", "2026-11-11", {
      categoryId: "return",
      categoryName: "Retorno",
    }),
    visit("3", "returning", "2026-11-11", {
      itemId: "follow",
      itemName: "Acompanhamento",
    }),
    visit("4", "cancelled", "2026-11-11", { status: "cancelled" }),
    visit("5", "booked", "2026-11-12", { status: "confirmed" }),
    visit("6", "personal", "2026-11-12"),
    visit("7", "future", "2026-11-13"),
  ];
  const result = agendaCharts(
    history,
    new Set(["personal"]),
    "2026-11-06",
    "2026-11-12",
    7,
  );
  assert.equal(result.firstTimeClients, 1);
  assert.equal(result.recurringClients, 1);
  assert.equal(
    result.clientMix.reduce((s, r) => s + r.count, 0),
    2,
  );
  assert.equal(
    result.attendanceCategories.reduce((s, r) => s + r.count, 0),
    3,
  );
  assert.equal(
    result.services.reduce((s, r) => s + r.count, 0),
    4,
  );
  assert.equal(result.services[0].id, "cut");
  assert.equal(result.trend[5].clients, 2);
  assert.equal(result.trend[5].completed, 2);
  assert.equal(result.trend.length, 7);
});
test("weekly/monthly trends count a returning client once per bucket and include empty buckets", () => {
  const result = agendaCharts(
    [visit("1", "same", "2026-11-01"), visit("2", "same", "2026-11-02")],
    new Set(),
    "2026-11-01",
    "2026-11-30",
    30,
  );
  assert.equal(result.trendGrouping, "week");
  assert.equal(result.trend[0].clients, 1);
  assert.equal(result.trend[0].completed, 2);
  assert.equal(result.trend[4].clients, 0);
  const annual = agendaCharts(
    [visit("1", "same", "2026-02-01"), visit("2", "same", "2026-02-20")],
    new Set(),
    "2026-01-01",
    "2026-12-31",
    365,
  );
  assert.equal(annual.trendGrouping, "month");
  assert.equal(annual.trend.length, 12);
  assert.equal(annual.trend[1].clients, 1);
  assert.equal(annual.trend[1].completed, 2);
  assert.equal(
    agendaCharts([], new Set(), "2026-11-06", "2026-11-12", 7).services.length,
    0,
  );
});
