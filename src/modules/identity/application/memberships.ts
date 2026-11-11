import { requireEmployeeSeat } from '../../../core/application/store-plans.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Context, id, parse } from '../../../core/application/context.js';
import type { Actor, Customer, Settings } from '../../../core/domain/models.js';
import type { Professional } from '../../../core/domain/professional.js';
import { hashPassword, registrationRequestSchema } from './identity.schemas.js';
import { CustomerAccounts } from './customer-accounts.js';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
interface Invitation {
  tenantId: string;
  expiresAt: number;
  uses: number;
}
export class Memberships {
  constructor(private readonly context: Context) {}
  private get repo() {
    return this.context.repository;
  }
  invite(actor: Actor) {
    this.context.admin(actor);
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 7 * 86400000;
    this.repo.transaction(() => {
      const previous = this.repo.get<{ hash: string }>(actor.tenantId, 'team', 'invitation');
      if (previous) this.repo.remove('system', 'team_invites', previous.hash);
      this.repo.put('system', 'team_invites', tokenHash(token), {
        tenantId: actor.tenantId,
        expiresAt,
        uses: 0,
      });
      this.repo.put(actor.tenantId, 'team', 'invitation', { hash: tokenHash(token), expiresAt });
    });
    return { token, expiresAt, path: `/convite#${token}` };
  }
  invitation(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Convite inválido.');
    const record = this.repo.get<Invitation>('system', 'team_invites', tokenHash(token));
    if (!record || record.expiresAt <= Date.now() || record.uses >= 100)
      throw new UnauthorizedException(
        'Convite expirado ou substituído. Peça um novo link ao responsável.',
      );
    return record;
  }
  preview(token: string) {
    const invite = this.invitation(token);
    const settings = this.repo.get<Settings>(invite.tenantId, 'settings', 'business')!;
    return { businessName: settings.businessName, expiresAt: invite.expiresAt };
  }
  accept(token: string, person: Customer): Customer {
    return this.repo.transaction(() => this.acceptInTransaction(token, person));
  }
  acceptInTransaction(token: string, person: Customer): Customer {
    const invite = this.invitation(token);
    const settings = this.repo.get<Settings>(invite.tenantId, 'settings', 'business')!;
    const identityId = person.identityId || person.id;
    const members = this.repo.list<Customer>(invite.tenantId, 'customers', { identityId });
    const existing = members.find(
      (member) => member.role === 'admin' || member.role === 'employee',
    );
    if (existing) {
      if (existing.active === false)
        throw new ForbiddenException('Acesso desativado. Fale com o responsável.');
      return existing;
    }
    const account = this.repo.get<{ userId: string }>(
      'system',
      'accounts',
      `${settings.slug}:${person.email}`,
    );
    if (account && !members.some((member) => member.id === account.userId))
      throw new ConflictException(
        'Entre na conta existente nesta loja antes de aceitar o convite.',
      );
    requireEmployeeSeat(this.repo, invite.tenantId);
    const member: Customer = {
      ...person,
      id: members[0]?.id || id(),
      identityId,
      tenantId: invite.tenantId,
      role: 'employee',
      active: true,
      professionalId: id(),
      addresses: [],
    };
    this.repo.put(invite.tenantId, 'customers', member.id, member);
    this.repo.put('system', 'accounts', `${settings.slug}:${member.email}`, {
      tenantId: invite.tenantId,
      userId: member.id,
    });
    const google = this.repo.list<{ sub?: string }>('system', 'google_persons', { identityId })[0];
    if (google?.sub)
      this.repo.put('system', 'google_accounts', `${member.tenantId}:${google.sub}`, {
        userId: member.id,
      });
    this.repo.put(invite.tenantId, 'professionals', member.professionalId!, {
      id: member.professionalId!,
      userId: member.id,
      name: member.name,
      active: true,
      serviceIds: [],
      openingHour: settings.openingHour,
      closingHour: settings.closingHour,
      workDays: settings.workDays,
      breaks: [],
      daysOff: [],
    } satisfies Professional);
    this.repo.put('system', 'team_invites', tokenHash(token), { ...invite, uses: invite.uses + 1 });
    this.context.notifyAdmins(
      member,
      'Novo funcionário',
      `${member.name} entrou na equipe por convite.`,
    );
    return member;
  }
  register(token: string, body: unknown) {
    this.invitation(token);
    const input = parse(registrationRequestSchema, { ...(body as object), role: 'customer' });
    const duplicate = new CustomerAccounts(this.context).all(input.email).length > 0;
    if (duplicate)
      throw new ConflictException(
        'Você já possui conta. Entre com sua senha ou Google para aceitar o convite.',
      );
    const person: Customer = {
      id: id(),
      tenantId: '',
      name: input.name,
      email: input.email,
      phone: input.phone,
      passwordHash: hashPassword(input.password),
      role: 'customer',
      addresses: [],
    };
    return this.accept(token, person);
  }
  switchStore(actor: Actor, slug: string): Customer {
    const store = this.repo.get<{ tenantId: string }>('system', 'stores', slug);
    if (!store) throw new BadRequestException('Loja não encontrada.');
    const person = this.context.require<Customer>(actor, 'customers', actor.id);
    const identityId = person.identityId || person.id;
    return this.repo.transaction(() => {
      const member = this.repo.list<Customer>(store.tenantId, 'customers', { identityId })[0];
      if (member) {
        if (member.active === false) throw new ForbiddenException('Acesso desativado nesta loja.');
        return member;
      }
      if (store.tenantId === actor.tenantId) return person;
      if (this.repo.get('system', 'accounts', `${slug}:${actor.email}`))
        throw new ConflictException(
          'Já existe outro cadastro com este e-mail na loja. Entre nele para comprovar o acesso.',
        );
      const customer: Customer = {
        ...person,
        id: id(),
        identityId,
        tenantId: store.tenantId,
        role: 'customer',
        professionalId: undefined,
        active: true,
        addresses: [],
      };
      this.repo.put(store.tenantId, 'customers', customer.id, customer);
      this.repo.put('system', 'accounts', `${slug}:${customer.email}`, {
        tenantId: store.tenantId,
        userId: customer.id,
      });
      const google = this.repo.list<{ sub?: string; userId: string }>('system', 'google_persons', {
        identityId,
      })[0];
      if (google?.sub)
        this.repo.put('system', 'google_accounts', `${store.tenantId}:${google.sub}`, {
          userId: customer.id,
        });
      return customer;
    });
  }
  team(actor: Actor) {
    this.context.admin(actor);
    return this.repo
      .list<Customer>(actor.tenantId, 'customers')
      .filter((user) => user.role === 'employee')
      .map(({ id, name, email, active, professionalId }) => ({
        id,
        name,
        email,
        active: active !== false,
        professionalId,
      }));
  }
  setActive(actor: Actor, userId: string, active: boolean) {
    this.context.admin(actor);
    return this.repo.transaction(() => {
      const employee = this.context.require<Customer>(actor, 'customers', userId);
      if (employee.role !== 'employee') throw new ForbiddenException();
      const hasActiveProfessional = employee.professionalId && this.repo.get<Professional>(actor.tenantId, 'professionals', employee.professionalId)?.active;
      if (active && employee.active === false && !hasActiveProfessional) requireEmployeeSeat(this.repo, actor.tenantId);
      this.repo.put(actor.tenantId, 'customers', userId, { ...employee, active });
      const professional =
        employee.professionalId &&
        this.repo.get<Professional>(actor.tenantId, 'professionals', employee.professionalId);
      if (professional)
        this.repo.put(actor.tenantId, 'professionals', professional.id, {
          ...professional,
          active,
        });
      return { ok: true };
    });
  }
}
