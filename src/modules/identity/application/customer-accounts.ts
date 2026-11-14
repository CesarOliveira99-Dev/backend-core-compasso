import { ConflictException } from '@nestjs/common';
import { Context, id } from '../../../core/application/context.js';
import type { Customer } from '../../../core/domain/models.js';
import { hashPassword } from './identity.schemas.js';

interface AccountReference {
  tenantId: string;
  userId: string;
}

/** Personal accounts have their own namespace; they never create a business. */
export class CustomerAccounts {
  constructor(private readonly context: Context) {}

  find(email: string): Customer | undefined {
    const account = this.context.repository.get<AccountReference>(
      'system',
      'customer_accounts',
      email,
    );
    return (
      account &&
      this.context.repository.get<Customer>(account.tenantId, 'customers', account.userId)
    );
  }

  all(email?: string): Customer[] {
    const repo = this.context.repository;
    const personal = repo
      .list<AccountReference>('system', 'customer_accounts')
      .flatMap(
        (account) => repo.get<Customer>(account.tenantId, 'customers', account.userId) || [],
      );
    const members = repo
      .list<{ tenantId: string }>('system', 'stores')
      .flatMap((store) => repo.list<Customer>(store.tenantId, 'customers'));
    return [...personal, ...members].filter((user) => !user.internal && (!email || user.email === email));
  }

  google(sub: string): Customer | undefined {
    return this.context.repository
      .list<AccountReference>('system', 'customer_accounts')
      .flatMap((account) => {
        const linked = this.context.repository.get<{ userId: string }>(
          'system',
          'google_accounts',
          `${account.tenantId}:${sub}`,
        );
        return linked?.userId === account.userId
          ? this.context.repository.get<Customer>(account.tenantId, 'customers', account.userId) ||
              []
          : [];
      })[0];
  }

  create(input: { name: string; email: string; phone: string; password: string }): Customer {
    if (this.all(input.email).length)
      throw new ConflictException(
        'Você já possui conta. Entre com sua senha ou recupere o acesso.',
      );
    const userId = id();
    const customer: Customer = {
      id: userId,
      identityId: userId,
      tenantId: `person:${userId}`,
      role: 'customer',
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash: hashPassword(input.password),
      addresses: [],
    };
    this.context.repository.put(customer.tenantId, 'customers', customer.id, customer);
    this.context.repository.put('system', 'customer_accounts', customer.email, {
      tenantId: customer.tenantId,
      userId: customer.id,
    });
    return customer;
  }
}
