import type { Appointment } from "../../../core/domain/models.js";
import { localDate } from "../../../core/domain/policies.js";
export interface ChartSlice {
  id: string;
  name: string;
  color: string;
  count: number;
}
const palette = [
  "#397c96",
  "#4d8658",
  "#a57135",
  "#8062aa",
  "#b75d75",
  "#507d78",
  "#8b704b",
  "#6376a4",
];
/** Receives only appointments already authorized for the requesting actor. */
export function agendaCharts(
  history: Appointment[],
  systemContacts: Set<string>,
  firstDate: string,
  today: string,
  days: number,
) {
  const throughToday = history.filter(
    (a) => localDate(a.startsAt) <= today && !systemContacts.has(a.customerId),
  );
  const period = throughToday.filter((a) => localDate(a.startsAt) >= firstDate);
  const completed = period.filter((a) => a.status === "completed");
  const lifetime = new Map<string, number>();
  for (const a of throughToday.filter((a) => a.status === "completed"))
    lifetime.set(a.customerId, (lifetime.get(a.customerId) || 0) + 1);
  const uniqueClients = new Set(completed.map((a) => a.customerId));
  const recurringClients = [...uniqueClients].filter(
    (id) => (lifetime.get(id) || 0) > 1,
  ).length;
  const firstTimeClients = uniqueClients.size - recurringClients;
  function distribution(items: Appointment[], category: boolean): ChartSlice[] {
    const groups = new Map<string, ChartSlice>();
    for (const a of [...items].sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    )) {
      const id = category ? a.categoryId || "unassigned" : a.itemId;
      const row = groups.get(id) || { id, name: "", color: "", count: 0 };
      row.name = category ? a.categoryName || "Sem categoria" : a.itemName;
      row.color = category ? a.categoryColor || "#64748b" : "";
      row.count++;
      groups.set(id, row);
    }
    return [...groups.values()]
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .map((row, index) => ({
        ...row,
        color: row.color || palette[index % palette.length],
      }));
  }
  const buckets = new Map<
    string,
    {
      key: string;
      start: string;
      end: string;
      clients: Set<string>;
      completed: number;
    }
  >();
  const first = new Date(`${firstDate}T12:00:00Z`);
  for (let i = 0; i < days; i++) {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + i);
    const day = date.toISOString().slice(0, 10);
    const key =
      days <= 7
        ? day
        : days <= 90
          ? String(Math.floor(i / 7))
          : day.slice(0, 7);
    const bucket = buckets.get(key) || {
      key,
      start: day,
      end: day,
      clients: new Set<string>(),
      completed: 0,
    };
    bucket.end = day;
    buckets.set(key, bucket);
  }
  for (const a of completed) {
    const day = localDate(a.startsAt),
      offset = Math.round(
        (Date.parse(`${day}T12:00:00Z`) - first.getTime()) / 86400000,
      );
    const key =
      days <= 7
        ? day
        : days <= 90
          ? String(Math.floor(offset / 7))
          : day.slice(0, 7);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.completed++;
      bucket.clients.add(a.customerId);
    }
  }
  return {
    firstTimeClients,
    recurringClients,
    clientMix: [
      {
        id: "first",
        name: "Primeira visita",
        color: "#397c96",
        count: firstTimeClients,
      },
      {
        id: "returning",
        name: "Já retornaram",
        color: "#4d8658",
        count: recurringClients,
      },
    ],
    attendanceCategories: distribution(completed, true),
    services: distribution(
      period.filter((a) => a.status !== "cancelled"),
      false,
    ),
    trend: [...buckets.values()].map(({ clients, ...bucket }) => ({
      ...bucket,
      clients: clients.size,
    })),
    trendGrouping: days <= 7 ? "day" : days <= 90 ? "week" : "month",
  };
}
