import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Context, timestamp } from '../../core/application/context.js';
import type { Actor, Appointment, Order, Triage } from '../../core/domain/models.js';

export interface VerifiedPayment {
  id: number | string;
  collector_id: number | string;
  external_reference: string;
  status: string;
  transaction_amount: number;
  currency_id: string;
  live_mode: boolean;
}

export function ownedOrder(context: Context, actor: Actor, orderId: string): Order {
  const order = context.require<Order>(actor, 'orders', orderId);
  context.owned(actor, order.customerId);
  return order;
}

export function payableOrder(context: Context, actor: Actor, orderId: string): Order {
  const order = ownedOrder(context, actor, orderId);
  if (order.paymentMethod !== 'online' || order.paymentStatus === 'paid' ||
      order.status === 'cancelled' || !Number.isSafeInteger(order.totalCents) || order.totalCents <= 0)
    throw new BadRequestException('Este pedido não está disponível para pagamento online.');
  const repo = context.repository;
  if (repo.list<Triage>(actor.tenantId, 'triage').some(t => t.orderId === orderId && t.status !== 'approved'))
    throw new BadRequestException('Aguarde a aprovação da triagem antes de pagar.');
  if (repo.list<Appointment>(actor.tenantId, 'appointments').some(a =>
    a.orderId === orderId && (a.status === 'pending' || a.status === 'cancelled')))
    throw new BadRequestException('Resolva a triagem ou o cancelamento dos atendimentos antes de pagar.');
  return order;
}

export function reservePaymentRoute(context: Context, tenantId: string, orderId: string, route: 'pro' | 'bricks') {
  context.repository.transaction(() => {
    const existing = context.repository.get<{ route: string }>(tenantId, 'payment_routes', orderId);
    if (existing && existing.route !== route)
      throw new BadRequestException('Este pedido já tem um pagamento iniciado por outro fluxo. Continue pela forma original.');
    context.repository.put(tenantId, 'payment_routes', orderId, { route });
  });
}

// Only provider responses fetched with the connected seller's token reach this function.
export function settlePayment(context: Context, tenantId: string, sellerId: string, payment: VerifiedPayment) {
  if (String(payment.collector_id) !== sellerId || payment.currency_id !== 'BRL')
    throw new ForbiddenException('Recebedor ou moeda incompatível.');
  if (payment.live_mode !== (process.env.MP_SANDBOX !== 'true'))
    throw new BadRequestException('Ambiente de pagamento incompatível.');
  const prefix = `${tenantId}:`;
  if (!payment.external_reference?.startsWith(prefix)) throw new BadRequestException('Pedido inválido.');
  const orderId = payment.external_reference.slice(prefix.length);
  const repo = context.repository;
  repo.transaction(() => {
    const order = repo.get<Order>(tenantId, 'orders', orderId);
    if (!order || order.paymentMethod !== 'online' ||
        Math.round(payment.transaction_amount * 100) !== order.totalCents)
      throw new BadRequestException('Valor ou pedido incompatível.');
    const other = repo.get<{ paymentId: string }>(tenantId, 'settlements', orderId);
    if (other && other.paymentId !== String(payment.id))
      throw new BadRequestException('Pedido já possui outro pagamento.');
    if (payment.status === 'approved' && order.status !== 'cancelled') {
      order.paymentStatus = 'paid';
      order.paidAt ??= timestamp();
      repo.put(tenantId, 'settlements', orderId, { paymentId: String(payment.id) });
    } else if (['refunded', 'charged_back'].includes(payment.status) && other) {
      order.paymentStatus = 'pending';
      order.paidAt = undefined;
    }
    repo.put(tenantId, 'orders', orderId, order);
    for (const appointment of repo.list<Appointment>(tenantId, 'appointments')
      .filter(a => a.orderId === orderId && a.status !== 'cancelled'))
      repo.put(tenantId, 'appointments', appointment.id, {
        ...appointment, paymentStatus: order.paymentStatus, paidAt: order.paidAt,
      });
    repo.put(tenantId, 'payment_events', String(payment.id), { status: payment.status, orderId, checkedAt: timestamp() });
    const attempt = repo.get<{ paymentId?: string; encryptedRequest?: string; status: string }>(tenantId, 'brick_attempts', orderId);
    if (attempt && (attempt.paymentId === String(payment.id) || (!attempt.paymentId && attempt.status === 'processing'))) {
      const { encryptedRequest: _request, ...safeAttempt } = attempt;
      repo.put(tenantId, 'brick_attempts', orderId, { ...safeAttempt, paymentId: String(payment.id), status: payment.status });
    }
  });
}
