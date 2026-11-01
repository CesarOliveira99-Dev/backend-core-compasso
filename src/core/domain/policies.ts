import type { Appointment, Discount, Order } from './models.js';
export function localDate(value: Date | string, timezone = 'America/Sao_Paulo'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}-${parts.find((p) => p.type === 'day')!.value}`;
}
export function localWeekday(value: Date | string, timezone = 'America/Sao_Paulo'): number {
  return new Date(`${localDate(value, timezone)}T12:00:00Z`).getUTCDay();
}
export function weekRange(now: Date, timezone: string): { start: string; end: string } {
  const start = new Date(`${localDate(now, timezone)}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
export function overlaps(start: string, end: string, appointments: Appointment[]): boolean {
  return appointments.some(
    (a) =>
      a.status !== 'cancelled' &&
      new Date(start) < new Date(a.endsAt) &&
      new Date(end) > new Date(a.startsAt),
  );
}
export function discountApplies(
  discount: Discount,
  itemId: string,
  kind: string,
  now: Date,
  weekday: number,
): boolean {
  return (
    discount.active &&
    new Date(discount.startsAt) <= now &&
    new Date(discount.expiresAt) >= now &&
    (discount.maxUses === 0 || discount.uses < discount.maxUses) &&
    (discount.itemIds.length === 0 || discount.itemIds.includes(itemId)) &&
    (discount.kinds.length === 0 || discount.kinds.includes(kind)) &&
    (discount.weekdays.length === 0 || discount.weekdays.includes(weekday))
  );
}
export function discountedPrice(priceCents: number, percent: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || percent < 0 || percent > 100)
    throw new Error('Invalid monetary value');
  return Math.round((priceCents * (100 - percent)) / 100);
}
export function dailySummary(
  appointments: Appointment[],
  now: Date,
  timezone: string,
  orders: Order[] = [],
) {
  const today = appointments.filter(
    (a) => localDate(a.startsAt, timezone) === localDate(now, timezone) && a.status !== 'cancelled',
  );
  return {
    completed: today.filter((a) => a.status === 'completed'),
    remaining: today.filter((a) => a.status !== 'completed'),
    completedOrders: orders.filter(
      (o) =>
        o.status === 'completed' &&
        localDate(o.completedAt || o.createdAt, timezone) === localDate(now, timezone),
    ),
    showCompleted:
      today.some((a) => a.status === 'completed') ||
      orders.some(
        (o) =>
          o.status === 'completed' &&
          localDate(o.completedAt || o.createdAt, timezone) === localDate(now, timezone),
      ),
  };
}
