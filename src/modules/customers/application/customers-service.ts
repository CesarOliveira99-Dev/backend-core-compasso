import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Context, id, parse } from '../../../core/application/context.js';
import type { Actor, Appointment, Customer, Order } from '../../../core/domain/models.js';
import { addressSchema } from './customers.schemas.js';
@Injectable()
export class CustomersService {
  constructor(private readonly context: Context) {}
  list(actor: Actor) {
    this.context.admin(actor);
    const appointments = this.context.repository.list<Appointment>(actor.tenantId, 'appointments');
    const orders = this.context.repository.list<Order>(actor.tenantId, 'orders');
    return this.context.repository
      .list<Customer>(actor.tenantId, 'customers')
      .filter((u) => u.role === 'customer')
      .map(({ passwordHash, ...u }) => ({
        ...u,
        visits: appointments.filter((a) => a.customerId === u.id && a.status === 'completed')
          .length,
        totalCents: orders
          .filter((o) => o.customerId === u.id && o.paymentStatus === 'paid')
          .reduce((sum, o) => sum + o.totalCents, 0),
      }));
  }
  profile(actor: Actor) {
    const { passwordHash, ...customer } = this.context.require<Customer>(
      actor,
      'customers',
      actor.id,
    );
    return customer;
  }
  update(actor: Actor, body: unknown) {
    const input = parse(
      z.object({ name: z.string().trim().min(2).max(100), phone: z.string().min(10).max(20) }),
      body,
    );
    const customer = this.context.require<Customer>(actor, 'customers', actor.id);
    const { passwordHash, ...result } = this.context.repository.put(
      actor.tenantId,
      'customers',
      customer.id,
      { ...customer, ...input },
    );
    return result;
  }
  address(actor: Actor, body: unknown) {
    const input = parse(addressSchema, body);
    const customer = this.context.require<Customer>(actor, 'customers', actor.id);
    const address = {
      ...input,
      id: id(),
      isDefault: input.isDefault || customer.addresses.length === 0,
    };
    if (address.isDefault) customer.addresses.forEach((a) => (a.isDefault = false));
    customer.addresses.push(address);
    this.context.repository.put(actor.tenantId, 'customers', customer.id, customer);
    return customer.addresses;
  }
  defaultAddress(actor: Actor, addressId: string) {
    const customer = this.context.require<Customer>(actor, 'customers', actor.id);
    if (!customer.addresses.some((a) => a.id === addressId)) return customer.addresses;
    customer.addresses.forEach((a) => (a.isDefault = a.id === addressId));
    this.context.repository.put(actor.tenantId, 'customers', customer.id, customer);
    return customer.addresses;
  }
}
