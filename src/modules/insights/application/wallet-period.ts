import { z } from "zod";
import { parse } from "../../../core/application/context.js";
import { localDate } from "../../../core/domain/policies.js";
import { validCalendarDate } from "../../appointments/domain/availability.js";
export function walletPeriod(
  query: unknown,
  timezone: string,
  now = new Date(),
) {
  const today = localDate(now, timezone);
  const date = z.string().refine(validCalendarDate, "Data inválida.");
  const input = parse(
    z
      .object({
        days: z.coerce.number().int().min(1).max(3650).optional(),
        from: date.optional(),
        to: date.optional(),
      })
      .strict()
      .refine((v) => !!v.from === !!v.to, "Informe as duas datas.")
      .refine(
        (v) => !v.from || v.days === undefined,
        "Escolha um período ou um intervalo de dias.",
      )
      .refine(
        (v) => !v.from || v.from <= v.to!,
        "A data inicial deve ser anterior à final.",
      )
      .refine((v) => !v.to || v.to <= today, "A data final deve ser até hoje.")
      .refine(
        (v) =>
          !v.from || (Date.parse(v.to!) - Date.parse(v.from)) / 86400000 < 3650,
        "Selecione até 10 anos.",
      ),
    query,
  );
  if (input.from && input.to)
    return {
      firstDate: input.from,
      periodEnd: input.to,
      days:
        Math.round((Date.parse(input.to) - Date.parse(input.from)) / 86400000) +
        1,
    };
  const days = input.days ?? 30,
    first = new Date(today + "T12:00:00Z");
  first.setUTCDate(first.getUTCDate() - days + 1);
  return {
    firstDate: first.toISOString().slice(0, 10),
    periodEnd: today,
    days,
  };
}
