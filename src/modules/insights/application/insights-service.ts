import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, parse } from '../../../core/application/context.js';
import type { Actor, Appointment, Feedback, Order, Triage } from '../../../core/domain/models.js';
import { dailySummary, localDate, weekRange } from '../../../core/domain/policies.js';
@Injectable()
export class InsightsService {
  constructor(private readonly context: Context) {}
  dashboard(actor: Actor) {
    const now = new Date();
    const settings = this.context.settings(actor);
    const appointments = this.context.repository
      .list<Appointment>(
        actor.tenantId,
        'appointments',
        actor.role === 'admin' ? {} : { customerId: actor.id },
      )
      .filter((a) => actor.role === 'admin' || a.customerId === actor.id);
    const orders = this.context.repository
      .list<Order>(actor.tenantId, 'orders', actor.role === 'admin' ? {} : { customerId: actor.id })
      .filter((o) => actor.role === 'admin' || o.customerId === actor.id);
    const week = weekRange(now, settings.timezone);
    const weekCompleted = appointments.filter(
      (a) =>
        a.status === 'completed' &&
        localDate(a.startsAt, settings.timezone) >= week.start &&
        localDate(a.startsAt, settings.timezone) <= week.end,
    );
    const feedback = this.context.repository
      .list<Feedback>(
        actor.tenantId,
        'feedback',
        actor.role === 'admin' ? {} : { customerId: actor.id },
      )
      .filter((f) => actor.role === 'admin' || f.customerId === actor.id);
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: settings.timezone,
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(now),
    );
    const today = dailySummary(appointments, now, settings.timezone, orders);
    return {
      greeting: hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite',
      date: localDate(now, settings.timezone),
      week,
      today,
      upcoming: appointments
        .filter(
          (a) => a.status !== 'cancelled' && a.status !== 'completed' && new Date(a.endsAt) >= now,
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .slice(0, 6),
      weekMinutes: weekCompleted.reduce(
        (sum, a) => sum + (new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000,
        0,
      ),
      weekRevenueCents: weekCompleted.reduce((sum, a) => sum + a.priceCents, 0),
      weekAppointments: appointments.filter(
        (a) =>
          a.status !== 'cancelled' &&
          localDate(a.startsAt, settings.timezone) >= week.start &&
          localDate(a.startsAt, settings.timezone) <= week.end,
      ).length,
      completedCount: weekCompleted.length,
      unseenOrders:
        actor.role === 'admin' ? orders.filter((o) => !o.seen && o.status === 'pending') : [],
      pendingTriage: this.context.repository
        .list<Triage>(actor.tenantId, 'triage')
        .filter(
          (t) => t.status === 'pending' && (actor.role === 'admin' || t.customerId === actor.id),
        ).length,
      averageRating: feedback.length
        ? feedback.reduce((sum, f) => sum + f.rating, 0) / feedback.length
        : 0,
      weekDays: Array.from({ length: 7 }, (_, day) => {
        const date = new Date(`${week.start}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + day);
        const key = date.toISOString().slice(0, 10);
        return {
          date: key,
          minutes: weekCompleted
            .filter((a) => localDate(a.startsAt, settings.timezone) === key)
            .reduce(
              (sum, a) =>
                sum + (new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000,
              0,
            ),
          appointments: appointments.filter(
            (a) => localDate(a.startsAt, settings.timezone) === key && a.status !== 'cancelled',
          ).length,
        };
      }),
    };
  }
  wallet(actor: Actor, query: unknown) {
    this.context.admin(actor);
    const input = parse(
      z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }),
      query,
    );
    const cutoff = new Date(Date.now() - input.days * 86400000).toISOString();
    const appointments = this.context.repository.list<Appointment>(actor.tenantId, 'appointments');
    const orders = this.context.repository.list<Order>(actor.tenantId, 'orders');
    const entries = [
      ...appointments
        .filter((a) => a.status === 'completed')
        .map((a) => ({
          id: a.id,
          name: a.itemName,
          customerName: a.customerName,
          amountCents: a.priceCents,
          date: a.completedAt || a.endsAt,
          paymentStatus: a.paymentStatus,
          kind: 'service',
        })),
      ...orders
        .filter((o) => o.status === 'completed' && o.items.some((i) => i.kind === 'product'))
        .map((o) => ({
          id: o.id,
          name: o.items
            .filter((i) => i.kind === 'product')
            .map((i) => i.name)
            .join(', '),
          customerName: o.customerName,
          amountCents: o.items
            .filter((i) => i.kind === 'product')
            .reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
          date: o.completedAt || o.createdAt,
          paymentStatus: o.paymentStatus,
          kind: 'product',
        })),
    ]
      .filter((e) => e.date >= cutoff)
      .sort((a, b) => b.date.localeCompare(a.date));
    const projection = appointments
      .filter((a) => a.status === 'confirmed' && new Date(a.startsAt) > new Date())
      .map((a) => ({
        id: a.id,
        name: a.itemName,
        customerName: a.customerName,
        date: a.startsAt,
        amountCents: a.priceCents,
        paymentStatus: a.paymentStatus,
      }));
    return {
      days: input.days,
      earnedCents: entries.reduce((s, e) => s + e.amountCents, 0),
      receivedCents: entries
        .filter((e) => e.paymentStatus === 'paid')
        .reduce((s, e) => s + e.amountCents, 0),
      unpaidCents: entries
        .filter((e) => e.paymentStatus !== 'paid')
        .reduce((s, e) => s + e.amountCents, 0),
      projectedCents: projection.reduce((s, e) => s + e.amountCents, 0),
      entries,
      projection,
    };
  }
  report(actor: Actor, query: unknown) {
    this.context.admin(actor);
    const input = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }), query);
    const appointments = this.context.repository
      .list<Appointment>(actor.tenantId, 'appointments')
      .filter((a) =>
        localDate(a.startsAt, this.context.settings(actor).timezone).startsWith(input.month),
      );
    return {
      month: input.month,
      total: appointments.length,
      completed: appointments.filter((a) => a.status === 'completed').length,
      cancelled: appointments.filter((a) => a.status === 'cancelled').length,
      totalCents: appointments
        .filter((a) => a.status === 'completed')
        .reduce((sum, a) => sum + a.priceCents, 0),
      appointments,
    };
  }
}
