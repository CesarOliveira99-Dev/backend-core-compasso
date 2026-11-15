import { BadRequestException } from "@nestjs/common";
import type { Appointment } from "../../../core/domain/models.js";
import { localDate } from "../../../core/domain/policies.js";
export const reminderFields = [
  "nome",
  "servico",
  "data",
  "horario",
  "profissional",
  "estabelecimento",
] as const;
export const defaultReminder =
  "Olá, {nome}! Lembrando do seu atendimento de {servico}, dia {data}, às {horario}, com {profissional}. Até lá!";
export function renderReminder(
  template: string,
  values: Record<(typeof reminderFields)[number], string>,
) {
  if (!template.trim() || template.length > 1500)
    throw new BadRequestException(
      "A mensagem deve ter de 1 a 1.500 caracteres.",
    );
  const unknown = [...template.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => m[1])
    .filter(
      (key) => !reminderFields.includes(key as (typeof reminderFields)[number]),
    );
  if (unknown.length || /[{}]/.test(template.replace(/\{[^{}]*\}/g, "")))
    throw new BadRequestException(
      "Use somente: " + reminderFields.map((key) => `{${key}}`).join(", "),
    );
  return template.replace(
    /\{([^{}]*)\}/g,
    (_, key: string) => values[key as keyof typeof values],
  );
}
export function addCalendarDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function clientSummary(
  history: Appointment[],
  timezone: string,
  now = new Date(),
) {
  const completed = history
    .filter((a) => a.status === "completed" && Date.parse(a.startsAt) <= +now)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const last = completed[0];
  const today = localDate(now, timezone);
  return {
    completed: completed.length,
    cancelled: history.filter(
      (a) => a.status === "cancelled" && a.attendanceOutcome !== "no_show",
    ).length,
    missed: history.filter((a) => a.attendanceOutcome === "no_show").length,
    productionCents: completed.reduce((sum, a) => sum + a.priceCents, 0),
    lastVisit: last?.startsAt || null,
    lastService: last?.itemName || null,
    daysSinceLast: last
      ? Math.floor(
          (Date.parse(today + "T12:00:00Z") -
            Date.parse(localDate(last.startsAt, timezone) + "T12:00:00Z")) /
            86400000,
        )
      : null,
    averageMinutes: completed.length
      ? Math.round(
          completed.reduce(
            (sum, a) =>
              sum + (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60000,
            0,
          ) / completed.length,
        )
      : 0,
    monthly: Array.from({ length: 6 }, (_, i) => {
      const date = new Date(today + "T12:00:00Z");
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - 5 + i);
      const month = date.toISOString().slice(0, 7);
      const appointments = completed.filter((a) =>
        localDate(a.startsAt, timezone).startsWith(month),
      );
      return {
        month,
        count: appointments.length,
        productionCents: appointments.reduce((s, a) => s + a.priceCents, 0),
      };
    }),
  };
}
