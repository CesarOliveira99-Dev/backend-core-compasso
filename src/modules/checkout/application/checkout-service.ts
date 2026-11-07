import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, id, parse, timestamp } from '../../../core/application/context.js';
import type {
  Actor,
  Appointment,
  CatalogItem,
  Customer,
  Discount,
  Order,
  Triage,
} from '../../../core/domain/models.js';
import { discountApplies, discountedPrice, localWeekday } from '../../../core/domain/policies.js';
import { AppointmentsService } from '../../appointments/appointments.module.js';
import { checkoutSchema } from './checkout.schemas.js';
@Injectable()
export class CheckoutService {
  constructor(
    private readonly context: Context,
    private readonly appointments: AppointmentsService,
  ) {}
  create(actor: Actor, body: unknown): Order {
    if (actor.role !== 'customer')
      throw new BadRequestException('Utilize a conta de cliente para realizar uma compra.');
    const input = parse(checkoutSchema, body);
    return this.context.repository.transaction(() => {
      const existing = this.context.repository.get<{ orderId: string; fingerprint: string }>(
        actor.tenantId,
        'checkout_keys',
        `${actor.id}:${input.idempotencyKey}`,
      );
      const fingerprint = JSON.stringify(input);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new BadRequestException('Chave já utilizada em outra compra.');
        return this.context.require<Order>(actor, 'orders', existing.orderId);
      }
      const { order, coupon, lines, hasProduct } = this.prepare(actor, input);
      if (input.expectedTotalCents !== undefined && input.expectedTotalCents !== order.totalCents)
        throw new BadRequestException(
          'Os valores foram atualizados. Confira o novo total antes de confirmar.',
        );
      lines.forEach((line, index) => {
        if (line.kind === 'service')
          this.appointments.create(
            actor,
            {
              itemId: line.itemId,
              professionalId: line.professionalId,
              startsAt: line.startsAt,
              notes: input.items[index].notes || '',
            },
            order.id,
            line.unitPriceCents,
          );
      });
      input.items.forEach((line) => {
        const item = this.context.require<CatalogItem>(actor, 'catalog', line.itemId);
        if (item.kind === 'product' && item.requiresTriage) {
          const triage: Triage = {
            id: id(),
            customerId: actor.id,
            customerName: actor.name,
            orderId: order.id,
            answers: `${item.name}: ${line.notes}`,
            status: 'pending',
            decision: '',
            createdAt: timestamp(),
          };
          this.context.repository.put(actor.tenantId, 'triage', triage.id, triage);
        }
      });
      this.context.repository.put(actor.tenantId, 'orders', order.id, order);
      this.context.repository.put(
        actor.tenantId,
        'checkout_keys',
        `${actor.id}:${input.idempotencyKey}`,
        { orderId: order.id, fingerprint },
      );
      if (coupon) {
        this.context.repository.put(actor.tenantId, 'coupons', coupon.id, {
          ...coupon,
          uses: coupon.uses + 1,
        });
        this.context.repository.put(
          actor.tenantId,
          'coupon_redemptions',
          `${coupon.id}:${actor.id}`,
          { orderId: order.id },
        );
      }
      this.context.notifyAdmins(
        actor,
        hasProduct ? 'Você realizou uma venda!' : 'Novo pedido recebido',
        `${actor.name} • R$ ${(order.totalCents / 100).toFixed(2)}`,
      );
      this.context.notify(
        actor,
        actor.id,
        'Pedido recebido',
        'Consulte seus itens e o que foi acordado em Meus pedidos.',
      );
      return order;
    });
  }

  quote(actor: Actor, body: unknown) {
    if (actor.role !== 'customer') throw new BadRequestException('Use uma conta de cliente.');
    const { order } = this.prepare(actor, parse(checkoutSchema, body));
    return { totalCents: order.totalCents, discountCents: order.discountCents, items: order.items };
  }
  private prepare(actor: Actor, input: z.output<typeof checkoutSchema>) {
    const settings = this.context.settings(actor);
    if (
      input.paymentMethod === 'online' &&
      !this.context.repository.get(actor.tenantId, 'payment_connections', 'mercadopago')
    )
      throw new BadRequestException('O comerciante ainda não conectou o Mercado Pago.');
    if (input.paymentMethod === 'pix_manual' && !settings.pixKey.trim())
      throw new BadRequestException('O comerciante ainda não cadastrou uma chave Pix.');
    const now = new Date();
    const customer = this.context.require<Customer>(actor, 'customers', actor.id);
    const promotions = this.context.repository.list<Discount>(actor.tenantId, 'promotions');
    const coupon = input.coupon
      ? this.context.repository.get<Discount>(
          actor.tenantId,
          'coupons',
          input.coupon.trim().toUpperCase(),
        )
      : undefined;
    if (input.coupon && !coupon) throw new BadRequestException('Cupom não encontrado.');
    if (
      coupon &&
      this.context.repository.get(actor.tenantId, 'coupon_redemptions', `${coupon.id}:${actor.id}`)
    )
      throw new BadRequestException('Você já utilizou este cupom.');
    let discountCents = 0;
    let couponUsed = false;
    const lines = input.items.map((line) => {
      const item = this.context.require<CatalogItem>(actor, 'catalog', line.itemId);
      if (!item.active) throw new BadRequestException('Um item está indisponível.');
      if (item.requiresTriage && (!line.notes || line.notes.trim().length < 5))
        throw new BadRequestException('Descreva a necessidade para os itens com triagem.');
      if (item.kind === 'service' && (!line.startsAt || line.quantity !== 1))
        throw new BadRequestException('Escolha um horário por serviço.');
      if (
        input.paymentMethod === 'on_day' &&
        ((item.kind === 'service' && !settings.payOnAppointment) ||
          (item.kind === 'product' && !settings.payOnDelivery))
      )
        throw new BadRequestException('Pagamento no dia indisponível para um dos itens.');
      const weekday = localWeekday(line.startsAt || now, settings.timezone);
      let percent = Math.max(
        0,
        ...promotions
          .filter((p) => discountApplies(p, item.id, item.kind, now, weekday))
          .map((p) => p.percent),
      );
      if (coupon && discountApplies(coupon, item.id, item.kind, now, weekday)) {
        percent = Math.max(percent, coupon.percent);
        couponUsed = true;
      }
      const unitPriceCents = discountedPrice(item.priceCents, percent);
      discountCents += (item.priceCents - unitPriceCents) * line.quantity;
      return {
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        kind: item.kind,
        unitPriceCents,
        startsAt: line.startsAt,
        professionalId: line.professionalId,
      };
    });
    if (coupon && !couponUsed)
      throw new BadRequestException('Cupom inválido para estes itens, dia, limite ou período.');
    const hasProduct = lines.some((line) => line.kind === 'product');
    const address = input.addressId
      ? customer.addresses.find((a) => a.id === input.addressId)
      : customer.addresses.find((a) => a.isDefault);
    if (hasProduct && !address)
      throw new BadRequestException('Cadastre um endereço para entrega dos produtos.');
    const order: Order = {
      id: id(),
      customerId: actor.id,
      customerName: actor.name,
      items: lines,
      totalCents: lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0),
      discountCents,
      status: 'pending',
      paymentStatus: 'pending',
      paymentMethod: input.paymentMethod,
      pixKey: input.paymentMethod === 'pix_manual' ? settings.pixKey : undefined,
      address: hasProduct ? address : undefined,
      seen: false,
      createdAt: timestamp(),
    };
    return { order, coupon, lines, hasProduct };
  }
  update(actor: Actor, orderId: string, body: unknown) {
    this.context.admin(actor);
    const input = parse(
      z.object({
        paymentStatus: z.literal('paid').optional(),
        status: z.literal('completed').optional(),
        seen: z.boolean().optional(),
      }),
      body,
    );
    return this.context.repository.transaction(() => {
      const order = this.context.require<Order>(actor, 'orders', orderId);
      if (input.paymentStatus && order.paymentMethod === 'online')
        throw new BadRequestException('O Mercado Pago confirma este pagamento automaticamente.');
      if (order.status === 'cancelled') throw new BadRequestException('Pedido cancelado.');
      if (
        input.status &&
        this.context.repository
          .list<Appointment>(actor.tenantId, 'appointments')
          .some(
            (a) => a.orderId === order.id && a.status !== 'completed' && a.status !== 'cancelled',
          )
      )
        throw new BadRequestException(
          'Finalize os atendimentos deste pedido na agenda antes de concluir o pedido.',
        );
      if (
        (input.status || input.paymentStatus) &&
        this.context.repository
          .list<Triage>(actor.tenantId, 'triage')
          .some((t) => t.orderId === order.id && t.status !== 'approved')
      )
        throw new BadRequestException(
          'Resolva a triagem do produto antes de concluir ou registrar o pagamento.',
        );
      if (input.paymentStatus) {
        order.paymentStatus = 'paid';
        order.paidAt ??= timestamp();
        this.context.repository
          .list<Appointment>(actor.tenantId, 'appointments')
          .filter((a) => a.orderId === order.id && a.status !== 'cancelled')
          .forEach((a) =>
            this.context.repository.put(actor.tenantId, 'appointments', a.id, {
              ...a,
              paymentStatus: 'paid',
              paidAt: order.paidAt,
            }),
          );
      }
      if (input.status) {
        order.status = 'completed';
        order.completedAt ??= timestamp();
        this.context.notify(
          actor,
          order.customerId,
          'Pedido concluído',
          'Seu pedido foi concluído. Você já pode programar uma nova compra.',
        );
      }
      if (input.seen !== undefined) order.seen = input.seen;
      return this.context.repository.put(actor.tenantId, 'orders', order.id, order);
    });
  }
}
