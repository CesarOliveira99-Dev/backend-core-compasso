import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dailySummary,
  discountedPrice,
  discountApplies,
  overlaps,
  weekRange,
} from '../src/core/domain/policies.js';
import type { Appointment, Discount, Order } from '../src/core/domain/models.js';
test('completed purchases also activate the completed section for today', () => {
  const order = {
    id: 'purchase',
    status: 'completed',
    createdAt: '2026-10-30T15:00:00Z',
    completedAt: '2026-10-31T15:00:00Z',
  } as Order;
  const summary = dailySummary([], new Date('2026-10-31T16:00:00Z'), 'America/Sao_Paulo', [order]);
  assert.equal(summary.showCompleted, true);
  assert.equal(summary.completedOrders.length, 1);
});
const appointment = {
  id: 'one',
  startsAt: '2026-10-31T13:00:00Z',
  endsAt: '2026-10-31T14:00:00Z',
  status: 'confirmed',
} as Appointment;
test('completed section appears only after a completion on the same local day', () => {
  const now = new Date('2026-10-31T15:00:00Z');
  assert.equal(dailySummary([appointment], now, 'America/Sao_Paulo').showCompleted, false);
  assert.equal(
    dailySummary([{ ...appointment, status: 'completed' }], now, 'America/Sao_Paulo').completed
      .length,
    1,
  );
  assert.equal(
    dailySummary(
      [{ ...appointment, status: 'completed' }],
      new Date('2026-11-01T15:00:00Z'),
      'America/Sao_Paulo',
    ).showCompleted,
    false,
  );
});
test('week turns on local Sunday rather than UTC midnight', () => {
  assert.deepEqual(weekRange(new Date('2026-11-01T01:00:00Z'), 'America/Sao_Paulo'), {
    start: '2026-10-25',
    end: '2026-10-31',
  });
  assert.deepEqual(weekRange(new Date('2026-11-01T04:00:00Z'), 'America/Sao_Paulo'), {
    start: '2026-11-01',
    end: '2026-11-07',
  });
});
test('adjacent bookings are allowed, overlapping bookings are rejected and cancelled slots are released', () => {
  assert.equal(overlaps('2026-10-31T14:00:00Z', '2026-10-31T15:00:00Z', [appointment]), false);
  assert.equal(overlaps('2026-10-31T13:30:00Z', '2026-10-31T14:30:00Z', [appointment]), true);
  assert.equal(
    overlaps(appointment.startsAt, appointment.endsAt, [{ ...appointment, status: 'cancelled' }]),
    false,
  );
});
test('discount respects usage, weekday, item and expiry and uses integer cents', () => {
  const discount: Discount = {
    id: 'x',
    name: 'x',
    percent: 15,
    itemIds: ['service'],
    kinds: ['service'],
    weekdays: [6],
    startsAt: '2026-10-01T00:00:00Z',
    expiresAt: '2026-11-01T00:00:00Z',
    maxUses: 2,
    uses: 1,
    active: true,
  };
  assert.equal(
    discountApplies(discount, 'service', 'service', new Date('2026-10-31T15:00:00Z'), 6),
    true,
  );
  assert.equal(
    discountApplies(
      { ...discount, uses: 2 },
      'service',
      'service',
      new Date('2026-10-31T15:00:00Z'),
      6,
    ),
    false,
  );
  assert.equal(
    discountApplies(discount, 'other', 'service', new Date('2026-10-31T15:00:00Z'), 6),
    false,
  );
  assert.equal(discountedPrice(1999, 15), 1699);
});
