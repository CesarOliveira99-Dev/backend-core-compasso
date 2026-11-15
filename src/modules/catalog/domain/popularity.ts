import type { Appointment } from '../../../core/domain/models.js';
export function recentBookingCounts(appointments: Appointment[], now = Date.now()) {
  const since = now - 90 * 86400000;
  const counts = new Map<string, number>();
  for (const appointment of appointments) {
    const date = Date.parse(appointment.startsAt);
    if (
      (appointment.status === 'confirmed' || appointment.status === 'completed') &&
      date >= since &&
      date <= now
    )
      counts.set(appointment.itemId, (counts.get(appointment.itemId) || 0) + 1);
  }
  return counts;
}
