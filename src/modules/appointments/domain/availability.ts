import type { Appointment, Settings } from '../../../core/domain/models.js';
import type { Professional } from '../../../core/domain/professional.js';

export function validCalendarDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
// Resolve a local wall-clock time through Intl, including days whose UTC offset changes.
function localTimestamp(date: string, minutes: number, timezone: string) {
  const target = Date.parse(`${date}T00:00:00Z`) + minutes * 60000;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(
      formatter.formatToParts(timestamp).map((part) => [part.type, part.value]),
    );
    const represented = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    timestamp += target - represented;
  }
  return timestamp;
}
export interface ScheduleWindow {
  opensAt: number;
  closesAt: number;
  breaks: { start: number; end: number }[];
}
export function scheduleWindow(
  date: string,
  settings: Settings,
  professional: Professional,
): ScheduleWindow | undefined {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (
    !settings.workDays.includes(weekday) ||
    !professional.workDays.includes(weekday) ||
    professional.daysOff?.includes(date)
  )
    return;
  const storeDay = settings.weeklyHours?.find((day) => day.day === weekday);
  const staffDay = professional.weeklyHours?.find((day) => day.day === weekday);
  if ((settings.weeklyHours && !storeDay) || (professional.weeklyHours && !staffDay)) return;
  const opening = Math.round(
    Math.max(
      storeDay?.openingHour ?? settings.openingHour,
      staffDay?.openingHour ?? professional.openingHour,
    ) * 60,
  );
  const closing = Math.round(
    Math.min(
      storeDay?.closingHour ?? settings.closingHour,
      staffDay?.closingHour ?? professional.closingHour,
    ) * 60,
  );
  if (closing <= opening) return;
  const clockMinutes = (clock: string) => {
    const [hour, minute] = clock.split(':').map(Number);
    return hour * 60 + minute;
  };
  return {
    opensAt: localTimestamp(date, opening, settings.timezone),
    closesAt: localTimestamp(date, closing, settings.timezone),
    breaks: (professional.breaks || [])
      .filter((interval) => !interval.date || interval.date === date)
      .map((interval) => ({
        start: localTimestamp(date, clockMinutes(interval.start), settings.timezone),
        end: localTimestamp(date, clockMinutes(interval.end), settings.timezone),
      })),
  };
}
export function slotIssue(
  start: number,
  end: number,
  window: ScheduleWindow | undefined,
  reservations: Appointment[],
  now: number,
): 'past' | 'hours' | 'busy' | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= now || end <= start)
    return 'past';
  if (
    !window ||
    start < window.opensAt ||
    end > window.closesAt ||
    window.breaks.some((interval) => start < interval.end && end > interval.start)
  )
    return 'hours';
  if (
    reservations.some(
      (appointment) =>
        appointment.status !== 'cancelled' &&
        start < Date.parse(appointment.endsAt) &&
        end > Date.parse(appointment.startsAt),
    )
  )
    return 'busy';
}
export function freeSlots(
  window: ScheduleWindow | undefined,
  durationMinutes: number,
  reservations: Appointment[],
  timezone: string,
  now = Date.now(),
) {
  if (!window) return [];
  const slots: { startsAt: string; endsAt: string; label: string }[] = [];
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (
    let start = window.opensAt;
    start + durationMinutes * 60000 <= window.closesAt;
    start += 15 * 60000
  ) {
    const end = start + durationMinutes * 60000;
    if (!slotIssue(start, end, window, reservations, now))
      slots.push({
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        label: formatter.format(start),
      });
  }
  return slots;
}
